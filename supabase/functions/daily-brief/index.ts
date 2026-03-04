// Supabase Edge Function: daily-brief
// Generates a personalized 2-4 sentence daily training brief from the athlete's digital twin

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CACHE_HOURS = 6

interface Activity {
  id: number
  athlete_id: number
  activity_date: string
  distance: number
  moving_time: number
  average_speed: number
  average_heartrate?: number
  activity_types: { id: number; name: string } | null
}

interface DailyBriefResult {
  brief: string
  today_action: string
  insight: string
  tone: 'positive' | 'cautionary' | 'neutral'
}

function calculateACWR(activities: Activity[]): {
  acwr: number
  acuteLoad: number
  chronicLoad: number
  totalVolumeKm: number
  weeklyVolumeKm: number
  trainingTrend: string
} {
  const now = new Date()
  const msPerDay = 86400000

  const last7 = activities.filter(a => {
    const d = new Date(a.activity_date)
    return (now.getTime() - d.getTime()) / msPerDay <= 7
  })
  const last28 = activities.filter(a => {
    const d = new Date(a.activity_date)
    return (now.getTime() - d.getTime()) / msPerDay <= 28
  })

  const toTSS = (a: Activity) => {
    const km = (a.distance || 0) / 1000
    const avgSpeed = a.average_speed || 0
    if (avgSpeed === 0) return 0
    const paceMinPerMile = (1609.34 / avgSpeed) / 60
    const intensityFactor = paceMinPerMile < 7 ? 1.5 : paceMinPerMile < 8.5 ? 1.2 : paceMinPerMile < 10 ? 1.0 : 0.8
    return km * intensityFactor
  }

  const acuteLoad = last7.reduce((sum, a) => sum + toTSS(a), 0)
  const chronicLoad = last28.length > 0 ? last28.reduce((sum, a) => sum + toTSS(a), 0) / 4 : 0
  const acwr = chronicLoad > 0 ? acuteLoad / chronicLoad : 1.0

  const weeklyVolumeKm = last7.reduce((sum, a) => sum + (a.distance || 0) / 1000, 0)
  const totalVolumeKm = last28.reduce((sum, a) => sum + (a.distance || 0) / 1000, 0)

  const first14 = last28.filter(a => {
    const d = new Date(a.activity_date)
    const daysAgo = (now.getTime() - d.getTime()) / msPerDay
    return daysAgo > 14 && daysAgo <= 28
  })
  const recent14 = last28.filter(a => {
    const d = new Date(a.activity_date)
    return (now.getTime() - d.getTime()) / msPerDay <= 14
  })

  const first14Vol = first14.reduce((sum, a) => sum + (a.distance || 0) / 1000, 0)
  const recent14Vol = recent14.reduce((sum, a) => sum + (a.distance || 0) / 1000, 0)

  let trainingTrend = 'consistent'
  if (recent14Vol > first14Vol * 1.1) trainingTrend = 'ramping_up'
  else if (recent14Vol < first14Vol * 0.9) trainingTrend = 'tapering'

  return {
    acwr: Math.round(acwr * 100) / 100,
    acuteLoad: Math.round(acuteLoad * 10) / 10,
    chronicLoad: Math.round(chronicLoad * 10) / 10,
    totalVolumeKm: Math.round(totalVolumeKm * 10) / 10,
    weeklyVolumeKm: Math.round(weeklyVolumeKm * 10) / 10,
    trainingTrend,
  }
}

