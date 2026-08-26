// Supabase Edge Function: feedback-workout
// Adlerian post-workout encouragement using athlete identity profile

import { corsHeaders } from '../_shared/cors.ts'
import {
  parseLegacyAthleteId,
  resolveUserEndpointDependencies,
  userGuardErrorResponse,
  type UserEndpointDependencies,
} from '../_shared/user-endpoint.ts'

interface FeedbackDependencies extends UserEndpointDependencies {}

function deriveEffortLabel(distance: number | null, elapsedTime: number | null): string {
  if (!distance || !elapsedTime || distance === 0 || elapsedTime === 0) {
    return 'Easy'
  }

  const durationMin = elapsedTime / 60
  const paceMinPerKm = (elapsedTime / (distance / 1000)) / 60

  if (durationMin >= 70) return 'Long'
  if (paceMinPerKm < 6.0 && durationMin < 40) return 'Tempo'
  if (paceMinPerKm <= 7.0) return 'Moderate'
  return 'Easy'
}

export function createHandler(overrides: Partial<FeedbackDependencies> = {}) {
  const userDeps = resolveUserEndpointDependencies(overrides)
  const deps: FeedbackDependencies = { ...userDeps }

  return async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const { athlete_id, activity_id } = await req.json()
    const requestedAthleteId = parseLegacyAthleteId(athlete_id)
    const context = await deps.requireUser(req, requestedAthleteId)

    if (requestedAthleteId === null || !activity_id) {
      return new Response(
        JSON.stringify({
          error: {
            code: 'INVALID_REQUEST',
            message: 'athlete_id and activity_id are required'
          }
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    const athleteId = context.athleteId
    const supabaseAdmin = deps.getAdmin()

    // Fetch activity, scoped to both activity ID and athlete ID
    const { data: activity, error: activityError } = await supabaseAdmin
      .from('activities')
      .select('id, distance, elapsed_time, average_heartrate, sport_type, name')
      .eq('id', activity_id)
      .eq('athlete_id', athleteId)
      .single()

    if (activityError || !activity) {
      console.error('FEEDBACK_ACTIVITY_LOOKUP_FAILED', {
        operation: 'activity_lookup',
        activityId: activity_id,
        athleteId,
      })
      return new Response(
        JSON.stringify({
          error: {
            code: 'NOT_FOUND',
            message: 'Activity not found for this athlete'
          }
        }),
        {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    // Fetch Adlerian profile from athlete_ai_profiles
    const { data: aiProfile } = await supabaseAdmin
      .from('athlete_ai_profiles')
      .select('core_memory')
      .eq('athlete_id', athleteId)
      .maybeSingle()

    const adlerianProfile = aiProfile?.core_memory?.adlerian_profile ?? {}
    const runnerIdentity: string = adlerianProfile.runner_identity ?? 'runner'
    const whyIRun: string = adlerianProfile.why_i_run ?? ''

    const effortLabel = deriveEffortLabel(activity.distance, activity.elapsed_time)

    const distanceKm = activity.distance ? (activity.distance / 1000).toFixed(2) : '0'
    const durationMin = activity.elapsed_time ? Math.round(activity.elapsed_time / 60) : 0
    const sportType = activity.sport_type ?? 'Run'
    const whyDisplay = whyIRun || '(not set)'

    const purpose = whyIRun ? " You connected the work to why you run: " + whyIRun + "." : "";
    const feedback = "You got out there for " + distanceKm + " km and " + durationMin + " minutes. That is what showing up as a " + runnerIdentity + " looks like." + purpose;

    // Insert insight row — one per call, duplicates are acceptable
    const { error: insertError } = await supabaseAdmin
      .from('activity_insights')
      .insert({
        activity_id,
        insight_type: 'adlerian_feedback',
        insight_data: {
          content: feedback,
          effort_label: effortLabel,
          athlete_id: athleteId
        },
        generated_by: 'feedback-workout'
      })

    if (insertError) {
      console.error('FEEDBACK_INSIGHT_WRITE_FAILED', { operation: 'insight_write' })
    }

    return new Response(
      JSON.stringify({ feedback, effort_label: effortLabel }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )

  } catch (error) {
    const guardResponse = userGuardErrorResponse(error, corsHeaders)
    if (guardResponse) return guardResponse

    console.error('FEEDBACK_UNEXPECTED_ERROR', { operation: 'feedback_request' })
    return new Response(
      JSON.stringify({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error'
        }
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
