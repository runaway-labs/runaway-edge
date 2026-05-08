import Anthropic from 'npm:@anthropic-ai/sdk'
import { corsHeaders } from '../_shared/cors.ts'

const NUM_CUES = 12
const MIN_CUES = 5

const anthropic = new Anthropic({
  apiKey: Deno.env.get('ANTHROPIC_API_KEY') ?? '',
})

const SYSTEM_PROMPT = `You are a running coach who knows this runner deeply. Generate exactly ${NUM_CUES} short, punchy motivational voice cues for their run today. Each cue is 1–2 sentences. Make them personal to their identity and milestone status. Vary the emotional arc: early cues are grounding (remind them why they are here), mid-run cues are identity-reinforcing (this is who they are), late-run cues are gritty (they have built this, finish strong). Do not use filler phrases like "You've got this" or "Keep it up" — make every cue specific to this runner. Return a JSON object with a single key "cues" containing an array of ${NUM_CUES} strings.`

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const { athlete_id, runner_identity, why_i_run, core_values, earned_milestone_keys } = await req.json()

    if (!runner_identity || !why_i_run) {
      return new Response(
        JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'runner_identity and why_i_run are required' } }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const milestoneText = Array.isArray(earned_milestone_keys) && earned_milestone_keys.length > 0
      ? `Earned milestones: ${(earned_milestone_keys as string[]).join(', ')}`
      : 'No milestones earned yet — this may be an early run.'

    const userMessage = [
      `Runner identity: ${runner_identity}`,
      `Why they run: ${why_i_run}`,
      `Core values: ${Array.isArray(core_values) ? (core_values as string[]).join(', ') : 'not specified'}`,
      milestoneText,
    ].join('\n')

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    })

    const responseText = message.content[0].type === 'text' ? message.content[0].text : ''

    let cues: string[]
    try {
      const parsed = JSON.parse(responseText)
      cues = parsed.cues
      if (!Array.isArray(cues) || cues.length < MIN_CUES) {
        throw new Error('Invalid cues array')
      }
    } catch {
      console.error('Failed to parse Claude response:', responseText)
      return new Response(
        JSON.stringify({ error: { code: 'PARSE_ERROR', message: 'Failed to parse cues from Claude' } }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('generate-run-cues complete:', { athlete_id, cue_count: cues.length })

    return new Response(
      JSON.stringify({ cues }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('Error in generate-run-cues:', error)
    return new Response(
      JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
