// Supabase Edge Function: garmin-callback
// Handle Garmin OAuth 2.0 PKCE callback and store tokens

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const GARMIN_CLIENT_ID = Deno.env.get('GARMIN_CONSUMER_KEY')?.trim()
const GARMIN_CLIENT_SECRET = Deno.env.get('GARMIN_CONSUMER_SECRET')?.trim()
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')?.trim()

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const url = new URL(req.url)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const error = url.searchParams.get('error')

    console.log('Garmin callback received:', {
      hasCode: !!code,
      hasState: !!state,
      error: error
    })

    // Handle error from Garmin
    if (error) {
      console.error('Garmin OAuth error:', error)
      return createErrorResponse(`Authorization failed: ${error}`)
    }

    if (!code || !state) {
      return createErrorResponse('Missing authorization code or state')
    }

    // Create Supabase client
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Retrieve the code verifier and auth_user_id using state
    const { data: tokenData, error: tokenError } = await supabaseAdmin
      .from('garmin_oauth_tokens')
      .select('token_secret, auth_user_id')
      .eq('oauth_token', state)
      .single()

    if (tokenError || !tokenData) {
      console.error('Could not find stored state:', tokenError)
      return createErrorResponse('OAuth session expired. Please try connecting again.')
    }

    const codeVerifier = tokenData.token_secret
    const authUserId = tokenData.auth_user_id

    // Exchange authorization code for access token
    const redirectUri = `${SUPABASE_URL}/functions/v1/garmin-callback`

    // Per Garmin PKCE spec: client_id and client_secret go in form data, NOT Basic Auth
    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: GARMIN_CLIENT_ID!,
      client_secret: GARMIN_CLIENT_SECRET!,
      code: code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri
    })

    console.log('Exchanging code for access token...')

    // Garmin's OAuth 2.0 token endpoint (from official PKCE spec)
    const tokenResponse = await fetch('https://diauth.garmin.com/di-oauth2-service/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: tokenParams.toString()
    })

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text()
      console.error('Token exchange failed:', errorText)
      return createErrorResponse(`Token exchange failed: ${tokenResponse.status}`)
    }

    const tokenJson = await tokenResponse.json()
    const accessToken = tokenJson.access_token
    const refreshToken = tokenJson.refresh_token
    const expiresIn = tokenJson.expires_in

    if (!accessToken) {
      return createErrorResponse('Invalid token response from Garmin')
    }

    console.log('Access token obtained successfully')

    // Clean up the temporary PKCE data
    await supabaseAdmin
      .from('garmin_oauth_tokens')
      .delete()
      .eq('oauth_token', state)

    // Store the access token in the athletes table
    if (authUserId) {
      const { error: updateError } = await supabaseAdmin
        .from('athletes')
        .update({
          garmin_access_token: accessToken,
          garmin_refresh_token: refreshToken,
          garmin_token_expires_at: expiresIn
            ? new Date(Date.now() + expiresIn * 1000).toISOString()
            : null,
          garmin_connected: true,
          garmin_connected_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('auth_user_id', authUserId)

      if (updateError) {
        console.error('Error storing Garmin credentials:', updateError)
        // Try fallback to garmin_connections table
        const { error: insertError } = await supabaseAdmin
          .from('garmin_connections')
          .upsert({
            auth_user_id: authUserId,
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_at: expiresIn
              ? new Date(Date.now() + expiresIn * 1000).toISOString()
              : null,
            connected_at: new Date().toISOString()
          }, { onConflict: 'auth_user_id' })

        if (insertError) {
          console.error('Error storing in garmin_connections:', insertError)
        }
      }
    }

    console.log('Garmin credentials stored successfully')

    // Redirect back to app with success using 302 redirect
    // ASWebAuthenticationSession needs a direct redirect, not an HTML page
    const deepLink = `runaway://garmin-connected?success=true`

    return new Response(null, {
      status: 302,
      headers: {
        ...corsHeaders,
        'Location': deepLink
      }
    })

  } catch (error) {
    console.error('Garmin OAuth callback error:', error)
    return createErrorResponse(error.message || 'Unknown error')
  }
})

function createErrorResponse(message: string): Response {
  // Use 302 redirect for ASWebAuthenticationSession compatibility
  const deepLink = `runaway://garmin-connected?success=false&error=${encodeURIComponent(message)}`

  return new Response(null, {
    status: 302,
    headers: {
      ...corsHeaders,
      'Location': deepLink
    }
  })
}
