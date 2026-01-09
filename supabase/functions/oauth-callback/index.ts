// Supabase Edge Function: oauth-callback
// Handle Strava OAuth callback and store tokens

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const STRAVA_CLIENT_ID = Deno.env.get('STRAVA_CLIENT_ID')
const STRAVA_CLIENT_SECRET = Deno.env.get('STRAVA_CLIENT_SECRET')

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const url = new URL(req.url)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state') // Contains auth_user_id from app
    const error = url.searchParams.get('error')

    // Handle authorization denial
    if (error) {
      console.log('OAuth denied:', error)
      const deniedDeepLink = `runaway://strava-connected?success=false&error=${encodeURIComponent('Authorization denied')}`

      return new Response(null, {
        status: 302,
        headers: {
          ...corsHeaders,
          'Location': deniedDeepLink
        }
      })
    }

    if (!code) {
      return new Response('No authorization code provided', {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'text/plain' }
      })
    }

    console.log('OAuth callback received:', { hasCode: !!code, hasState: !!state })

    // Exchange code for tokens
    const tokenResponse = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code'
      })
    })

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text()
      console.error('Strava token exchange failed:', errorText)
      throw new Error(`Token exchange failed: ${tokenResponse.status}`)
    }

    const tokenData = await tokenResponse.json()
    const { access_token, refresh_token, expires_at, athlete } = tokenData

    console.log('Token exchange successful:', { athlete_id: athlete.id })

    // Create Supabase client
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Store tokens and athlete data in Supabase
    const athleteData = {
      id: athlete.id,
      auth_user_id: state || null, // Link to Supabase auth user
      first_name: athlete.firstname,
      last_name: athlete.lastname,
      email: athlete.email || null,
      sex: athlete.sex || null,
      weight: athlete.weight || 0,
      city: athlete.city || null,
      state: athlete.state || null,
      country: athlete.country || null,
      premium: athlete.premium || false,
      created_at: athlete.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      access_token: access_token,
      refresh_token: refresh_token,
      token_expires_at: new Date(expires_at * 1000).toISOString(),
      strava_connected: true,
      strava_connected_at: new Date().toISOString()
    }

    const { error: upsertError } = await supabaseAdmin
      .from('athletes')
      .upsert(athleteData, { onConflict: 'id' })

    if (upsertError) {
      console.error('Error storing athlete data:', upsertError)
      throw new Error(`Database error: ${upsertError.message}`)
    }

    console.log('Athlete data stored successfully:', athlete.id)

    // Redirect back to app with success using 302 redirect
    const deepLink = `runaway://strava-connected?success=true&athlete_id=${athlete.id}`

    return new Response(null, {
      status: 302,
      headers: {
        ...corsHeaders,
        'Location': deepLink
      }
    })

  } catch (error) {
    console.error('OAuth callback error:', error)
    const errorDeepLink = `runaway://strava-connected?success=false&error=${encodeURIComponent(error.message)}`

    return new Response(null, {
      status: 302,
      headers: {
        ...corsHeaders,
        'Location': errorDeepLink
      }
    })
  }
})
