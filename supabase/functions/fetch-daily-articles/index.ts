// Supabase Edge Function: fetch-daily-articles
// Fetches running/fitness articles from RSS feeds and stores in database
// Runs every morning at 6 AM via pg_cron - eliminates load times in the app

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Initialize Supabase client with service role for database writes
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// RSS Feed configuration
interface RSSFeed {
  name: string
  url: string
  defaultCategory: string
}

const RSS_FEEDS: RSSFeed[] = [
  { name: "Runner's World", url: "https://www.runnersworld.com/rss/all.xml", defaultCategory: "training" },
  { name: "Running Magazine", url: "https://runningmagazine.ca/feed/", defaultCategory: "general" },
  { name: "iRunFar", url: "https://www.irunfar.com/feed", defaultCategory: "training" },
  { name: "Outside Running", url: "https://www.outsideonline.com/category/running/feed/", defaultCategory: "training" },
  { name: "Women's Running", url: "https://womensrunning.com/feed/", defaultCategory: "general" },
  { name: "Trail Runner Magazine", url: "https://www.trailrunnermag.com/feed/", defaultCategory: "training" },
  { name: "Podium Runner", url: "https://www.podiumrunner.com/feed/", defaultCategory: "training" },
]

// Article category detection keywords
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  health: ["injury", "health", "wellness", "recovery", "pain", "stretching", "therapy", "medical", "doctor", "prevention", "treatment", "healing", "physio", "physical therapy"],
  nutrition: ["nutrition", "diet", "food", "fuel", "hydration", "eating", "meal", "snack", "supplement", "vitamin", "protein", "carb", "electrolyte", "recipe"],
  gear: ["shoe", "gear", "equipment", "watch", "gps", "apparel", "clothing", "tech", "review", "test", "product", "brand", "model", "kit"],
  events: ["race", "marathon", "5k", "10k", "half", "event", "calendar", "registration", "results", "finish", "medal", "virtual", "boston", "nyc"],
  training: ["training", "workout", "plan", "schedule", "speed", "tempo", "interval", "technique", "form", "coaching", "tips", "mileage", "base", "taper"],
}

interface RSSItem {
  title: string
  description: string
  link: string
  author?: string
  pubDate?: string
  imageUrl?: string
}

interface ArticleRecord {
  title: string
  summary: string
  url: string
  image_url?: string
  author?: string
  source: string
  category: string
  tags: string[]
  published_at?: string
  relevance_score: number
  is_active: boolean
}

// Parse RSS feed XML
function parseRSS(xml: string): RSSItem[] {
  const items: RSSItem[] = []

  // Simple regex-based XML parsing for RSS items
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi
  const titleRegex = /<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/i
  const descRegex = /<description><!\[CDATA\[(.*?)\]\]><\/description>|<description>(.*?)<\/description>/is
  const linkRegex = /<link>(.*?)<\/link>/i
  const authorRegex = /<(?:dc:creator|author)><!\[CDATA\[(.*?)\]\]><\/(?:dc:creator|author)>|<(?:dc:creator|author)>(.*?)<\/(?:dc:creator|author)>/i
  const pubDateRegex = /<pubDate>(.*?)<\/pubDate>/i
  const imageRegex = /<media:content[^>]*url="([^"]*)"[^>]*>|<enclosure[^>]*url="([^"]*)"[^>]*type="image|<img[^>]*src="([^"]*)"/i

  let match
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1]

    const titleMatch = titleRegex.exec(itemXml)
    const descMatch = descRegex.exec(itemXml)
    const linkMatch = linkRegex.exec(itemXml)
    const authorMatch = authorRegex.exec(itemXml)
    const pubDateMatch = pubDateRegex.exec(itemXml)
    const imageMatch = imageRegex.exec(itemXml)

    const rawTitle = (titleMatch?.[1] || titleMatch?.[2] || '').trim()
    const rawDescription = (descMatch?.[1] || descMatch?.[2] || '').trim()
    const link = (linkMatch?.[1] || '').trim()

    if (rawTitle && link) {
      items.push({
        title: cleanTitle(rawTitle),
        description: cleanHTML(decodeNumericEntities(rawDescription)),
        link,
        author: (authorMatch?.[1] || authorMatch?.[2] || '').trim() || undefined,
        pubDate: pubDateMatch?.[1]?.trim(),
        imageUrl: imageMatch?.[1] || imageMatch?.[2] || imageMatch?.[3] || extractImageFromHTML(rawDescription),
      })
    }
  }

  return items
}

// Decode numeric HTML entities (&#8217; -> ', &#x2019; -> ', etc.)
function decodeNumericEntities(text: string): string {
  // Decode decimal entities like &#8217;
  let decoded = text.replace(/&#(\d+);/g, (_, num) =>
    String.fromCharCode(parseInt(num, 10))
  )
  // Decode hex entities like &#x2019;
  decoded = decoded.replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  )
  return decoded
}

// Clean HTML from text content
function cleanHTML(html: string, maxLength: number = 500): string {
  return html
    .replace(/<[^>]+>/g, '') // Remove HTML tags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '...')
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, maxLength)
}

