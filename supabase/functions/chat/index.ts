// Supabase Edge Function: chat
// AI-powered conversational coaching with Claude

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const { athlete_id, message, conversation_id } = await req.json()

    if (!athlete_id || !message) {
      return new Response(
        JSON.stringify({
          error: {
            code: 'INVALID_REQUEST',
            message: 'athlete_id and message are required'
          }
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    console.log('Chat request:', { athlete_id, messageLength: message.length, conversation_id })

    // Create Supabase client with service role key for database access
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Get recent activities (last 14 days)
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - 14)

    const { data: activities, error: activitiesError } = await supabaseAdmin
      .from('activities')
      .select('*')
      .eq('athlete_id', athlete_id)
      .gte('activity_date', cutoffDate.toISOString())
      .order('activity_date', { ascending: false })
      .limit(20)

    if (activitiesError) {
      console.error('Error fetching activities:', activitiesError)
    }

    // Get athlete info
    const { data: athlete, error: athleteError } = await supabaseAdmin
      .from('athletes')
      .select('*')
      .eq('id', athlete_id)
      .single()

    if (athleteError) {
      console.error('Error fetching athlete:', athleteError)
    }

    // Build context for Claude
    const contextParts = []

    if (athlete) {
      contextParts.push(`Athlete: ${athlete.first_name} ${athlete.last_name}`)
      if (athlete.city || athlete.state || athlete.country) {
        contextParts.push(`Location: ${[athlete.city, athlete.state, athlete.country].filter(Boolean).join(', ')}`)
      }
    }

    if (activities && activities.length > 0) {
      contextParts.push(`\nRecent activities (last 14 days):`)
      activities.forEach((activity: any) => {
        const date = new Date(activity.activity_date).toLocaleDateString()
        const distanceKm = (activity.distance / 1000).toFixed(2)
        const durationMin = Math.round(activity.moving_time / 60)
        const paceMinPerKm = activity.moving_time / 60 / (activity.distance / 1000)
        const pace = `${Math.floor(paceMinPerKm)}:${String(Math.round((paceMinPerKm % 1) * 60)).padStart(2, '0')}/km`

        contextParts.push(`- ${date}: ${activity.name} - ${distanceKm}km in ${durationMin}min (${pace})`)

        if (activity.average_heart_rate) {
          contextParts.push(`  HR: ${Math.round(activity.average_heart_rate)} bpm`)
        }
        if (activity.elevation_gain) {
          contextParts.push(`  Elevation: ${Math.round(activity.elevation_gain)}m`)
        }
      })
    } else {
      contextParts.push('\nNo recent activities found.')
    }

    const context = contextParts.join('\n')

    // Call Anthropic API
    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 2048,
        system: `You are an expert running coach. You provide personalized training advice based on the athlete's activity history. Be supportive, concise, and data-driven. Use the context provided to give specific, actionable advice.

Context about the athlete:
${context}`,
        messages: [
          {
            role: 'user',
            content: message
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
    const answer = anthropicData.content[0].text

    // Generate or use conversation ID
    const conversationId = conversation_id || crypto.randomUUID()

    // Optionally store conversation in database
    // (Skipped for now - can be added later)

    console.log('Chat response generated:', { athlete_id, answerLength: answer.length, conversationId })

    return new Response(
      JSON.stringify({
        answer,
        conversation_id: conversationId,
        context: {
          activities_count: activities?.length || 0,
          athlete_name: athlete ? `${athlete.first_name} ${athlete.last_name}` : null
        },
        timestamp: new Date().toISOString()
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )

  } catch (error) {
    console.error('Error in chat function:', error)
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
