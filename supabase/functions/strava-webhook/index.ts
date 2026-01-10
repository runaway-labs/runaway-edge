// Supabase Edge Function: strava-webhook
// Handles Strava webhook verification (GET) and activity events (POST)

import { createClient } from 'jsr:@supabase/supabase-js@2'

const STRAVA_API_BASE = 'https://www.strava.com/api/v3'
const STRAVA_CLIENT_ID = Deno.env.get('STRAVA_CLIENT_ID')
const STRAVA_CLIENT_SECRET = Deno.env.get('STRAVA_CLIENT_SECRET')
const STRAVA_VERIFY_TOKEN = Deno.env.get('STRAVA_VERIFY_TOKEN')

// Activity type mapping (Strava sport_type -> activity_type_id)
const ACTIVITY_TYPE_MAP: Record<string, number> = {
  'Run': 103,
  'Ride': 104,
  'Walk': 105,
  'Hike': 106,
  'VirtualRide': 107,
  'VirtualRun': 108,
  'Swim': 109,
  'Workout': 110,
  'WeightTraining': 111,
  'Yoga': 112,
  'Crossfit': 113,
  'Elliptical': 114,
  'Rowing': 115,
  'RockClimbing': 116,
  'AlpineSki': 117,
  'Snowboard': 118,
  'MountainBikeRide': 119,
  'GravelRide': 120,
  'TrailRun': 121,
  'Golf': 123
}

// Activity type display names for notifications
const ACTIVITY_TYPE_NAMES: Record<string, string> = {
  'Run': 'run',
  'Ride': 'ride',
  'Walk': 'walk',
  'Hike': 'hike',
  'VirtualRide': 'virtual ride',
  'VirtualRun': 'virtual run',
  'Swim': 'swim',
  'Workout': 'workout',
  'WeightTraining': 'strength session',
  'Yoga': 'yoga session',
  'Crossfit': 'CrossFit workout',
  'Elliptical': 'elliptical session',
  'Rowing': 'rowing session',
  'RockClimbing': 'climbing session',
  'AlpineSki': 'ski session',
  'Snowboard': 'snowboard session',
  'MountainBikeRide': 'mountain bike ride',
  'GravelRide': 'gravel ride',
  'TrailRun': 'trail run',
  'Golf': 'round of golf'
}

// Congratulatory messages for notifications
const CONGRATULATORY_TITLES = [
  "You crushed it! 💪",
  "Another one in the books! 🔥",
  "Way to show up! 🏆",
  "Beast mode activated! 🦾",
  "Legend status! ⭐",
  "That's what champions do! 🥇",
  "Unstoppable! 🚀",
  "You're on fire! 🔥",
  "Keep that momentum! ⚡",
  "Nailed it! 🎯"
]

function getActivityTypeId(sportType: string): number {
  return ACTIVITY_TYPE_MAP[sportType] || 110 // Default to Workout
}

function formatDistance(meters: number): string {
  const miles = meters * 0.000621371
  return miles.toFixed(1)
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)

  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  return `${minutes} min`
}

// Transform Strava activity to database schema
function transformActivityData(athleteId: number, record: any) {
  const transformed: Record<string, any> = {
    id: record.id,
    athlete_id: athleteId,
    name: record.name,
    description: record.description || '',
    activity_type_id: getActivityTypeId(record.sport_type || record.type),
    activity_date: record.start_date,
    start_time: record.start_date_local,
    elapsed_time: record.elapsed_time,
    moving_time: record.moving_time,
    distance: record.distance,
    elevation_gain: record.total_elevation_gain,
    elevation_high: record.elev_high,
    elevation_low: record.elev_low,
    max_speed: record.max_speed,
    average_speed: record.average_speed,
    max_heart_rate: record.max_heartrate ? Math.round(record.max_heartrate) : null,
    average_heart_rate: record.average_heartrate ? Math.round(record.average_heartrate) : null,
    has_heartrate: record.has_heartrate || false,
    max_watts: record.max_watts ? Math.round(record.max_watts) : null,
    average_watts: record.average_watts ? Math.round(record.average_watts) : null,
    device_watts: record.device_watts || false,
    calories: record.calories || 1,
    commute: record.commute || false,
    flagged: record.flagged || false,
    trainer: record.trainer || false,
    manual: record.manual || false,
    private: record.private || false,
    external_id: record.id?.toString(),
    from_upload: true,
    resource_state: 2,
    map_polyline: record.map?.polyline || null,
    map_summary_polyline: record.map?.summary_polyline || null,
    start_latitude: record.start_latlng?.[0] || null,
    start_longitude: record.start_latlng?.[1] || null,
    end_latitude: record.end_latlng?.[0] || null,
    end_longitude: record.end_latlng?.[1] || null
  }

  // Convert undefined to null
  Object.keys(transformed).forEach(key => {
    if (transformed[key] === undefined) {
      transformed[key] = null
    }
  })

  return transformed
}

