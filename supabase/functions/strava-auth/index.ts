// Supabase Edge Function: strava-auth
// Initiate Strava OAuth flow — generate authorization URL

import { corsHeaders } from '../_shared/cors.ts'

const STRAVA_CLIENT_ID = Deno.env.get('STRAVA_CLIENT_ID')?.trim()
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')?.trim()

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    let authUserId: string | null = null
    let webRedirectUrl: string | null = null

    if (req.method === 'POST') {
      const body = await req.json()
      authUserId = body.auth_user_id || null
      webRedirectUrl = body.web_redirect_url || null
    } else {
      const url = new URL(req.url)
      authUserId = url.searchParams.get('auth_user_id')
      webRedirectUrl = url.searchParams.get('web_redirect_url')
    }

    if (!STRAVA_CLIENT_ID) {
      throw new Error('STRAVA_CLIENT_ID not configured')
    }

    // Encode auth_user_id + web_redirect_url into state
    const stateData = { auth_user_id: authUserId, web_redirect_url: webRedirectUrl }
    const state = btoa(JSON.stringify(stateData))

    // Callback URL points to the oauth-callback edge function
    const redirectUri = `${SUPABASE_URL}/functions/v1/oauth-callback`

    const authParams = new URLSearchParams({
      client_id: STRAVA_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      approval_prompt: 'auto',
      scope: 'activity:read_all,profile:read_all',
      state: state,
    })

    const authorizationUrl = `https://www.strava.com/oauth/authorize?${authParams.toString()}`

    console.log('Strava auth URL generated for user:', authUserId)

    return new Response(
      JSON.stringify({ success: true, authorization_url: authorizationUrl }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('Strava auth error:', error)
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
