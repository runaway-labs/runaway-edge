// Supabase Edge Function: identity-profile
// Adlerian Psychology Phase 1 — builds runner identity from activity data + values

import { corsHeaders } from '../_shared/cors.ts'
import {
  parseLegacyAthleteId,
  resolveUserEndpointDependencies,
  userGuardErrorResponse,
  type UserEndpointDependencies,
} from '../_shared/user-endpoint.ts'
import { classifyRunnerIdentity, frameGoal, identitySummary } from './deterministic.ts'

const MILESTONE_SEEDS = [
  { key: 'first_run', label: 'First Step', description: 'Completed your first run with Runaway' },
  { key: 'streak_7', label: 'Seven-Day Streak', description: 'Ran 7 days in a row' },
  { key: 'distance_5k', label: '5K Club', description: 'Completed a run of at least 5K' },
  { key: 'distance_half', label: 'Half Marathon Club', description: 'Completed a half marathon or longer' },
  { key: 'consistency_4weeks', label: 'Consistent Builder', description: 'Ran at least once a week for 4 consecutive weeks' },
  { key: 'comeback', label: 'Comeback Runner', description: 'Returned to running after a gap of 2+ weeks' },
]

function computeActivityStats(activities: Array<{
  distance: number | null
  elapsed_time: number | null
  activity_date: string | null
  elevation_gain: number | null
  sport_type: string | null
}>) {
  const totalRuns = activities.length

  const totalDistanceM = activities.reduce((sum, a) => sum + (a.distance ?? 0), 0)
  const totalDistanceKm = (totalDistanceM / 1000).toFixed(1)

  const weekendRuns = activities.filter((a) => {
    if (!a.activity_date) return false
    const day = new Date(a.activity_date).getDay()
    return day === 0 || day === 6
  }).length

  const morningRuns = activities.filter((a) => {
    if (!a.activity_date) return false
    return new Date(a.activity_date).getHours() < 10
  }).length

  const totalElevation = activities.reduce((sum, a) => sum + (a.elevation_gain ?? 0), 0)
  const avgElevation = totalRuns > 0 ? (totalElevation / totalRuns).toFixed(0) : '0'

  let hasComeback = false
  if (activities.length >= 2) {
    const sorted = [...activities]
      .filter((a) => a.activity_date != null)
      .sort((a, b) => new Date(a.activity_date!).getTime() - new Date(b.activity_date!).getTime())

    for (let i = 1; i < sorted.length; i++) {
      const prev = new Date(sorted[i - 1].activity_date!).getTime()
      const curr = new Date(sorted[i].activity_date!).getTime()
      const gapDays = (curr - prev) / (1000 * 60 * 60 * 24)
      if (gapDays >= 14) {
        hasComeback = true
        break
      }
    }
  }

  return { totalRuns, totalDistanceKm, weekendRuns, morningRuns, avgElevation, hasComeback }
}

const DEFAULT_IDENTITY_SUMMARY = 'You show up consistently and keep building your running practice.'

