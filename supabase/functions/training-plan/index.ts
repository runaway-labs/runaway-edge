// Supabase Edge Function: training-plan
// GET endpoint to fetch an existing weekly training plan

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  // Only allow GET requests
  if (req.method !== 'GET') {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Method not allowed'
      }),
      {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )
  }

  try {
    // Parse query parameters
    const url = new URL(req.url)
    const athleteId = url.searchParams.get('athlete_id')
    const weekStartDate = url.searchParams.get('week_start_date')

    if (!athleteId || !weekStartDate) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'athlete_id and week_start_date query parameters are required'
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    console.log('Fetch training plan request:', { athleteId, weekStartDate })

    // Create Supabase client
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Fetch the training plan
    const { data: plan, error } = await supabaseAdmin
      .from('weekly_training_plans')
      .select('*')
      .eq('athlete_id', parseInt(athleteId))
      .eq('week_start_date', weekStartDate)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        // No rows returned - plan not found
        return new Response(
          JSON.stringify({
            success: true,
            plan: null
          }),
          {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          }
        )
      }

      console.error('Error fetching plan:', error)
      throw error
    }

    console.log('Plan found:', {
      id: plan.id,
      workouts: plan.workouts?.length || 0
    })

    return new Response(
      JSON.stringify({
        success: true,
        plan: plan
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )

  } catch (error) {
    console.error('Error in training-plan:', error)
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
