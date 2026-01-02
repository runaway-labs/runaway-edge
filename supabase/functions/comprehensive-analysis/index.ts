// Supabase Edge Function: comprehensive-analysis
// Provides training load, VO2max estimates, and weather-adjusted recommendations
// Replaces the deprecated Runaway Coach API endpoint

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')

interface Activity {
  id: number
  athlete_id: number
  activity_date: string
  distance: number // meters
  moving_time: number // seconds
  elapsed_time: number // seconds
  average_speed: number // m/s
  max_speed: number // m/s
  average_heartrate?: number
  max_heartrate?: number
  total_elevation_gain?: number
  type: string
  average_temp?: number
}

interface QuickWinsResponse {
  success: boolean
  athlete_id: string
  analysis_date: string
  analyses: {
    weather_context: WeatherAnalysis | null
    vo2max_estimate: VO2MaxEstimate | null
    training_load: TrainingLoadAnalysis | null
  }
  priority_recommendations: string[]
}

interface WeatherAnalysis {
  average_temperature_celsius: number
  average_humidity_percent: number
  heat_stress_runs: number
  ideal_condition_runs: number
  weather_impact_score: string
  pace_degradation_seconds_per_mile: number
  heat_acclimation_level: string
  optimal_training_times: string[]
  recommendations: string[]
}

interface VO2MaxEstimate {
  vo2_max: number
  fitness_level: string
  estimation_method: string
  vvo2_max_pace: string | null
  race_predictions: RacePrediction[]
  recommendations: string[]
  data_quality_score: number
}

interface RacePrediction {
  distance: string
  distance_km: number
  predicted_time: string
  predicted_time_seconds: number
  pace_per_km: string
  pace_per_mile: string
  confidence: string
}

