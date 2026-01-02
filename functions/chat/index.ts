// Chat Edge Function
// AI-powered conversational coaching with RAG over activity history

import { createSupabaseClient } from '../_shared/supabase.ts'
import { createAnthropicClient } from '../_shared/anthropic.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { ActivitySummarizer } from '../_shared/activity-summarizer.ts'
import type { Activity } from '../_shared/types.ts'

interface ChatRequest {
  athlete_id: number
  message: string
  conversation_id?: string
}

interface ChatContext {
  profile: any
  recentActivities: Activity[]
  relevantActivities: Activity[]
  stats: {
    totalActivities: number
    totalDistanceMiles: string
    totalHours: string
  }
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabase = createSupabaseClient()
    const anthropic = createAnthropicClient()

    // Parse request body
    const { athlete_id, message, conversation_id }: ChatRequest = await req.json()

    // Validate input
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

    console.log('Chat request', {
      athlete_id,
      messageLength: message.length,
      conversationId: conversation_id,
      isNewConversation: !conversation_id
    })

    // Generate conversation ID if not provided
    const currentConversationId = conversation_id || crypto.randomUUID()

    // Load conversation history if continuing a conversation
    let conversationHistory: any[] = []
    if (conversation_id) {
      const { data: history } = await supabase
        .from('chat_conversations')
        .select('role, message, timestamp')
        .eq('conversation_id', conversation_id)
        .order('timestamp', { ascending: true })
        .limit(10)

      conversationHistory = history || []
      console.log('Loaded conversation history', { messageCount: conversationHistory.length })
    }

    // Build context from athlete's data
    const context = await buildContext(supabase, athlete_id, message)

    // Format prompt for Claude
    const prompt = formatPromptWithHistory(message, context, conversationHistory)

    console.log('Sending to Claude', {
      athlete_id,
      promptLength: prompt.length,
      recentActivities: context.recentActivities.length,
      relevantActivities: context.relevantActivities.length,
      historyMessages: conversationHistory.length
    })

