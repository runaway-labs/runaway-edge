// OAuth Callback Edge Function
// Handle OAuth callback from Strava

import { createSupabaseClient } from '../_shared/supabase.ts'
import { corsHeaders } from '../_shared/cors.ts'

const STRAVA_CLIENT_ID = Deno.env.get('STRAVA_CLIENT_ID')!
const STRAVA_CLIENT_SECRET = Deno.env.get('STRAVA_CLIENT_SECRET')!

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  // Handle OAuth error
  if (error) {
    console.error('OAuth error', { error })

    return new Response(
      `<!DOCTYPE html>
      <html>
      <head>
        <title>Strava Authorization Error</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            max-width: 600px;
            margin: 100px auto;
            padding: 20px;
            text-align: center;
          }
          .error {
            color: #dc3545;
            font-size: 24px;
            margin-bottom: 20px;
          }
        </style>
      </head>
      <body>
        <div class="error">✗ Authorization Failed</div>
        <p>There was an error connecting your Strava account.</p>
        <p><small>${error}</small></p>
      </body>
      </html>`,
      {
        status: 400,
        headers: { 'Content-Type': 'text/html' }
      }
    )
  }

  // Validate required parameters
  if (!code) {
    return new Response(
      `<!DOCTYPE html>
      <html>
      <head>
        <title>Strava Authorization Error</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            max-width: 600px;
            margin: 100px auto;
            padding: 20px;
            text-align: center;
          }
          .error {
            color: #dc3545;
            font-size: 24px;
            margin-bottom: 20px;
          }
        </style>
      </head>
      <body>
        <div class="error">✗ Invalid Request</div>
        <p>Authorization code is required.</p>
      </body>
      </html>`,
      {
        status: 400,
        headers: { 'Content-Type': 'text/html' }
      }
    )
  }

  try {
    console.log('Received OAuth callback', { state })

    // Exchange code for tokens
    const tokenResponse = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code'
      })
    })

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text()
      throw new Error(`Strava token exchange failed: ${errorText}`)
    }

    const tokenData = await tokenResponse.json()

    const {
      access_token,
      refresh_token,
      expires_at,
      athlete
    } = tokenData

    console.log('OAuth tokens obtained', {
      athleteId: athlete.id,
      athleteName: `${athlete.firstname} ${athlete.lastname}`
    })

    const supabase = createSupabaseClient()

    // Store athlete in database
    const { error: athleteError } = await supabase
      .from('athletes')
      .upsert({
        id: athlete.id,
        first_name: athlete.firstname,
        last_name: athlete.lastname,
        profile_picture: athlete.profile,
        city: athlete.city,
        state: athlete.state,
        country: athlete.country,
        sex: athlete.sex,
        weight: athlete.weight,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'id'
      })

    if (athleteError) {
      throw new Error(`Error storing athlete: ${athleteError.message}`)
    }

    // Store OAuth tokens
    const expiresAtDate = new Date(expires_at * 1000).toISOString()

    const { error: tokenError } = await supabase
      .from('strava_tokens')
      .upsert({
        athlete_id: athlete.id,
        access_token,
        refresh_token,
        expires_at: expiresAtDate,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'athlete_id'
      })

    if (tokenError) {
      throw new Error(`Error storing tokens: ${tokenError.message}`)
    }

    console.log('Athlete and tokens stored', { athleteId: athlete.id })

    // Return success page
    return new Response(
      `<!DOCTYPE html>
      <html>
      <head>
        <title>Strava Authorization Success</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            max-width: 600px;
            margin: 100px auto;
            padding: 20px;
            text-align: center;
          }
          .success {
            color: #28a745;
            font-size: 24px;
            margin-bottom: 20px;
          }
          .info {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 5px;
            margin: 20px 0;
          }
          code {
            background: #e9ecef;
            padding: 2px 6px;
            border-radius: 3px;
            font-family: monospace;
          }
        </style>
      </head>
      <body>
        <div class="success">✓ Authorization Successful!</div>
        <p>Your Strava account has been connected.</p>
        <div class="info">
          <p><strong>Athlete:</strong> ${athlete.firstname} ${athlete.lastname}</p>
          <p><strong>Athlete ID:</strong> <code>${athlete.id}</code></p>
        </div>
        <p>You can now use the Runaway app to sync your activities.</p>
        <p><small>You can safely close this window.</small></p>
      </body>
      </html>`,
      {
        headers: { 'Content-Type': 'text/html' }
      }
    )

  } catch (error) {
    console.error('OAuth callback error', {
      error: error.message,
      stack: error.stack
    })

    return new Response(
      `<!DOCTYPE html>
      <html>
      <head>
        <title>Strava Authorization Error</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            max-width: 600px;
            margin: 100px auto;
            padding: 20px;
            text-align: center;
          }
          .error {
            color: #dc3545;
            font-size: 24px;
            margin-bottom: 20px;
          }
        </style>
      </head>
      <body>
        <div class="error">✗ Authorization Failed</div>
        <p>There was an error connecting your Strava account.</p>
        <p><small>${error.message}</small></p>
      </body>
      </html>`,
      {
        status: 500,
        headers: { 'Content-Type': 'text/html' }
      }
    )
  }
})
