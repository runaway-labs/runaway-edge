// Journal Edge Function
// Generate AI-powered weekly training journal entries

import { createSupabaseClient } from '../_shared/supabase.ts'
import { createAnthropicClient } from '../_shared/anthropic.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { ActivitySummarizer } from '../_shared/activity-summarizer.ts'
import type { Activity } from '../_shared/types.ts'

interface JournalGenerateRequest {
  athlete_id: number
  week_start_date?: string
}

interface WeekStats {
  total_distance_miles: string | null
  total_time_hours: string
  activities_count: number
  avg_pace: string
  longest_run_miles: string
  elevation_gain_feet: number
  avg_heart_rate: number | null
}

interface Insight {
  type: 'observation' | 'achievement' | 'recommendation' | 'pattern'
  text: string
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const url = new URL(req.url)
  const supabase = createSupabaseClient()

  try {
    // Route: POST /journal/generate
    if (req.method === 'POST' && url.pathname.endsWith('/generate')) {
      const { athlete_id, week_start_date }: JournalGenerateRequest = await req.json()

      if (!athlete_id) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'INVALID_REQUEST',
              message: 'athlete_id is required'
            }
          }),
          {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          }
        )
      }

      // Default to start of current week if not provided
      let weekStart: Date
      if (week_start_date) {
        weekStart = new Date(week_start_date)
      } else {
        // Get Monday of current week
        const today = new Date()
        const dayOfWeek = today.getDay()
        const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
        weekStart = new Date(today)
        weekStart.setDate(today.getDate() + daysToMonday)
        weekStart.setHours(0, 0, 0, 0)
      }

      console.log('Generating journal entry', {
        athlete_id,
        week_start_date: weekStart.toISOString()
      })

      // Generate journal
      const journalEntry = await generateWeeklyJournal(supabase, athlete_id, weekStart)

      if (!journalEntry) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'NO_ACTIVITIES',
              message: 'No activities found for this week'
            }
          }),
          {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          }
        )
      }

      return new Response(
        JSON.stringify({
          success: true,
          journal: journalEntry
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    // Route: GET /journal/:athlete_id
    if (req.method === 'GET') {
      const pathParts = url.pathname.split('/')
      const athlete_id = parseInt(pathParts[pathParts.length - 1])
      const limit = parseInt(url.searchParams.get('limit') || '10')

      if (isNaN(athlete_id)) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'INVALID_REQUEST',
              message: 'Invalid athlete_id'
            }
          }),
          {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          }
        )
      }

      console.log('Fetching journal entries', { athlete_id, limit })

      const { data: entries, error } = await supabase
        .from('training_journal')
        .select('*')
        .eq('athlete_id', athlete_id)
        .order('week_start_date', { ascending: false })
        .limit(limit)

      if (error) {
        throw error
      }

      return new Response(
        JSON.stringify({
          success: true,
          entries: entries || [],
          count: entries?.length || 0
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    return new Response(
      JSON.stringify({
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: 'Method not allowed'
        }
      }),
      {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )

  } catch (error) {
    console.error('Error in journal endpoint', {
      error: error.message,
      stack: error.stack
    })

    return new Response(
      JSON.stringify({
        error: {
          code: 'INTERNAL_ERROR',
          message: error.message
        }
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )
  }
})

/**
 * Generate weekly journal entry
 */
async function generateWeeklyJournal(
  supabase: any,
  athleteId: number,
  weekStartDate: Date
): Promise<any | null> {
  const anthropic = createAnthropicClient()

  // Calculate week end date
  const weekEndDate = new Date(weekStartDate)
  weekEndDate.setDate(weekEndDate.getDate() + 6)

  // Get activities for the week
  const weekActivities = await getWeekActivities(supabase, athleteId, weekStartDate, weekEndDate)

  if (weekActivities.length === 0) {
    console.log('No activities found for week', { athleteId, weekStartDate })
    return null
  }

  // Calculate week statistics
  const weekStats = calculateWeekStats(weekActivities)

  // Get athlete profile for context
  const { data: profile } = await supabase
    .from('athlete_ai_profiles')
    .select('*')
    .eq('athlete_id', athleteId)
    .single()

  // Get previous week for comparison
  const previousWeekStart = new Date(weekStartDate)
  previousWeekStart.setDate(previousWeekStart.getDate() - 7)
  const previousWeekEnd = new Date(weekStartDate)
  previousWeekEnd.setTime(previousWeekEnd.getTime() - 1)

  const previousWeekActivities = await getWeekActivities(
    supabase,
    athleteId,
    previousWeekStart,
    previousWeekEnd
  )

  const previousWeekStats = previousWeekActivities.length > 0
    ? calculateWeekStats(previousWeekActivities)
    : null

  // Generate narrative using Claude
  const prompt = buildNarrativePrompt(weekActivities, weekStats, previousWeekStats, profile)

  console.log('Sending to Claude for journal generation', {
    athleteId,
    promptLength: prompt.length,
    activitiesCount: weekActivities.length
  })

  const response = await anthropic.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: prompt
    }]
  })

  const fullResponse = response.content[0].type === 'text' ? response.content[0].text : ''

  // Parse narrative and insights from response
  const parts = fullResponse.split('INSIGHTS:')
  const narrative = parts[0].replace('NARRATIVE:', '').trim()

  let insights: Insight[] = []
  if (parts.length > 1) {
    const insightsText = parts[1].trim()
    insights = insightsText.split('\n')
      .filter(line => line.trim().startsWith('-'))
      .map(line => {
        const text = line.replace(/^-\s*/, '').trim()
        // Categorize insights
        let type: Insight['type'] = 'observation'
        const lowerText = text.toLowerCase()

        if (lowerText.includes('achievement') || lowerText.includes('pr') || lowerText.includes('milestone')) {
          type = 'achievement'
        } else if (lowerText.includes('recommend') || lowerText.includes('should') || lowerText.includes('consider')) {
          type = 'recommendation'
        } else if (lowerText.includes('pattern') || lowerText.includes('consistently') || lowerText.includes('trend')) {
          type = 'pattern'
        }

        return { type, text }
      })
  }

  // Save journal entry
  const { data: journalEntry, error } = await supabase
    .from('training_journal')
    .insert({
      athlete_id: athleteId,
      week_start_date: weekStartDate.toISOString().split('T')[0],
      week_end_date: weekEndDate.toISOString().split('T')[0],
      narrative,
      week_stats: weekStats,
      insights,
      generation_model: 'claude-3-5-sonnet-20241022'
    })
    .select()
    .single()

  if (error) {
    throw new Error(`Error saving journal entry: ${error.message}`)
  }

  console.log('Weekly journal generated', {
    athleteId,
    journalId: journalEntry.id,
    narrativeLength: narrative.length
  })

  return journalEntry
}

