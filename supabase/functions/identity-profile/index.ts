// Supabase Edge Function: identity-profile
// Adlerian Psychology Phase 1 — builds runner identity from activity data + values

import { corsHeaders } from '../_shared/cors.ts'
import {
  parseLegacyAthleteId,
  resolveUserEndpointDependencies,
  userGuardErrorResponse,
  type UserEndpointDependencies,
} from '../_shared/user-endpoint.ts'

const VALID_IDENTITY_LABELS = [
  'Morning Runner',
  'Trail Explorer',
  'Consistent Builder',
  'Weekend Warrior',
  'Comeback Runner',
] as const

type RunnerIdentity = typeof VALID_IDENTITY_LABELS[number]

const DEFAULT_IDENTITY: RunnerIdentity = 'Consistent Builder'

const MILESTONE_SEEDS = [
  { key: 'first_run', label: 'First Step', description: 'Completed your first run with Runaway' },
  { key: 'streak_7', label: 'Seven-Day Streak', description: 'Ran 7 days in a row' },
  { key: 'distance_5k', label: '5K Club', description: 'Completed a run of at least 5K' },
  { key: 'distance_half', label: 'Half Marathon Club', description: 'Completed a half marathon or longer' },
  { key: 'consistency_4weeks', label: 'Consistent Builder', description: 'Ran at least once a week for 4 consecutive weeks' },
  { key: 'comeback', label: 'Comeback Runner', description: 'Returned to running after a gap of 2+ weeks' },
]

function isValidIdentityLabel(value: string): value is RunnerIdentity {
  return VALID_IDENTITY_LABELS.includes(value as RunnerIdentity)
}

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

  return { totalRuns, totalDistanceKm, weekendRuns, avgElevation, hasComeback }
}

const DEFAULT_IDENTITY_SUMMARY = 'You show up consistently and keep building your running practice.'

async function callClaudeIdentity(
  stats: ReturnType<typeof computeActivityStats>,
  why_i_run: string,
  core_values: string[],
  anthropicApiKey: string,
): Promise<{ runner_identity: RunnerIdentity; identity_summary: string }> {
  const prompt = `You are categorizing a runner's identity. Based on the data below, pick EXACTLY ONE identity label from this list:
- Morning Runner (runs frequently, often early)
- Trail Explorer (high average elevation gain, varied terrain)
- Consistent Builder (steady weekly cadence, no long gaps)
- Weekend Warrior (most runs cluster on Saturday/Sunday)
- Comeback Runner (returned after a 2+ week gap recently)

Runner data:
- Total runs last 90 days: ${stats.totalRuns}
- Total distance: ${stats.totalDistanceKm} km
- Weekend runs: ${stats.weekendRuns} of ${stats.totalRuns}
- Average elevation gain per run: ${stats.avgElevation}m
- Has comeback pattern: ${stats.hasComeback}
- Why they run: "${why_i_run}"
- Core values: ${core_values.join(', ')}

Default to "Consistent Builder" if data is insufficient.

Respond with ONLY valid JSON, no markdown:
{
  "runner_identity": "<one of the five labels>",
  "identity_summary": "<one sentence, second person, under 20 words, never mention pace/goals/PRs>"
}`

  // Identity classification falls back to the default identity on any failure.
  // Saving the profile must succeed even if Anthropic is unreachable or rate-limited —
  // the runner can re-classify later by editing the mindset.
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('Anthropic identity API error:', response.status, errorText)
      return { runner_identity: DEFAULT_IDENTITY, identity_summary: DEFAULT_IDENTITY_SUMMARY }
    }

    const data = await response.json()
    const rawText = data.content[0].text.trim()

    let parsed: { runner_identity: string; identity_summary: string }
    try {
      parsed = JSON.parse(rawText)
    } catch {
      console.error('Failed to parse Claude identity response:', rawText)
      return { runner_identity: DEFAULT_IDENTITY, identity_summary: DEFAULT_IDENTITY_SUMMARY }
    }

    const runner_identity = isValidIdentityLabel(parsed.runner_identity)
      ? parsed.runner_identity
      : DEFAULT_IDENTITY

    return { runner_identity, identity_summary: parsed.identity_summary ?? DEFAULT_IDENTITY_SUMMARY }
  } catch (err) {
    console.error('Identity classification call failed (non-fatal):', err)
    return { runner_identity: DEFAULT_IDENTITY, identity_summary: DEFAULT_IDENTITY_SUMMARY }
  }
}

