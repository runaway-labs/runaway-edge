// goal-assessment edge function
// Takes a goal and assesses training trajectory toward it

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader ?? '' } } }
    )

    const { goal_id } = await req.json()

    // Get athlete
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders })

    const { data: athlete } = await supabase
      .from('athletes').select('id').eq('auth_user_id', user.id).single()
    if (!athlete) return new Response(JSON.stringify({ error: 'Athlete not found' }), { status: 404, headers: corsHeaders })

    // Get the goal
    const { data: goal } = await supabase
      .from('running_goals')
      .select('*')
      .eq('id', goal_id)
      .eq('athlete_id', athlete.id)
      .single()
    if (!goal) return new Response(JSON.stringify({ error: 'Goal not found' }), { status: 404, headers: corsHeaders })

    // Get last 8 weeks of activities for trend analysis
    const eightWeeksAgo = new Date()
    eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56)

    const { data: activities } = await supabase
      .from('activities')
      .select('distance, moving_time, average_speed, average_heart_rate, activity_date, training_load, suffer_score')
      .eq('athlete_id', athlete.id)
      .gte('activity_date', eightWeeksAgo.toISOString().split('T')[0])
      .order('activity_date', { ascending: false })
      .limit(40)

    // Compute training signals
    const acts = activities ?? []
    const totalRuns = acts.length
    const totalDistanceM = acts.reduce((s, a) => s + (a.distance ?? 0), 0)
    const totalDistanceMi = totalDistanceM * 0.000621371
    const weeklyMileage = totalDistanceMi / 8

    // Recent 4-week vs prior 4-week for trend
    const recent4 = acts.filter((_, i) => i < Math.floor(totalRuns / 2))
    const prior4 = acts.filter((_, i) => i >= Math.floor(totalRuns / 2))
    const recentMi = recent4.reduce((s, a) => s + (a.distance ?? 0), 0) * 0.000621371
    const priorMi = prior4.reduce((s, a) => s + (a.distance ?? 0), 0) * 0.000621371
    const trend = prior4.length > 0 ? (recentMi - priorMi) / priorMi : 0

    // Average pace (recent)
    const recentWithPace = recent4.filter(a => a.distance && a.moving_time && a.distance > 0)
    const avgPaceSecPerMi = recentWithPace.length > 0
      ? (recentWithPace.reduce((s, a) => s + ((a.moving_time! / (a.distance! * 0.000621371))), 0) / recentWithPace.length)
      : null

    const fmtPace = (s: number) => {
      const m = Math.floor(s / 60); const sec = Math.round(s % 60)
      return `${m}:${String(sec).padStart(2, '0')}/mi`
    }

    // Days until goal end_date
    const daysLeft = goal.end_date
      ? Math.max(0, Math.round((new Date(goal.end_date).getTime() - Date.now()) / 86400000))
      : null

    const trendPercent = Math.round(trend * 100);
    const direction = trendPercent > 5 ? "building" : trendPercent < -5 ? "declining" : "holding steady";
    const insights = [
      { title: "Your current training", detail: "You are averaging " + weeklyMileage.toFixed(1) + " miles per week across " + totalRuns + " runs; volume is " + direction + " at " + trendPercent + "%." },
      { title: "The measurable gap", detail: "Your recent average pace is " + (avgPaceSecPerMi ? fmtPace(avgPaceSecPerMi) : "not yet established") + ". " + (daysLeft === null ? "No deadline is set." : daysLeft + " days remain.") },
      { title: "Protect the next step", detail: trendPercent > 10 ? "Hold volume steady before adding intensity." : "Build one variable at a time and reassess after four more weeks." },
    ];

    return new Response(
      JSON.stringify({ insights, weekly_mileage: weeklyMileage, trend, avg_pace_sec: avgPaceSecPerMi, days_left: daysLeft }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers: corsHeaders })
  }
})
