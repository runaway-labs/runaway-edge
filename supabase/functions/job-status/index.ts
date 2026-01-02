// Supabase Edge Function: job-status
// Get sync job status by job ID

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // Extract job ID from URL path
    // Expected format: /job-status/{jobId} or /{jobId}
    const url = new URL(req.url)
    const pathParts = url.pathname.split('/').filter(Boolean)
    const jobId = pathParts[pathParts.length - 1]

    if (!jobId || jobId === 'job-status') {
      return new Response(
        JSON.stringify({
          error: {
            code: 'INVALID_REQUEST',
            message: 'Job ID is required in the URL path'
          }
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    console.log('Fetching job status:', { jobId })

    // Create Supabase client
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Get job from database
    const { data: job, error: jobError } = await supabaseAdmin
      .from('sync_jobs')
      .select('*')
      .eq('id', jobId)
      .single()

    if (jobError || !job) {
      console.warn('Job not found:', jobId)
      return new Response(
        JSON.stringify({
          error: {
            code: 'JOB_NOT_FOUND',
            message: `Job ${jobId} not found`
          }
        }),
        {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    // Calculate progress percentage
    const total = job.total_activities || 0
    const processed = job.processed_activities || 0
    const failed = job.failed_activities || 0
    let progressPercent = 0

    if (total > 0) {
      progressPercent = Math.round((processed / total) * 100)
    } else if (job.status === 'running') {
      progressPercent = 10 // Show some progress if running but totals not set
    } else if (job.status === 'completed') {
      progressPercent = 100
    }

    // Return job status
    const response = {
      id: job.id,
      job_id: job.id,
      user_id: job.athlete_id,
      status: job.status,
      sync_type: job.sync_type,
      created_at: job.created_at,
      started_at: job.started_at,
      completed_at: job.completed_at,
      progress: progressPercent,
      activities_processed: processed,
      error: job.error_message,
      after_date: job.after_date,
      before_date: job.before_date,
      metadata: job.metadata
    }

    console.log('Job status:', { jobId, status: job.status, progress: progressPercent })

    return new Response(
      JSON.stringify(response),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )

  } catch (error) {
    console.error('Error fetching job status:', error)
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