interface TrainingLoadAnalysis {
  acute_load_7_days: number
  chronic_load_28_days: number
  acwr: number
  weekly_tss: number
  total_volume_km: number
  recovery_status: string
  injury_risk_level: string
  training_trend: string
  fitness_trend: string
  recommendations: string[]
  daily_recommendations: { [key: string]: string }
}

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // Get JWT token from Authorization header
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ success: false, error: 'Missing authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Create Supabase client with user's JWT
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    })

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)

    // Get the authenticated user
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser()
    if (authError || !user) {
      return new Response(
        JSON.stringify({ success: false, error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('Comprehensive analysis request for user:', user.id)

    // Get athlete ID from auth user
    const { data: athlete, error: athleteError } = await supabaseAdmin
      .from('athletes')
      .select('id, first_name, last_name, city, state')
      .eq('auth_user_id', user.id)
      .single()

    if (athleteError || !athlete) {
      return new Response(
        JSON.stringify({ success: false, error: 'Athlete not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Get activities from last 60 days
    const sixtyDaysAgo = new Date()
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60)

    const { data: activities, error: activitiesError } = await supabaseAdmin
      .from('activities')
      .select('*')
      .eq('athlete_id', athlete.id)
      .gte('activity_date', sixtyDaysAgo.toISOString())
      .order('activity_date', { ascending: false })
      .limit(100)

    if (activitiesError) {
      console.error('Error fetching activities:', activitiesError)
    }

    const runningActivities = (activities || []).filter(
      (a: Activity) => a.type?.toLowerCase().includes('run')
    )

    console.log(`Found ${runningActivities.length} running activities in last 60 days`)

    // Calculate training load metrics locally (no AI needed)
    const trainingLoad = calculateTrainingLoad(runningActivities)

    // Calculate weather context from activity data
    const weatherContext = calculateWeatherContext(runningActivities)

    // Use AI to generate VO2max estimate and recommendations
    let vo2maxEstimate: VO2MaxEstimate | null = null
    let priorityRecommendations: string[] = []

    if (runningActivities.length >= 3 && ANTHROPIC_API_KEY) {
      try {
        const aiAnalysis = await generateAIAnalysis(runningActivities, trainingLoad, athlete)
        vo2maxEstimate = aiAnalysis.vo2maxEstimate
        priorityRecommendations = aiAnalysis.recommendations
      } catch (aiError) {
        console.error('AI analysis failed:', aiError)
        priorityRecommendations = generateFallbackRecommendations(trainingLoad)
      }
    } else {
      priorityRecommendations = generateFallbackRecommendations(trainingLoad)
    }

    const response: QuickWinsResponse = {
      success: true,
      athlete_id: athlete.id.toString(),
      analysis_date: new Date().toISOString(),
      analyses: {
        weather_context: weatherContext,
        vo2max_estimate: vo2maxEstimate,
        training_load: trainingLoad
      },
      priority_recommendations: priorityRecommendations
    }

    return new Response(
      JSON.stringify(response),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Error in comprehensive-analysis:', error)
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

// Calculate training load metrics
function calculateTrainingLoad(activities: Activity[]): TrainingLoadAnalysis {
  const now = new Date()
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const twentyEightDaysAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000)

  // Filter activities by time period
  const last7Days = activities.filter(a => new Date(a.activity_date) >= sevenDaysAgo)
  const last28Days = activities.filter(a => new Date(a.activity_date) >= twentyEightDaysAgo)

  // Calculate load (simplified TSS using duration * intensity)
  const calculateLoad = (acts: Activity[]) => {
    return acts.reduce((sum, a) => {
      const durationHours = (a.moving_time || 0) / 3600
      const intensityFactor = calculateIntensityFactor(a)
      return sum + (durationHours * intensityFactor * 100)
    }, 0)
  }

  const acuteLoad = calculateLoad(last7Days)
  const chronicLoad = calculateLoad(last28Days) / 4 // Weekly average

  const acwr = chronicLoad > 0 ? acuteLoad / chronicLoad : 1.0

  // Total volume in km
  const totalVolumeKm = last28Days.reduce((sum, a) => sum + (a.distance || 0) / 1000, 0)

  // Determine recovery status based on ACWR
  let recoveryStatus: string
  let injuryRiskLevel: string

  if (acwr < 0.8) {
    recoveryStatus = 'well_recovered'
    injuryRiskLevel = 'low'
  } else if (acwr <= 1.0) {
    recoveryStatus = 'adequate'
    injuryRiskLevel = 'low'
  } else if (acwr <= 1.3) {
    recoveryStatus = 'adequate'
    injuryRiskLevel = 'moderate'
  } else if (acwr <= 1.5) {
    recoveryStatus = 'fatigued'
    injuryRiskLevel = 'high'
  } else {
    recoveryStatus = 'overreaching'
    injuryRiskLevel = 'very_high'
  }

  // Determine training trend
  const firstWeekLoad = calculateLoad(last28Days.filter(a => {
    const date = new Date(a.activity_date)
    return date >= twentyEightDaysAgo && date < new Date(twentyEightDaysAgo.getTime() + 7 * 24 * 60 * 60 * 1000)
  }))

  let trainingTrend: string
  if (acuteLoad > firstWeekLoad * 1.1) {
    trainingTrend = 'ramping_up'
  } else if (acuteLoad < firstWeekLoad * 0.9) {
    trainingTrend = 'tapering'
  } else {
    trainingTrend = 'steady'
  }

  // Fitness trend (simplified)
  const fitnessTrend = acwr >= 0.8 && acwr <= 1.3 ? 'improving' : acwr > 1.3 ? 'maintaining' : 'declining'

  // Generate recommendations
  const recommendations: string[] = []
  if (acwr < 0.8) {
    recommendations.push('Training load is low. Consider gradually increasing volume to maintain fitness.')
  } else if (acwr <= 1.3) {
    recommendations.push(`ACWR is ${acwr.toFixed(2)} (optimal zone). Training load is well-managed.`)
  } else if (acwr <= 1.5) {
    recommendations.push(`ACWR is ${acwr.toFixed(2)} (caution zone). Consider reducing intensity this week.`)
  } else {
    recommendations.push(`ACWR is ${acwr.toFixed(2)} (danger zone). Take extra rest days to prevent injury.`)
  }

  recommendations.push('Recovery essentials: 7-9 hours sleep, protein within 30min post-run.')

  // Daily recommendations
  const dailyRecommendations: { [key: string]: string } = {
    'Day 1': acwr > 1.3 ? 'Rest or easy 20min walk' : '40min easy run',
    'Day 2': acwr > 1.3 ? '30min recovery run' : '45min moderate run with pickups',
    'Day 3': 'Rest or cross-training',
    'Day 4': acwr > 1.5 ? '30min easy run' : '50min tempo run',
    'Day 5': 'Rest',
    'Day 6': '40min easy run',
    'Day 7': acwr > 1.3 ? '60min easy long run' : '75min long run'
  }

  return {
    acute_load_7_days: Math.round(acuteLoad * 10) / 10,
    chronic_load_28_days: Math.round(chronicLoad * 10) / 10,
    acwr: Math.round(acwr * 100) / 100,
    weekly_tss: Math.round(acuteLoad * 10) / 10,
    total_volume_km: Math.round(totalVolumeKm * 10) / 10,
    recovery_status: recoveryStatus,
    injury_risk_level: injuryRiskLevel,
    training_trend: trainingTrend,
    fitness_trend: fitnessTrend,
    recommendations,
    daily_recommendations: dailyRecommendations
  }
}

function calculateIntensityFactor(activity: Activity): number {
  const avgSpeed = activity.average_speed || 0
  if (avgSpeed === 0) return 1.0

  // Convert m/s to min/mile pace
  const paceMinPerMile = (1609.34 / avgSpeed) / 60.0

  if (paceMinPerMile < 7) return 1.5 // Hard
  if (paceMinPerMile < 8.5) return 1.2 // Moderate
  if (paceMinPerMile < 10) return 1.0 // Easy
  return 0.8 // Recovery
}

// Calculate weather context from activity temperature data
function calculateWeatherContext(activities: Activity[]): WeatherAnalysis | null {
  const activitiesWithTemp = activities.filter(a => a.average_temp !== undefined && a.average_temp !== null)

  if (activitiesWithTemp.length < 3) {
    return null // Not enough data
  }

  const temps = activitiesWithTemp.map(a => a.average_temp!)
  const avgTemp = temps.reduce((sum, t) => sum + t, 0) / temps.length

  // Estimate heat stress runs (temp > 25C / 77F)
  const heatStressRuns = activitiesWithTemp.filter(a => a.average_temp! > 25).length
  const idealConditionRuns = activitiesWithTemp.filter(a => a.average_temp! >= 10 && a.average_temp! <= 20).length

  // Weather impact score based on average temp
  let weatherImpactScore: string
  let paceDegradation: number

  if (avgTemp <= 15) {
    weatherImpactScore = 'minimal'
    paceDegradation = 0
  } else if (avgTemp <= 22) {
    weatherImpactScore = 'minimal'
    paceDegradation = 5
  } else if (avgTemp <= 28) {
    weatherImpactScore = 'moderate'
    paceDegradation = 15
  } else if (avgTemp <= 32) {
    weatherImpactScore = 'significant'
    paceDegradation = 25
  } else {
    weatherImpactScore = 'severe'
    paceDegradation = 40
  }

  // Heat acclimation based on heat exposure
  const heatExposureRatio = heatStressRuns / activitiesWithTemp.length
  let heatAcclimationLevel: string
  if (heatExposureRatio >= 0.5) {
    heatAcclimationLevel = 'well-acclimated'
  } else if (heatExposureRatio >= 0.2) {
    heatAcclimationLevel = 'developing'
  } else {
    heatAcclimationLevel = 'none'
  }

  const recommendations: string[] = []
  if (avgTemp > 22) {
    recommendations.push(`Average training temperature (${avgTemp.toFixed(1)}C) is above ideal. Expect ${paceDegradation}s/mile slower pace in heat.`)
  }
  if (heatStressRuns > 5) {
    recommendations.push('Multiple heat stress runs detected. Stay well hydrated and consider electrolyte supplementation.')
  }
  recommendations.push('Train early morning (5-7am) or evening (7-9pm) to avoid peak heat.')

  return {
    average_temperature_celsius: Math.round(avgTemp * 10) / 10,
    average_humidity_percent: 65, // Default since we don't have humidity data
    heat_stress_runs: heatStressRuns,
    ideal_condition_runs: idealConditionRuns,
    weather_impact_score: weatherImpactScore,
    pace_degradation_seconds_per_mile: paceDegradation,
    heat_acclimation_level: heatAcclimationLevel,
    optimal_training_times: ['5:00-7:00 AM', '7:00-9:00 PM'],
    recommendations
  }
}

// Generate AI-powered VO2max estimate and recommendations
async function generateAIAnalysis(
  activities: Activity[],
  trainingLoad: TrainingLoadAnalysis,
  athlete: any
): Promise<{ vo2maxEstimate: VO2MaxEstimate | null, recommendations: string[] }> {

  // Calculate basic metrics for the prompt
  const recentRuns = activities.slice(0, 20)
  const avgPace = recentRuns.reduce((sum, a) => {
    if (!a.average_speed || a.average_speed === 0) return sum
    return sum + (1609.34 / a.average_speed) / 60
  }, 0) / recentRuns.filter(a => a.average_speed > 0).length

  const longestRun = Math.max(...activities.map(a => a.distance || 0)) / 1000
  const fastestPace = Math.min(...activities.filter(a => a.average_speed > 0).map(a => (1609.34 / a.average_speed) / 60))

  const prompt = `Analyze this runner's data and estimate their VO2max and race predictions.

Runner Profile:
- Name: ${athlete.first_name} ${athlete.last_name}
- Location: ${[athlete.city, athlete.state].filter(Boolean).join(', ') || 'Unknown'}

Training Data (last 60 days):
- Total runs: ${activities.length}
- Average pace: ${avgPace.toFixed(2)} min/mile
- Fastest pace: ${fastestPace.toFixed(2)} min/mile
- Longest run: ${longestRun.toFixed(1)} km
- Weekly volume: ${(trainingLoad.total_volume_km / 4).toFixed(1)} km
- ACWR: ${trainingLoad.acwr}

Respond with ONLY valid JSON matching this structure:
{
  "vo2_max": number (estimated VO2max in ml/kg/min),
  "fitness_level": "elite" | "excellent" | "good" | "average" | "below_average",
  "estimation_method": "pace_analysis",
  "vvo2_max_pace": "M:SS" format or null,
  "race_predictions": [
    {
      "distance": "5K",
      "distance_km": 5.0,
      "predicted_time": "H:MM:SS",
      "predicted_time_seconds": number,
      "pace_per_km": "M:SS",
      "pace_per_mile": "M:SS",
      "confidence": "high" | "medium" | "low"
    }
  ],
  "recommendations": ["string", "string"],
  "data_quality_score": number 0-1,
  "priority_recommendations": ["string", "string", "string"]
}`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY || '',
      'anthropic-version': '2024-10-22'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: 'You are an expert running coach and exercise physiologist. Provide accurate VO2max estimates and race predictions based on training data. Use established formulas like the Jack Daniels VDOT system. Be conservative with predictions. Respond with ONLY valid JSON.',
      messages: [{ role: 'user', content: prompt }]
    })
  })

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status}`)
  }

  const data = await response.json()
  let jsonText = data.content[0].text

  // Extract JSON if wrapped in code blocks
  if (jsonText.includes('```json')) {
    jsonText = jsonText.split('```json')[1].split('```')[0].trim()
  } else if (jsonText.includes('```')) {
    jsonText = jsonText.split('```')[1].split('```')[0].trim()
  }

  const analysis = JSON.parse(jsonText)

  return {
    vo2maxEstimate: {
      vo2_max: analysis.vo2_max,
      fitness_level: analysis.fitness_level,
      estimation_method: analysis.estimation_method,
      vvo2_max_pace: analysis.vvo2_max_pace,
      race_predictions: analysis.race_predictions || [],
      recommendations: analysis.recommendations || [],
      data_quality_score: analysis.data_quality_score || 0.7
    },
    recommendations: analysis.priority_recommendations || analysis.recommendations || []
  }
}

// Generate recommendations without AI
function generateFallbackRecommendations(trainingLoad: TrainingLoadAnalysis): string[] {
  const recommendations: string[] = []

  // ACWR recommendation
  if (trainingLoad.acwr < 0.8) {
    recommendations.push('Training load is below optimal. Consider gradually increasing weekly mileage by 10%.')
  } else if (trainingLoad.acwr <= 1.3) {
    recommendations.push(`ACWR is ${trainingLoad.acwr.toFixed(2)} (optimal zone). Training load is well-managed.`)
  } else {
    recommendations.push(`ACWR is ${trainingLoad.acwr.toFixed(2)} (elevated). Consider extra recovery this week.`)
  }

  // Volume recommendation
  const weeklyKm = trainingLoad.total_volume_km / 4
  if (weeklyKm < 20) {
    recommendations.push('Build your aerobic base with more easy miles. Aim for 25-30km per week.')
  } else if (weeklyKm >= 40) {
    recommendations.push('Good training volume. Focus on quality sessions while maintaining mileage.')
  }

  // Recovery recommendation
  recommendations.push('Recovery essentials: 7-9 hours sleep, protein within 30min post-run, foam rolling.')

  // General advice
  recommendations.push('Include one long run per week to build endurance.')

  return recommendations.slice(0, 5)
}
