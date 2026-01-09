// Supabase Edge Function: garmin-webhook
// Receives Garmin activity notifications (Push and Ping services)

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const GARMIN_CONSUMER_KEY = Deno.env.get('GARMIN_CONSUMER_KEY')
const GARMIN_CONSUMER_SECRET = Deno.env.get('GARMIN_CONSUMER_SECRET')

// OAuth 1.0a helper functions for authenticated API calls
function generateNonce(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

function generateTimestamp(): string {
  return Math.floor(Date.now() / 1000).toString()
}

function percentEncode(str: string): string {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
}

function createSignatureBaseString(
  method: string,
  url: string,
  params: Record<string, string>
): string {
  const sortedParams = Object.keys(params)
    .sort()
    .map(key => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&')

  return `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(sortedParams)}`
}

async function createSignature(
  baseString: string,
  consumerSecret: string,
  tokenSecret: string = ''
): Promise<string> {
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`
  const encoder = new TextEncoder()

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingKey),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  )

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(baseString))
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
}

function createAuthorizationHeader(
  params: Record<string, string>,
  signature: string
): string {
  const allParams = { ...params, oauth_signature: signature }
  const headerParams = Object.keys(allParams)
    .sort()
    .map(key => `${percentEncode(key)}="${percentEncode(allParams[key])}"`)
    .join(', ')
  return `OAuth ${headerParams}`
}

// Fetch data from Garmin using OAuth 1.0a (for Ping service callbacks)
async function fetchFromGarmin(
  url: string,
  accessToken: string,
  tokenSecret: string
): Promise<Response> {
  const nonce = generateNonce()
  const timestamp = generateTimestamp()

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: GARMIN_CONSUMER_KEY!,
    oauth_token: accessToken,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_nonce: nonce,
    oauth_version: '1.0'
  }

  const baseString = createSignatureBaseString('GET', url, oauthParams)
  const signature = await createSignature(baseString, GARMIN_CONSUMER_SECRET!, tokenSecret)
  const authHeader = createAuthorizationHeader(oauthParams, signature)

  return fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': authHeader
    }
  })
}

// Merge Garmin-specific data into an existing activity (e.g., from Strava)
async function mergeGarminData(
  supabase: ReturnType<typeof createClient>,
  existingActivityId: number,
  garminData: GarminActivity
): Promise<void> {
  // Build update object with Garmin-specific fields
  // Only update fields that have values and might be better from Garmin
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString()
  }

  // Heart rate data (Garmin watches typically have better HR accuracy)
  if (garminData.averageHeartRateInBeatsPerMinute) {
    updates.average_heart_rate = garminData.averageHeartRateInBeatsPerMinute
  }
  if (garminData.maxHeartRateInBeatsPerMinute) {
    updates.max_heart_rate = garminData.maxHeartRateInBeatsPerMinute
  }

  // Cadence (from watch accelerometer)
  if (garminData.averageRunCadenceInStepsPerMinute) {
    updates.average_cadence = garminData.averageRunCadenceInStepsPerMinute
  }

  // Device info
  if (garminData.deviceName) {
    updates.device_name = garminData.deviceName
  }

  // Store raw Garmin data for reference
  updates.raw_data = garminData

  // Only update if we have something to add
  if (Object.keys(updates).length > 1) { // More than just updated_at
    const { error } = await supabase
      .from('activities')
      .update(updates)
      .eq('id', existingActivityId)

    if (error) {
      console.error('Error merging Garmin data:', error)
      throw error
    }

    console.log(`Merged Garmin data into activity ${existingActivityId}:`, Object.keys(updates).filter(k => k !== 'updated_at' && k !== 'raw_data'))
  }
}

// Check for duplicate activity from another source (e.g., Strava)
async function checkForDuplicate(
  supabase: ReturnType<typeof createClient>,
  athleteId: number | null,
  startTime: Date,
  distance: number | undefined,
  duration: number
): Promise<{ isDuplicate: boolean; existingId?: number; existingSource?: string }> {
  if (!athleteId) return { isDuplicate: false }

  // Time window: ±2 minutes
  const timeWindowMs = 2 * 60 * 1000
  const startMin = new Date(startTime.getTime() - timeWindowMs).toISOString()
  const startMax = new Date(startTime.getTime() + timeWindowMs).toISOString()

  // Query for activities in the same time window
  const { data: existing, error } = await supabase
    .from('activities')
    .select('id, source, distance, elapsed_time, activity_date')
    .eq('athlete_id', athleteId)
    .gte('activity_date', startMin)
    .lte('activity_date', startMax)
    .neq('source', 'garmin') // Don't match against other Garmin activities

  if (error || !existing || existing.length === 0) {
    return { isDuplicate: false }
  }

  // Check if any match by distance (within 100m) and duration (within 60s)
  for (const activity of existing) {
    const distanceMatch = !distance || !activity.distance ||
      Math.abs((activity.distance as number) - distance) < 100

    const durationMatch = !activity.elapsed_time ||
      Math.abs((activity.elapsed_time as number) - duration) < 60

    if (distanceMatch && durationMatch) {
      console.log(`Found duplicate: Garmin activity matches ${activity.source} activity ${activity.id}`)
      return {
        isDuplicate: true,
        existingId: activity.id as number,
        existingSource: activity.source as string
      }
    }
  }

  return { isDuplicate: false }
}

// Process and store activity data
async function processActivity(
  supabase: ReturnType<typeof createClient>,
  activityData: GarminActivity,
  authUserId: string,
  athleteId: number | null
): Promise<void> {
  const activityDate = new Date(activityData.startTimeInSeconds * 1000)

  // Check for duplicates from other sources (e.g., Strava)
  const { isDuplicate, existingId, existingSource } = await checkForDuplicate(
    supabase,
    athleteId,
    activityDate,
    activityData.distanceInMeters,
    activityData.durationInSeconds
  )

  if (isDuplicate && existingId) {
    console.log(`Merging Garmin data into ${existingSource} activity ${existingId}`)

    // Merge Garmin-specific data into the existing activity
    await mergeGarminData(supabase, existingId, activityData)
    return
  }

  // Generate a unique ID for Garmin activities
  // Use negative numbers to avoid collision with Strava IDs (which are positive)
  const garminActivityId = activityData.activityId || Math.floor(Date.now() / 1000)
  const uniqueId = -Math.abs(garminActivityId)

  // Convert Garmin activity to match existing activities schema
  const activity = {
    id: uniqueId,
    athlete_id: athleteId,
    auth_user_id: authUserId,
    source: 'garmin',
    external_id: activityData.activityId?.toString() || activityData.summaryId,

    // Basic info
    name: activityData.activityName || `${mapGarminActivityType(activityData.activityType)} Activity`,
    type: mapGarminActivityType(activityData.activityType),

    // Timing
    activity_date: activityDate.toISOString(),
    start_date_local: activityDate.toISOString(),
    elapsed_time: activityData.durationInSeconds,
    moving_time: activityData.movingDurationInSeconds || activityData.durationInSeconds,

    // Distance and speed (in meters)
    distance: activityData.distanceInMeters,
    average_speed: activityData.averageSpeedInMetersPerSecond,
    max_speed: activityData.maxSpeedInMetersPerSecond,

    // Heart rate
    average_heart_rate: activityData.averageHeartRateInBeatsPerMinute,
    max_heart_rate: activityData.maxHeartRateInBeatsPerMinute,

    // Elevation
    elevation_gain: activityData.totalElevationGainInMeters,

    // Cadence
    average_cadence: activityData.averageRunCadenceInStepsPerMinute,

    // Additional data
    device_name: activityData.deviceName,
    manual: activityData.manual || false,
    raw_data: activityData,

    // Timestamps
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }

  // Use upsert with the unique ID
  const { error } = await supabase
    .from('activities')
    .upsert(activity, {
      onConflict: 'id',
      ignoreDuplicates: false
    })

  if (error) {
    console.error('Error storing activity:', error)
    throw error
  }

  console.log(`Stored Garmin activity: ${activity.name} (ID: ${activity.id}, external: ${activity.external_id})`)
}

// Map Garmin activity types to our types
function mapGarminActivityType(garminType: string): string {
  const typeMap: Record<string, string> = {
    'RUNNING': 'Run',
    'INDOOR_RUNNING': 'Run',
    'TREADMILL_RUNNING': 'Run',
    'TRAIL_RUNNING': 'Trail Run',
    'TRACK_RUNNING': 'Run',
    'WALKING': 'Walk',
    'HIKING': 'Hike',
    'CYCLING': 'Ride',
    'INDOOR_CYCLING': 'Ride',
    'MOUNTAIN_BIKING': 'Ride',
    'SWIMMING': 'Swim',
    'POOL_SWIMMING': 'Swim',
    'OPEN_WATER_SWIMMING': 'Swim',
    'STRENGTH_TRAINING': 'Workout',
    'CARDIO_TRAINING': 'Workout',
    'YOGA': 'Yoga',
    'OTHER': 'Workout'
  }
  return typeMap[garminType] || 'Workout'
}

// Types for Garmin activity data
interface GarminActivity {
  activityId?: number
  summaryId?: string
  activityName?: string
  activityType: string
  startTimeInSeconds: number
  startTimeOffsetInSeconds?: number
  durationInSeconds: number
  movingDurationInSeconds?: number
  distanceInMeters?: number
  averageSpeedInMetersPerSecond?: number
  maxSpeedInMetersPerSecond?: number
  averageHeartRateInBeatsPerMinute?: number
  maxHeartRateInBeatsPerMinute?: number
  averageRunCadenceInStepsPerMinute?: number
  totalElevationGainInMeters?: number
  totalElevationLossInMeters?: number
  activeKilocalories?: number
  totalKilocalories?: number
  deviceName?: string
  manual?: boolean
}

interface GarminPushPayload {
  activities?: GarminActivity[]
  activityDetails?: unknown[]
  activityFiles?: unknown[]
  moveIQActivities?: GarminActivity[]
  manuallyUpdatedActivities?: GarminActivity[]
  deregistrations?: { userId: string }[]
}

interface GarminPingPayload {
  activities?: { callbackURL: string; userId: string }[]
  activityDetails?: { callbackURL: string; userId: string }[]
  activityFiles?: { callbackURL: string; userId: string }[]
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  // Only accept POST requests
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const body = await req.json()
    console.log('Garmin webhook received:', JSON.stringify(body, null, 2))

    // Handle deregistrations (user disconnected Garmin)
    if (body.deregistrations && body.deregistrations.length > 0) {
      for (const dereg of body.deregistrations) {
        console.log(`User deregistered: ${dereg.userId}`)
        // Could update athlete record to mark as disconnected
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Determine if this is Push or Ping format
    const isPush = body.activities && Array.isArray(body.activities) &&
                   body.activities.length > 0 && body.activities[0].activityType
    const isPing = body.activities && Array.isArray(body.activities) &&
                   body.activities.length > 0 && body.activities[0].callbackURL

    if (isPush) {
      // PUSH SERVICE: Activity data sent directly
      console.log('Processing Push notification...')

      const activities: GarminActivity[] = [
        ...(body.activities || []),
        ...(body.moveIQActivities || []),
        ...(body.manuallyUpdatedActivities || [])
      ]

      for (const activity of activities) {
        // Find the user by their Garmin connection
        // Note: For now, we look up athletes with Garmin connected
        // TODO: Use Garmin user ID from activity payload when available
        const { data: athlete, error: lookupError } = await supabaseAdmin
          .from('athletes')
          .select('id, auth_user_id')
          .eq('garmin_connected', true)
          .single()

        if (lookupError || !athlete) {
          console.error('Could not find athlete for activity:', lookupError)
          continue
        }

        await processActivity(supabaseAdmin, activity, athlete.auth_user_id, athlete.id)
      }

    } else if (isPing) {
      // PING SERVICE: Callback URLs provided, need to fetch data
      console.log('Processing Ping notification...')

      for (const item of body.activities || []) {
        const { callbackURL, userId } = item

        // Find athlete with Garmin credentials
        const { data: athlete, error: lookupError } = await supabaseAdmin
          .from('athletes')
          .select('id, auth_user_id, garmin_access_token, garmin_token_secret')
          .eq('garmin_connected', true)
          .single()

        if (lookupError || !athlete || !athlete.garmin_access_token) {
          console.error('Could not find athlete credentials for ping:', lookupError)
          continue
        }

        // Fetch data from callback URL using OAuth
        const response = await fetchFromGarmin(
          callbackURL,
          athlete.garmin_access_token,
          athlete.garmin_token_secret
        )

        if (!response.ok) {
          console.error('Failed to fetch from callback URL:', await response.text())
          continue
        }

        const activityData = await response.json()

        if (Array.isArray(activityData)) {
          for (const activity of activityData) {
            await processActivity(supabaseAdmin, activity, athlete.auth_user_id, athlete.id)
          }
        } else {
          await processActivity(supabaseAdmin, activityData, athlete.auth_user_id, athlete.id)
        }
      }
    } else {
      console.log('Unknown webhook format, ignoring')
    }

    // Must return 200 within 30 seconds per Garmin docs
    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error('Garmin webhook error:', error)
    // Still return 200 to prevent Garmin from retrying
    return new Response(JSON.stringify({ success: true, warning: 'Error processing' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
