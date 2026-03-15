// Supabase Edge Function: max-data
// Provides Max (AI assistant) read-only access to Jack's training data.
// Protected by a shared secret token (MAX_DATA_TOKEN env var).

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-max-token',
}

const MAX_DATA_TOKEN = Deno.env.get('MAX_DATA_TOKEN')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

function getAdmin() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  const tokenHeader = req.headers.get('x-max-token')
  if (!MAX_DATA_TOKEN || tokenHeader !== MAX_DATA_TOKEN) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const url = new URL(req.url)
  const query = url.searchParams.get('q') || 'overview'
  const days = parseInt(url.searchParams.get('days') || '30')
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100)

  const sb = getAdmin()

  try {
    const { data: athlete, error: ae } = await sb
      .from('athletes')
      .select('id, first_name, last_name, email, created_at, strava_connected, garmin_connected, daily_brief_generated_at')
      .order('created_at', { ascending: true })
      .limit(1)
      .single()

    if (ae || !athlete) {
      return new Response(JSON.stringify({ error: 'Could not find athlete', details: ae?.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const athleteId = athlete.id
    const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0]
    const result: Record<string, unknown> = { athlete, query, days }

    // --- ACTIVITIES (no join) ---
    if (query === 'overview' || query === 'activities') {
      const { data: activities, error: acte } = await sb
        .from('activities')
        .select('id, name, distance, moving_time, elapsed_time, activity_date, average_speed, max_speed, average_heart_rate, max_heart_rate, suffer_score, elevation_gain, activity_type_id')
        .eq('athlete_id', athleteId)
        .gte('activity_date', since)
        .order('activity_date', { ascending: false })
        .limit(limit)

      if (acte) result.activities_error = acte.message
      result.activities = activities || []

      // Enrich with type names if we got activities
      if (activities?.length) {
        const typeIds = [...new Set(activities.map(a => a.activity_type_id).filter(Boolean))]
        if (typeIds.length) {
          const { data: types } = await sb.from('activity_types').select('id, name').in('id', typeIds)
          const typeMap = Object.fromEntries((types || []).map(t => [t.id, t.name]))
          result.activities = activities.map(a => ({ ...a, activity_type: typeMap[a.activity_type_id] || 'Unknown' }))
        }
      }
    }

    // --- BIOMETRICS ---
    if (query === 'overview' || query === 'biometrics') {
      const { data: bio, error: be } = await sb
        .from('biometric_enrichment')
        .select('*')
        .eq('athlete_id', athleteId)
        .gte('recorded_at', since)
        .order('recorded_at', { ascending: false })
        .limit(limit)

      if (be) {
        // fallback
        const { data: bio2 } = await sb
          .from('biometrics')
          .select('*')
          .eq('athlete_id', athleteId)
          .order('recorded_at', { ascending: false })
          .limit(limit)
        result.biometrics = bio2 || []
      } else {
        result.biometrics = bio || []
      }
    }

    // --- UPCOMING RACES ---
    if (query === 'overview' || query === 'races') {
      const today = new Date().toISOString().split('T')[0]
      const { data: races, error: re } = await sb
        .from('athlete_races')
        .select('id, race_name, race_date, city, state, runsignup_race_id')
        .eq('athlete_id', athleteId)
        .gte('race_date', today)
        .order('race_date', { ascending: true })
        .limit(5)

      result.upcoming_races = races || []
      if (re) result.races_error = re?.message

      // athlete_races has race_name directly (RunSignUp cache)
    }

    // --- TRAINING LOAD (computed ACWR) ---
    if (query === 'overview' || query === 'load') {
      const { data: last28Acts } = await sb
        .from('activities')
        .select('distance, moving_time, activity_date, average_speed')
        .eq('athlete_id', athleteId)
        .gte('activity_date', new Date(Date.now() - 28 * 86400000).toISOString().split('T')[0])
        .order('activity_date', { ascending: false })

      if (last28Acts) {
        const KM_TO_MI = 0.621371
        const now = Date.now()
        const msPerDay = 86400000
        const last7 = last28Acts.filter(a => (now - new Date(a.activity_date).getTime()) / msPerDay <= 7)

        const toLoad = (a: { distance: number; average_speed: number }) => {
          const km = (a.distance || 0) / 1000
          const avgSpeed = a.average_speed || 0
          if (avgSpeed === 0) return km
          const paceMinPerMile = (1609.34 / avgSpeed) / 60
          const intensity = paceMinPerMile < 7 ? 1.5 : paceMinPerMile < 8.5 ? 1.2 : paceMinPerMile < 10 ? 1.0 : 0.8
          return km * intensity
        }

        const acuteLoad = last7.reduce((s, a) => s + toLoad(a), 0)
        const chronicLoad = last28Acts.length > 0 ? last28Acts.reduce((s, a) => s + toLoad(a), 0) / 4 : 0
        const acwr = chronicLoad > 0 ? +(acuteLoad / chronicLoad).toFixed(2) : 1.0

        result.training_load = {
          acwr,
          acuteLoad: +acuteLoad.toFixed(1),
          chronicLoad: +chronicLoad.toFixed(1),
          weeklyMiles: +(last7.reduce((s, a) => s + (a.distance || 0) / 1000 * KM_TO_MI, 0)).toFixed(1),
          monthlyMiles: +(last28Acts.reduce((s, a) => s + (a.distance || 0) / 1000 * KM_TO_MI, 0)).toFixed(1),
          riskLevel: acwr > 1.5 ? 'high' : acwr > 1.3 ? 'moderate' : acwr < 0.8 ? 'low' : 'optimal',
          activitiesLast7: last7.length,
          activitiesLast28: last28Acts.length,
        }
      }
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return new Response(JSON.stringify({ error: 'Internal error', details: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
