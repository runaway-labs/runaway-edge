import { corsHeaders } from '../_shared/cors.ts'
import {
  parseLegacyAthleteId,
  resolveUserEndpointDependencies,
  userGuardErrorResponse,
  type UserEndpointDependencies,
} from '../_shared/user-endpoint.ts'

const RUNNING_SPORT_TYPES = ['Run', 'TrailRun', 'VirtualRun']

const DISTANCE_5K_METERS = 5000
const DISTANCE_HALF_MARATHON_METERS = 21097
const MS_PER_DAY = 86_400_000

type Activity = {
  distance: number | null
  activity_date: string | null
}

function toCalendarDay(dateStr: string): string {
  return dateStr.slice(0, 10)
}

function isoWeekKey(dateStr: string): string {
  const d = new Date(dateStr)
  const thursday = new Date(d)
  thursday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3)
  const year = thursday.getUTCFullYear()
  const startOfYear = new Date(Date.UTC(year, 0, 4))
  const weekNum = Math.round(
    ((thursday.getTime() - startOfYear.getTime()) / MS_PER_DAY -
      3 + ((startOfYear.getUTCDay() + 6) % 7)) / 7
  ) + 1
  return `${year}-W${String(weekNum).padStart(2, '0')}`
}

function isoWeeksInYear(y: number): number {
  const jan1 = new Date(Date.UTC(y, 0, 1)).getUTCDay()
  const dec31 = new Date(Date.UTC(y, 11, 31)).getUTCDay()
  return (jan1 === 4 || dec31 === 4) ? 53 : 52
}

function evaluateMilestones(
  activities: Activity[],
  unearnedKeys: Set<string>
): string[] {
  const newlyEarned: string[] = []

  const sorted = activities
    .filter((a): a is Activity & { activity_date: string } => a.activity_date != null)
    .sort((a, b) => a.activity_date.localeCompare(b.activity_date))

  // first_run uses the raw activities count (before date filtering)
  if (unearnedKeys.has('first_run') && activities.length >= 1) {
    newlyEarned.push('first_run')
  }

  if (sorted.length === 0) return newlyEarned

  if (unearnedKeys.has('distance_5k')) {
    if (sorted.some((a) => (a.distance ?? 0) >= DISTANCE_5K_METERS)) {
      newlyEarned.push('distance_5k')
    }
  }

  if (unearnedKeys.has('distance_half')) {
    if (sorted.some((a) => (a.distance ?? 0) >= DISTANCE_HALF_MARATHON_METERS)) {
      newlyEarned.push('distance_half')
    }
  }

  if (unearnedKeys.has('streak_7')) {
    const daySet = new Set(sorted.map((a) => toCalendarDay(a.activity_date)))
    const days = Array.from(daySet).sort()
    let streak = 1
    for (let i = 1; i < days.length; i++) {
      const prev = new Date(days[i - 1])
      const curr = new Date(days[i])
      const diffDays = Math.round((curr.getTime() - prev.getTime()) / MS_PER_DAY)
      if (diffDays === 1) {
        streak++
        if (streak >= 7) { newlyEarned.push('streak_7'); break }
      } else {
        streak = 1
      }
    }
  }

  if (unearnedKeys.has('consistency_4weeks')) {
    const weekSet = new Set(sorted.map((a) => isoWeekKey(a.activity_date)))
    const weeks = Array.from(weekSet).sort()
    const weekMap: Record<string, boolean> = {}
    for (const w of weeks) weekMap[w] = true

    outer: for (let i = 0; i < weeks.length; i++) {
      const [yearStr, wStr] = weeks[i].split('-W')
      let year = parseInt(yearStr)
      let week = parseInt(wStr)
      let consecutive = 1
      for (let j = 1; j < 4; j++) {
        week++
        if (week > isoWeeksInYear(year)) { week = 1; year++ }
        const key = `${year}-W${String(week).padStart(2, '0')}`
        if (!weekMap[key]) continue outer
        consecutive++
      }
      if (consecutive >= 4) { newlyEarned.push('consistency_4weeks'); break }
    }
  }

  if (unearnedKeys.has('comeback') && sorted.length >= 2) {
    for (let i = 1; i < sorted.length; i++) {
      const prev = new Date(sorted[i - 1].activity_date)
      const curr = new Date(sorted[i].activity_date)
      const gapDays = (curr.getTime() - prev.getTime()) / MS_PER_DAY
      if (gapDays >= 14) {
        newlyEarned.push('comeback')
        break
      }
    }
  }

  return newlyEarned
}

