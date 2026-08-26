// Supabase Edge Function: daily-brief
// Generates a personalized 2-4 sentence daily training brief from the athlete's digital twin
// v2: Added Twin Taper Mode — special phase detection + voice for 21 days pre-race

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { buildDailyBrief } from './deterministic.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

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
  activity_type_id?: number
  activity_types?: { id: number; name: string } | null
}

interface DailyBriefResult {
  brief: string
  today_action: string
  insight: string
  tone: 'positive' | 'cautionary' | 'neutral'
  taper_mode_active?: boolean
  taper_phase?: string
}

function calculateACWR(activities: Activity[]): {
  acwr: number
  acuteLoad: number
  chronicLoad: number
  totalVolumeMi: number
  weeklyVolumeMi: number
  peakWeeklyMi: number
  cumulativeMi84d: number
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
  const last84 = activities.filter(a => {
    const d = new Date(a.activity_date)
    return (now.getTime() - d.getTime()) / msPerDay <= 84
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
  const cumulativeMi84d = last84.reduce((sum, a) => sum + (a.distance || 0) / 1000 * KM_TO_MI, 0)

  // Find peak week in last 84 days
  let peakWeeklyMi = 0
  for (let weekStart = 0; weekStart < 12; weekStart++) {
    const wStart = weekStart * 7
    const wEnd = wStart + 7
    const weekActs = last84.filter(a => {
      const daysAgo = (now.getTime() - new Date(a.activity_date).getTime()) / msPerDay
      return daysAgo > wStart && daysAgo <= wEnd
    })
    const weekMi = weekActs.reduce((sum, a) => sum + (a.distance || 0) / 1000 * KM_TO_MI, 0)
    if (weekMi > peakWeeklyMi) peakWeeklyMi = weekMi
  }

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
    peakWeeklyMi: Math.round(peakWeeklyMi * 10) / 10,
    cumulativeMi84d: Math.round(cumulativeMi84d * 10) / 10,
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

// Twin Taper Mode: determine phase + voice
function getTaperPhase(daysOut: number): {
  phase: string
  phaseName: string
  taperModeActive: boolean
  systemContext: string
  responseGuidance: string
} {
  if (daysOut === 0) {
    return {
      phase: 'race_day',
      phaseName: 'Race Day',
      taperModeActive: true,
      systemContext: 'This is RACE DAY. The twin\'s only job: witness and send off.',
      responseGuidance: `brief: One line. No data. Just the moment. Example: "Today is the day your twin has been building toward. The data is done. Now you run."
today_action: "Run your race. Trust what you've built."
insight: Name the cumulative miles trained. That's the only number today.
tone: positive`,
    }
  }
  if (daysOut <= 6) {
    return {
      phase: 'race_week',
      phaseName: 'Race Week',
      taperModeActive: true,
      systemContext: 'RACE WEEK (Twin Taper Mode — Phase 3). The twin goes quiet on analysis, loud on identity. One sentence + one data point per brief. No training recommendations. No pace targets. Only presence.',
      responseGuidance: `brief: One sentence. Acknowledge the countdown. Reference total cumulative miles trained. Example: "Six days. You've built 287 miles of foundation for this. Nothing left to do but arrive."
today_action: Max 10 words. Easy movement or full rest only.
insight: One fact from their training history that proves their readiness.
tone: positive`,
    }
  }
  if (daysOut <= 13) {
    return {
      phase: 'taper_trust',
      phaseName: 'Taper — Trust Phase',
      taperModeActive: true,
      systemContext: 'TAPER TRUST PHASE (Twin Taper Mode — Phase 2). The twin is the counterweight to taper madness. Volume is dropping intentionally. ACWR dropping is CORRECT. The twin must name the doubt before it lands.',
      responseGuidance: `brief: Name what they're probably feeling (legs heavy, doubt creeping in, urge to run more). Then refute it with their actual data. ACWR dropping is the goal, not a warning sign. HRV and resting HR are the real signals now — reference them if available. Example: "Your legs will lie to you this week, Jack. Here's what your body is actually doing: ACWR at 0.82, right where it needs to be. Taper is working."
today_action: Recovery-focused. Specific but gentle.
insight: One data point that proves fitness is intact despite lower volume.
tone: positive (taper is working, not a regression)`,
    }
  }
  if (daysOut <= 21) {
    return {
      phase: 'taper_arriving',
      phaseName: 'Taper — Arriving Phase',
      taperModeActive: true,
      systemContext: 'ARRIVING PHASE (Twin Taper Mode — Phase 1). The training build is complete. The twin\'s job: show the athlete the mountain they climbed. Not what to do next — what they\'ve already done.',
      responseGuidance: `brief: Open with the cumulative picture. Total miles in the last 12 weeks. Peak week mileage. Long run progression. Then: "You're not building anymore. You're arriving." Make the fitness real and visible.
today_action: Last quality work if scheduled; easy miles or rest otherwise.
insight: Something from the 12-week arc they might not have seen — peak week, total volume, long run progression.
tone: positive`,
    }
  }

  // Not in taper window
  return {
    phase: 'normal',
    phaseName: '',
    taperModeActive: false,
    systemContext: '',
    responseGuidance: '',
  }
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

    const today = new Date().toISOString().split('T')[0]
    const eightyfourDaysAgo = new Date()
    eightyfourDaysAgo.setDate(eightyfourDaysAgo.getDate() - 84)

    const [activitiesResult, athleteRaceResult, publicRaceResult, planResult] = await Promise.all([
      supabase
        .from('activities')
        .select('id, athlete_id, activity_date, distance, moving_time, average_speed, average_heart_rate, activity_type_id')
        .eq('athlete_id', athlete.id)
        .gte('activity_date', eightyfourDaysAgo.toISOString().split('T')[0])
        .order('activity_date', { ascending: false })
        .limit(100),

      // Primary: athlete's personal race registrations (RunSignUp cache)
      supabase
        .from('athlete_races')
        .select('race_name, race_date, city, state, runsignup_race_id')
        .eq('athlete_id', athlete.id)
        .gte('race_date', today)
        .order('race_date', { ascending: true })
        .limit(1),

      // Fallback: public race directory
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
    const RUN_TYPES = new Set([1, 2, 3]) // Run activity type IDs — adjust to match your data
    const runningActivities = activities.filter(a => !a.activity_type_id || a.activity_type_id <= 5)

    const loadMetrics = calculateACWR(runningActivities)
    const acwrState = getACWRState(loadMetrics.acwr)
    const last5 = buildLast5Snippet(runningActivities)

    // Determine upcoming race — prefer athlete_races, fall back to public directory
    let raceName = ''
    let raceDate = ''
    let goalTime = ''
    let daysOut = 9999

    const personalRace = athleteRaceResult.data?.[0] as {
      race_name: string
      race_date: string
      city?: string
      state?: string
      runsignup_race_id?: number
    } | undefined

    if (personalRace?.race_date) {
      raceDate = personalRace.race_date
      raceName = personalRace.race_name ?? 'Goal Race'
      goalTime = ''
      daysOut = Math.ceil((new Date(raceDate + 'T00:00:00').getTime() - Date.now()) / 86400000)
    } else {
      const publicRace = publicRaceResult.data?.[0] as {
        races: { race_name: string; race_date: string; city?: string; state?: string; distance_km?: number }
      } | undefined
      if (publicRace?.races) {
        raceDate = publicRace.races.race_date
        raceName = publicRace.races.race_name
        daysOut = Math.ceil((new Date(raceDate + 'T00:00:00').getTime() - Date.now()) / 86400000)
      }
    }

    // Twin Taper Mode detection
    const taperData = raceName ? getTaperPhase(daysOut) : {
      phase: 'normal', phaseName: '', taperModeActive: false, systemContext: '', responseGuidance: ''
    }

    // Legacy phase text for non-taper phases
    let legacyPhaseGuidance = ''
    if (!taperData.taperModeActive && raceName) {
      if (daysOut <= 42) {
        legacyPhaseGuidance = 'Final Build phase. Last window for meaningful training stimulus. Make it count.'
      } else {
        legacyPhaseGuidance = 'Base Building phase. Aerobic foundation is the priority. Volume over intensity.'
      }
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

    let result: DailyBriefResult = buildDailyBrief({
      firstName: athlete.first_name ?? 'Runner',
      metrics: loadMetrics,
      acwrState: acwrState.state,
      raceName: raceName || undefined,
      daysOut: raceName ? daysOut : undefined,
      taperPhase: taperData.taperModeActive ? taperData.phaseName : undefined,
    })

    // Attach taper mode metadata
    if (taperData.taperModeActive) {
      result.taper_mode_active = true
      result.taper_phase = taperData.phaseName
    }

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