// Transform Strava athlete to database schema
function transformAthleteData(athleteId: number, athleteData: any) {
  const transformed: Record<string, any> = {
    id: athleteId,
    first_name: athleteData.firstname,
    last_name: athleteData.lastname,
    email: athleteData.email,
    sex: athleteData.sex,
    weight: athleteData.weight || 0,
    city: athleteData.city,
    state: athleteData.state,
    country: athleteData.country,
    premium: athleteData.premium || false,
    created_at: athleteData.created_at,
    updated_at: new Date().toISOString()
  }

  // Convert undefined to null
  Object.keys(transformed).forEach(key => {
    if (transformed[key] === undefined) {
      transformed[key] = null
    }
  })

  return transformed
}

// Refresh access token for an athlete
async function refreshAccessToken(supabase: any, athleteId: number): Promise<string> {
  // Get stored refresh token
  const { data: athlete, error: fetchError } = await supabase
    .from('athletes')
    .select('refresh_token')
    .eq('id', athleteId)
    .single()

  if (fetchError || !athlete?.refresh_token) {
    throw new Error(`No refresh token found for athlete ${athleteId}`)
  }

  // Exchange refresh token for new access token
  const tokenResponse = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: STRAVA_CLIENT_ID!,
      client_secret: STRAVA_CLIENT_SECRET!,
      refresh_token: athlete.refresh_token,
      grant_type: 'refresh_token'
    })
  })

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text()
    throw new Error(`Strava token refresh failed: ${errorText}`)
  }

  const tokenData = await tokenResponse.json()

  // Update tokens in database
  await supabase
    .from('athletes')
    .update({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      token_expires_at: new Date(tokenData.expires_at * 1000).toISOString()
    })
    .eq('id', athleteId)

  console.log(`Token refreshed for athlete ${athleteId}`)
  return tokenData.access_token
}

