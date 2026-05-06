// Supabase Edge Function: feedback-workout
// Adlerian post-workout encouragement using athlete identity profile

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')

function deriveEffortLabel(distance: number | null, elapsedTime: number | null): string {
  if (!distance || !elapsedTime || distance === 0 || elapsedTime === 0) {
    return 'Easy'
  }

  const durationMin = elapsedTime / 60
  const paceMinPerKm = (elapsedTime / (distance / 1000)) / 60

  if (durationMin >= 70) return 'Long'
  if (paceMinPerKm < 6.0 && durationMin < 40) return 'Tempo'
  if (paceMinPerKm <= 7.0) return 'Moderate'
  return 'Easy'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const { athlete_id, activity_id } = await req.json()

    if (!athlete_id || !activity_id) {
      return new Response(
        JSON.stringify({
          error: {
            code: 'INVALID_REQUEST',
            message: 'athlete_id and activity_id are required'
          }
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Fetch activity, scoped to both activity ID and athlete ID
    const { data: activity, error: activityError } = await supabaseAdmin
      .from('activities')
      .select('id, distance, elapsed_time, average_heartrate, sport_type, name')
      .eq('id', activity_id)
      .eq('athlete_id', athlete_id)
      .single()

    if (activityError || !activity) {
      console.error('Activity not found:', activityError)
      return new Response(
        JSON.stringify({
          error: {
            code: 'NOT_FOUND',
            message: 'Activity not found for this athlete'
          }
        }),
        {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    // Fetch Adlerian profile from athlete_ai_profiles
    const { data: aiProfile } = await supabaseAdmin
      .from('athlete_ai_profiles')
      .select('core_memory')
      .eq('athlete_id', athlete_id)
      .maybeSingle()

    const adlerianProfile = aiProfile?.core_memory?.adlerian_profile ?? {}
    const runnerIdentity: string = adlerianProfile.runner_identity ?? 'runner'
    const whyIRun: string = adlerianProfile.why_i_run ?? ''

    const effortLabel = deriveEffortLabel(activity.distance, activity.elapsed_time)

    const distanceKm = activity.distance ? (activity.distance / 1000).toFixed(2) : '0'
    const durationMin = activity.elapsed_time ? Math.round(activity.elapsed_time / 60) : 0
    const sportType = activity.sport_type ?? 'Run'
    const whyDisplay = whyIRun || '(not set)'

    const prompt = `You are an Adlerian running coach. Write 2-3 sentences of post-workout encouragement.

Rules:
- Open by acknowledging they showed up ("You got out there", "Today you ran", "You laced up")
- Name their identity naturally: "${runnerIdentity}"
- Never compare to a goal, PR, or previous run
- Never use "but", "however", or pivot language
- 2-3 sentences maximum
- Second person

Athlete context:
- Runner identity: ${runnerIdentity}
- Why they run: ${whyDisplay}
- Today's workout: ${distanceKm}km in ${durationMin}min (${effortLabel})
- Sport: ${sportType}

Respond with ONLY the feedback text. No JSON, no quotes, no preamble.`

    let feedback = `You showed up today — that's what a ${runnerIdentity} does.`

    try {
      const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY || '',
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 200,
          messages: [
            {
              role: 'user',
              content: prompt
            }
          ]
        })
      })

      if (anthropicResponse.ok) {
        const anthropicData = await anthropicResponse.json()
        feedback = anthropicData.content[0].text.trim()
      } else {
        const errorText = await anthropicResponse.text()
        console.error('Anthropic API error:', anthropicResponse.status, errorText)
      }
    } catch (claudeError) {
      console.error('Claude call failed, using default feedback:', claudeError)
    }

    // Insert insight row — one per call, duplicates are acceptable
    const { error: insertError } = await supabaseAdmin
      .from('activity_insights')
      .insert({
        activity_id,
        insight_type: 'adlerian_feedback',
        insight_data: {
          content: feedback,
          effort_label: effortLabel,
          athlete_id
        },
        generated_by: 'feedback-workout'
      })

    if (insertError) {
      console.error('Failed to insert activity insight:', insertError)
    }

    return new Response(
      JSON.stringify({ feedback, effort_label: effortLabel }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )

  } catch (error) {
    console.error('Error in feedback-workout function:', error)
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
