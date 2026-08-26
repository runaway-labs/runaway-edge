// Supabase Edge Function: generate-training-plan
// Generates a personalized weekly training plan using provider AI

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

interface Goal {
  id?: number
  type: string
  target_value: number
  deadline: string
  title: string
  weeks_remaining: number
}

interface GenerateRequest {
  athlete_id: number
  week_start_date: string
  goal?: Goal
}

interface DailyWorkout {
  id: string
  date: string
  day_of_week: string
  workout_type: string
  title: string
  description: string
  duration?: number
  distance?: number
  target_pace?: string
  exercises?: Exercise[]
  is_completed: boolean
  completed_activity_id?: number
}

interface Exercise {
  id: string
  name: string
  sets?: number
  reps?: string
  weight?: string
  notes?: string
}

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const request: GenerateRequest = await req.json()

    const { athlete_id, week_start_date, goal } = request

    if (!athlete_id || !week_start_date) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'athlete_id and week_start_date are required'
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    console.log('Generate training plan request:', { athlete_id, week_start_date, goal: goal?.title })

    // Create Supabase client
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Get athlete info
    const { data: athlete, error: athleteError } = await supabaseAdmin
      .from('athletes')
      .select('*')
      .eq('id', athlete_id)
      .single()

    if (athleteError) {
      console.error('Error fetching athlete:', athleteError)
    }

    // Fetch Adlerian profile
    const { data: aiProfileData } = await supabaseAdmin
      .from('athlete_ai_profiles')
      .select('core_memory')
      .eq('athlete_id', athlete_id)
      .maybeSingle()

    const planCoreMemory = (aiProfileData?.core_memory as Record<string, any>) ?? {}
    const planAdlerian = planCoreMemory.adlerian_profile ?? null

    // Get recent activities (last 4 weeks) to understand training patterns
    const fourWeeksAgo = new Date(week_start_date)
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28)

    const { data: recentActivities, error: activitiesError } = await supabaseAdmin
      .from('activities')
      .select('*')
      .eq('athlete_id', athlete_id)
      .gte('activity_date', fourWeeksAgo.toISOString())
      .lt('activity_date', week_start_date)
      .order('activity_date', { ascending: false })
      .limit(30)

    if (activitiesError) {
      console.error('Error fetching recent activities:', activitiesError)
    }

    const planDays = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const startDate = new Date(week_start_date);
    const dayOffsets: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    const generatedPlan = {
      workouts: planDays.map((day: string, index: number) => {
        const date = new Date(startDate); date.setUTCDate(startDate.getUTCDate() + (dayOffsets[day.toLowerCase()] ?? index));
        const running = index % 2 === 0;
        return { id: crypto.randomUUID(), date: date.toISOString().split('T')[0], day_of_week: day.toLowerCase(), workout_type: running ? 'easy_run' : 'stretch_mobility', title: running ? 'Easy Run' : 'Recovery Mobility', description: 'Keep the effort controlled and finish with reserve.', duration: running ? 35 : 25, ...(running ? { distance: 3, target_pace: 'conversational effort' } : {}), is_completed: false, completed_activity_id: null };
      }),
      focus_area: 'Consistency and recovery',
      notes: 'Legacy compatibility plan generated with conservative local rules.',
      total_mileage: planDays.filter((_: string, index: number) => index % 2 === 0).length * 3,
    };

    // Calculate week end date
    const weekStart = new Date(week_start_date)
    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekEnd.getDate() + 6)

    // Calculate total mileage if not provided
    const totalMileage = generatedPlan.total_mileage || (generatedPlan.workouts || [])
      .filter((w: DailyWorkout) => w.distance)
      .reduce((sum: number, w: DailyWorkout) => sum + (w.distance || 0), 0)

    // Build the complete plan response
    const plan = {
      id: crypto.randomUUID(),
      athlete_id: athlete_id,
      week_start_date: week_start_date,
      week_end_date: weekEnd.toISOString().split('T')[0],
      workouts: generatedPlan.workouts || [],
      week_number: null,
      total_mileage: totalMileage,
      focus_area: generatedPlan.focus_area || 'Base Building',
      notes: generatedPlan.notes || 'Focus on consistency and recovery.',
      generated_at: new Date().toISOString(),
      goal_id: goal?.id || null
    }

    console.log('Plan generated successfully:', {
      workouts: plan.workouts.length,
      total_mileage: plan.total_mileage
    })

    // Optionally save to database
    const { error: insertError } = await supabaseAdmin
      .from('weekly_training_plans')
      .upsert({
        id: plan.id,
        athlete_id: plan.athlete_id,
        week_start_date: plan.week_start_date,
        week_end_date: plan.week_end_date,
        workouts: plan.workouts,
        total_mileage: plan.total_mileage,
        focus_area: plan.focus_area,
        notes: plan.notes,
        generated_at: plan.generated_at,
        goal_id: plan.goal_id
      }, {
        onConflict: 'athlete_id,week_start_date'
      })

    if (insertError) {
      console.error('Error saving plan to database:', insertError)
      // Don't fail the request, just log the error
    }

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
    console.error('Error in generate-training-plan:', error)
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )
  }
})

