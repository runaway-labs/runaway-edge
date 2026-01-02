// Supabase Edge Function: regenerate-training-plan
// Regenerates remaining weekly training plan based on completed activities
// Uses Claude to create adaptive, personalized adjustments

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')

interface CompletedDay {
  day: string
  date: string
  actual: {
    name: string
    type: string
    distance_miles: number
    duration_minutes: number
    pace: string
    elevation_gain_ft: number
    average_hr?: number
  }
  planned?: {
    type: string
    title: string
    distance_miles?: number
    duration_minutes?: number
  }
}

interface Goal {
  id?: number
  type: string
  target_value: number
  deadline: string
  title: string
  weeks_remaining: number
}

interface RegenerateRequest {
  athlete_id: number
  week_start_date: string
  completed_days: CompletedDay[]
  remaining_days: string[]
  original_plan: {
    total_mileage: number
    focus_area?: string
    notes?: string
  }
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
    const request: RegenerateRequest = await req.json()

    const {
      athlete_id,
      week_start_date,
      completed_days,
      remaining_days,
      original_plan,
      goal
    } = request

    if (!athlete_id || !week_start_date || !remaining_days || remaining_days.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'athlete_id, week_start_date, and remaining_days are required'
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    console.log('Regenerate plan request:', {
      athlete_id,
      week_start_date,
      completed_days: completed_days.length,
      remaining_days
    })

    // Create Supabase client
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Get athlete info for personalization
    const { data: athlete, error: athleteError } = await supabaseAdmin
      .from('athletes')
      .select('*')
      .eq('id', athlete_id)
      .single()

    if (athleteError) {
      console.error('Error fetching athlete:', athleteError)
    }

    // Get recent activities beyond this week for context (previous 3 weeks)
    const threeWeeksAgo = new Date(week_start_date)
    threeWeeksAgo.setDate(threeWeeksAgo.getDate() - 21)

    const { data: recentActivities, error: activitiesError } = await supabaseAdmin
      .from('activities')
      .select('*')
      .eq('athlete_id', athlete_id)
      .gte('activity_date', threeWeeksAgo.toISOString())
      .lt('activity_date', week_start_date)
      .order('activity_date', { ascending: false })
      .limit(15)

    if (activitiesError) {
      console.error('Error fetching recent activities:', activitiesError)
    }

    // Build the prompt for Claude
    const prompt = buildRegenerationPrompt(
      athlete,
      completed_days,
      remaining_days,
      original_plan,
      goal,
      recentActivities || [],
      week_start_date
    )

    console.log('Calling Claude for plan regeneration...')

    // Call Anthropic API
    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY || '',
        'anthropic-version': '2024-10-22'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: `You are an expert running coach and exercise physiologist. Your task is to regenerate a weekly training plan based on what the athlete has actually completed so far this week.

IMPORTANT: You must respond with ONLY valid JSON, no markdown, no explanation. The JSON must match this exact structure:
{
  "workouts": [...],
  "notes": "string",
  "focus_area": "string"
}

Each workout in the array must have:
- id: unique string (use UUID format)
- date: ISO date string
- day_of_week: lowercase day name
- workout_type: one of [easy_run, long_run, tempo_run, interval_run, hill_run, recovery_run, strength_training, upper_body, lower_body, full_body, yoga, cross_training, stretch_mobility]
- title: short workout title
- description: detailed description with instructions
- duration: minutes (number, optional)
- distance: miles (number, optional for running workouts)
- target_pace: pace range string (optional)
- exercises: array of exercises for strength workouts (optional)
- is_completed: false
- completed_activity_id: null

Key principles:
1. RECOVERY FIRST: If athlete exceeded planned load, prioritize recovery
2. PROGRESSIVE OVERLOAD: Don't increase weekly mileage by more than 10%
3. HARD-EASY PATTERN: Never schedule hard workouts on consecutive days
4. GOAL ALIGNMENT: Keep the athlete on track for their goal while respecting fatigue
5. SPECIFICITY: Match workout types to the athlete's goal (marathon = more long runs, 5K = more speed)`,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    })

    if (!anthropicResponse.ok) {
      const errorData = await anthropicResponse.text()
      console.error('Anthropic API error:', errorData)
      throw new Error(`Anthropic API error: ${anthropicResponse.status}`)
    }

    const anthropicData = await anthropicResponse.json()
    const responseText = anthropicData.content[0].text

    console.log('Claude response received, parsing...')

    // Parse the JSON response
    let regeneratedPlan
    try {
      // Try to extract JSON if wrapped in markdown code blocks
      let jsonText = responseText
      if (responseText.includes('```json')) {
        jsonText = responseText.split('```json')[1].split('```')[0].trim()
      } else if (responseText.includes('```')) {
        jsonText = responseText.split('```')[1].split('```')[0].trim()
      }
      regeneratedPlan = JSON.parse(jsonText)
    } catch (parseError) {
      console.error('Failed to parse Claude response:', responseText)
      throw new Error('Failed to parse AI response as JSON')
    }

    // Calculate week end date
    const weekStart = new Date(week_start_date)
    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekEnd.getDate() + 6)

    // Calculate total mileage from regenerated workouts
    const totalMileage = (regeneratedPlan.workouts || [])
      .filter((w: DailyWorkout) => w.distance)
      .reduce((sum: number, w: DailyWorkout) => sum + (w.distance || 0), 0)

    // Build the complete plan response
    const plan = {
      id: crypto.randomUUID(),
      athlete_id: athlete_id,
      week_start_date: week_start_date,
      week_end_date: weekEnd.toISOString().split('T')[0],
      workouts: regeneratedPlan.workouts || [],
      week_number: null,
      total_mileage: totalMileage,
      focus_area: regeneratedPlan.focus_area || original_plan.focus_area,
      notes: regeneratedPlan.notes || 'Plan adjusted based on your actual training.',
      generated_at: new Date().toISOString(),
      goal_id: goal?.id || null
    }

    console.log('Plan regenerated successfully:', {
      workouts: plan.workouts.length,
      total_mileage: plan.total_mileage
    })

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
    console.error('Error in regenerate-training-plan:', error)
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

