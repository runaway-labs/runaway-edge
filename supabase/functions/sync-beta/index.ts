// Supabase Edge Function: sync-beta
// Create a sync job to fetch recent activities from Strava (max 20 activities)

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const { user_id, sync_type = 'incremental', after, before } = await req.json()

    if (!user_id) {
      return new Response(
        JSON.stringify({
          error: {
            code: 'INVALID_REQUEST',
            message: 'user_id is required'
          }
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    console.log('Creating sync-beta job:', { user_id, sync_type, after, before })

    // Create Supabase client
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Check if user has OAuth tokens (verify athlete is connected)
    const { data: athlete, error: athleteError } = await supabaseAdmin
      .from('athletes')
      .select('id, access_token, refresh_token, strava_connected')
      .eq('id', user_id)
      .single()

    if (athleteError || !athlete) {
      console.warn('Athlete not found:', user_id)
      return new Response(
        JSON.stringify({
          error: {
            code: 'ATHLETE_NOT_FOUND',
            message: `Athlete ${user_id} not found`
          }
        }),
        {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    if (!athlete.strava_connected || !athlete.access_token || !athlete.refresh_token) {
      console.warn('OAuth tokens not found for athlete:', user_id)
      return new Response(
        JSON.stringify({
          error: {
            code: 'TOKEN_NOT_FOUND',
            message: `OAuth tokens not found for user ${user_id}. User needs to complete OAuth flow first.`
          }
        }),
        {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    // Create sync job in database
    const jobData = {
      athlete_id: user_id,
      status: 'pending',
      sync_type: sync_type,
      after_date: after || null,
      before_date: before || null,
      metadata: {
        max_activities: 20, // Beta feature: limit to 20 activities
        created_from: 'ios_app'
      },
      created_at: new Date().toISOString()
    }

    const { data: job, error: jobError } = await supabaseAdmin
      .from('sync_jobs')
      .insert(jobData)
      .select()
      .single()

    if (jobError) {
      console.error('Error creating sync job:', jobError)
      throw new Error(`Failed to create sync job: ${jobError.message}`)
    }

    console.log('Sync-beta job created:', { job_id: job.id, user_id, sync_type })

    // Return job details
    return new Response(
      JSON.stringify({
        job_id: job.id,
        status: job.status,
        sync_type: job.sync_type,
        created_at: job.created_at,
        user_id: user_id,
        max_activities: 20
      }),
      {
        status: 201,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )

  } catch (error) {
    console.error('Error in sync-beta:', error)
    return new Response(
      JSON.stringify({
        error: {
          code: 'INTERNAL_ERROR',
          message: error.message
        }
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )
  }
})