function buildGenerationPrompt(
  athlete: any,
  goal: Goal | undefined,
  recentActivities: any[],
  weekStartDate: string
): string {
  const parts: string[] = []

  // Athlete context
  parts.push(`## Athlete Profile`)
  if (athlete) {
    parts.push(`Name: ${athlete.first_name} ${athlete.last_name}`)
    if (athlete.city || athlete.state) {
      parts.push(`Location: ${[athlete.city, athlete.state].filter(Boolean).join(', ')}`)
    }
  } else {
    parts.push(`New athlete - no profile data available`)
  }

  // Goal context
  if (goal) {
    parts.push(`\n## Current Goal`)
    parts.push(`Goal: ${goal.title}`)
    parts.push(`Type: ${goal.type}`)
    parts.push(`Target: ${goal.target_value}`)
    parts.push(`Deadline: ${goal.deadline}`)
    parts.push(`Weeks Remaining: ${goal.weeks_remaining}`)
  } else {
    parts.push(`\n## Goal`)
    parts.push(`No specific goal set. Focus on general fitness and base building.`)
  }

  // Recent training analysis
  parts.push(`\n## Recent Training History (Last 4 Weeks)`)

  if (recentActivities && recentActivities.length > 0) {
    // Calculate weekly summaries
    const weeklyStats: { [week: string]: { runs: number, miles: number, minutes: number } } = {}

    recentActivities.forEach((activity: any) => {
      const activityDate = new Date(activity.activity_date)
      const weekKey = getWeekKey(activityDate)

      if (!weeklyStats[weekKey]) {
        weeklyStats[weekKey] = { runs: 0, miles: 0, minutes: 0 }
      }

      weeklyStats[weekKey].runs++
      weeklyStats[weekKey].miles += (activity.distance || 0) / 1609.34
      weeklyStats[weekKey].minutes += (activity.moving_time || 0) / 60
    })

    Object.entries(weeklyStats).forEach(([week, stats]) => {
      parts.push(`- Week of ${week}: ${stats.runs} runs, ${stats.miles.toFixed(1)} miles, ${Math.round(stats.minutes)} min`)
    })

    // Calculate averages
    const weeks = Object.keys(weeklyStats).length || 1
    const totalMiles = Object.values(weeklyStats).reduce((sum, w) => sum + w.miles, 0)
    const avgWeeklyMiles = totalMiles / weeks

    parts.push(`\nAverage weekly mileage: ${avgWeeklyMiles.toFixed(1)} miles`)
    parts.push(`Recommended this week: ${(avgWeeklyMiles * 1.05).toFixed(1)} - ${(avgWeeklyMiles * 1.10).toFixed(1)} miles (5-10% increase)`)
  } else {
    parts.push(`No recent activity data available.`)
    parts.push(`Starting with a conservative base-building week of approximately 15-20 miles.`)
  }

  // Week dates
  parts.push(`\n## Week to Plan`)
  parts.push(`Week starting: ${weekStartDate}`)

  const weekStart = new Date(weekStartDate)
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

  parts.push(`\nDates for each day:`)
  days.forEach((day, i) => {
    const date = new Date(weekStart)
    date.setDate(date.getDate() + i)
    parts.push(`- ${day}: ${date.toISOString().split('T')[0]}`)
  })

  // Instructions
  parts.push(`\n## Instructions`)
  parts.push(`Create a complete 7-day training plan with appropriate workouts for each day.`)
  parts.push(`Include a mix of:`)
  parts.push(`- 1 Long run (Sunday or Saturday)`)
  parts.push(`- 1-2 Quality sessions (tempo, intervals, or hills)`)
  parts.push(`- 2-3 Easy runs`)
  parts.push(`- 2-3 Strength/cross-training sessions`)
  parts.push(`- 1 Rest or active recovery day`)
  parts.push(`\nRespond with ONLY the JSON object, no other text.`)

  return parts.join('\n')
}

function getWeekKey(date: Date): string {
  const sunday = new Date(date)
  sunday.setDate(sunday.getDate() - sunday.getDay())
  return sunday.toISOString().split('T')[0]
}
