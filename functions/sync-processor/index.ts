// Sync Processor Edge Function
// Processes sync jobs by fetching activities from Strava API
// Called by pg_cron every 5 minutes or can be invoked manually

import { createSupabaseClient } from '../_shared/supabase.ts'
import { corsHeaders } from '../_shared/cors.ts'

const STRAVA_CLIENT_ID = Deno.env.get('STRAVA_CLIENT_ID')!
const STRAVA_CLIENT_SECRET = Deno.env.get('STRAVA_CLIENT_SECRET')!

interface StravaActivity {
  id: number
  athlete: { id: number }
  name: string
  distance: number
  moving_time: number
  elapsed_time: number
  total_elevation_gain: number
  type: string
  start_date: string
  start_date_local: string
  timezone: string
  start_latlng: [number, number] | null
  end_latlng: [number, number] | null
  average_speed: number
  max_speed: number
  average_cadence?: number
  average_heartrate?: number
  max_heartrate?: number
  elev_high?: number
  elev_low?: number
  upload_id?: number
  external_id?: string
  trainer?: boolean
  commute?: boolean
  manual?: boolean
  private?: boolean
  flagged?: boolean
  workout_type?: number
  average_watts?: number
  max_watts?: number
  kilojoules?: number
  device_watts?: boolean
  suffer_score?: number
  map?: {
    summary_polyline?: string
  }
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabase = createSupabaseClient()

    console.log('Starting sync job processor')

    // Get pending jobs (limit to 5 at a time to avoid overload)
    const { data: jobs, error: jobsError } = await supabase
      .from('sync_jobs')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(5)

    if (jobsError) {
      throw new Error(`Error fetching jobs: ${jobsError.message}`)
    }