function buildLast5Snippet(activities: Activity[]): string {
  const sorted = [...activities].sort(
    (a, b) => new Date(b.activity_date).getTime() - new Date(a.activity_date).getTime()
  )
  return sorted.slice(0, 5).map(a => {
    const km = ((a.distance || 0) / 1000).toFixed(1)
    const pace = a.average_speed && a.average_speed > 0
      ? `${((1609.34 / a.average_speed) / 60).toFixed(2)} min/mi`
      : 'N/A'
    const hr = a.average_heartrate ? `, HR ${Math.round(a.average_heartrate)}bpm` : ''
    const type = a.activity_types?.name ?? 'Run'
    const date = new Date(a.activity_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    return `  ${date}: ${km}km @ ${pace}${hr} (${type})`
  }).join('\n')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Auth: extract JWT → get user
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    const token = authHeader.replace('Bearer ', '')

    const { data: { user }, error: userError } = await supabase.auth.getUser(token)
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Get athlete
    const { data: athlete, error: athleteError } = await supabase
      .from('athletes')
      .select('id, first_name, email, daily_brief, daily_brief_generated_at')
      .eq('auth_user_id', user.id)
      .single()

    if (athleteError || !athlete) {
      return new Response(JSON.stringify({ error: 'Athlete not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Cache check: return cached brief if < 6 hours old
    if (athlete.daily_brief_generated_at && athlete.daily_brief) {
      const generatedAt = new Date(athlete.daily_brief_generated_at)
      const ageHours = (Date.now() - generatedAt.getTime()) / 3600000
      if (ageHours < CACHE_HOURS) {
        const cached = athlete.daily_brief as DailyBriefResult
        return new Response(JSON.stringify({
          success: true,
          ...cached,
          generated_at: athlete.daily_brief_generated_at,
          cached: true,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }
    }

    // Fetch data in parallel
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
    const today = new Date().toISOString().split('T')[0]

    const [activitiesResult, raceResult, planResult] = await Promise.all([
      supabase
        .from('activities')
        .select('*, activity_types(id, name)')
        .eq('athlete_id', athlete.id)
        .gte('activity_date', thirtyDaysAgo.toISOString().split('T')[0])
        .order('activity_date', { ascending: false })
        .limit(30),

      supabase
        .from('runners')
        .select('races!inner(race_name, race_date, city, state, distance_km)')
        .eq('email', athlete.email)
        .gte('races.race_date', today)
        .order('races.race_date', { ascending: true })
        .limit(1),

      supabase
        .from('weekly_training_plans')
        .select('week_start_date, total_planned_km, plan_data')
        .eq('athlete_id', athlete.id)
        .order('week_start_date', { ascending: false })
        .limit(1),
    ])

    const activities = (activitiesResult.data ?? []) as Activity[]
    const runningActivities = activities.filter(a =>
      a.activity_types?.name === 'Run' || a.activity_types?.name === 'Running'
    )

    // ACWR and volume summary
    const loadMetrics = calculateACWR(runningActivities)

    // Last 5 activities snippet
    const last5 = buildLast5Snippet(runningActivities)

    // Next race
    let nextRaceText = 'No upcoming races registered'
    const raceRow = raceResult.data?.[0] as { races: { race_name: string; race_date: string; city?: string; state?: string; distance_km?: number } } | undefined
    if (raceRow?.races) {
      const r = raceRow.races
      const daysOut = Math.ceil(
        (new Date(r.race_date + 'T00:00:00').getTime() - Date.now()) / 86400000
      )
      nextRaceText = `${r.race_name}${r.distance_km ? ` (${r.distance_km}km)` : ''} in ${daysOut} days${r.city ? `, ${r.city}` : ''}`
    }

    // Latest training plan
    let planText = 'No training plan on file'
    const planRow = planResult.data?.[0]
    if (planRow) {
      planText = `Week of ${planRow.week_start_date}, planned ${planRow.total_planned_km ?? '?'}km`
    }

    // Build Claude prompt
    const systemPrompt = `You are the athlete's digital running twin — a deeply personalized AI coach that knows their training history intimately. Speak in first person about their data ("Your ACWR hit 1.4..."), not in generic advice mode. Never say "7-9 hours sleep" or other generic wellness platitudes. Reference specific numbers from their recent training. Be direct, human, and conversational — like a coach texting before a morning run.`

    const userPrompt = `Generate a daily training brief for ${athlete.first_name ?? 'the athlete'}.

Training Load (last 30 days):
- ACWR: ${loadMetrics.acwr} (acute/chronic workload ratio)
- Acute load (7d): ${loadMetrics.acuteLoad}
- Chronic load (28d avg): ${loadMetrics.chronicLoad}
- This week's volume: ${loadMetrics.weeklyVolumeKm}km
- 28-day total volume: ${loadMetrics.totalVolumeKm}km (avg ${(loadMetrics.totalVolumeKm / 4).toFixed(1)}km/week)
- Training trend: ${loadMetrics.trainingTrend}

Last 5 runs:
${last5 || '  No recent runs'}

Next race: ${nextRaceText}
Training plan: ${planText}

Respond with ONLY valid JSON matching this exact structure:
{
  "brief": "2-4 sentence narrative referencing their actual numbers and recent training pattern",
  "today_action": "One specific action for today (15 words max)",
  "insight": "One data-backed observation they might not have noticed (20 words max)",
  "tone": "positive" | "cautionary" | "neutral"
}

Rules:
- brief must reference at least one specific number (ACWR, km, pace, days to race, etc.)
- today_action must be concrete (e.g. "30min easy run, keep HR under 145" not "rest and recover")
- tone is "cautionary" if ACWR > 1.3, "positive" if ACWR 0.8-1.3 and trend is ramping_up, else "neutral"
- Never use generic recovery platitudes`

    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY || '',
        'anthropic-version': '2024-10-22',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    })

    if (!anthropicResponse.ok) {
      throw new Error(`Anthropic API error: ${anthropicResponse.status}`)
    }

    const anthropicData = await anthropicResponse.json()
    let jsonText = anthropicData.content[0].text

    if (jsonText.includes('```json')) {
      jsonText = jsonText.split('```json')[1].split('```')[0].trim()
    } else if (jsonText.includes('```')) {
      jsonText = jsonText.split('```')[1].split('```')[0].trim()
    }

    const result: DailyBriefResult = JSON.parse(jsonText)
    const generatedAt = new Date().toISOString()

    // Cache result
    await supabase
      .from('athletes')
      .update({ daily_brief: result, daily_brief_generated_at: generatedAt })
      .eq('id', athlete.id)

    return new Response(JSON.stringify({
      success: true,
      ...result,
      generated_at: generatedAt,
      cached: false,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (error) {
    console.error('daily-brief error:', error)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