export function createHandler(overrides: Partial<UserEndpointDependencies> = {}) {
  const deps = resolveUserEndpointDependencies(overrides)

  return async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // activity_id is included in the request for log traceability; detection uses full history
    const { athlete_id, activity_id } = await req.json()
    const requestedAthleteId = parseLegacyAthleteId(athlete_id)
    const context = await deps.requireUser(req, requestedAthleteId)

    if (requestedAthleteId === null) {
      return new Response(
        JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'athlete_id is required' } }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const athleteId = context.athleteId
    const supabaseAdmin = deps.getAdmin()

    if (activity_id != null) {
      const { data: activity, error: activityError } = await supabaseAdmin
        .from('activities')
        .select('id')
        .eq('id', activity_id)
        .eq('athlete_id', athleteId)
        .maybeSingle()

      if (activityError || !activity) {
        return new Response(
          JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Activity not found for this athlete' } }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    }

    const { data: unearnedRows, error: milestoneError } = await supabaseAdmin
      .from('runner_identity_milestones')
      .select('milestone_key')
      .eq('athlete_id', athleteId)
      .eq('earned', false)

    if (milestoneError) {
      console.error('MILESTONE_LOOKUP_FAILED', { operation: 'milestone_lookup' })
      return new Response(
        JSON.stringify({ error: { code: 'DB_ERROR', message: 'Failed to fetch milestones' } }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!unearnedRows || unearnedRows.length === 0) {
      return new Response(
        JSON.stringify({ newly_earned: [] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const unearnedKeys = new Set<string>(
      unearnedRows.map((r: { milestone_key: string }) => r.milestone_key),
    )

    const { data: activities, error: activitiesError } = await supabaseAdmin
      .from('activities')
      .select('distance, activity_date')
      .eq('athlete_id', athleteId)
      .in('sport_type', RUNNING_SPORT_TYPES)
      .order('activity_date', { ascending: true })

    if (activitiesError) {
      console.error('MILESTONE_ACTIVITY_LOOKUP_FAILED', { operation: 'activity_lookup' })
      return new Response(
        JSON.stringify({ error: { code: 'DB_ERROR', message: 'Failed to fetch activities' } }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const newlyEarned = evaluateMilestones(activities ?? [], unearnedKeys)

    const confirmedEarned: string[] = []
    if (newlyEarned.length > 0) {
      const now = new Date().toISOString()
      for (const key of newlyEarned) {
        const { error: updateError } = await supabaseAdmin
          .from('runner_identity_milestones')
          .update({ earned: true, earned_at: now })
          .eq('athlete_id', athleteId)
          .eq('milestone_key', key)
          .eq('earned', false)
        if (updateError) {
          console.error('MILESTONE_UPDATE_FAILED', {
            operation: 'milestone_update',
            milestoneKey: key,
          })
        } else {
          confirmedEarned.push(key)
        }
      }
    }

    console.log('check-milestones complete:', { athlete_id: athleteId, activity_id, newly_earned: confirmedEarned })

    return new Response(
      JSON.stringify({ newly_earned: confirmedEarned }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    const guardResponse = userGuardErrorResponse(error, corsHeaders)
    if (guardResponse) return guardResponse

    console.error('MILESTONE_UNEXPECTED_ERROR', { operation: 'milestone_request' })
    return new Response(
      JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
  }
}

if (import.meta.main) {
  Deno.serve(createHandler())
}