    // Call Claude API
    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: prompt
      }]
    })

    const answer = response.content[0].type === 'text' ? response.content[0].text : ''

    // Store conversation in database
    await storeConversation(supabase, athlete_id, message, answer, context, currentConversationId)

    console.log('Chat response generated', {
      athlete_id,
      responseLength: answer.length,
      conversationId: currentConversationId
    })

    // Return response
    return new Response(
      JSON.stringify({
        answer,
        conversation_id: currentConversationId,
        context: {
          recentActivitiesCount: context.recentActivities.length,
          relevantActivitiesCount: context.relevantActivities.length,
          totalActivities: context.stats.totalActivities,
          historyMessages: conversationHistory.length
        },
        timestamp: new Date().toISOString()
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )

  } catch (error) {
    console.error('Error in chat endpoint', {
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
 * Build context for Claude from athlete data
 */
async function buildContext(
  supabase: any,
  athleteId: number,
  userQuery: string
): Promise<ChatContext> {
  const context: ChatContext = {
    profile: null,
    recentActivities: [],
    relevantActivities: [],
    stats: {
      totalActivities: 0,
      totalDistanceMiles: '0',
      totalHours: '0'
    }
  }

  // Get athlete profile (if exists)
  const { data: profile } = await supabase
    .from('athlete_ai_profiles')
    .select('*')
    .eq('athlete_id', athleteId)
    .single()

  context.profile = profile

  // Get recent activities (last 14 days)
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - 14)

  const { data: recentActivities } = await supabase
    .from('activities')
    .select('*')
    .eq('athlete_id', athleteId)
    .gte('activity_date', cutoffDate.toISOString())
    .order('activity_date', { ascending: false })
    .limit(20)

  context.recentActivities = recentActivities || []

  // Search for relevant historical activities using semantic search
  // Check if query is temporal (asking about "last" or "recent")
  const isTemporalQuery = /\b(last|recent|latest|when did i|most recent)\b/i.test(userQuery)

  if (isTemporalQuery) {
    // For temporal queries, prioritize date ordering
    // TODO: Combine with semantic search once embeddings are set up
    const { data: temporalActivities } = await supabase
      .from('activities')
      .select('*')
      .eq('athlete_id', athleteId)
      .order('activity_date', { ascending: false })
      .limit(10)

    context.relevantActivities = temporalActivities || []
  }

  // Calculate basic stats
  const { data: stats } = await supabase
    .from('activities')
    .select('distance, moving_time')
    .eq('athlete_id', athleteId)

  if (stats && stats.length > 0) {
    const totalDistance = stats.reduce((sum: number, a: any) =>
      sum + (parseFloat(a.distance) || 0), 0)
    const totalTime = stats.reduce((sum: number, a: any) =>
      sum + (a.moving_time || 0), 0)

    context.stats = {
      totalActivities: stats.length,
      totalDistanceMiles: ActivitySummarizer.metersToMiles(totalDistance) || '0',
      totalHours: (totalTime / 3600).toFixed(1)
    }
  }

  return context
}

/**
 * Format prompt with conversation history for Claude
 */
function formatPromptWithHistory(
  userQuery: string,
  context: ChatContext,
  conversationHistory: any[]
): string {
  const parts: string[] = []

  // System context
  parts.push('You are an experienced running coach with deep expertise in exercise physiology, training periodization, and athlete psychology.')
  parts.push('')

  // Include athlete profile/memory if available
  if (context.profile?.core_memory) {
    const memory = context.profile.core_memory
    parts.push('ATHLETE PROFILE & MEMORY:')

    if (memory.personal) {
      if (memory.personal.preferred_name || memory.personal.experience_level) {
        parts.push(`- Athlete: ${memory.personal.preferred_name || 'Runner'} (${memory.personal.experience_level || 'runner'})`)
      }
    }

    if (memory.goals?.primary) {
      parts.push(`- Current Goal: ${memory.goals.primary}`)
    }

    if (memory.physical_profile?.current_concerns?.length > 0) {
      parts.push(`- Current Concerns: ${memory.physical_profile.current_concerns.join(', ')}`)
    }

    parts.push('')
  }

  // Add conversation history if exists
  if (conversationHistory.length > 0) {
    parts.push('CONVERSATION HISTORY:')
    conversationHistory.forEach((msg: any) => {
      const role = msg.role === 'user' ? 'ATHLETE' : 'COACH'
      parts.push(`${role}: ${msg.message}`)
    })
    parts.push('')
  }

  // Athlete stats
  if (context.stats.totalActivities > 0) {
    parts.push('ATHLETE STATISTICS:')
    parts.push(`- Total activities: ${context.stats.totalActivities}`)
    parts.push(`- Total distance: ${context.stats.totalDistanceMiles} miles`)
    parts.push(`- Total time: ${context.stats.totalHours} hours`)
    parts.push('')
  }

  // Recent training (last 14 days)
  if (context.recentActivities.length > 0) {
    parts.push('RECENT TRAINING (last 14 days):')
    context.recentActivities.forEach(activity => {
      const summary = ActivitySummarizer.generateSummary(activity)
      parts.push(`- ${summary}`)
    })
    parts.push('')
  }

  // Relevant historical activities
  if (context.relevantActivities.length > 0) {
    parts.push('RELEVANT HISTORICAL ACTIVITIES:')
    context.relevantActivities.forEach(activity => {
      const summary = ActivitySummarizer.generateDetailedSummary(activity)
      parts.push(`- ${summary}`)
    })
    parts.push('')
  }

  // Current question
  parts.push('CURRENT ATHLETE QUESTION:')
  parts.push(userQuery)
  parts.push('')

  // Instructions
  parts.push('INSTRUCTIONS:')
  parts.push('- Continue the conversation naturally, building on previous context')
  parts.push('- Provide a clear, concise answer based on the data above')
  parts.push('- Reference specific activities and dates when relevant')
  parts.push('- Explain the "why" behind patterns, not just the "what"')
  parts.push('- If data is insufficient to answer, say so honestly')
  parts.push('- Be encouraging and supportive in tone')
  parts.push('- Keep response to 3-5 sentences unless more detail is needed')

  return parts.join('\n')
}

/**
 * Store conversation in database
 */
async function storeConversation(
  supabase: any,
  athleteId: number,
  userMessage: string,
  assistantMessage: string,
  context: ChatContext,
  conversationId: string
): Promise<void> {
  const conversationEntries = [
    {
      athlete_id: athleteId,
      conversation_id: conversationId,
      message: userMessage,
      role: 'user',
      context_used: {
        recentActivities: context.recentActivities.length,
        relevantActivities: context.relevantActivities.length
      }
    },
    {
      athlete_id: athleteId,
      conversation_id: conversationId,
      message: assistantMessage,
      role: 'assistant',
      context_used: null
    }
  ]

  const { error } = await supabase
    .from('chat_conversations')
    .insert(conversationEntries)

  if (error) {
    console.error('Error storing conversation', {
      error: error.message,
      conversationId
    })
    // Don't throw - conversation storage failure shouldn't break the chat
  }
}
