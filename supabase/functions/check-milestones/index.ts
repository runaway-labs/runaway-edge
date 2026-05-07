import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const RUNNING_SPORT_TYPES = ['Run', 'TrailRun', 'VirtualRun']

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
    ((thursday.getTime() - startOfYear.getTime()) / 86400000 -
      3 + ((startOfYear.getUTCDay() + 6) % 7)) / 7
  ) + 1
  return `${year}-W${String(weekNum).padStart(2, '0')}`
}

function evaluateMilestones(
  activities: Activity[],
  unearnedKeys: Set<string>
): string[] {
  const newlyEarned: string[] = []

  const sorted = activities
    .filter((a): a is Activity & { activity_date: string } => a.activity_date != null)
    .sort((a, b) => a.activity_date.localeCompare(b.activity_date))

  if (sorted.length === 0) return newlyEarned

  if (unearnedKeys.has('first_run')) {
    newlyEarned.push('first_run')
  }

  if (unearnedKeys.has('distance_5k')) {
    if (sorted.some((a) => (a.distance ?? 0) >= 5000)) {
      newlyEarned.push('distance_5k')
    }
  }

  if (unearnedKeys.has('distance_half')) {
    if (sorted.some((a) => (a.distance ?? 0) >= 21097)) {
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
      const diffDays = Math.round((curr.getTime() - prev.getTime()) / 86400000)
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
        if (week > 52) { week = 1; year++ }
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
      const gapDays = (curr.getTime() - prev.getTime()) / 86400000
      if (gapDays >= 14) {
        newlyEarned.push('comeback')
        break
      }
    }
  }

  return newlyEarned
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const { athlete_id, activity_id } = await req.json()

    if (!athlete_id) {
      return new Response(
        JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'athlete_id is required' } }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: unearnedRows, error: milestoneError } = await supabaseAdmin
      .from('runner_identity_milestones')
      .select('milestone_key')
      .eq('athlete_id', athlete_id)
      .eq('earned', false)

    if (milestoneError) {
      console.error('Error fetching milestones:', milestoneError)
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

    const unearnedKeys = new Set(unearnedRows.map((r) => r.milestone_key as string))

    const { data: activities, error: activitiesError } = await supabaseAdmin
      .from('activities')
      .select('distance, activity_date')
      .eq('athlete_id', athlete_id)
      .in('sport_type', RUNNING_SPORT_TYPES)
      .order('activity_date', { ascending: true })

    if (activitiesError) {
      console.error('Error fetching activities:', activitiesError)
      return new Response(
        JSON.stringify({ error: { code: 'DB_ERROR', message: 'Failed to fetch activities' } }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const newlyEarned = evaluateMilestones(activities ?? [], unearnedKeys)

    if (newlyEarned.length > 0) {
      const now = new Date().toISOString()
      for (const key of newlyEarned) {
        const { error: updateError } = await supabaseAdmin
          .from('runner_identity_milestones')
          .update({ earned: true, earned_at: now })
          .eq('athlete_id', athlete_id)
          .eq('milestone_key', key)
          .eq('earned', false)
        if (updateError) {
          console.error(`Error marking milestone ${key}:`, updateError)
        }
      }
    }

    console.log('check-milestones complete:', { athlete_id, activity_id, newly_earned: newlyEarned })

    return new Response(
      JSON.stringify({ newly_earned: newlyEarned }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('Error in check-milestones:', error)
    return new Response(
      JSON.stringify({ error: 'Internal error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
