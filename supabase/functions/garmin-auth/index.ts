// Supabase Edge Function: garmin-auth
// Initiate Garmin OAuth 2.0 PKCE flow

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

// Garmin uses "Consumer Key" terminology but it's the same as Client ID for OAuth 2.0
const GARMIN_CLIENT_ID = Deno.env.get('GARMIN_CONSUMER_KEY')?.trim()
const GARMIN_CLIENT_SECRET = Deno.env.get('GARMIN_CONSUMER_SECRET')?.trim()
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')?.trim()

// OAuth 2.0 PKCE helper functions
function generateCodeVerifier(): string {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return base64UrlEncode(array)
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return base64UrlEncode(new Uint8Array(digest))
}

function base64UrlEncode(buffer: Uint8Array): string {
  let binary = ''
  for (const byte of buffer) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function generateState(): string {
  const array = new Uint8Array(16)
  crypto.getRandomValues(array)
  return base64UrlEncode(array)
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // Get the auth_user_id from the request (to link the connection later)
    let authUserId: string | null = null

    if (req.method === 'POST') {
      const body = await req.json()
      authUserId = body.auth_user_id || null
    } else {
      const url = new URL(req.url)
      authUserId = url.searchParams.get('auth_user_id')
    }

    console.log('Initiating Garmin OAuth 2.0 PKCE for user:', authUserId)

    if (!GARMIN_CLIENT_ID || !GARMIN_CLIENT_SECRET) {
      throw new Error('Garmin API credentials not configured')
    }

    // Generate PKCE values
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = await generateCodeChallenge(codeVerifier)
    const state = generateState()

    // Callback URL
    const redirectUri = `${SUPABASE_URL}/functions/v1/garmin-callback`

    // Store PKCE verifier and state for callback validation
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { error: insertError } = await supabaseAdmin
      .from('garmin_oauth_tokens')
      .upsert({
        oauth_token: state, // Use state as the key
        token_secret: codeVerifier, // Store code_verifier in token_secret field
        auth_user_id: authUserId,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10 min expiry
      }, { onConflict: 'oauth_token' })

    if (insertError) {
      console.error('Error storing PKCE data:', insertError)
    }

    // Build the authorization URL for OAuth 2.0 PKCE
    // Use the correct Garmin authorization endpoint
    const authParams = new URLSearchParams({
      client_id: GARMIN_CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri,
      state: state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    })

    // Garmin's OAuth 2.0 authorization endpoint (from official PKCE spec)
    const authorizationUrl = `https://connect.garmin.com/oauth2Confirm?${authParams.toString()}`

    console.log('Authorization URL generated:', authorizationUrl)

    return new Response(
      JSON.stringify({
        success: true,
        authorization_url: authorizationUrl,
        oauth_token: state // Return state for reference
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )

  } catch (error) {
    console.error('Garmin auth initiation error:', error)
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )
  }
})
