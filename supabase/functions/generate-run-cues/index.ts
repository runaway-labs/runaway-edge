import { corsHeaders } from '../_shared/cors.ts'
import {
  parseLegacyAthleteId,
  resolveUserEndpointDependencies,
  userGuardErrorResponse,
  type UserEndpointDependencies,
} from '../_shared/user-endpoint.ts'
import { generateRunCues } from './deterministic.ts'

export function createHandler(overrides: Partial<UserEndpointDependencies> = {}) {
  const deps = resolveUserEndpointDependencies(overrides)

  return async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

    try {
      const { athlete_id, runner_identity, why_i_run, core_values, earned_milestone_keys } = await req.json()
      const requestedAthleteId = parseLegacyAthleteId(athlete_id)
      await deps.requireUser(req, requestedAthleteId)

      if (!runner_identity || !why_i_run) {
        return new Response(
          JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'runner_identity and why_i_run are required' } }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }

      const cues = generateRunCues({
        runnerIdentity: runner_identity,
        whyIRun: why_i_run,
        coreValues: Array.isArray(core_values) ? core_values : [],
        earnedMilestoneKeys: Array.isArray(earned_milestone_keys) ? earned_milestone_keys : [],
      })
      return new Response(JSON.stringify({ cues }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    } catch (error) {
      const guardResponse = userGuardErrorResponse(error, corsHeaders)
      if (guardResponse) return guardResponse
      console.error('RUN_CUES_UNEXPECTED_ERROR', { operation: 'run_cues' })
      return new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
  }
}

if (import.meta.main) Deno.serve(createHandler())
