// Supabase Edge Function: sync-beta
// Fetches recent activities from Strava and stores them in the database

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const STRAVA_API_BASE = 'https://www.strava.com/api/v3'

interface StravaActivity {
  id: number
  name: string
  type: string
  sport_type: string
  start_date: string
  start_date_local: string
  timezone: string
  distance: number
  moving_time: number
  elapsed_time: number
  total_elevation_gain: number
  average_speed: number
  max_speed: number
  average_heartrate?: number
  max_heartrate?: number
  average_cadence?: number
  start_latlng?: [number, number]
  end_latlng?: [number, number]
  map?: {
    id: string
    summary_polyline: string
    polyline?: string
  }
  calories?: number
  suffer_score?: number
  workout_type?: number
  description?: string
  device_name?: string
  splits_metric?: any[]
  splits_standard?: any[]
  laps?: any[]
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const { user_id, max_activities = 100 } = await req.json()

    if (!user_id) {
      return new Response(
        JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'user_id is required' } }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('Starting sync-beta for user:', user_id)

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Get athlete with OAuth tokens
    const { data: athlete, error: athleteError } = await supabaseAdmin
      .from('athletes')
      .select('id, access_token, refresh_token, token_expires_at, strava_connected')
      .eq('id', user_id)
      .single()

    if (athleteError || !athlete) {
      console.error('Athlete not found:', user_id)
      return new Response(
        JSON.stringify({ error: { code: 'ATHLETE_NOT_FOUND', message: `Athlete ${user_id} not found` } }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!athlete.strava_connected || !athlete.access_token) {
      return new Response(
        JSON.stringify({ error: { code: 'NOT_CONNECTED', message: 'Strava not connected' } }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Check if token needs refresh
    let accessToken = athlete.access_token
    const tokenExpiresAt = athlete.token_expires_at ? new Date(athlete.token_expires_at) : null

    if (tokenExpiresAt && tokenExpiresAt <= new Date()) {
      console.log('Token expired, refreshing...')
      const refreshed = await refreshStravaToken(athlete.refresh_token, supabaseAdmin, user_id)
      if (!refreshed) {
        return new Response(
          JSON.stringify({ error: { code: 'TOKEN_REFRESH_FAILED', message: 'Failed to refresh Strava token' } }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      accessToken = refreshed
    }

    // Fetch activities from Strava
    console.log(`Fetching up to ${max_activities} activities from Strava...`)
    const activities = await fetchStravaActivities(accessToken, max_activities)
    console.log(`Fetched ${activities.length} activities from Strava`)

    if (activities.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          synced: 0,
          message: 'No new activities found'
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Upsert activities to database
    let syncedCount = 0
    let errorCount = 0

    for (const activity of activities) {
      try {
        const activityRecord = mapStravaActivity(activity, user_id)

        const { error: upsertError } = await supabaseAdmin
          .from('activities')
          .upsert(activityRecord, {
            onConflict: 'strava_id',
            ignoreDuplicates: false
          })

        if (upsertError) {
          console.error(`Error upserting activity ${activity.id}:`, upsertError)
          errorCount++
        } else {
          syncedCount++
        }
      } catch (err) {
        console.error(`Error processing activity ${activity.id}:`, err)
        errorCount++
      }
    }

    console.log(`Sync complete: ${syncedCount} synced, ${errorCount} errors`)

    return new Response(
      JSON.stringify({
        success: true,
        synced: syncedCount,
        errors: errorCount,
        total_fetched: activities.length
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Error in sync-beta:', error)
    return new Response(
      JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: error.message } }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

async function refreshStravaToken(
  refreshToken: string,
  supabase: any,
  athleteId: number
): Promise<string | null> {
  try {
    const response = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: Deno.env.get('STRAVA_CLIENT_ID'),
        client_secret: Deno.env.get('STRAVA_CLIENT_SECRET'),
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      })
    })

    if (!response.ok) {
      console.error('Token refresh failed:', await response.text())
      return null
    }

    const data = await response.json()

    // Update tokens in database
    await supabase
      .from('athletes')
      .update({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        token_expires_at: new Date(data.expires_at * 1000).toISOString()
      })
      .eq('id', athleteId)

    return data.access_token
  } catch (err) {
    console.error('Error refreshing token:', err)
    return null
  }
}

async function fetchStravaActivities(accessToken: string, limit: number): Promise<StravaActivity[]> {
  const response = await fetch(
    `${STRAVA_API_BASE}/athlete/activities?per_page=${limit}`,
    {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    }
  )

  if (!response.ok) {
    const errorText = await response.text()
    console.error('Strava API error:', response.status, errorText)
    throw new Error(`Strava API error: ${response.status}`)
  }

  return await response.json()
}

function mapStravaActivity(activity: StravaActivity, athleteId: number): any {
  return {
    strava_id: activity.id,
    athlete_id: athleteId,
    name: activity.name,
    type: activity.type,
    sport_type: activity.sport_type,
    start_date: activity.start_date,
    start_date_local: activity.start_date_local,
    timezone: activity.timezone,
    distance: activity.distance,
    moving_time: activity.moving_time,
    elapsed_time: activity.elapsed_time,
    total_elevation_gain: activity.total_elevation_gain,
    average_speed: activity.average_speed,
    max_speed: activity.max_speed,
    average_heartrate: activity.average_heartrate || null,
    max_heartrate: activity.max_heartrate || null,
    average_cadence: activity.average_cadence || null,
    start_lat: activity.start_latlng?.[0] || null,
    start_lng: activity.start_latlng?.[1] || null,
    end_lat: activity.end_latlng?.[0] || null,
    end_lng: activity.end_latlng?.[1] || null,
    summary_polyline: activity.map?.summary_polyline || null,
    calories: activity.calories || null,
    suffer_score: activity.suffer_score || null,
    workout_type: activity.workout_type || null,
    description: activity.description || null,
    device_name: activity.device_name || null,
    source: 'strava',
    updated_at: new Date().toISOString()
  }
}
