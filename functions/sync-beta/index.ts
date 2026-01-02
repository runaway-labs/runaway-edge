// Sync Beta Edge Function
// Create sync job for iOS app (limited to 20 activities)

import { createSupabaseClient } from '../_shared/supabase.ts'
import { corsHeaders } from '../_shared/cors.ts'

interface SyncBetaRequest {
  user_id: number
  sync_type?: 'full' | 'incremental'
  after?: number
  before?: number
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabase = createSupabaseClient()

    // Parse request body
    const {
      user_id,
      sync_type = 'incremental',
      after,
      before
    }: SyncBetaRequest = await req.json()

    // Validate input
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

    console.log('Creating sync-beta job (max 20 activities)', {
      user_id,
      sync_type,
      after,
      before
    })

    // Check if user has OAuth tokens
    const { data: tokens, error: tokenError } = await supabase
      .from('strava_tokens')
      .select('*')
      .eq('athlete_id', user_id)
      .single()

    if (tokenError || !tokens) {
      console.warn('OAuth tokens not found for user', { user_id })

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

    // Create sync job with max_activities metadata
    const { data: job, error: jobError } = await supabase
      .from('sync_jobs')
      .insert({
        athlete_id: user_id,
        sync_type,
        after_timestamp: after ? new Date(after * 1000).toISOString() : null,
        before_timestamp: before ? new Date(before * 1000).toISOString() : null,
        status: 'pending',
        metadata: {
          max_activities: 20 // Beta feature: limit to 20 activities
        }
      })
      .select()
      .single()

    if (jobError) {
      throw new Error(`Error creating sync job: ${jobError.message}`)
    }

    console.log('Sync-beta job created', {
      jobId: job.id,
      user_id,
      sync_type,
      max_activities: 20
    })

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
    console.error('Error in sync-beta endpoint', {
      error: error.message,
      stack: error.stack
    })

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
