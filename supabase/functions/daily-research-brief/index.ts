// Supabase Edge Function: daily-research-brief
// AI-powered daily research brief for Runaway iOS app improvements
// Runs every morning at 6 AM via pg_cron

import { corsHeaders } from '../_shared/cors.ts'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')
const GITHUB_TOKEN = Deno.env.get('GITHUB_TOKEN')
const GITHUB_REPO_OWNER = Deno.env.get('GITHUB_REPO_OWNER') || 'runaway-labs'
const GITHUB_REPO_NAME = Deno.env.get('GITHUB_REPO_NAME') || 'Runaway-iOS'

interface ResearchTopic {
  title: string
  prompt: string
}

// Rotating topics - one per day to reduce API calls and compute time
const ALL_TOPICS: ResearchTopic[] = [
  {
    title: 'Emerging Fitness Technology',
    prompt: `Research the latest emerging technologies in fitness and running apps (2024-2025). Cover: sensor tech, GPS improvements, battery optimization, offline-first patterns. Provide 5 specific, actionable recommendations with implementation priority.`
  },
  {
    title: 'AI & Machine Learning Use Cases',
    prompt: `Research cutting-edge AI/ML for running apps: on-device ML (Core ML, Apple Foundation Models), personalized training, injury prediction, voice coaching, readiness scoring. Provide 5 implementation ideas with technical approaches.`
  },
  {
    title: 'Competitive Analysis',
    prompt: `Analyze Strava, Nike Run Club, Garmin Connect, WHOOP: engagement features, differentiators, social/gamification, premium features, UX patterns. Focus on features a solo dev can implement. Provide top 5 recommendations.`
  },
  {
    title: 'iOS Architecture & Performance',
    prompt: `iOS best practices 2025: SwiftUI optimization, background location, SwiftData, WidgetKit, App Intents, Live Activities, memory/battery optimization. Provide 5 specific architectural patterns and implementation strategies.`
  },
  {
    title: 'Health & Wellness Integration',
    prompt: `HealthKit integration: workout types, sleep/performance correlation, HRV readiness scoring, recovery science. Provide 5 data-driven implementation recommendations.`
  },
  {
    title: 'User Experience & Design Trends',
    prompt: `Mobile fitness app UX trends 2025: onboarding, data visualization, motivation/habit formation, accessibility, dark mode, haptics. Provide 5 specific UI/UX improvements for a running app.`
  },
  {
    title: 'Monetization & Growth',
    prompt: `Fitness app monetization: subscription models, premium features worth paying for, user acquisition, retention strategies, App Store optimization. Provide 5 actionable growth recommendations.`
  }
]

// Get today's topic (rotates daily)
function getTodaysTopic(): ResearchTopic {
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000)
  return ALL_TOPICS[dayOfYear % ALL_TOPICS.length]
}

const RESEARCH_TOPICS: ResearchTopic[] = [getTodaysTopic()]

// App context to provide Claude with understanding of Runaway
const APP_CONTEXT = `
# Runaway iOS - App Context

Runaway is a personalized running companion app built with SwiftUI for iOS. Key features include:

## Current Architecture
- SwiftUI with @Observable pattern (iOS 17+)
- Supabase backend (PostgreSQL, Auth, Realtime, Edge Functions)
- Strava integration for activity sync
- GPS tracking with background location
- AI coaching via Claude API
- Widget support (WidgetKit)
- Daily commitment tracking
- Awards/achievements system

## Tech Stack
- Swift/SwiftUI
- Supabase (PostgreSQL, Auth, Storage, Realtime)
- MapKit for route display
- Core Location for GPS
- Claude API for AI features
- Charts framework for data visualization

## Key Services
- ActivityRecordingService - GPS workout recording
- RealtimeService - Live data sync
- AwardsService - Lifetime achievement tracking
- ChatService - AI coaching conversations
- HealthKit integration (planned)

## Current Focus Areas
- HealthKit workout integration
- Daily readiness/recovery scoring
- Apple Foundation Models (on-device AI)
- Enhanced training insights
- Performance optimization

The app targets serious recreational runners who want data-driven insights without the complexity of pro-level tools.
`

