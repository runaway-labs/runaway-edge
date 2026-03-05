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
  totalVolumeMi: number
  weeklyVolumeMi: number
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

  const KM_TO_MI = 0.621371
  const weeklyVolumeMi = last7.reduce((sum, a) => sum + (a.distance || 0) / 1000 * KM_TO_MI, 0)
  const totalVolumeMi = last28.reduce((sum, a) => sum + (a.distance || 0) / 1000 * KM_TO_MI, 0)

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
    totalVolumeMi: Math.round(totalVolumeMi * 10) / 10,
    weeklyVolumeMi: Math.round(weeklyVolumeMi * 10) / 10,
    trainingTrend,
  }
}

function getACWRState(acwr: number): { state: string; voice: string } {
  if (acwr < 0.8) return {
    state: 'underloading',
    voice: "You're fading. Your body has built capacity you're not using — it's craving load."
  }
  if (acwr <= 1.0) return {
    state: 'maintenance',
    voice: "You're in maintenance. Solid base, but not building right now."
  }
  if (acwr <= 1.3) return {
    state: 'optimal',
    voice: "You're in the flow. Load and capacity are matched — this is the sweet spot."
  }
  if (acwr <= 1.5) return {
    state: 'caution',
    voice: "You're flirting with the edge. Your spike load is 30-50% above your base. Pull back or pay later."
  }
  return {
    state: 'danger',
    voice: "You're in the red. Load is more than 50% above your chronic base. This is where injuries happen."
  }
}

