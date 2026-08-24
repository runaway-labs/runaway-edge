// Supabase Edge Function: journal
// Generate AI-powered training journal entries

import { corsHeaders } from '../_shared/cors.ts'
import {
  parseLegacyAthleteId,
  resolveUserEndpointDependencies,
  userGuardErrorResponse,
  type UserEndpointDependencies,
} from '../_shared/user-endpoint.ts'

interface JournalDependencies extends UserEndpointDependencies {
  fetch: typeof fetch
  getEnv: (name: string) => string | undefined
}

export function createHandler(overrides: Partial<JournalDependencies> = {}) {
  const userDeps = resolveUserEndpointDependencies(overrides)
  const deps: JournalDependencies = {
    ...userDeps,
    fetch: overrides.fetch ?? globalThis.fetch,
    getEnv: overrides.getEnv ?? ((name) => Deno.env.get(name)),
  }

  return async (req: Request) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  const url = new URL(req.url)
  const pathParts = url.pathname.split('/').filter(Boolean)

  // POST /journal/generate - Generate journal for a week
  if (req.method === 'POST' && pathParts[pathParts.length - 1] === 'generate') {
    return await handleGenerate(req, deps)
  }

  // POST /journal/generate-recent - Generate for multiple weeks
  if (req.method === 'POST' && pathParts[pathParts.length - 1] === 'generate-recent') {
    return await handleGenerateRecent(req, deps)
  }

  // GET /journal/:athlete_id and GET /journal?athlete_id=:athlete_id
  if (req.method === 'GET') {
    const journalIndex = pathParts.lastIndexOf('journal')
    const pathAthleteId = journalIndex >= 0 && pathParts.length > journalIndex + 1
      ? pathParts[journalIndex + 1]
      : null
    const athleteId = url.searchParams.get('athlete_id') ?? pathAthleteId
    return await handleGetEntries(req, athleteId, url.searchParams.get('limit'), deps)
  }

  return new Response(
    JSON.stringify({ error: 'Not found' }),
    {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    }
  )
  }
}

if (import.meta.main) {
  Deno.serve(createHandler())
}

