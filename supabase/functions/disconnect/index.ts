// Supabase Edge Function: disconnect
// Disconnect Strava account - revoke tokens and clear from database

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const { athlete_id, auth_user_id } = await req.json()

    if (!athlete_id && !auth_user_id) {
      return new Response(
        JSON.stringify({
          error: 'Either athlete_id or auth_user_id is required'
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    console.log('Disconnect request:', { athlete_id, auth_user_id })

    // Create Supabase client
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Find athlete by either athlete_id or auth_user_id
    let query = supabaseAdmin.from('athletes').select('*')

    if (athlete_id) {
      query = query.eq('id', athlete_id)
    } else if (auth_user_id) {
      query = query.eq('auth_user_id', auth_user_id)
    }

    const { data: athlete, error: fetchError } = await query.single()

    if (fetchError || !athlete) {
      console.warn('Athlete not found:', { athlete_id, auth_user_id })
      return new Response(
        JSON.stringify({
          error: 'Athlete not found'
        }),
        {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    // Revoke access with Strava (optional - requires access_token)
    if (athlete.access_token) {
      try {
        console.log('Revoking Strava access token for athlete:', athlete.id)

        const revokeResponse = await fetch('https://www.strava.com/oauth/deauthorize', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${athlete.access_token}`
          }
        })

        if (revokeResponse.ok) {
          console.log('Strava access revoked successfully for athlete:', athlete.id)
        } else {
          const errorText = await revokeResponse.text()
          console.warn('Strava deauthorization failed:', errorText)
          // Continue even if revocation fails (token may be expired)
        }
      } catch (deauthError) {
        console.error('Strava deauthorization error:', deauthError)
        // Continue even if revocation fails
      }
    }

    // Update athlete record to mark as disconnected and clear tokens
    const { error: updateError } = await supabaseAdmin
      .from('athletes')
      .update({
        strava_connected: false,
        strava_disconnected_at: new Date().toISOString(),
        access_token: null,
        refresh_token: null,
        token_expires_at: null
      })
      .eq('id', athlete.id)

    if (updateError) {
      console.error('Error updating athlete:', updateError)
      throw new Error(`Failed to update athlete: ${updateError.message}`)
    }

    console.log('Athlete disconnected successfully:', athlete.id)

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Disconnected from Strava successfully',
        athlete_id: athlete.id
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )

  } catch (error) {
    console.error('Disconnect error:', error)
    return new Response(
      JSON.stringify({
        error: 'Failed to disconnect from Strava',
        details: error.message
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )
  }
})