function buildLast5Snippet(activities: Activity[]): string {
  const sorted = [...activities].sort(
    (a, b) => new Date(b.activity_date).getTime() - new Date(a.activity_date).getTime()
  )
  return sorted.slice(0, 5).map(a => {
    const mi = ((a.distance || 0) / 1609.34).toFixed(2)
    const pace = a.average_speed && a.average_speed > 0
      ? `${((1609.34 / a.average_speed) / 60).toFixed(2)} min/mi`
      : 'N/A'
    const hr = a.average_heartrate ? `, HR ${Math.round(a.average_heartrate)}bpm` : ''
    const type = a.activity_types?.name ?? 'Run'
    const date = new Date(a.activity_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    return `  ${date}: ${mi}mi @ ${pace}${hr} (${type})`
  }).join('\n')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
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

    const { data: athlete, error: athleteError } = await supabase
      .from('athletes')
      .select('id, first_name, email, daily_brief, daily_brief_generated_at, garmin_connected, garmin_fitness_stats')
      .eq('auth_user_id', user.id)
      .single()

    if (athleteError || !athlete) {
      return new Response(JSON.stringify({ error: 'Athlete not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const forceRefresh = new URL(req.url).searchParams.get('refresh') === 'true'
    if (!forceRefresh && athlete.daily_brief_generated_at && athlete.daily_brief) {
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

    const sixtyDaysAgo = new Date()
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60)
    const today = new Date().toISOString().split('T')[0]

    const [activitiesResult, raceResult, planResult] = await Promise.all([
      supabase
        .from('activities')
        .select('*, activity_types(id, name)')
        .eq('athlete_id', athlete.id)
        .gte('activity_date', sixtyDaysAgo.toISOString().split('T')[0])
        .order('activity_date', { ascending: false })
        .limit(60),

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
    const RUN_TYPES = new Set(['Run', 'Running', 'Trail Run', 'Trail Running', 'Treadmill', 'Treadmill Running', 'Virtual Run', 'Race'])
    const runningActivities = activities.filter(a =>
      !a.activity_types?.name || RUN_TYPES.has(a.activity_types.name)
    )

    const loadMetrics = calculateACWR(runningActivities)
    const acwrState = getACWRState(loadMetrics.acwr)
    const last5 = buildLast5Snippet(runningActivities)

    let nextRaceText = 'No upcoming races registered'
    const raceRow = raceResult.data?.[0] as { races: { race_name: string; race_date: string; city?: string; state?: string; distance_km?: number } } | undefined
    if (raceRow?.races) {
      const r = raceRow.races
      const daysOut = Math.ceil(
        (new Date(r.race_date + 'T00:00:00').getTime() - Date.now()) / 86400000
      )
      nextRaceText = `${r.race_name}${r.distance_km ? ` (${r.distance_km}km)` : ''} in ${daysOut} days${r.city ? `, ${r.city}` : ''}`
    }

    let planText = 'No training plan on file'
    const planRow = planResult.data?.[0]
    if (planRow) {
      planText = `Week of ${planRow.week_start_date}, planned ${planRow.total_planned_km ?? '?'}km`
    }

    const garmin = athlete.garmin_fitness_stats as Record<string, unknown> | null
    let garminSection = ''
    if (athlete.garmin_connected && garmin) {
      const lines: string[] = []
      if (garmin.vo2Max) lines.push(`- Device VO2max: ${garmin.vo2Max} ml/kg/min`)
      if (garmin.trainingStatus) lines.push(`- Training status: ${garmin.trainingStatus}${garmin.trainingStatusDescription ? ` — ${garmin.trainingStatusDescription}` : ''}`)
      if (garmin.recoveryTime) lines.push(`- Recovery time remaining: ${garmin.recoveryTime}h`)
      if (garmin.bodyBattery != null) lines.push(`- Body Battery: ${garmin.bodyBattery}/100`)
      if (garmin.hrvStatus) lines.push(`- HRV status: ${garmin.hrvStatus}${garmin.hrvValue ? ` (${garmin.hrvValue}ms)` : ''}`)
      if (garmin.restingHeartRate) lines.push(`- Resting HR: ${garmin.restingHeartRate}bpm`)
      if (garmin.sleepScore) lines.push(`- Last sleep score: ${garmin.sleepScore}/100`)
      if (garmin.trainingLoad) lines.push(`- Garmin training load (7d): ${garmin.trainingLoad}`)
      if (lines.length > 0) garminSection = `\nGarmin Device Data:\n${lines.join('\n')}`
    }

    const systemPrompt = `You are the athlete's digital running twin — a deeply personalized AI that has studied their full training history. You are not a coach. You are a mirror. You reflect what the data shows about who they are becoming as an athlete.

Your voice: direct, second person, declarative. Like a training partner who has been with them for every run and knows the numbers cold. No cheerleading. No judgment. When the data says something good, say it. When the data says something concerning, say it straight.

ACWR is your primary signal for training state. Use this language system exactly:
- ACWR < 0.8: "You're fading. Your body has built capacity you're not using."
- ACWR 0.8–1.0: "You're in maintenance. Solid base, not building."
- ACWR 1.0–1.3: "You're in the flow. Load and capacity are matched."
- ACWR 1.3–1.5: "You're flirting with the edge. Pull back or pay later."
- ACWR > 1.5: "You're in the red. This is where injuries happen."

Current ACWR state for this athlete: ${acwrState.state} (${loadMetrics.acwr})
Reference voice for this state: "${acwrState.voice}"

Every sentence must reference actual numbers. Never give generic advice. If Garmin data is present, it overrides estimated values — those numbers are live from the device.`

    const userPrompt = `Generate a daily training brief for ${athlete.first_name ?? 'the athlete'}.

Training Load (last 28 days):
- ACWR: ${loadMetrics.acwr} — state: ${acwrState.state}
- Acute load (7d): ${loadMetrics.acuteLoad}
- Chronic load (28d avg): ${loadMetrics.chronicLoad}
- This week's volume: ${loadMetrics.weeklyVolumeMi}mi
- 28-day total: ${loadMetrics.totalVolumeMi}mi (avg ${(loadMetrics.totalVolumeMi / 4).toFixed(1)}mi/week)
- Training trend: ${loadMetrics.trainingTrend}
${garminSection}
Last 5 runs:
${last5 || '  No recent runs'}

Next race: ${nextRaceText}
Training plan: ${planText}

Respond with ONLY valid JSON:
{
  "brief": "2-4 sentences. Must reference ACWR state using the voice system above. Must include at least 2 specific numbers. No generic advice.",
  "today_action": "One specific concrete action for today. Max 15 words. Must be specific (e.g. '45min easy, HR under 140' not 'rest and recover').",
  "insight": "One data pattern they may not have noticed. Max 20 words. Must cite a number.",
  "tone": "cautionary if ACWR > 1.3 | positive if ACWR 0.8–1.3 and trend is ramping_up | neutral otherwise"
}

Rules:
- Never use: 'stay hydrated', 'listen to your body', 'recovery is important', 'great job'
- Always use their name in the brief
- Tone must match ACWR state exactly`

    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
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
