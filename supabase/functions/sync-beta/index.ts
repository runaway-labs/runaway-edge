// Supabase Edge Function: sync-beta
// Fetches activities from Strava and stores them in the database
// Supports pagination for full sync and date range filtering

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const STRAVA_API_BASE = 'https://www.strava.com/api/v3'
const STRAVA_PAGE_SIZE = 100 // Max allowed by Strava API

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
    const body = await req.json()
    const {
      user_id,
      max_activities = 100,
      sync_all = false,        // If true, paginate through ALL activities
      after,                   // Unix timestamp - only activities after this time
      before                   // Unix timestamp - only activities before this time
    } = body

    if (!user_id) {
      return new Response(
        JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'user_id is required' } }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('Starting sync for user:', user_id, { max_activities, sync_all, after, before })

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

    // Fetch activity types from database for mapping
    const { data: activityTypes, error: typesError } = await supabaseAdmin
      .from('activity_types')
      .select('id, name')

    if (typesError) {
      console.error('Error fetching activity types:', typesError)
    }

    // Build activity type lookup map (Strava type name -> database id)
    const activityTypeMap: Record<string, number> = {}
    if (activityTypes) {
      for (const at of activityTypes) {
        // Map by exact name and lowercase
        activityTypeMap[at.name] = at.id
        activityTypeMap[at.name.toLowerCase()] = at.id
      }
    }
    console.log('Activity type map:', activityTypeMap)

    // Fetch activities from Strava
    const effectiveLimit = sync_all ? Infinity : max_activities
    console.log(`Fetching ${sync_all ? 'all' : `up to ${max_activities}`} activities from Strava...`)
    const activities = await fetchStravaActivities(accessToken, effectiveLimit, after, before)
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
        const activityRecord = mapStravaActivity(activity, user_id, activityTypeMap)

        console.log(`Upserting activity ${activity.id}: ${activity.name}`)
        console.log(`  - athlete_id: ${activityRecord.athlete_id}`)
        console.log(`  - distance: ${activityRecord.distance}`)
        console.log(`  - activity_date: ${activityRecord.activity_date}`)

        const { data: upsertData, error: upsertError, status, statusText } = await supabaseAdmin
          .from('activities')
          .upsert(activityRecord, {
            onConflict: 'id',
            ignoreDuplicates: false
          })
          .select('id, name')

        console.log(`  - Response status: ${status} ${statusText}`)

        if (upsertError) {
          console.error(`  - ERROR upserting activity ${activity.id}:`, JSON.stringify(upsertError))
          errorCount++
        } else {
          console.log(`  - SUCCESS: upserted data:`, JSON.stringify(upsertData))
          syncedCount++
        }

        // Verify the record exists
        const { data: verifyData, error: verifyError } = await supabaseAdmin
          .from('activities')
          .select('id, name')
          .eq('id', activity.id)
          .single()

        if (verifyError) {
          console.log(`  - VERIFY FAILED: Activity ${activity.id} NOT in database:`, JSON.stringify(verifyError))
        } else {
          console.log(`  - VERIFY OK: Activity ${activity.id} exists in database:`, JSON.stringify(verifyData))
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

async function fetchStravaActivities(
  accessToken: string,
  limit: number,
  after?: number,
  before?: number
): Promise<StravaActivity[]> {
  const allActivities: StravaActivity[] = []
  let page = 1
  let hasMore = true

  while (hasMore && allActivities.length < limit) {
    // Build query params
    const params = new URLSearchParams({
      per_page: String(Math.min(STRAVA_PAGE_SIZE, limit - allActivities.length)),
      page: String(page)
    })

    // Add date filters if provided
    if (after) params.append('after', String(after))
    if (before) params.append('before', String(before))

    const url = `${STRAVA_API_BASE}/athlete/activities?${params.toString()}`
    console.log(`Fetching page ${page}...`)

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('Strava API error:', response.status, errorText)
      throw new Error(`Strava API error: ${response.status}`)
    }

    const pageActivities: StravaActivity[] = await response.json()
    allActivities.push(...pageActivities)

    // Check if we should continue paginating
    if (pageActivities.length < STRAVA_PAGE_SIZE) {
      hasMore = false // No more activities
    } else {
      page++
    }

    // Safety limit to prevent infinite loops
    if (page > 100) {
      console.warn('Reached maximum page limit (100)')
      break
    }
  }

  return allActivities
}

function mapStravaActivity(activity: StravaActivity, athleteId: number, activityTypeMap: Record<string, number>): any {
  // Look up activity_type_id from our map
  // Try: sport_type, then type, then lowercase versions
  const activityTypeId =
    activityTypeMap[activity.sport_type] ||
    activityTypeMap[activity.type] ||
    activityTypeMap[activity.sport_type?.toLowerCase()] ||
    activityTypeMap[activity.type?.toLowerCase()] ||
    activityTypeMap['Run'] ||  // Default to Run if nothing matches
    1  // Fallback to 1

  console.log(`  - Mapping type: sport_type="${activity.sport_type}", type="${activity.type}" -> activity_type_id=${activityTypeId}`)

  return {
    id: activity.id,  // Using Strava ID as primary key
    athlete_id: athleteId,
    activity_type_id: activityTypeId,
    name: activity.name,
    activity_date: activity.start_date,
    start_time: activity.start_date_local,
    distance: activity.distance,
    moving_time: activity.moving_time,
    elapsed_time: activity.elapsed_time,
    elevation_gain: activity.total_elevation_gain,
    average_speed: activity.average_speed,
    max_speed: activity.max_speed,
    // Map to existing column names (with underscores)
    average_heart_rate: activity.average_heartrate || null,
    max_heart_rate: activity.max_heartrate || null,
    average_cadence: activity.average_cadence || null,
    // Map to existing column names (full names)
    start_latitude: activity.start_latlng?.[0] || null,
    start_longitude: activity.start_latlng?.[1] || null,
    end_latitude: activity.end_latlng?.[0] || null,
    end_longitude: activity.end_latlng?.[1] || null,
    map_summary_polyline: activity.map?.summary_polyline || null,
    calories: activity.calories || null,
    suffer_score: activity.suffer_score || null,
    workout_type: activity.workout_type || null,
    description: activity.description || null,
    device_name: activity.device_name || null,
    source: 'strava',
    updated_at: new Date().toISOString()
  }
}
