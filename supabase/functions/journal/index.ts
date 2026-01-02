// Supabase Edge Function: journal
// Generate AI-powered training journal entries

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  const url = new URL(req.url)
  const pathParts = url.pathname.split('/').filter(Boolean)

  // POST /journal/generate - Generate journal for a week
  if (req.method === 'POST' && pathParts[pathParts.length - 1] === 'generate') {
    return await handleGenerate(req)
  }

  // POST /journal/generate-recent - Generate for multiple weeks
  if (req.method === 'POST' && pathParts[pathParts.length - 1] === 'generate-recent') {
    return await handleGenerateRecent(req)
  }

  // GET /journal/:athlete_id - Get journal entries
  if (req.method === 'GET' && pathParts.length >= 2) {
    const athleteId = pathParts[pathParts.length - 1]
    return await handleGetEntries(athleteId, url.searchParams.get('limit'))
  }

  return new Response(
    JSON.stringify({ error: 'Not found' }),
    {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    }
  )
})

async function handleGenerate(req: Request) {
  try {
    const { athlete_id, week_start_date } = await req.json()

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

    console.log('Generating journal:', { athlete_id, weekStart: weekStart.toISOString() })

    // Create Supabase client
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Get activities for the week
    const { data: activities, error: activitiesError } = await supabaseAdmin
      .from('activities')
      .select('*')
      .eq('athlete_id', athlete_id)
      .gte('activity_date', weekStart.toISOString())
      .lt('activity_date', weekEnd.toISOString())
      .order('activity_date', { ascending: true })

    if (activitiesError) {
      throw new Error(`Error fetching activities: ${activitiesError.message}`)
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
    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY || '',
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
      const errorData = await anthropicResponse.text()
      console.error('Anthropic API error:', errorData)
      throw new Error(`Anthropic API error: ${anthropicResponse.status}`)
    }

    const anthropicData = await anthropicResponse.json()
    const journalText = anthropicData.content[0].text

    // Store journal in database
    const journalEntry = {
      athlete_id,
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
      console.error('Error storing journal:', insertError)
      // Continue even if storage fails
    }

    console.log('Journal generated successfully:', { athlete_id, activities: activities.length })

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
    console.error('Error generating journal:', error)
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
}

async function handleGenerateRecent(req: Request) {
  try {
    const { athlete_id, weeks = 4 } = await req.json()

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

    console.log('Generating recent journals:', { athlete_id, weeks })

    const generatedEntries = []
    const today = new Date()

    for (let i = weeks - 1; i >= 0; i--) {
      const dayOfWeek = today.getDay()
      const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
      const weekStart = new Date(today)
      weekStart.setDate(today.getDate() + daysToMonday - (i * 7))
      weekStart.setHours(0, 0, 0, 0)

      try {
        const generateReq = new Request('http://localhost/generate', {
          method: 'POST',
          body: JSON.stringify({
            athlete_id,
            week_start_date: weekStart.toISOString().split('T')[0]
          })
        })

        const response = await handleGenerate(generateReq)
        const data = await response.json()

        if (data.success && data.journal) {
          generatedEntries.push(data.journal)
        }
      } catch (error) {
        console.warn('Failed to generate journal for week:', weekStart.toISOString(), error.message)
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
    console.error('Error generating recent journals:', error)
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
}

async function handleGetEntries(athleteIdStr: string, limitStr: string | null) {
  try {
    const athlete_id = parseInt(athleteIdStr)
    const limit = limitStr ? parseInt(limitStr) : 10

    console.log('Fetching journal entries:', { athlete_id, limit })

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: entries, error } = await supabaseAdmin
      .from('training_journals')
      .select('*')
      .eq('athlete_id', athlete_id)
      .order('week_start', { ascending: false })
      .limit(limit)

    if (error) {
      throw new Error(`Error fetching journals: ${error.message}`)
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
    console.error('Error fetching journal entries:', error)
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
}