function buildRegenerationPrompt(
  athlete: any,
  completedDays: CompletedDay[],
  remainingDays: string[],
  originalPlan: { total_mileage: number; focus_area?: string; notes?: string },
  goal: Goal | undefined,
  recentActivities: any[],
  weekStartDate: string
): string {
  const parts: string[] = []

  // Athlete context
  if (athlete) {
    parts.push(`## Athlete Profile`)
    parts.push(`Name: ${athlete.first_name} ${athlete.last_name}`)
    if (athlete.city || athlete.state) {
      parts.push(`Location: ${[athlete.city, athlete.state].filter(Boolean).join(', ')}`)
    }
  }

  // Goal context
  if (goal) {
    parts.push(`\n## Current Goal`)
    parts.push(`Goal: ${goal.title}`)
    parts.push(`Type: ${goal.type}`)
    parts.push(`Target: ${goal.target_value}`)
    parts.push(`Deadline: ${goal.deadline}`)
    parts.push(`Weeks Remaining: ${goal.weeks_remaining}`)
  }

  // Recent training history (before this week)
  if (recentActivities && recentActivities.length > 0) {
    parts.push(`\n## Recent Training History (Previous 3 Weeks)`)

    let totalMiles = 0
    let totalRuns = 0

    recentActivities.forEach((activity: any) => {
      const distanceMiles = (activity.distance || 0) / 1609.34
      totalMiles += distanceMiles
      totalRuns++
    })

    parts.push(`Total runs: ${totalRuns}`)
    parts.push(`Total mileage: ${totalMiles.toFixed(1)} miles`)
    parts.push(`Average per week: ${(totalMiles / 3).toFixed(1)} miles`)
  }

  // Original plan context
  parts.push(`\n## Original Plan for This Week`)
  parts.push(`Week starting: ${weekStartDate}`)
  parts.push(`Planned total mileage: ${originalPlan.total_mileage} miles`)
  if (originalPlan.focus_area) {
    parts.push(`Focus area: ${originalPlan.focus_area}`)
  }

  // What was completed this week
  parts.push(`\n## Completed Activities This Week`)
  if (completedDays.length === 0) {
    parts.push(`No activities completed yet this week.`)
  } else {
    let actualMileage = 0
    let plannedMileage = 0

    completedDays.forEach((day) => {
      parts.push(`\n### ${day.day.charAt(0).toUpperCase() + day.day.slice(1)} (${day.date})`)
      parts.push(`**Actual:** ${day.actual.name}`)
      parts.push(`- Distance: ${day.actual.distance_miles.toFixed(1)} miles`)
      parts.push(`- Duration: ${day.actual.duration_minutes} minutes`)
      parts.push(`- Pace: ${day.actual.pace}`)
      if (day.actual.elevation_gain_ft > 0) {
        parts.push(`- Elevation: ${Math.round(day.actual.elevation_gain_ft)} ft`)
      }
      if (day.actual.average_hr) {
        parts.push(`- Avg HR: ${day.actual.average_hr} bpm`)
      }

      actualMileage += day.actual.distance_miles

      if (day.planned) {
        parts.push(`**Planned:** ${day.planned.title} (${day.planned.type})`)
        if (day.planned.distance_miles) {
          parts.push(`- Planned distance: ${day.planned.distance_miles} miles`)
          plannedMileage += day.planned.distance_miles
        }

        // Calculate deviation
        if (day.planned.distance_miles) {
          const deviation = ((day.actual.distance_miles - day.planned.distance_miles) / day.planned.distance_miles * 100)
          parts.push(`- Deviation: ${deviation > 0 ? '+' : ''}${deviation.toFixed(0)}%`)
        }
      } else {
        parts.push(`**Planned:** Rest day (unplanned workout)`)
      }
    })

    parts.push(`\n**Summary:**`)
    parts.push(`- Actual mileage so far: ${actualMileage.toFixed(1)} miles`)
    parts.push(`- Planned mileage so far: ${plannedMileage.toFixed(1)} miles`)
    parts.push(`- Load ratio: ${plannedMileage > 0 ? (actualMileage / plannedMileage * 100).toFixed(0) : 'N/A'}%`)
  }

  // What needs to be planned
  parts.push(`\n## Days Needing New Workouts`)
  parts.push(`Please generate workouts for: ${remainingDays.join(', ')}`)

  // Calculate dates for remaining days
  const weekStart = new Date(weekStartDate)
  const dayMap: { [key: string]: number } = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6
  }

  parts.push(`\nDates for each day:`)
  remainingDays.forEach((day) => {
    const dayOffset = dayMap[day.toLowerCase()] || 0
    const date = new Date(weekStart)
    date.setDate(date.getDate() + dayOffset)
    parts.push(`- ${day}: ${date.toISOString().split('T')[0]}`)
  })

  // Instructions
  parts.push(`\n## Instructions`)
  parts.push(`1. Analyze the athlete's completed activities and how they deviate from the plan`)
  parts.push(`2. Consider accumulated fatigue and recovery needs`)
  parts.push(`3. Generate appropriate workouts for the remaining days`)
  parts.push(`4. If the athlete has exceeded planned load, prioritize recovery`)
  parts.push(`5. If the athlete has under-trained, consider slightly increasing intensity (but don't overcompensate)`)
  parts.push(`6. Keep the athlete on track for their goal while respecting their body's signals`)
  parts.push(`\nRespond with ONLY the JSON object, no other text.`)

  return parts.join('\n')
}
