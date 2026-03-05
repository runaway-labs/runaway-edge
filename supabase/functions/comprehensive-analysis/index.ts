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

interface VO2MaxWorkoutPlan {
  name: string
  description: string
  frequency: string
  example: string
}

interface VO2MaxEstimate {
  vo2_max: number
  fitness_level: string
  estimation_method: string
  vvo2_max_pace: string | null
  race_predictions: RacePrediction[]
  recommendations: string[]
  improvement_workouts: VO2MaxWorkoutPlan[]
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
  weekly_volume_km: number
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

    // Get activities from last 60 days (join activity_types to get type name)
    const sixtyDaysAgo = new Date()
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60)

    const { data: activities, error: activitiesError } = await supabaseAdmin
      .from('activities')
      .select('*, activity_types(id, name)')
      .eq('athlete_id', athlete.id)
      .gte('activity_date', sixtyDaysAgo.toISOString())
      .order('activity_date', { ascending: false })
      .limit(100)

    if (activitiesError) {
      console.error('Error fetching activities:', activitiesError)
    }

    // Map activities to include type from joined activity_types
    const activitiesWithType = (activities || []).map((a: any) => ({
      ...a,
      type: a.activity_types?.name || ''
    }))

    const runningActivities = activitiesWithType.filter(
      (a: Activity) => a.type?.toLowerCase().includes('run')
    )

    console.log(`Found ${runningActivities.length} running activities in last 60 days`)

    // Calculate training load metrics locally (no AI needed)
    const trainingLoad = calculateTrainingLoad(runningActivities)

    // Calculate weather context from activity data
    const weatherContext = calculateWeatherContext(runningActivities)

    // Calculate VO2max estimate and recommendations
    let vo2maxEstimate: VO2MaxEstimate | null = null
    let priorityRecommendations: string[] = []

    if (runningActivities.length >= 3) {
      // Always calculate VO2max using pace-based formula (no AI needed)
      vo2maxEstimate = calculateVO2MaxFromPace(runningActivities)

      // Try AI for enhanced recommendations if available
      if (ANTHROPIC_API_KEY) {
        try {
          const aiAnalysis = await generateAIAnalysis(runningActivities, trainingLoad, athlete)
          // Use AI recommendations but keep pace-based VO2max as fallback
          if (aiAnalysis.vo2maxEstimate) {
            vo2maxEstimate = aiAnalysis.vo2maxEstimate
          }
          priorityRecommendations = aiAnalysis.recommendations
        } catch (aiError) {
          console.error('AI analysis failed, using fallback:', aiError)
          priorityRecommendations = generateFallbackRecommendations(trainingLoad)
        }
      } else {
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

  // Weekly volume (last 7 days) in km
  const weeklyVolumeKm = last7Days.reduce((sum, a) => sum + (a.distance || 0) / 1000, 0)

  // Total volume (last 28 days) in km - for reference
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

  recommendations.push(`Your ${(totalVolumeKm / 4).toFixed(0)}km weekly average over 28 days ${trainingTrend === 'ramping_up' ? 'is trending up — watch your ACWR carefully this week' : trainingTrend === 'tapering' ? 'has been dropping — consider whether this is intentional taper or lost momentum' : 'has been consistent — a good foundation to build from'}.`)

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
    weekly_volume_km: Math.round(weeklyVolumeKm * 10) / 10,
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

// Calculate VO2max from pace using Jack Daniels VDOT formula
function calculateVO2MaxFromPace(activities: Activity[]): VO2MaxEstimate | null {
  // Filter activities with valid speed data
  const validActivities = activities.filter(a => a.average_speed > 0 && a.distance > 1000)

  if (validActivities.length < 3) {
    return null
  }

  // Find the best effort (fastest pace for runs > 3km)
  const qualityRuns = validActivities.filter(a => a.distance >= 3000)
  if (qualityRuns.length === 0) {
    return null
  }

  // Get fastest pace (highest speed) from quality runs
  const bestRun = qualityRuns.reduce((best, curr) =>
    curr.average_speed > best.average_speed ? curr : best
  )

  // Convert to velocity in meters per minute
  const velocityMPerMin = bestRun.average_speed * 60

  // Jack Daniels VO2 formula: VO2 = -4.60 + 0.182258*v + 0.000104*v²
  // This gives the oxygen cost at that velocity
  const vo2AtPace = -4.60 + (0.182258 * velocityMPerMin) + (0.000104 * velocityMPerMin * velocityMPerMin)

  // Duration correction - estimate what % of VO2max this effort represents
  // Shorter efforts = higher % of VO2max
  const durationMin = bestRun.moving_time / 60
  let vo2maxPercent: number
  if (durationMin <= 10) {
    vo2maxPercent = 0.98  // Near-max effort
  } else if (durationMin <= 20) {
    vo2maxPercent = 0.95
  } else if (durationMin <= 40) {
    vo2maxPercent = 0.90
  } else if (durationMin <= 60) {
    vo2maxPercent = 0.85
  } else {
    vo2maxPercent = 0.80  // Long easy runs
  }

  // Estimate VO2max
  const vo2max = vo2AtPace / vo2maxPercent

  // Clamp to reasonable range (30-85)
  const clampedVo2max = Math.max(30, Math.min(85, vo2max))

  // Determine fitness level
  let fitnessLevel: string
  if (clampedVo2max >= 60) {
    fitnessLevel = 'elite'
  } else if (clampedVo2max >= 52) {
    fitnessLevel = 'excellent'
  } else if (clampedVo2max >= 45) {
    fitnessLevel = 'good'
  } else if (clampedVo2max >= 38) {
    fitnessLevel = 'average'
  } else {
    fitnessLevel = 'below_average'
  }

  // Calculate vVO2max pace (velocity at VO2max)
  // Solve quadratic: 0.000104*v² + 0.182258*v + (-4.60 - vo2max) = 0
  const a = 0.000104
  const b = 0.182258
  const c = -4.60 - clampedVo2max
  const vVO2maxMPerMin = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a)
  const vVO2maxPaceMinPerKm = 1000 / vVO2maxMPerMin
  const vVO2maxPaceFormatted = formatPace(vVO2maxPaceMinPerKm)

  // Generate race predictions using VDOT-based formulas
  const racePredictions = generateRacePredictions(clampedVo2max)

  // Calculate weekly volume for workout planning
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const last7Days = validActivities.filter(a => new Date(a.activity_date) >= sevenDaysAgo)
  const weeklyVolumeKm = last7Days.reduce((sum, a) => sum + (a.distance || 0) / 1000, 0)

  // Generate improvement workouts
  const improvementWorkouts = generateVO2MaxImprovementPlan(clampedVo2max, vVO2maxPaceFormatted, weeklyVolumeKm || 30)

  // Calculate data quality score
  const dataQuality = Math.min(1, validActivities.length / 10) *
    (qualityRuns.length >= 5 ? 1 : 0.8)

  return {
    vo2_max: Math.round(clampedVo2max * 10) / 10,
    fitness_level: fitnessLevel,
    estimation_method: 'pace_based_vdot',
    vvo2_max_pace: vVO2maxPaceFormatted,
    race_predictions: racePredictions,
    recommendations: generateVO2MaxRecommendations(clampedVo2max, fitnessLevel),
    improvement_workouts: improvementWorkouts,
    data_quality_score: Math.round(dataQuality * 100) / 100
  }
}

function formatPace(minPerKm: number): string {
  const mins = Math.floor(minPerKm)
  const secs = Math.round((minPerKm - mins) * 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function generateRacePredictions(vo2max: number): RacePrediction[] {
  // VDOT-based race time predictions
  // These are approximations based on Jack Daniels' tables
  const predictions: RacePrediction[] = []

  const distances = [
    { name: '5K', km: 5.0 },
    { name: '10K', km: 10.0 },
    { name: 'Half Marathon', km: 21.0975 },
    { name: 'Marathon', km: 42.195 }
  ]

  for (const dist of distances) {
    // Estimate race velocity from VO2max
    // Higher distances = lower % of vVO2max
    let percentVO2max: number
    if (dist.km <= 5) {
      percentVO2max = 0.97
    } else if (dist.km <= 10) {
      percentVO2max = 0.93
    } else if (dist.km <= 21.1) {
      percentVO2max = 0.85
    } else {
      percentVO2max = 0.78
    }

    // Calculate race VO2 demand
    const raceVO2 = vo2max * percentVO2max

    // Reverse the Jack Daniels formula to get velocity
    const a = 0.000104
    const b = 0.182258
    const c = -4.60 - raceVO2
    const velocityMPerMin = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a)

    // Calculate time
    const distanceMeters = dist.km * 1000
    const timeMinutes = distanceMeters / velocityMPerMin
    const timeSeconds = Math.round(timeMinutes * 60)

    // Format time
    const hours = Math.floor(timeSeconds / 3600)
    const mins = Math.floor((timeSeconds % 3600) / 60)
    const secs = timeSeconds % 60
    const timeFormatted = hours > 0
      ? `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
      : `${mins}:${secs.toString().padStart(2, '0')}`

    // Pace calculations
    const pacePerKm = timeMinutes / dist.km
    const pacePerMile = pacePerKm * 1.60934

    predictions.push({
      distance: dist.name,
      distance_km: dist.km,
      predicted_time: timeFormatted,
      predicted_time_seconds: timeSeconds,
      pace_per_km: formatPace(pacePerKm),
      pace_per_mile: formatPace(pacePerMile),
      confidence: dist.km <= 10 ? 'high' : dist.km <= 21.1 ? 'medium' : 'low'
    })
  }

  return predictions
}

function generateVO2MaxRecommendations(vo2max: number, fitnessLevel: string): string[] {
  const recommendations: string[] = []

  if (vo2max < 40) {
    recommendations.push('Focus on building aerobic base with easy runs 3-4x per week.')
    recommendations.push('Gradually increase weekly mileage by no more than 10% per week.')
  } else if (vo2max < 50) {
    recommendations.push('Add tempo runs (20-40min at threshold pace) once per week.')
    recommendations.push('Include long runs to build endurance for longer races.')
  } else {
    recommendations.push('Incorporate interval training (e.g., 5x1000m at 5K pace) for speed.')
    recommendations.push('Maintain high aerobic volume while adding quality sessions.')
  }

  recommendations.push(`Your ${fitnessLevel} fitness level suggests good potential for improvement with consistent training.`)

  return recommendations
}

interface VO2MaxWorkout {
  name: string
  description: string
  frequency: string
  example: string
}

function generateVO2MaxImprovementPlan(vo2max: number, vvo2maxPace: string, weeklyVolumeKm: number): VO2MaxWorkout[] {
  const workouts: VO2MaxWorkout[] = []

  // Calculate training paces based on vVO2max
  // Parse vVO2max pace (format "M:SS")
  const [mins, secs] = vvo2maxPace.split(':').map(Number)
  const vvo2maxMinPerKm = mins + secs / 60

  // Training pace zones
  const intervalPace = formatPaceFromMinPerKm(vvo2maxMinPerKm) // 95-100% vVO2max
  const tempoPace = formatPaceFromMinPerKm(vvo2maxMinPerKm * 1.08) // ~88-92% vVO2max
  const easyPace = formatPaceFromMinPerKm(vvo2maxMinPerKm * 1.35) // ~65-75% vVO2max

  // VO2max intervals - most effective for raising VO2max
  workouts.push({
    name: 'VO2max Intervals',
    description: 'Hard intervals at 95-100% of your max aerobic capacity. The most effective workout for raising VO2max.',
    frequency: '1x per week',
    example: `5x1000m at ${intervalPace}/km with 3min jog recovery`
  })

  // Tempo runs - threshold training
  workouts.push({
    name: 'Tempo Run',
    description: 'Sustained effort at lactate threshold. Improves your ability to hold faster paces longer.',
    frequency: '1x per week',
    example: `20-30min continuous at ${tempoPace}/km`
  })

  // Long run - aerobic base
  const longRunDistance = Math.min(Math.round(weeklyVolumeKm * 0.3), 25)
  workouts.push({
    name: 'Long Run',
    description: 'Builds aerobic endurance and fat-burning efficiency. Keep it conversational pace.',
    frequency: '1x per week',
    example: `${longRunDistance}km at ${easyPace}/km or slower`
  })

  // Hill repeats - strength + VO2max
  workouts.push({
    name: 'Hill Repeats',
    description: 'Builds running-specific strength while stressing the aerobic system. Great VO2max stimulus with less impact.',
    frequency: '1x every 2 weeks',
    example: '8x90sec uphill hard, jog down recovery'
  })

  // Easy runs - recovery and base
  workouts.push({
    name: 'Easy Runs',
    description: 'Recovery and aerobic base building. Should feel comfortable - you can hold a conversation.',
    frequency: '2-3x per week',
    example: `30-45min at ${easyPace}/km or slower`
  })

  return workouts
}

function formatPaceFromMinPerKm(minPerKm: number): string {
  const mins = Math.floor(minPerKm)
  const secs = Math.round((minPerKm - mins) * 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
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

  const prompt = `This runner's current training data:
- Name: ${athlete.first_name}
- ACWR: ${trainingLoad.acwr} (${trainingLoad.injury_risk_level} risk, ${trainingLoad.recovery_status})
- Acute load 7d: ${trainingLoad.acute_load_7_days}, Chronic load 28d avg: ${trainingLoad.chronic_load_28_days}
- Training trend: ${trainingLoad.training_trend}
- Weekly volume last 7 days: ${trainingLoad.weekly_volume_km.toFixed(1)} km
- 28-day avg weekly volume: ${(trainingLoad.total_volume_km / 4).toFixed(1)} km/week
- Average pace (last 20 runs): ${avgPace.toFixed(2)} min/mile
- Fastest recent pace: ${fastestPace.toFixed(2)} min/mile
- Longest recent run: ${longestRun.toFixed(1)} km

Generate 3 priority_recommendations. Rules:
1. Each must reference at least one specific number from their data above
2. Each must be actionable for THIS week specifically
3. Do NOT include generic wellness advice (no sleep tips, no "eat protein", no foam rolling)
4. Write like a coach who knows this athlete's numbers intimately

Also estimate VO2max and race predictions using Jack Daniels VDOT method.

Return ONLY valid JSON:
{
  "vo2_max": number,
  "fitness_level": "elite"|"excellent"|"good"|"average"|"below_average",
  "estimation_method": "pace_analysis",
  "vvo2_max_pace": "M:SS",
  "race_predictions": [
    { "distance": "5K", "distance_km": 5.0, "predicted_time": "MM:SS", "predicted_time_seconds": number, "pace_per_km": "M:SS", "pace_per_mile": "M:SS", "confidence": "high" },
    { "distance": "10K", "distance_km": 10.0, "predicted_time": "MM:SS", "predicted_time_seconds": number, "pace_per_km": "M:SS", "pace_per_mile": "M:SS", "confidence": "medium" },
    { "distance": "Half Marathon", "distance_km": 21.0975, "predicted_time": "H:MM:SS", "predicted_time_seconds": number, "pace_per_km": "M:SS", "pace_per_mile": "M:SS", "confidence": "medium" },
    { "distance": "Marathon", "distance_km": 42.195, "predicted_time": "H:MM:SS", "predicted_time_seconds": number, "pace_per_km": "M:SS", "pace_per_mile": "M:SS", "confidence": "low" }
  ],
  "recommendations": ["string referencing their data", "string referencing their data"],
  "data_quality_score": number between 0 and 1,
  "priority_recommendations": [
    "recommendation 1 with specific number from their data",
    "recommendation 2 with specific number from their data",
    "recommendation 3 with specific number from their data"
  ]
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

  // Volume trend recommendation
  const avgWeekly = (trainingLoad.total_volume_km / 4).toFixed(0)
  const trendMsg = trainingLoad.training_trend === 'ramping_up'
    ? `trending up — keep weekly increases under 10%`
    : trainingLoad.training_trend === 'tapering'
    ? `dropping — confirm this is intentional before the next block`
    : `consistent — solid base to build from`
  recommendations.push(`Your ${avgWeekly}km weekly average over 28 days is ${trendMsg}.`)

  // General advice
  recommendations.push('Include one long run per week to build endurance.')

  return recommendations.slice(0, 5)
}
