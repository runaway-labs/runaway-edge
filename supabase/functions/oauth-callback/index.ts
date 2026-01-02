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
      return new Response(
        `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Authorization Failed</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, sans-serif;
              display: flex;
              align-items: center;
              justify-content: center;
              height: 100vh;
              margin: 0;
              background: #f5f5f5;
              text-align: center;
              padding: 20px;
            }
            .container { max-width: 400px; }
            h1 { color: #dc2626; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Authorization Failed</h1>
            <p>You did not authorize Runaway to access your Strava data.</p>
            <p><a href="runaway://strava-connected?success=false">Return to app</a></p>
          </div>
        </body>
        </html>
        `,
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'text/html' }
        }
      )
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

    // Redirect back to app with success
    const deepLink = `runaway://strava-connected?success=true&athlete_id=${athlete.id}`

    return new Response(
      `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Strava Connected</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-align: center;
            padding: 20px;
          }
          .container { max-width: 400px; }
          h1 { font-size: 32px; margin-bottom: 20px; }
          p { font-size: 18px; margin-bottom: 30px; opacity: 0.9; }
          .button {
            display: inline-block;
            padding: 15px 40px;
            background: white;
            color: #667eea;
            text-decoration: none;
            border-radius: 25px;
            font-weight: bold;
            font-size: 16px;
          }
          .icon { font-size: 64px; margin-bottom: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="icon">✓</div>
          <h1>Connected to Strava!</h1>
          <p>Your Strava account has been successfully connected.</p>
          <a href="${deepLink}" class="button">Return to Runaway</a>
          <p style="font-size: 14px; margin-top: 30px; opacity: 0.7;">
            If you're not redirected automatically, tap the button above.
          </p>
        </div>
        <script>
          // Automatically attempt to open the app
          window.location.href = '${deepLink}';
          // Fallback: try again after a short delay
          setTimeout(() => {
            window.location.href = '${deepLink}';
          }, 500);
        </script>
      </body>
      </html>
      `,
      {
        headers: { ...corsHeaders, 'Content-Type': 'text/html' }
      }
    )

  } catch (error) {
    console.error('OAuth callback error:', error)
    return new Response(
      `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Connection Error</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: sans-serif; padding: 20px; text-align: center;">
        <h1>Connection Error</h1>
        <p>There was an error connecting your Strava account.</p>
        <p style="color: #dc2626;">${error.message}</p>
        <p><a href="runaway://strava-connected?success=false">Return to app</a></p>
      </body>
      </html>
      `,
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'text/html' }
      }
    )
  }
})