async function handleGenerate(req: Request, deps: JournalDependencies) {
  try {
    const { athlete_id, week_start_date } = await req.json()
    const requestedAthleteId = parseLegacyAthleteId(athlete_id)
    const context = await deps.requireUser(req, requestedAthleteId)

    if (requestedAthleteId === null) {
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

    // Calculate week start (Monday)
    let weekStart: Date
    if (week_start_date) {
      weekStart = new Date(week_start_date)
    } else {
      const today = new Date()
      const dayOfWeek = today.getDay()
      const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
      weekStart = new Date(today)
      weekStart.setDate(today.getDate() + daysToMonday)
      weekStart.setHours(0, 0, 0, 0)
    }

    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekStart.getDate() + 7)

    const athleteId = context.athleteId
    console.log('Generating journal:', { athlete_id: athleteId, weekStart: weekStart.toISOString() })

    const supabaseAdmin = deps.getAdmin()

    // Get activities for the week
    const { data: activities, error: activitiesError } = await supabaseAdmin
      .from('activities')
      .select('*')
      .eq('athlete_id', athleteId)
      .gte('activity_date', weekStart.toISOString())
      .lt('activity_date', weekEnd.toISOString())
      .order('activity_date', { ascending: true })

    if (activitiesError) {
      console.error('JOURNAL_ACTIVITY_LOOKUP_FAILED', { operation: 'activity_lookup' })
      throw new Error('JOURNAL_ACTIVITY_LOOKUP_FAILED')
    }

    if (!activities || activities.length === 0) {
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

    // Build activity summary
    const activitySummaries = activities.map((activity: any) => {
      const date = new Date(activity.activity_date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
      const distanceKm = (activity.distance / 1000).toFixed(2)
      const durationMin = Math.round(activity.moving_time / 60)
      const paceMinPerKm = activity.moving_time / 60 / (activity.distance / 1000)
      const pace = `${Math.floor(paceMinPerKm)}:${String(Math.round((paceMinPerKm % 1) * 60)).padStart(2, '0')}/km`

      let summary = `${date}: ${activity.name} - ${distanceKm}km in ${durationMin}min (${pace})`
      if (activity.average_heart_rate) {
        summary += `, HR: ${Math.round(activity.average_heart_rate)} bpm`
      }
      if (activity.elevation_gain) {
        summary += `, Elevation: ${Math.round(activity.elevation_gain)}m`
      }
      return summary
    })

    // Calculate weekly stats
    const totalDistance = activities.reduce((sum: number, a: any) => sum + (a.distance || 0), 0) / 1000
    const totalTime = activities.reduce((sum: number, a: any) => sum + (a.moving_time || 0), 0)
    const totalElevation = activities.reduce((sum: number, a: any) => sum + (a.elevation_gain || 0), 0)

    const weekSummary = `
Week of ${weekStart.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
Total: ${activities.length} activities, ${totalDistance.toFixed(1)}km, ${Math.round(totalTime / 60)}min, ${Math.round(totalElevation)}m elevation
`

    // Call Anthropic API to generate journal
    const anthropicApiKey = deps.getEnv('ANTHROPIC_API_KEY') ?? ''
    const anthropicResponse = await deps.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1500,
        system: `You are a running coach writing a training journal entry. Analyze the week's training and provide:
1. A brief summary of the week's training
2. Key highlights or achievements
3. Areas for improvement
4. Recommendations for next week

Be encouraging but honest. Focus on patterns, consistency, and progression.`,
        messages: [
          {
            role: 'user',
            content: `Generate a training journal entry for this week:\n\n${weekSummary}\n\nActivities:\n${activitySummaries.join('\n')}`
          }
        ]
      })
    })

    if (!anthropicResponse.ok) {
      console.error('ANTHROPIC_JOURNAL_FAILED', {
        operation: 'journal_generation',
        status: anthropicResponse.status,
      })
      throw new Error('ANTHROPIC_JOURNAL_FAILED')
    }

    const anthropicData = await anthropicResponse.json()
    const journalText = anthropicData.content[0].text

    // Store journal in database
    const journalEntry = {
      athlete_id: athleteId,
      week_start: weekStart.toISOString(),
      week_end: weekEnd.toISOString(),
      content: journalText,
      total_distance: totalDistance,
      total_time: Math.round(totalTime / 60),
      total_elevation: Math.round(totalElevation),
      activity_count: activities.length,
      created_at: new Date().toISOString()
    }

    const { data: insertedJournal, error: insertError } = await supabaseAdmin
      .from('training_journals')
      .insert(journalEntry)
      .select()
      .single()

    if (insertError) {
      console.error('JOURNAL_WRITE_FAILED', { operation: 'journal_write' })
      // Continue even if storage fails
    }

    console.log('Journal generated successfully:', { athlete_id: athleteId, activities: activities.length })

    return new Response(
      JSON.stringify({
        success: true,
        journal: insertedJournal || journalEntry
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )

  } catch (error) {
    const guardResponse = userGuardErrorResponse(error, corsHeaders)
    if (guardResponse) return guardResponse

    console.error('JOURNAL_GENERATE_UNEXPECTED_ERROR', { operation: 'journal_generate' })
    return new Response(
      JSON.stringify({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error'
        }
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )
  }
}

async function handleGenerateRecent(req: Request, deps: JournalDependencies) {
  try {
    const { athlete_id, weeks = 4 } = await req.json()
    const requestedAthleteId = parseLegacyAthleteId(athlete_id)
    const context = await deps.requireUser(req, requestedAthleteId)

    if (requestedAthleteId === null) {
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

    const requestedWeeks = Number(weeks)
    const weeksToGenerate = Number.isInteger(requestedWeeks)
      ? Math.min(4, Math.max(1, requestedWeeks))
      : 4

    console.log('Generating recent journals:', { athlete_id: context.athleteId, weeks: weeksToGenerate })

    const generatedEntries = []
    const today = new Date()

    for (let i = weeksToGenerate - 1; i >= 0; i--) {
      const dayOfWeek = today.getDay()
      const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
      const weekStart = new Date(today)
      weekStart.setDate(today.getDate() + daysToMonday - (i * 7))
      weekStart.setHours(0, 0, 0, 0)

      try {
        const generateReq = new Request('http://localhost/generate', {
          method: 'POST',
          headers: {
            Authorization: context.authorization,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            athlete_id: context.athleteId,
            week_start_date: weekStart.toISOString().split('T')[0]
          })
        })

        const response = await handleGenerate(generateReq, deps)
        const data = await response.json()

        if (data.success && data.journal) {
          generatedEntries.push(data.journal)
        }
      } catch {
        console.warn('JOURNAL_RECENT_WEEK_FAILED', {
          operation: 'journal_generate_recent',
          weekStart: weekStart.toISOString(),
        })
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        generated: generatedEntries.length,
        entries: generatedEntries
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )

  } catch (error) {
    const guardResponse = userGuardErrorResponse(error, corsHeaders)
    if (guardResponse) return guardResponse

    console.error('JOURNAL_RECENT_UNEXPECTED_ERROR', { operation: 'journal_generate_recent' })
    return new Response(
      JSON.stringify({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error'
        }
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )
  }
}

async function handleGetEntries(
  req: Request,
  athleteIdStr: string | null,
  limitStr: string | null,
  deps: JournalDependencies,
) {
  try {
    const requestedAthleteId = parseLegacyAthleteId(athleteIdStr)
    const context = await deps.requireUser(req, requestedAthleteId)

    if (requestedAthleteId === null) {
      return new Response(
        JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'athlete_id is required' } }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const parsedLimit = limitStr === null ? 10 : Number(limitStr)
    const limit = Number.isInteger(parsedLimit)
      ? Math.min(100, Math.max(1, parsedLimit))
      : 10

    console.log('Fetching journal entries:', { athlete_id: context.athleteId, limit })

    const supabaseAdmin = deps.getAdmin()

    const { data: entries, error } = await supabaseAdmin
      .from('training_journals')
      .select('*')
      .eq('athlete_id', context.athleteId)
      .order('week_start', { ascending: false })
      .limit(limit)

    if (error) {
      console.error('JOURNAL_ENTRY_LOOKUP_FAILED', { operation: 'journal_entry_lookup' })
      throw new Error('JOURNAL_ENTRY_LOOKUP_FAILED')
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

  } catch (error) {
    const guardResponse = userGuardErrorResponse(error, corsHeaders)
    if (guardResponse) return guardResponse

    console.error('JOURNAL_GET_UNEXPECTED_ERROR', { operation: 'journal_get' })
    return new Response(
      JSON.stringify({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error'
        }
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )
  }
}