/**
 * Get activities for a specific week
 */
async function getWeekActivities(
  supabase: any,
  athleteId: number,
  startDate: Date,
  endDate: Date
): Promise<Activity[]> {
  const { data: activities, error } = await supabase
    .from('activities')
    .select('*')
    .eq('athlete_id', athleteId)
    .gte('activity_date', startDate.toISOString())
    .lte('activity_date', endDate.toISOString())
    .order('activity_date', { ascending: true })

  if (error) {
    throw new Error(`Error fetching week activities: ${error.message}`)
  }

  return activities || []
}

/**
 * Calculate statistics for the week
 */
function calculateWeekStats(activities: Activity[]): WeekStats {
  const totalDistance = activities.reduce((sum, a) => sum + (parseFloat(String(a.distance)) || 0), 0)
  const totalTime = activities.reduce((sum, a) => sum + (a.moving_time || 0), 0)
  const totalElevation = activities.reduce((sum, a) => sum + (a.elevation_gain || 0), 0)

  // Calculate average pace (weighted by distance)
  let totalPaceMinutes = 0
  let totalDistanceForPace = 0
  activities.forEach(a => {
    if (a.distance && a.moving_time && a.distance > 0) {
      const distanceMeters = parseFloat(String(a.distance))
      const paceMinPerMile = (a.moving_time / 60) / (distanceMeters * 0.000621371)
      totalPaceMinutes += paceMinPerMile * (distanceMeters * 0.000621371)
      totalDistanceForPace += distanceMeters * 0.000621371
    }
  })

  const avgPaceMinPerMile = totalDistanceForPace > 0 ? totalPaceMinutes / totalDistanceForPace : 0
  const avgPace = formatPace(avgPaceMinPerMile)

  // Find longest run
  const longestRun = Math.max(...activities.map(a => parseFloat(String(a.distance)) || 0)) * 0.000621371

  // Calculate average heart rate
  const activitiesWithHR = activities.filter(a => a.average_heart_rate)
  const avgHeartRate = activitiesWithHR.length > 0
    ? Math.round(activitiesWithHR.reduce((sum, a) => sum + (a.average_heart_rate || 0), 0) / activitiesWithHR.length)
    : null

  return {
    total_distance_miles: ActivitySummarizer.metersToMiles(totalDistance),
    total_time_hours: (totalTime / 3600).toFixed(1),
    activities_count: activities.length,
    avg_pace: avgPace,
    longest_run_miles: longestRun.toFixed(2),
    elevation_gain_feet: Math.round(totalElevation * 3.28084),
    avg_heart_rate: avgHeartRate
  }
}

