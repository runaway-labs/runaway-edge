// goal-assessment edge function
// Takes a goal and assesses training trajectory toward it

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')

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
      .from('goals')
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

    const prompt = `You are the Runaway training twin — direct, honest, second-person voice. No cheerleading.

The athlete has set this goal:
- Type: ${goal.goal_type}
- Activity: ${goal.activity_type ?? 'running'}
- Target value: ${goal.target_value} ${goal.goal_type === 'race_time' ? 'seconds (format as H:MM:SS)' : goal.goal_type === 'pace' ? 'seconds per mile' : 'miles'}
- Current value: ${goal.current_value ?? 'unknown'}
- Start date: ${goal.start_date ?? 'unknown'}
- End date / deadline: ${goal.end_date ?? 'none set'}
- Days remaining: ${daysLeft ?? 'unknown'}

Their recent 8 weeks of training:
- Total runs: ${totalRuns}
- Weekly mileage avg: ${weeklyMileage.toFixed(1)} mi/week
- Recent 4-week vs prior 4-week volume: ${trend > 0 ? '+' : ''}${(trend * 100).toFixed(0)}% ${trend > 0 ? 'building' : trend < -0.05 ? 'declining' : 'flat'}
- Current average pace: ${avgPaceSecPerMi ? fmtPace(avgPaceSecPerMi) : 'unknown'}

Return ONLY valid JSON (no markdown, no code blocks) in this exact format:
{
  "insights": [
    { "title": "short sharp headline about where they stand", "detail": "1-2 sentences with specific numbers, honest assessment" },
    { "title": "what the gap actually is", "detail": "1-2 sentences on the delta between current training and what the goal requires" },
    { "title": "the single most important thing to do now", "detail": "1-2 sentences, specific, actionable, based on their data" }
  ]
}

Rules:
- 3 insights total, each with a title (max 8 words) and detail (1-2 sentences)
- Second person voice. Reference actual numbers.
- No generic advice. No cheerleading. Be honest about whether they'll make it.
- Do not wrap in markdown or add any text outside the JSON.`

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    const result = await response.json()
    const rawText = result.content?.[0]?.text ?? '{}'

    // Parse structured insights, fall back gracefully
    let insights: { title: string; detail: string }[] = []
    try {
      const parsed = JSON.parse(rawText)
      insights = parsed.insights ?? []
    } catch {
      // If model didn't return clean JSON, wrap the raw text as a single insight
      insights = [{ title: 'Training assessment', detail: rawText }]
    }

    return new Response(
      JSON.stringify({ insights, weekly_mileage: weeklyMileage, trend, avg_pace_sec: avgPaceSecPerMi, days_left: daysLeft }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers: corsHeaders })
  }
})