// Send push notification via FCM
async function sendActivityNotification(supabase: any, athleteId: number, activityData: any) {
  try {
    // Get athlete's FCM token
    const { data: athlete, error } = await supabase
      .from('athletes')
      .select('fcm_token, first_name')
      .eq('id', athleteId)
      .single()

    if (error || !athlete?.fcm_token) {
      console.log(`No FCM token found for athlete ${athleteId} - skipping notification`)
      return
    }

    const activityType = activityData.sport_type || activityData.type || 'Workout'
    const activityName = ACTIVITY_TYPE_NAMES[activityType] || activityType.toLowerCase()
    const distance = activityData.distance || 0
    const duration = activityData.moving_time || activityData.elapsed_time || 0
    const firstName = athlete.first_name || 'Athlete'

    // Pick random title
    const title = CONGRATULATORY_TITLES[Math.floor(Math.random() * CONGRATULATORY_TITLES.length)]

    // Build body
    let body: string
    if (distance > 0) {
      body = `${firstName} just logged a ${formatDistance(distance)} mile ${activityName} in ${formatDuration(duration)}!`
    } else {
      body = `${firstName} just crushed a ${formatDuration(duration)} ${activityName}!`
    }

    // Send via FCM HTTP v1 API
    const fcmKey = Deno.env.get('FCM_SERVER_KEY')
    if (!fcmKey) {
      console.log('FCM_SERVER_KEY not set - skipping notification')
      return
    }

    const fcmResponse = await fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        'Authorization': `key=${fcmKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        to: athlete.fcm_token,
        notification: {
          title: title,
          body: body,
          sound: 'default'
        },
        data: {
          sync_type: 'new_activity',
          activity_id: activityData.id?.toString() || '',
          activity_type: activityType
        }
      })
    })

    if (fcmResponse.ok) {
      console.log(`Push notification sent for athlete ${athleteId}`)
    } else {
      const errorText = await fcmResponse.text()
      console.error('FCM error:', errorText)
    }

  } catch (error) {
    console.error('Notification error:', error)
    // Don't throw - notification failure shouldn't break webhook
  }
}

// Handle deauthorization event
async function handleDeauthorization(supabase: any, athleteId: number) {
  console.log(`Processing deauthorization for athlete ${athleteId}`)

  const { error } = await supabase
    .from('athletes')
    .update({
      strava_connected: false,
      strava_disconnected_at: new Date().toISOString(),
      access_token: null,
      refresh_token: null,
      token_expires_at: null
    })
    .eq('id', athleteId)

  if (error) {
    console.error('Deauthorization update failed:', error)
    throw error
  }

  console.log(`Athlete ${athleteId} deauthorized successfully`)
}

// Handle new activity event
async function handleActivityCreate(supabase: any, activityId: number, athleteId: number) {
  console.log(`Processing new activity ${activityId} for athlete ${athleteId}`)

  // Check if athlete is still connected
  const { data: athlete, error: checkError } = await supabase
    .from('athletes')
    .select('strava_connected, auth_user_id')
    .eq('id', athleteId)
    .single()

  if (checkError) {
    console.error('Error checking athlete:', checkError)
    throw new Error('Failed to check athlete status')
  }

  if (!athlete || !athlete.strava_connected) {
    console.log(`Ignoring webhook for disconnected athlete ${athleteId}`)
    return 'IGNORED_DISCONNECTED_USER'
  }

  // Get fresh access token
  const accessToken = await refreshAccessToken(supabase, athleteId)

  const headers = {
    'Authorization': `Bearer ${accessToken}`
  }

  // Fetch activity and athlete data from Strava in parallel
  const [activityResponse, athleteResponse] = await Promise.all([
    fetch(`${STRAVA_API_BASE}/activities/${activityId}`, { headers }),
    fetch(`${STRAVA_API_BASE}/athlete`, { headers })
  ])

  if (!activityResponse.ok) {
    const errorText = await activityResponse.text()
    throw new Error(`Failed to fetch activity: ${errorText}`)
  }

  if (!athleteResponse.ok) {
    const errorText = await athleteResponse.text()
    throw new Error(`Failed to fetch athlete: ${errorText}`)
  }

  const activityData = await activityResponse.json()
  const athleteData = await athleteResponse.json()

  console.log(`Fetched activity: ${activityData.name}`)

  // Transform and save data
  const transformedActivity = transformActivityData(athleteId, activityData)
  const transformedAthlete = transformAthleteData(athleteId, athleteData)

  const [activityResult, athleteResult] = await Promise.all([
    supabase.from('activities').upsert(transformedActivity, { onConflict: 'id' }),
    supabase.from('athletes').upsert(transformedAthlete, { onConflict: 'id' })
  ])

  const errors = [activityResult.error, athleteResult.error].filter(Boolean)
  if (errors.length > 0) {
    console.error('Database errors:', errors)
    throw new Error(`Failed to save data: ${errors.map(e => e.message).join(', ')}`)
  }

  console.log(`Activity ${activityId} saved successfully`)

  // Send push notification
  await sendActivityNotification(supabase, athleteId, activityData)

  return 'EVENT_RECEIVED'
}

Deno.serve(async (req) => {
  const url = new URL(req.url)

  // GET request - Webhook verification
  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode')
    const token = url.searchParams.get('hub.verify_token')
    const challenge = url.searchParams.get('hub.challenge')

    console.log('Webhook verification request:', { mode, hasToken: !!token, hasChallenge: !!challenge })

    if (!STRAVA_VERIFY_TOKEN) {
      console.error('STRAVA_VERIFY_TOKEN not configured!')
      return new Response('Server configuration error', { status: 500 })
    }

    if (mode === 'subscribe' && token === STRAVA_VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED')
      return new Response(
        JSON.stringify({ 'hub.challenge': challenge }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    } else {
      console.log('Verification failed - token mismatch')
      return new Response('Forbidden', { status: 403 })
    }
  }

  // POST request - Activity event
  if (req.method === 'POST') {
    try {
      const body = await req.json()
      console.log('Webhook event received:', JSON.stringify(body))

      const supabase = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      )

      // Handle deauthorization
      if (body.aspect_type === 'update' && body.updates?.authorized === 'false') {
        await handleDeauthorization(supabase, body.owner_id)
        return new Response('DEAUTH_PROCESSED', { status: 200 })
      }

      // Handle new activity
      if (body.aspect_type === 'create' && body.object_type === 'activity') {
        const activityId = body.object_id
        const athleteId = body.owner_id

        if (!activityId || !athleteId) {
          console.error('Missing activity_id or athlete_id')
          return new Response('Missing required fields', { status: 400 })
        }

        const result = await handleActivityCreate(supabase, activityId, athleteId)
        return new Response(result, { status: 200 })
      }

      // Handle activity update (optional - just acknowledge)
      if (body.aspect_type === 'update' && body.object_type === 'activity') {
        console.log(`Activity ${body.object_id} updated - could re-fetch if needed`)
        return new Response('UPDATE_ACKNOWLEDGED', { status: 200 })
      }

      // Handle activity delete (optional)
      if (body.aspect_type === 'delete' && body.object_type === 'activity') {
        console.log(`Activity ${body.object_id} deleted`)
        // Optionally delete from database:
        // await supabase.from('activities').delete().eq('id', body.object_id)
        return new Response('DELETE_ACKNOWLEDGED', { status: 200 })
      }

      // Unknown event type - still acknowledge
      console.log('Unknown webhook event type:', body.aspect_type, body.object_type)
      return new Response('EVENT_ACKNOWLEDGED', { status: 200 })

    } catch (error) {
      console.error('Webhook processing error:', error)
      // Return 200 to prevent Strava from retrying
      return new Response('ERROR_LOGGED', { status: 200 })
    }
  }

  return new Response('Method not allowed', { status: 405 })
})
