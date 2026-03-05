// activity-observations edge function
// Generates twin observations for recent activities, stored in activity_insights table

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')

interface Activity {
  id: number
  name: string
  activity_date: string
  distance: number
  moving_time: number
  average_speed: number
  average_heartrate?: number
  pr_count?: number
  perceived_exertion?: number
  activity_types: { name: string } | null
}

function paceMinPerMile(avgSpeed: number): string {
  if (!avgSpeed || avgSpeed === 0) return 'N/A'
  const minPerMile = (1609.34 / avgSpeed) / 60
  const mins = Math.floor(minPerMile)
  const secs = Math.round((minPerMile - mins) * 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''))
    if (!user) return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

    const { data: athlete } = await supabase.from('athletes').select('id').eq('auth_user_id', user.id).single()
    if (!athlete) return new Response(JSON.stringify({ observations: {} }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    const { data: activities } = await supabase
      .from('activities')
      .select('id, name, activity_date, distance, moving_time, average_speed, average_heartrate, pr_count, perceived_exertion, activity_types(name)')
      .eq('athlete_id', athlete.id)
      .gte('activity_date', thirtyDaysAgo.toISOString().split('T')[0])
      .order('activity_date', { ascending: false })
      .limit(10)

    if (!activities || activities.length === 0) {
      return new Response(JSON.stringify({ observations: {} }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const activityIds = activities.map(a => a.id)

    // Check existing observations
    const { data: existingInsights } = await supabase
      .from('activity_insights')
      .select('activity_id, insight_data')
      .in('activity_id', activityIds)
      .eq('insight_type', 'twin_observation')

    const existingMap: Record<number, string> = {}
    for (const insight of existingInsights ?? []) {
      const d = insight.insight_data as { observation?: string } | null
      if (d?.observation) existingMap[insight.activity_id] = d.observation
    }

    const needObservations = (activities as Activity[]).filter(a => !existingMap[a.id])

    if (needObservations.length > 0) {
      const allMiles = (activities as Activity[]).map(a => a.distance / 1609.34)
      const avgMiles = allMiles.reduce((s, v) => s + v, 0) / allMiles.length
      const paceSamples = (activities as Activity[]).filter(a => a.average_speed > 0).map(a => 1609.34 / a.average_speed / 60)
      const avgPaceVal = paceSamples.length > 0 ? paceSamples.reduce((s, v) => s + v, 0) / paceSamples.length : null

      const activityLines = needObservations.slice(0, 6).map(a => {
        const mi = (a.distance / 1609.34).toFixed(2)
        const pace = paceMinPerMile(a.average_speed)
        const hr = a.average_heartrate ? `, HR ${Math.round(a.average_heartrate)}` : ''
        const pr = (a.pr_count ?? 0) > 0 ? `, ${a.pr_count} PR` : ''
        const rpe = a.perceived_exertion ? `, RPE ${a.perceived_exertion}` : ''
        const type = a.activity_types?.name ?? 'Run'
        const date = new Date(a.activity_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        return `[ID:${a.id}] ${date}: "${a.name}" — ${mi}mi @ ${pace}/mi${hr}${pr}${rpe} (${type})`
      }).join('\n')

      const prompt = `You are a digital running twin. Generate one observation per activity — specific, data-backed, 12 words max. Compare to other activities when it adds meaning. Never generic.

Context (last 10 activities):
- Avg distance: ${avgMiles.toFixed(1)}mi
- Avg pace: ${avgPaceVal ? `${Math.floor(avgPaceVal)}:${Math.round((avgPaceVal % 1) * 60).toString().padStart(2, '0')}/mi` : 'N/A'}

Activities:
${activityLines}

Respond ONLY with JSON mapping activity ID (as string) to observation:
{"123": "Fastest 5-miler this month. Pace held through mile 5.", "124": "Easy effort dialed in — HR 138, textbook aerobic run."}`

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 600, messages: [{ role: 'user', content: prompt }] }),
      })

      if (response.ok) {
        const data = await response.json()
        let jsonText = data.content[0].text
        if (jsonText.includes('```')) jsonText = jsonText.split('```')[1].replace('json', '').trim().split('```')[0].trim()

        try {
          const observations: Record<string, string> = JSON.parse(jsonText)

          const upserts = Object.entries(observations).map(([id, obs]) => ({
            activity_id: parseInt(id),
            insight_type: 'twin_observation',
            insight_data: { observation: obs },
          }))

          if (upserts.length > 0) {
            await supabase
              .from('activity_insights')
              .upsert(upserts, { onConflict: 'activity_id,insight_type' })
              .catch(() => {
                // If upsert conflict key is wrong, do individual inserts
                return supabase.from('activity_insights').insert(upserts)
              })
          }

          for (const [id, obs] of Object.entries(observations)) {
            existingMap[parseInt(id)] = obs
          }
        } catch (parseErr) {
          console.error('Failed to parse observations JSON:', parseErr)
        }
      }
    }

    return new Response(JSON.stringify({ observations: existingMap }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    console.error('activity-observations error:', err)
    return new Response(JSON.stringify({ observations: {} }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
