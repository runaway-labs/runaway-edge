// Supabase Edge Function: backfill-splits
// Fetches splits_metric from Strava for all activities that don't have splits yet.
// Safe to call multiple times (idempotent — skips activities already populated).

import { corsHeaders } from '../_shared/cors.ts'
import {
  parseLegacyAthleteId,
  resolveUserEndpointDependencies,
  userGuardErrorResponse,
  type UserEndpointDependencies,
} from '../_shared/user-endpoint.ts'

const STRAVA_API_BASE = 'https://www.strava.com/api/v3'
const MAX_BACKFILL_ACTIVITIES = 100
const STRAVA_TOKEN_REFRESH_FAILED = 'STRAVA_TOKEN_REFRESH_FAILED'

interface BackfillDependencies extends UserEndpointDependencies {
  fetch: typeof fetch
  getEnv: (name: string) => string | undefined
}

async function refreshAccessToken(
  supabase: any,
  athleteId: number,
  fetchImpl: typeof fetch,
  getEnv: (name: string) => string | undefined,
): Promise<string> {
  const stravaClientId = getEnv('STRAVA_CLIENT_ID')
  const stravaClientSecret = getEnv('STRAVA_CLIENT_SECRET')

  if (!stravaClientId || !stravaClientSecret) {
    throw new Error('STRAVA_CREDENTIALS_MISSING')
  }

  const { data: athlete, error } = await supabase
    .from('athletes')
    .select('refresh_token')
    .eq('id', athleteId)
    .single()

  if (error || !athlete?.refresh_token) {
    throw new Error('STRAVA_REFRESH_TOKEN_MISSING')
  }

  const res = await fetchImpl('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: stravaClientId,
      client_secret: stravaClientSecret,
      refresh_token: athlete.refresh_token,
      grant_type: 'refresh_token'
    })
  })

  if (!res.ok) {
    console.error('Strava token refresh failed', {
      code: STRAVA_TOKEN_REFRESH_FAILED,
      status: res.status,
    })
    throw new Error(`${STRAVA_TOKEN_REFRESH_FAILED}: Unable to refresh Strava access token`)
  }

  const token = await res.json()
  await supabase.from('athletes').update({
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_expires_at: new Date(token.expires_at * 1000).toISOString()
  }).eq('id', athleteId)

  return token.access_token
}

export function createHandler(overrides: Partial<BackfillDependencies> = {}) {
  const userDeps = resolveUserEndpointDependencies(overrides)
  const deps: BackfillDependencies = {
    ...userDeps,
    fetch: overrides.fetch ?? globalThis.fetch,
    getEnv: overrides.getEnv ?? ((name) => Deno.env.get(name)),
  }

  return async (req: Request) => {
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    if (req.method !== 'POST') {
      return new Response('POST only', { status: 405, headers: corsHeaders })
    }

    try {
      const body = await req.json().catch(() => ({}))
      const requestedAthleteId = parseLegacyAthleteId(body.athlete_id)
      const context = await deps.requireUser(req, requestedAthleteId)
      const limit: number = body.limit ?? 50

      if (requestedAthleteId === null) {
        return new Response(
          JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'athlete_id required' } }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BACKFILL_ACTIVITIES) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'INVALID_REQUEST',
              message: `limit must be an integer between 1 and ${MAX_BACKFILL_ACTIVITIES}`
            }
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const athleteId = context.athleteId
      const supabase = deps.getAdmin()

  // Fetch activities that are missing splits, most recent first
  const { data: activities, error: fetchError } = await supabase
    .from('activities')
    .select('id')
    .eq('athlete_id', athleteId)
    .is('splits', null)
    .order('start_time', { ascending: false })
    .limit(limit)

  if (fetchError) {
    console.error('BACKFILL_ACTIVITY_LOOKUP_FAILED', { operation: 'activity_lookup' })
    return new Response(
      JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  if (!activities || activities.length === 0) {
    return new Response(JSON.stringify({ message: 'All activities already have splits', updated: 0 }), { status: 200 })
  }

  console.log(`Backfilling splits for ${activities.length} activities (athlete ${athleteId})`)

  const accessToken = await refreshAccessToken(
    supabase,
    athleteId,
    deps.fetch,
    deps.getEnv,
  )
  const headers = { 'Authorization': `Bearer ${accessToken}` }

  let updated = 0
  let failed = 0

  for (const activity of activities) {
    try {
      // Strava rate limit: 100 req/15min, 1000/day — add small delay between calls
      await new Promise(r => setTimeout(r, 200))

      const res = await deps.fetch(`${STRAVA_API_BASE}/activities/${activity.id}`, { headers })

      if (res.status === 429) {
        console.warn('STRAVA_ACTIVITY_RATE_LIMITED', {
          operation: 'activity_fetch',
          status: res.status,
        })
        break
      }

      if (!res.ok) {
        console.error('STRAVA_ACTIVITY_FETCH_FAILED', {
          operation: 'activity_fetch',
          activityId: activity.id,
          status: res.status,
        })
        failed++
        continue
      }

      const data = await res.json()
      // Store empty array for activities with no splits so they aren't re-queried
      const splits = data.splits_metric ?? []

      const { error: updateError } = await supabase
        .from('activities')
        .update({ splits })
        .eq('id', activity.id)
        .eq('athlete_id', athleteId)

      if (updateError) {
        console.error('BACKFILL_ACTIVITY_UPDATE_FAILED', {
          operation: 'activity_update',
          activityId: activity.id,
        })
        failed++
      } else {
        updated++
      }
    } catch {
      console.error('BACKFILL_ACTIVITY_PROCESSING_FAILED', {
        operation: 'activity_processing',
        activityId: activity.id,
      })
      failed++
    }
  }

  return new Response(
    JSON.stringify({ updated, failed, remaining: activities.length - updated - failed }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
    } catch (error) {
      const guardResponse = userGuardErrorResponse(error, corsHeaders)
      if (guardResponse) return guardResponse

      console.error('BACKFILL_UNEXPECTED_ERROR', { operation: 'backfill_request' })
      return new Response(
        JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }
}

if (import.meta.main) {
  Deno.serve(createHandler())
}
