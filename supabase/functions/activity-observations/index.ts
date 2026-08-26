// activity-observations edge function
// Generates twin observations for recent activities, stored in activity_insights table

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface Activity {
  id: number
  name: string
  activity_date: string
  distance: number
  moving_time: number
  average_speed: number
  average_heartrate?: number
  pr_count?: number
  perceived_exertion?: number
  activity_types: { name: string } | null
}

function paceMinPerMile(avgSpeed: number): string {
  if (!avgSpeed || avgSpeed === 0) return 'N/A'
  const minPerMile = (1609.34 / avgSpeed) / 60
  const mins = Math.floor(minPerMile)
  const secs = Math.round((minPerMile - mins) * 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''))
    if (!user) return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

    const { data: athlete } = await supabase.from('athletes').select('id').eq('auth_user_id', user.id).single()
    if (!athlete) return new Response(JSON.stringify({ observations: {} }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

    if (req.method === 'POST') {
      const body = await req.json() as { activity_id?: number; observation?: string }
      const activityId = Number(body.activity_id)
      const observation = String(body.observation ?? '').trim().slice(0, 500)
      if (!Number.isInteger(activityId) || activityId <= 0 || observation.length < 12) {
        return new Response(JSON.stringify({ success: false, error: 'Invalid activity observation' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const { data: ownedActivity } = await supabase
        .from('activities')
        .select('id')
        .eq('id', activityId)
        .eq('athlete_id', athlete.id)
        .maybeSingle()
      if (!ownedActivity) {
        return new Response(JSON.stringify({ success: false, error: 'Activity not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const { error: saveError } = await supabase.from('activity_insights').upsert({
        activity_id: activityId,
        insight_type: 'twin_observation',
        insight_data: { observation, source: 'apple_on_device' },
      }, { onConflict: 'activity_id,insight_type' })
      if (saveError) {
        return new Response(JSON.stringify({ success: false, error: 'Unable to save observation' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    const { data: activities } = await supabase
      .from('activities')
      .select('id, name, activity_date, distance, moving_time, average_speed, average_heartrate, pr_count, perceived_exertion, activity_types(name)')
      .eq('athlete_id', athlete.id)
      .gte('activity_date', thirtyDaysAgo.toISOString().split('T')[0])
      .order('activity_date', { ascending: false })
      .limit(10)

    if (!activities || activities.length === 0) {
      return new Response(JSON.stringify({ observations: {} }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const activityIds = activities.map(a => a.id)

    // Check existing observations
    const { data: existingInsights } = await supabase
      .from('activity_insights')
      .select('activity_id, insight_data')
      .in('activity_id', activityIds)
      .eq('insight_type', 'twin_observation')

    const existingMap: Record<number, string> = {}
    for (const insight of existingInsights ?? []) {
      const d = insight.insight_data as { observation?: string } | null
      if (d?.observation) existingMap[insight.activity_id] = d.observation
    }

    const needObservations = (activities as Activity[]).filter(a => !existingMap[a.id])

    // New iOS 27 builds create observations on-device. Existing synced observations remain readable.

    return new Response(JSON.stringify({ observations: existingMap }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    console.error('activity-observations error:', err)
    return new Response(JSON.stringify({ observations: {} }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
