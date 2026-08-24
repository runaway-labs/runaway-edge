// Supabase Edge Function: training-plan
// GET endpoint to fetch an existing weekly training plan

import { corsHeaders } from '../_shared/cors.ts'
import {
  parseLegacyAthleteId,
  resolveUserEndpointDependencies,
  userGuardErrorResponse,
  type UserEndpointDependencies,
} from '../_shared/user-endpoint.ts'

export function createHandler(overrides: Partial<UserEndpointDependencies> = {}) {
  const deps = resolveUserEndpointDependencies(overrides)

  return async (req: Request) => {
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
    const athleteIdParam = url.searchParams.get('athlete_id')
    const weekStartDate = url.searchParams.get('week_start_date')
    const requestedAthleteId = parseLegacyAthleteId(athleteIdParam)
    const context = await deps.requireUser(req, requestedAthleteId)

    if (requestedAthleteId === null || !weekStartDate) {
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

    console.log('Fetch training plan request:', { athleteId: context.athleteId, weekStartDate })

    const supabaseAdmin = deps.getAdmin()

    // Fetch the training plan
    const { data: plan, error } = await supabaseAdmin
      .from('weekly_training_plans')
      .select('*')
      .eq('athlete_id', context.athleteId)
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
    const guardResponse = userGuardErrorResponse(error, corsHeaders)
    if (guardResponse) return guardResponse

    console.error('Error in training-plan:', error)
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Internal server error'
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )
  }
  }
}

if (import.meta.main) {
  Deno.serve(createHandler())
}