async function callClaude(systemPrompt: string, userPrompt: string, maxTokens: number = 2048): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userPrompt
        }
      ]
    })
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Claude API error: ${response.status} - ${errorText}`)
  }

  const data = await response.json()
  return data.content[0].text
}

async function commitToGitHub(content: string, filename: string): Promise<{ success: boolean; url?: string; error?: string }> {
  const path = `research/${filename}`

  // First, check if file already exists to get its SHA (needed for updates)
  let existingSha: string | undefined

  try {
    const checkResponse = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/${path}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }
    )

    if (checkResponse.ok) {
      const existingFile = await checkResponse.json()
      existingSha = existingFile.sha
      console.log(`File exists, will update. SHA: ${existingSha}`)
    }
  } catch (e) {
    // File doesn't exist, that's fine - we'll create it
    console.log('File does not exist, will create new')
  }

  // Create or update file
  const requestBody: Record<string, string> = {
    message: `Daily Research Brief - ${new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })}`,
    content: btoa(unescape(encodeURIComponent(content))), // Base64 encode with UTF-8 support
    branch: 'main'
  }

  // Include SHA if updating existing file
  if (existingSha) {
    requestBody.sha = existingSha
  }

  const createFileResponse = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/${path}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify(requestBody)
    }
  )

  if (!createFileResponse.ok) {
    const errorData = await createFileResponse.text()
    console.error('GitHub API error:', errorData)
    return { success: false, error: `GitHub API error: ${createFileResponse.status} - ${errorData}` }
  }

  const responseData = await createFileResponse.json()
  return {
    success: true,
    url: responseData.content?.html_url || `https://github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/blob/main/${path}`
  }
}

function generateTimestamp(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

async function generateResearchBrief(): Promise<string> {
  const timestamp = generateTimestamp()
  const todaysTopic = getTodaysTopic()
  const dateFormatted = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })

  // Get upcoming topics for the week
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000)
  const upcomingTopics = Array.from({ length: 7 }, (_, i) =>
    ALL_TOPICS[(dayOfYear + i) % ALL_TOPICS.length].title
  )

  let markdown = `# Runaway iOS - Daily Research Brief

**Date:** ${dateFormatted}
**Today's Focus:** ${todaysTopic.title}

---

> Your daily dose of innovation and insights for building the best running app.

---

`

  // Research today's topic
  const systemPrompt = `You are a senior iOS developer and product strategist researching improvements for a running app called Runaway. You have deep expertise in Swift, SwiftUI, fitness technology, and mobile app architecture.

${APP_CONTEXT}

Provide detailed, actionable research with:
- Specific technical recommendations (concepts and approaches, NOT code)
- Priority rankings (High/Medium/Low)
- Implementation effort estimates
- Links to relevant documentation or resources when applicable

Do NOT include code snippets, pseudocode, or code examples. Focus on strategic insights and actionable recommendations.

Be thorough but focused. This is for a solo developer, so prioritize high-impact, achievable improvements.`

  console.log(`Researching: ${todaysTopic.title}...`)

  try {
    const research = await callClaude(systemPrompt, todaysTopic.prompt, 2500)

    markdown += `## ${todaysTopic.title}

${research}

---

## Today's Action Items

Based on today's research, here are your priorities:

- [ ] **High Priority:** Implement the top recommendation from above
- [ ] **Medium Priority:** Research one linked resource in depth
- [ ] **Quick Win:** Make one small improvement inspired by this brief

---

## This Week's Topics

| Day | Topic |
|-----|-------|
${upcomingTopics.map((topic, i) => `| ${i === 0 ? '**Today**' : `Day ${i + 1}`} | ${i === 0 ? `**${topic}**` : topic} |`).join('\n')}

---

## Notes

*This research brief was automatically generated by Claude AI. Topics rotate daily to cover all aspects of app development throughout the week.*

**Generated:** ${new Date().toISOString()}
**Model:** claude-3-5-sonnet
**Topic:** ${todaysTopic.title} (${(dayOfYear % ALL_TOPICS.length) + 1}/${ALL_TOPICS.length})

---

Happy building! 🏃‍♂️
`
  } catch (error) {
    console.error(`Error researching ${todaysTopic.title}:`, error)
    markdown += `## ${todaysTopic.title}

*Research temporarily unavailable. Error: ${error.message}*

Please try again or check the Edge Function logs.

---

**Generated:** ${new Date().toISOString()}
`
  }

  return markdown
}

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // Check for required environment variables
    if (!ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not configured')
    }
    if (!GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN is not configured')
    }

    console.log('Starting daily research brief generation...')
    const startTime = Date.now()

    // Generate the research brief
    const markdown = await generateResearchBrief()

    // Create filename with timestamp
    const filename = `${generateTimestamp()}-daily-brief.md`

    // Commit to GitHub
    console.log(`Committing research brief to GitHub: ${filename}`)
    const commitResult = await commitToGitHub(markdown, filename)

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`Research brief completed in ${duration}s`)

    if (commitResult.success) {
      return new Response(
        JSON.stringify({
          success: true,
          message: 'Daily research brief generated and committed successfully',
          filename,
          url: commitResult.url,
          duration: `${duration}s`,
          topics: RESEARCH_TOPICS.length,
          timestamp: new Date().toISOString()
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    } else {
      // Brief was generated but commit failed - return the markdown anyway
      return new Response(
        JSON.stringify({
          success: false,
          message: 'Research brief generated but GitHub commit failed',
          error: commitResult.error,
          markdown: markdown.substring(0, 1000) + '...', // Preview
          duration: `${duration}s`
        }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

  } catch (error) {
    console.error('Error in daily-research-brief function:', error)
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