/**
 * Format pace as MM:SS
 */
function formatPace(paceMinPerMile: number): string {
  if (!paceMinPerMile || paceMinPerMile === 0) return 'N/A'
  const minutes = Math.floor(paceMinPerMile)
  const seconds = Math.round((paceMinPerMile - minutes) * 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

/**
 * Build prompt for narrative generation
 */
function buildNarrativePrompt(
  activities: Activity[],
  weekStats: WeekStats,
  previousWeekStats: WeekStats | null,
  profile: any
): string {
  const parts: string[] = []

  parts.push('You are an experienced running coach writing a weekly training summary for your athlete.')
  parts.push('')

  // Athlete context
  if (profile?.core_memory) {
    const memory = profile.core_memory
    parts.push('ATHLETE CONTEXT:')
    if (memory.goals?.primary) {
      parts.push(`- Goal: ${memory.goals.primary}`)
    }
    if (memory.personal?.experience_level) {
      parts.push(`- Experience: ${memory.personal.experience_level}`)
    }
    parts.push('')
  }

  // Week statistics
  parts.push("THIS WEEK'S TRAINING:")
  parts.push(`- ${weekStats.activities_count} runs`)
  parts.push(`- ${weekStats.total_distance_miles} total miles`)
  parts.push(`- ${weekStats.total_time_hours} hours of running`)
  parts.push(`- Avg pace: ${weekStats.avg_pace}/mile`)
  parts.push(`- Longest run: ${weekStats.longest_run_miles} miles`)
  if (weekStats.avg_heart_rate) {
    parts.push(`- Avg HR: ${weekStats.avg_heart_rate} bpm`)
  }
  parts.push('')

  // Comparison to previous week
  if (previousWeekStats) {
    parts.push('COMPARISON TO LAST WEEK:')
    const currentDist = parseFloat(weekStats.total_distance_miles || '0')
    const prevDist = parseFloat(previousWeekStats.total_distance_miles || '0')
    if (prevDist > 0) {
      const distanceChange = ((currentDist - prevDist) / prevDist * 100).toFixed(1)
      parts.push(`- Distance: ${parseFloat(distanceChange) > 0 ? '+' : ''}${distanceChange}%`)
    }
    parts.push(`- Activities: ${weekStats.activities_count} vs ${previousWeekStats.activities_count}`)
    parts.push('')
  }

  // Individual activities
  parts.push('INDIVIDUAL RUNS:')
  activities.forEach((activity, index) => {
    const summary = ActivitySummarizer.generateSummary(activity)
    parts.push(`${index + 1}. ${summary}`)
  })
  parts.push('')

  parts.push('INSTRUCTIONS:')
  parts.push('Write a warm, encouraging weekly summary in 2-4 paragraphs. Include:')
  parts.push('1. Overview of the week and standout performances')
  parts.push('2. Progress towards goals (if applicable)')
  parts.push('3. Patterns or trends you notice')
  parts.push('4. Encouragement and forward-looking statement')
  parts.push('')
  parts.push('Then, provide 3-5 key insights as bullet points.')
  parts.push('')
  parts.push('Format your response as:')
  parts.push('NARRATIVE:')
  parts.push('[Your 2-4 paragraph summary]')
  parts.push('')
  parts.push('INSIGHTS:')
  parts.push('- [Insight 1]')
  parts.push('- [Insight 2]')
  parts.push('- [Insight 3]')

  return parts.join('\n')
}
