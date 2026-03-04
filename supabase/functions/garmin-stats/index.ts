// Supabase Edge Function: garmin-stats
// Fetch fitness metrics from Garmin Health API (VO2 max, training status, HRV, etc.)

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const GARMIN_CLIENT_ID = Deno.env.get('GARMIN_CONSUMER_KEY')?.trim()
const GARMIN_CLIENT_SECRET = Deno.env.get('GARMIN_CONSUMER_SECRET')?.trim()

interface GarminFitnessStats {
  vo2Max?: number
  vo2MaxCycling?: number
  fitnessAge?: number
  trainingStatus?: string
  trainingStatusDescription?: string
  trainingLoad?: number
  trainingLoadBalance?: string
  recoveryTime?: number
  recoveryTimeDescription?: string
  bodyBattery?: number
  stressLevel?: number
  restingHeartRate?: number
  hrvStatus?: string
  hrvValue?: number
  sleepScore?: number
  intensityMinutes?: number
  weeklyIntensityMinutes?: number
  lastUpdated?: string
}

// Fetch from Garmin API using OAuth 2.0 Bearer token
async function fetchGarminEndpoint(
  endpoint: string,
  accessToken: string
): Promise<Response> {
  const baseUrl = 'https://apis.garmin.com'
  const url = `${baseUrl}${endpoint}`

  console.log(`Fetching from Garmin: ${endpoint}`)

  return fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  })
}

// Get today's date range for API calls
function getTodayRange(): { start: number; end: number } {
  const now = new Date()
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1)

  return {
    start: Math.floor(startOfDay.getTime() / 1000),
    end: Math.floor(endOfDay.getTime() / 1000)
  }
}