export function createHandler(overrides: Partial<UserEndpointDependencies> = {}) {
  const deps = resolveUserEndpointDependencies(overrides)

  return async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const { athlete_id, why_i_run, core_values, mode } = await req.json()
    const requestedAthleteId = parseLegacyAthleteId(athlete_id)
    const context = await deps.requireUser(req, requestedAthleteId)

    if (requestedAthleteId === null || !why_i_run || !core_values || !Array.isArray(core_values) || core_values.length === 0) {
      return new Response(
        JSON.stringify({ error: 'athlete_id, why_i_run, and core_values are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const athleteId = context.athleteId
    console.log('Identity profile request', { athleteId })

    const supabaseAdmin = deps.getAdmin()

    // Fetch activities from last 90 days
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 90)

    const { data: activities, error: activitiesError } = await supabaseAdmin
      .from('activities')
      .select('distance, elapsed_time, activity_date, elevation_gain, sport_type')
      .eq('athlete_id', athleteId)
      .gte('activity_date', cutoff.toISOString())

    if (activitiesError) {
      console.error('IDENTITY_ACTIVITY_LOOKUP_FAILED', { operation: 'activity_lookup' })
    }

    // Fetch existing core_memory from athlete_ai_profiles
    const { data: existingProfile, error: profileError } = await supabaseAdmin
      .from('athlete_ai_profiles')
      .select('core_memory')
      .eq('athlete_id', athleteId)
      .maybeSingle()

    if (profileError) {
      console.error('IDENTITY_PROFILE_LOOKUP_FAILED', { operation: 'identity_profile_lookup' })
    }

    const activityList = activities ?? []
    const stats = computeActivityStats(activityList)

    const runner_identity = classifyRunnerIdentity({
      totalRuns: stats.totalRuns,
      weekendRuns: stats.weekendRuns,
      morningRuns: stats.morningRuns,
      avgElevation: Number(stats.avgElevation),
      hasComeback: stats.hasComeback,
    })
    const identity_summary = identitySummary(runner_identity)

    // Merge adlerian_profile into existing core_memory
    const existingCoreMemory = existingProfile?.core_memory ?? {}
    const adlerianProfile = {
      runner_identity,
      identity_summary,
      why_i_run,
      core_values,
      updated_at: new Date().toISOString(),
    }

    const mergedCoreMemory = {
      ...existingCoreMemory,
      adlerian_profile: adlerianProfile,
    }

    // Upsert athlete_ai_profiles with merged core_memory
    const { error: upsertProfileError } = await supabaseAdmin
      .from('athlete_ai_profiles')
      .upsert(
        { athlete_id: athleteId, core_memory: mergedCoreMemory },
        { onConflict: 'athlete_id' }
      )

    if (upsertProfileError) {
      console.error('IDENTITY_PROFILE_WRITE_FAILED', { operation: 'identity_profile_write' })
      throw new Error('Failed to save identity profile')
    }

    // Seed milestone rows
    const milestoneRows = MILESTONE_SEEDS.map((m) => ({
      athlete_id: athleteId,
      milestone_key: m.key,
      label: m.label,
      description: m.description,
      earned: false,
    }))

    const { error: milestoneError } = await supabaseAdmin
      .from('runner_identity_milestones')
      .upsert(milestoneRows, { onConflict: 'athlete_id,milestone_key', ignoreDuplicates: true })

    if (milestoneError) {
      console.error('IDENTITY_MILESTONE_SEED_FAILED', { operation: 'milestone_seed' })
    }

    // Check for active goal and generate goal_framing if present
    const { data: activeGoal, error: goalError } = await supabaseAdmin
      .from('running_goals')
      .select('id, title, goal_type')
      .eq('athlete_id', athleteId)
      .eq('is_active', true)
      .maybeSingle()

    if (goalError) {
      console.error('IDENTITY_GOAL_LOOKUP_FAILED', { operation: 'goal_lookup' })
    }

    if (activeGoal) {
      const goal_framing = frameGoal(runner_identity, activeGoal.title)
      const { error: goalUpdateError } = await supabaseAdmin
        .from('running_goals')
        .update({ goal_framing })
        .eq('id', activeGoal.id)

      if (goalUpdateError) {
        console.error('IDENTITY_GOAL_UPDATE_FAILED', { operation: 'goal_update' })
      }
    }

    console.log('Identity profile complete', { athleteId })

    return new Response(
      JSON.stringify({ runner_identity, identity_summary, why_i_run, core_values }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    const guardResponse = userGuardErrorResponse(error, corsHeaders)
    if (guardResponse) return guardResponse

    console.error('IDENTITY_UNEXPECTED_ERROR', { operation: 'identity_request' })
    return new Response(
      JSON.stringify({ error: 'Internal error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
  }
}

if (import.meta.main) {
  Deno.serve(createHandler())
}