async function callClaudeGoalFraming(
  activeGoal: { id: number; title: string; goal_type: string },
  runner_identity: RunnerIdentity,
  anthropicApiKey: string,
): Promise<string> {
  const prompt = `Write one sentence (under 20 words) framing this running goal in identity terms for a "${runner_identity}". Never mention numbers or pace. Second person.

Goal: ${activeGoal.title} (type: ${activeGoal.goal_type})
Runner identity: ${runner_identity}

Respond with ONLY the sentence, no JSON, no quotes.`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 80,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    console.error('Anthropic goal-framing API error:', errorText)
    throw new Error(`Anthropic API error: ${response.status}`)
  }

  const data = await response.json()
  return data.content[0].text.trim()
}

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
    console.log('identity-profile request:', { athlete_id: athleteId, mode })

    const supabaseAdmin = deps.getAdmin()
    const anthropicApiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''

    // Fetch activities from last 90 days
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 90)

    const { data: activities, error: activitiesError } = await supabaseAdmin
      .from('activities')
      .select('distance, elapsed_time, activity_date, elevation_gain, sport_type')
      .eq('athlete_id', athleteId)
      .gte('activity_date', cutoff.toISOString())

    if (activitiesError) {
      console.error('Error fetching activities:', activitiesError)
    }

    // Fetch existing core_memory from athlete_ai_profiles
    const { data: existingProfile, error: profileError } = await supabaseAdmin
      .from('athlete_ai_profiles')
      .select('core_memory')
      .eq('athlete_id', athleteId)
      .maybeSingle()

    if (profileError) {
      console.error('Error fetching athlete_ai_profiles:', profileError)
    }

    const activityList = activities ?? []
    const stats = computeActivityStats(activityList)

    // Call Claude for identity classification
    const { runner_identity, identity_summary } = await callClaudeIdentity(
      stats,
      why_i_run,
      core_values,
      anthropicApiKey,
    )

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
      console.error('Error upserting athlete_ai_profiles:', upsertProfileError)
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
      console.error('Error seeding milestones:', milestoneError)
    }

    // Check for active goal and generate goal_framing if present
    const { data: activeGoal, error: goalError } = await supabaseAdmin
      .from('running_goals')
      .select('id, title, goal_type')
      .eq('athlete_id', athleteId)
      .eq('is_active', true)
      .maybeSingle()

    if (goalError) {
      console.error('Error fetching running_goals:', goalError)
    }

    if (activeGoal) {
      // Goal-framing is best-effort — a Claude failure here must not abort
      // the identity save. The identity write above has already succeeded.
      try {
        const goal_framing = await callClaudeGoalFraming(activeGoal, runner_identity, anthropicApiKey)

        const { error: goalUpdateError } = await supabaseAdmin
          .from('running_goals')
          .update({ goal_framing })
          .eq('id', activeGoal.id)

        if (goalUpdateError) {
          console.error('Error updating goal_framing:', goalUpdateError)
        }
      } catch (err) {
        console.error('Goal-framing call failed (non-fatal):', err)
      }
    }

    console.log('identity-profile complete:', { athlete_id: athleteId, runner_identity })

    return new Response(
      JSON.stringify({ runner_identity, identity_summary, why_i_run, core_values }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    const guardResponse = userGuardErrorResponse(error, corsHeaders)
    if (guardResponse) return guardResponse

    console.error('Error in identity-profile function:', error)
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
