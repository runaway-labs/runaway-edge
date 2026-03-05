// micro-wins edge function
// Pure computation — no LLM. Detects real achievements from activity history.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface Activity {
  id: number
  activity_date: string
  distance: number
  moving_time: number
  average_speed: number
  average_heartrate?: number
  pr_count?: number
  activity_types: { name: string } | null
}

interface MicroWin {
  text: string
  stat: string
  type: 'pr' | 'streak' | 'volume' | 'consistency' | 'pace' | 'fitness'
}

const RUN_TYPES = new Set(['Run', 'Running', 'Trail Run', 'Trail Running', 'Treadmill', 'Treadmill Running', 'Virtual Run', 'Race'])
const MS_PER_DAY = 86400000
const KM_TO_MI = 0.621371

function weekStart(date: Date): string {
  const d = new Date(date)
  d.setDate(d.getDate() - d.getDay())
  return d.toISOString().split('T')[0]
}

function computeWins(activities: Activity[]): MicroWin[] {
  const wins: MicroWin[] = []
  const now = new Date()

  const runs = activities
    .filter(a => !a.activity_types?.name || RUN_TYPES.has(a.activity_types.name))
    .sort((a, b) => new Date(b.activity_date).getTime() - new Date(a.activity_date).getTime())

  if (runs.length === 0) return wins

  // ── PRs in last 14 days ─────────────────────────────────────
  const recentPRs = runs.filter(a => {
    const daysAgo = (now.getTime() - new Date(a.activity_date).getTime()) / MS_PER_DAY
    return daysAgo <= 14 && (a.pr_count ?? 0) > 0
  })
  for (const r of recentPRs.slice(0, 2)) {
    const mi = (r.distance / 1609.34).toFixed(1)
    wins.push({
      text: `${r.pr_count} segment PR${(r.pr_count ?? 0) > 1 ? 's' : ''} on your ${mi}mi run.`,
      stat: `${r.pr_count} PR${(r.pr_count ?? 0) > 1 ? 's' : ''}`,
      type: 'pr'
    })
  }

  // ── Current streak ─────────────────────────────────────────
  let streak = 0
  const activityDays = new Set(runs.map(a => a.activity_date.split('T')[0]))
  for (let i = 0; i < 60; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().split('T')[0]
    if (activityDays.has(key)) streak++
    else if (i > 0) break
  }
  if (streak >= 3) {
    wins.push({
      text: `${streak}-day training streak. You've shown up every day this week.`,
      stat: `${streak} days`,
      type: 'streak'
    })
  }

  // ── Best week volume in last 8 weeks ───────────────────────
  const weekMap: Record<string, number> = {}
  for (const r of runs) {
    const daysAgo = (now.getTime() - new Date(r.activity_date).getTime()) / MS_PER_DAY
    if (daysAgo > 56) continue
    const wk = weekStart(new Date(r.activity_date))
    weekMap[wk] = (weekMap[wk] ?? 0) + r.distance
  }
  const weekEntries = Object.entries(weekMap).sort((a, b) => b[0].localeCompare(a[0]))
  const currentWeekKey = weekStart(now)
  if (weekEntries.length >= 2) {
    const currentWeekMi = ((weekMap[currentWeekKey] ?? 0) / 1609.34)
    const prevWeeks = weekEntries.filter(([k]) => k !== currentWeekKey).map(([, v]) => v)
    const maxPrev = Math.max(...prevWeeks)
    if (currentWeekMi > 0 && (weekMap[currentWeekKey] ?? 0) >= maxPrev && prevWeeks.length >= 2) {
      wins.push({
        text: `Best volume week in ${prevWeeks.length} weeks — ${currentWeekMi.toFixed(1)}mi and counting.`,
        stat: `${currentWeekMi.toFixed(1)}mi`,
        type: 'volume'
      })
    }
  }

  // ── Runs this week vs last week ────────────────────────────
  const thisWeekRuns = runs.filter(a => {
    const daysAgo = (now.getTime() - new Date(a.activity_date).getTime()) / MS_PER_DAY
    return daysAgo <= 7
  })
  const lastWeekRuns = runs.filter(a => {
    const daysAgo = (now.getTime() - new Date(a.activity_date).getTime()) / MS_PER_DAY
    return daysAgo > 7 && daysAgo <= 14
  })
  if (thisWeekRuns.length >= 4 && thisWeekRuns.length >= lastWeekRuns.length) {
    wins.push({
      text: `${thisWeekRuns.length} runs this week. Consistent.`,
      stat: `${thisWeekRuns.length}× this week`,
      type: 'consistency'
    })
  }

  // ── Pace improvement over last 4 weeks ────────────────────
  const last14 = runs.filter(a => {
    const daysAgo = (now.getTime() - new Date(a.activity_date).getTime()) / MS_PER_DAY
    return daysAgo <= 14 && a.average_speed > 0 && a.distance > 3000
  })
  const prev14 = runs.filter(a => {
    const daysAgo = (now.getTime() - new Date(a.activity_date).getTime()) / MS_PER_DAY
    return daysAgo > 14 && daysAgo <= 28 && a.average_speed > 0 && a.distance > 3000
  })
  if (last14.length >= 2 && prev14.length >= 2) {
    const avgPaceRecent = last14.reduce((s, a) => s + 1609.34 / a.average_speed / 60, 0) / last14.length
    const avgPacePrev = prev14.reduce((s, a) => s + 1609.34 / a.average_speed / 60, 0) / prev14.length
    const deltaSec = Math.round((avgPacePrev - avgPaceRecent) * 60)
    if (deltaSec >= 5) {
      wins.push({
        text: `Average pace improved ${deltaSec}s/mi over the last 2 weeks.`,
        stat: `${deltaSec}s/mi faster`,
        type: 'pace'
      })
    }
  }

  // ── Monthly volume milestone ───────────────────────────────
  const last30Mi = runs
    .filter(a => (now.getTime() - new Date(a.activity_date).getTime()) / MS_PER_DAY <= 30)
    .reduce((s, a) => s + a.distance / 1609.34, 0)

  const milestones = [100, 75, 50, 40, 30]
  for (const m of milestones) {
    if (last30Mi >= m) {
      wins.push({
        text: `Over ${m}mi in the last 30 days. That's consistent training.`,
        stat: `${last30Mi.toFixed(0)}mi / 30d`,
        type: 'volume'
      })
      break
    }
  }

  // Deduplicate — max 3 wins
  const seen = new Set<string>()
  return wins.filter(w => {
    if (seen.has(w.type)) return false
    seen.add(w.type)
    return true
  }).slice(0, 3)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''))
    if (!user) return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

    const { data: athlete } = await supabase.from('athletes').select('id').eq('auth_user_id', user.id).single()
    if (!athlete) return new Response(JSON.stringify({ wins: [] }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

    const sixtyDaysAgo = new Date()
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60)

    const { data: activities } = await supabase
      .from('activities')
      .select('id, activity_date, distance, moving_time, average_speed, average_heartrate, pr_count, activity_types(name)')
      .eq('athlete_id', athlete.id)
      .gte('activity_date', sixtyDaysAgo.toISOString().split('T')[0])
      .order('activity_date', { ascending: false })
      .limit(60)

    const wins = computeWins((activities ?? []) as Activity[])

    return new Response(JSON.stringify({ wins, computed_at: new Date().toISOString() }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    console.error('micro-wins error:', err)
    return new Response(JSON.stringify({ wins: [] }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