// Clean title - decode entities but preserve full text
function cleanTitle(title: string): string {
  let cleaned = title
    .replace(/<!\[CDATA\[|\]\]>/g, '') // Remove CDATA markers
    .replace(/<[^>]+>/g, '') // Remove HTML tags
  cleaned = decodeNumericEntities(cleaned)
  return cleanHTML(cleaned, 300) // Titles can be up to 300 chars
}

// Extract image URL from HTML content
function extractImageFromHTML(html: string): string | undefined {
  const imgMatch = /<img[^>]+src="([^"]*)"/.exec(html)
  return imgMatch?.[1]
}

// Detect article category based on content
function detectCategory(title: string, description: string, defaultCategory: string): string {
  const content = `${title} ${description}`.toLowerCase()

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(keyword => content.includes(keyword))) {
      return category
    }
  }

  return defaultCategory
}

// Extract tags from content
function extractTags(title: string, description: string, category: string): string[] {
  const content = `${title} ${description}`.toLowerCase()
  const tags: string[] = [category]

  // Add relevant keywords as tags
  const allKeywords = Object.values(CATEGORY_KEYWORDS).flat()
  for (const keyword of allKeywords) {
    if (content.includes(keyword) && !tags.includes(keyword)) {
      tags.push(keyword)
      if (tags.length >= 5) break // Limit to 5 tags
    }
  }

  return tags
}

// Calculate relevance score
function calculateRelevance(title: string, description: string): number {
  let score = 0.7 // Base score

  const content = `${title} ${description}`.toLowerCase()

  // Boost for running-specific content
  if (content.includes('running') || content.includes('runner')) score += 0.1
  if (content.includes('marathon') || content.includes('training')) score += 0.05
  if (content.includes('race') || content.includes('workout')) score += 0.05

  // Slight penalty for very short descriptions
  if (description.length < 50) score -= 0.1

  return Math.min(Math.max(score, 0.5), 1.0)
}

// Parse date string to ISO format
function parseDate(dateStr?: string): string | undefined {
  if (!dateStr) return undefined

  try {
    const date = new Date(dateStr)
    if (isNaN(date.getTime())) return undefined
    return date.toISOString()
  } catch {
    return undefined
  }
}

// Fetch articles from a single RSS feed
async function fetchFeed(feed: RSSFeed): Promise<ArticleRecord[]> {
  try {
    console.log(`Fetching: ${feed.name}...`)

    const response = await fetch(feed.url, {
      headers: {
        'User-Agent': 'Runaway-iOS-Research-Bot/1.0',
        'Accept': 'application/rss+xml, application/xml, text/xml',
      }
    })

    if (!response.ok) {
      console.error(`Failed to fetch ${feed.name}: ${response.status}`)
      return []
    }

    const xml = await response.text()
    const items = parseRSS(xml)

    console.log(`  Found ${items.length} items from ${feed.name}`)

    return items.slice(0, 10).map(item => { // Limit to 10 per feed
      const category = detectCategory(item.title, item.description, feed.defaultCategory)
      return {
        title: item.title,
        summary: item.description,
        url: item.link,
        image_url: item.imageUrl,
        author: item.author,
        source: feed.name,
        category,
        tags: extractTags(item.title, item.description, category),
        published_at: parseDate(item.pubDate),
        relevance_score: calculateRelevance(item.title, item.description),
        is_active: true,
      }
    })
  } catch (error) {
    console.error(`Error fetching ${feed.name}:`, error)
    return []
  }
}

// Main fetch function
async function fetchAllArticles(): Promise<{ inserted: number; updated: number; errors: string[] }> {
  const errors: string[] = []
  let inserted = 0
  let updated = 0

  // Fetch from all feeds in parallel
  const results = await Promise.all(RSS_FEEDS.map(feed => fetchFeed(feed)))
  const allArticles = results.flat()

  console.log(`Total articles fetched: ${allArticles.length}`)

  // Upsert articles to database
  for (const article of allArticles) {
    try {
      const { data, error } = await supabase
        .from('research_articles')
        .upsert(article, {
          onConflict: 'url',
          ignoreDuplicates: false, // Update existing articles
        })
        .select('id')

      if (error) {
        console.error(`Error upserting article: ${error.message}`)
        errors.push(`${article.title}: ${error.message}`)
      } else {
        // Check if it was an insert or update (Supabase doesn't distinguish directly)
        inserted++
      }
    } catch (error) {
      console.error(`Error processing article:`, error)
      errors.push(`${article.title}: ${error}`)
    }
  }

  // Clean up old articles (older than 30 days)
  const { error: cleanupError } = await supabase.rpc('cleanup_old_research_articles')
  if (cleanupError) {
    console.warn('Cleanup warning:', cleanupError.message)
  }

  return { inserted, updated, errors }
}

// Edge function handler
Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    console.log('Starting daily article fetch...')
    const startTime = Date.now()

    const result = await fetchAllArticles()

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`Completed in ${duration}s: ${result.inserted} articles processed`)

    // Get total count in DB
    const { count } = await supabase
      .from('research_articles')
      .select('*', { count: 'exact', head: true })
      .eq('is_active', true)

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Daily article fetch completed',
        articlesProcessed: result.inserted,
        totalInDatabase: count,
        errors: result.errors.length > 0 ? result.errors.slice(0, 5) : undefined,
        duration: `${duration}s`,
        timestamp: new Date().toISOString(),
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )
  } catch (error) {
    console.error('Error in fetch-daily-articles:', error)
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )
  }
})