    if (!jobs || jobs.length === 0) {
      console.log('No pending jobs to process')
      return new Response(
        JSON.stringify({
          message: 'No pending jobs',
          processed: 0
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    console.log(`Processing ${jobs.length} sync jobs`)

    const results = []

    // Process each job
    for (const job of jobs) {
      try {
        const result = await processJob(supabase, job)
        results.push(result)
      } catch (error) {
        console.error(`Error processing job ${job.id}`, {
          error: error.message,
          jobId: job.id
        })
        results.push({
          jobId: job.id,
          success: false,
          error: error.message
        })
      }
    }

    return new Response(
      JSON.stringify({
        message: 'Jobs processed',
        processed: results.length,
        results
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )

  } catch (error) {
    console.error('Error in sync processor', {
      error: error.message,
      stack: error.stack
    })

    return new Response(
      JSON.stringify({
        error: {
          code: 'PROCESSOR_ERROR',
          message: error.message
        }
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )
  }
})

/**
 * Process a single sync job
 */
async function processJob(supabase: any, job: any): Promise<any> {
  const jobId = job.id
  const athleteId = job.athlete_id
  const maxActivities = job.metadata?.max_activities || null

  console.log(`Processing job ${jobId} for athlete ${athleteId}`, {
    syncType: job.sync_type,
    maxActivities
  })

  // Mark job as in progress
  await supabase
    .from('sync_jobs')
    .update({
      status: 'in_progress',
      started_at: new Date().toISOString()
    })
    .eq('id', jobId)

  try {
    // Get athlete's Strava tokens
    const { data: tokens, error: tokenError } = await supabase
      .from('strava_tokens')
      .select('*')
      .eq('athlete_id', athleteId)
      .single()

    if (tokenError || !tokens) {
      throw new Error(`No tokens found for athlete ${athleteId}`)
    }

    // Check if token needs refresh
    const expiresAt = new Date(tokens.expires_at)
    const now = new Date()

    let accessToken = tokens.access_token

    if (expiresAt <= now) {
      console.log(`Token expired for athlete ${athleteId}, refreshing...`)
      accessToken = await refreshToken(supabase, athleteId, tokens.refresh_token)
    }

    // Fetch activities from Strava
    const activities = await fetchActivitiesFromStrava(
      accessToken,
      job.after_timestamp,
      job.before_timestamp,
      maxActivities
    )

    console.log(`Fetched ${activities.length} activities for athlete ${athleteId}`)

    // Store activities in database
    let processed = 0
    let failed = 0

    for (const stravaActivity of activities) {
      try {
        await storeActivity(supabase, stravaActivity)
        processed++
      } catch (error) {
        console.error(`Error storing activity ${stravaActivity.id}`, {
          error: error.message
        })
        failed++
      }
    }

    // Mark job as completed
    await supabase
      .from('sync_jobs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        total_activities: activities.length,
        processed_activities: processed,
        failed_activities: failed
      })
      .eq('id', jobId)

    console.log(`Job ${jobId} completed: ${processed} processed, ${failed} failed`)

    return {
      jobId,
      success: true,
      processed,
      failed,
      total: activities.length
    }

  } catch (error) {
    // Mark job as failed
    await supabase
      .from('sync_jobs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: error.message
      })
      .eq('id', jobId)

    throw error
  }
}

/**
 * Refresh Strava access token
 */
async function refreshToken(
  supabase: any,
  athleteId: number,
  refreshToken: string
): Promise<string> {
  const response = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Token refresh failed: ${errorText}`)
  }

  const data = await response.json()

  // Update tokens in database
  const expiresAt = new Date(data.expires_at * 1000).toISOString()

  await supabase
    .from('strava_tokens')
    .update({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: expiresAt,
      updated_at: new Date().toISOString()
    })
    .eq('athlete_id', athleteId)

  console.log(`Token refreshed for athlete ${athleteId}`)

  return data.access_token
}

/**
 * Fetch activities from Strava API with pagination
 */
async function fetchActivitiesFromStrava(
  accessToken: string,
  afterTimestamp: string | null,
  beforeTimestamp: string | null,
  maxActivities: number | null
): Promise<StravaActivity[]> {
  const allActivities: StravaActivity[] = []
  let page = 1
  const perPage = 200 // Strava max per page

  while (true) {
    // Build query parameters
    const params = new URLSearchParams({
      page: page.toString(),
      per_page: perPage.toString()
    })

    if (afterTimestamp) {
      const afterEpoch = Math.floor(new Date(afterTimestamp).getTime() / 1000)
      params.append('after', afterEpoch.toString())
    }

    if (beforeTimestamp) {
      const beforeEpoch = Math.floor(new Date(beforeTimestamp).getTime() / 1000)
      params.append('before', beforeEpoch.toString())
    }

    console.log(`Fetching Strava activities: page ${page}`)

    const response = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?${params}`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      }
    )

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Strava API error: ${response.status} - ${errorText}`)
    }

    const activities: StravaActivity[] = await response.json()

    if (activities.length === 0) {
      break // No more activities
    }

    allActivities.push(...activities)

    // Check if we've hit the max activities limit (for beta sync)
    if (maxActivities && allActivities.length >= maxActivities) {
      console.log(`Reached max activities limit: ${maxActivities}`)
      return allActivities.slice(0, maxActivities)
    }

    // If we got fewer than perPage, we've reached the end
    if (activities.length < perPage) {
      break
    }

    page++

    // Rate limiting: wait 1 second between requests
    await new Promise(resolve => setTimeout(resolve, 1000))
  }

  return allActivities
}

/**
 * Store activity in database
 */
async function storeActivity(supabase: any, activity: StravaActivity): Promise<void> {
  const activityData = {
    id: activity.id,
    athlete_id: activity.athlete.id,
    name: activity.name,
    distance: activity.distance,
    moving_time: activity.moving_time,
    elapsed_time: activity.elapsed_time,
    elevation_gain: activity.total_elevation_gain,
    type: activity.type,
    activity_date: activity.start_date,
    start_date_local: activity.start_date_local,
    timezone: activity.timezone,
    start_latlng: activity.start_latlng,
    end_latlng: activity.end_latlng,
    average_speed: activity.average_speed,
    max_speed: activity.max_speed,
    average_cadence: activity.average_cadence,
    average_heart_rate: activity.average_heartrate,
    max_heart_rate: activity.max_heartrate,
    elev_high: activity.elev_high,
    elev_low: activity.elev_low,
    upload_id: activity.upload_id,
    external_id: activity.external_id,
    trainer: activity.trainer || false,
    commute: activity.commute || false,
    manual: activity.manual || false,
    private: activity.private || false,
    flagged: activity.flagged || false,
    workout_type: activity.workout_type,
    average_watts: activity.average_watts,
    max_watts: activity.max_watts,
    kilojoules: activity.kilojoules,
    device_watts: activity.device_watts || false,
    suffer_score: activity.suffer_score,
    map_summary_polyline: activity.map?.summary_polyline,
    updated_at: new Date().toISOString()
  }

  // Upsert activity (insert or update if exists)
  const { error } = await supabase
    .from('activities')
    .upsert(activityData, {
      onConflict: 'id'
    })

  if (error) {
    throw new Error(`Error storing activity: ${error.message}`)
  }
}