// Parse training status from Garmin's response
function parseTrainingStatus(status: string): { status: string; description: string } {
  const statusMap: Record<string, { status: string; description: string }> = {
    'PRODUCTIVE': { status: 'Productive', description: 'Your training is improving your fitness' },
    'MAINTAINING': { status: 'Maintaining', description: 'Your training is maintaining your fitness level' },
    'RECOVERY': { status: 'Recovery', description: 'Your lighter training is allowing your body to recover' },
    'UNPRODUCTIVE': { status: 'Unproductive', description: 'Your training load is high but fitness is declining' },
    'DETRAINING': { status: 'Detraining', description: 'You\'ve been training less and losing fitness' },
    'PEAKING': { status: 'Peaking', description: 'You\'re in ideal race condition' },
    'OVERREACHING': { status: 'Overreaching', description: 'Your training load is very high - rest needed' },
    'NO_STATUS': { status: 'No Status', description: 'Not enough data to determine training status' }
  }

  return statusMap[status] || { status: status, description: '' }
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // Get auth user from request
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Create user client to get the authenticated user
    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser()
    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Get athlete with Garmin credentials
    const { data: athlete, error: athleteError } = await supabaseAdmin
      .from('athletes')
      .select('id, garmin_connected, garmin_access_token, garmin_refresh_token, garmin_token_expires_at')
      .eq('auth_user_id', user.id)
      .single()

    if (athleteError || !athlete) {
      return new Response(
        JSON.stringify({ error: 'Athlete not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!athlete.garmin_connected || !athlete.garmin_access_token) {
      return new Response(
        JSON.stringify({ error: 'Garmin not connected', garmin_connected: false }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const accessToken = athlete.garmin_access_token
    const stats: GarminFitnessStats = {}
    const { start, end } = getTodayRange()

    // Fetch User Metrics (VO2 max, fitness age, training status)
    try {
      const metricsResponse = await fetchGarminEndpoint(
        `/wellness-api/rest/user/metrics?uploadStartTimeInSeconds=${start}&uploadEndTimeInSeconds=${end}`,
        accessToken
      )

      if (metricsResponse.ok) {
        const metricsData = await metricsResponse.json()
        console.log('User metrics:', JSON.stringify(metricsData))

        if (Array.isArray(metricsData) && metricsData.length > 0) {
          const latest = metricsData[metricsData.length - 1]
          stats.vo2Max = latest.vo2Max
          stats.vo2MaxCycling = latest.vo2MaxCycling
          stats.fitnessAge = latest.fitnessAge
        }
      }
    } catch (e) {
      console.error('Error fetching user metrics:', e)
    }

    // Fetch Daily Summary (steps, stress, body battery, resting HR)
    try {
      const dailyResponse = await fetchGarminEndpoint(
        `/wellness-api/rest/dailies?uploadStartTimeInSeconds=${start}&uploadEndTimeInSeconds=${end}`,
        accessToken
      )

      if (dailyResponse.ok) {
        const dailyData = await dailyResponse.json()
        console.log('Daily summary:', JSON.stringify(dailyData))

        if (Array.isArray(dailyData) && dailyData.length > 0) {
          const latest = dailyData[dailyData.length - 1]
          console.log('Daily fields available:', Object.keys(latest))
          stats.restingHeartRate = latest.restingHeartRateInBeatsPerMinute
          stats.stressLevel = latest.averageStressLevel
          // Try multiple possible field names for Body Battery
          stats.bodyBattery = latest.bodyBatteryMostRecentValue
            ?? latest.bodyBatteryHighestValue
            ?? latest.maxBodyBattery
          stats.intensityMinutes = latest.moderateIntensityDurationInSeconds
            ? Math.floor(latest.moderateIntensityDurationInSeconds / 60)
            : undefined
        }
      }
    } catch (e) {
      console.error('Error fetching daily summary:', e)
    }

    // Fetch HRV data
    try {
      const hrvResponse = await fetchGarminEndpoint(
        `/wellness-api/rest/hrv?uploadStartTimeInSeconds=${start}&uploadEndTimeInSeconds=${end}`,
        accessToken
      )

      if (hrvResponse.ok) {
        const hrvData = await hrvResponse.json()
        console.log('HRV data:', JSON.stringify(hrvData))

        if (Array.isArray(hrvData) && hrvData.length > 0) {
          const latest = hrvData[hrvData.length - 1]
          stats.hrvValue = latest.hrvValue || latest.weeklyAvg
          stats.hrvStatus = latest.status
        }
      }
    } catch (e) {
      console.error('Error fetching HRV:', e)
    }

    // Fetch Sleep data
    try {
      const sleepResponse = await fetchGarminEndpoint(
        `/wellness-api/rest/sleeps?uploadStartTimeInSeconds=${start - 86400}&uploadEndTimeInSeconds=${end}`,
        accessToken
      )

      if (sleepResponse.ok) {
        const sleepData = await sleepResponse.json()
        console.log('Sleep data:', JSON.stringify(sleepData))

        if (Array.isArray(sleepData) && sleepData.length > 0) {
          const latest = sleepData[sleepData.length - 1]
          stats.sleepScore = latest.overallSleepScore || latest.sleepScores?.overall
        }
      }
    } catch (e) {
      console.error('Error fetching sleep:', e)
    }

    // Fetch Training Status (if available - newer endpoint)
    try {
      const trainingResponse = await fetchGarminEndpoint(
        `/wellness-api/rest/training-status?uploadStartTimeInSeconds=${start}&uploadEndTimeInSeconds=${end}`,
        accessToken
      )

      if (trainingResponse.ok) {
        const trainingData = await trainingResponse.json()
        console.log('Training status:', JSON.stringify(trainingData))

        if (Array.isArray(trainingData) && trainingData.length > 0) {
          const latest = trainingData[trainingData.length - 1]
          const parsed = parseTrainingStatus(latest.trainingStatus || latest.status)
          stats.trainingStatus = parsed.status
          stats.trainingStatusDescription = parsed.description
          stats.trainingLoad = latest.trainingLoad || latest.load7Days
          stats.recoveryTime = latest.recoveryTimeInHours
        }
      }
    } catch (e) {
      console.error('Error fetching training status:', e)
    }

    stats.lastUpdated = new Date().toISOString()

    // Get existing cached stats to merge with (preserve data that wasn't fetched today)
    const { data: existingAthlete } = await supabaseAdmin
      .from('athletes')
      .select('garmin_fitness_stats')
      .eq('id', athlete.id)
      .single()

    const existingStats = (existingAthlete?.garmin_fitness_stats as GarminFitnessStats) || {}

    // Filter out undefined/null values from new stats
    const validNewStats = Object.fromEntries(
      Object.entries(stats).filter(([, v]) => v !== undefined && v !== null)
    )

    // Merge: existing stats as base, new valid stats override
    const mergedStats: GarminFitnessStats = {
      ...existingStats,
      ...validNewStats,
      lastUpdated: stats.lastUpdated
    }

    // Only update if we have actual data
    if (Object.keys(validNewStats).length > 1) { // > 1 because lastUpdated is always present
      const { error: updateError } = await supabaseAdmin
        .from('athletes')
        .update({
          garmin_fitness_stats: mergedStats,
          garmin_stats_updated_at: stats.lastUpdated
        })
        .eq('id', athlete.id)

      if (updateError) {
        console.error('Error storing stats:', updateError)
      }
    } else {
      console.log('No new Garmin data today, using cached stats')
    }

    return new Response(
      JSON.stringify({
        success: true,
        stats: mergedStats, // Return merged stats so UI always has full picture
        garmin_connected: true
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Garmin stats error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Failed to fetch Garmin stats' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
