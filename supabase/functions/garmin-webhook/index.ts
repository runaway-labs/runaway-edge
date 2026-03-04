// Supabase Edge Function: garmin-webhook
// Receives Garmin notifications for activities, health metrics, sleep, HRV, etc.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
const GARMIN_CONSUMER_KEY = Deno.env.get('GARMIN_CONSUMER_KEY');
const GARMIN_CONSUMER_SECRET = Deno.env.get('GARMIN_CONSUMER_SECRET');
// ============================================================================
// OAuth 1.0a helpers (for Ping service callbacks)
// ============================================================================
function generateNonce() {
  return crypto.randomUUID().replace(/-/g, '');
}
function generateTimestamp() {
  return Math.floor(Date.now() / 1000).toString();
}
function percentEncode(str) {
  return encodeURIComponent(str).replace(/!/g, '%21').replace(/\*/g, '%2A').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
}
function createSignatureBaseString(method, url, params) {
  const sortedParams = Object.keys(params).sort().map((key)=>`${percentEncode(key)}=${percentEncode(params[key])}`).join('&');
  return `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(sortedParams)}`;
}
async function createSignature(baseString, consumerSecret, tokenSecret = '') {
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(signingKey), {
    name: 'HMAC',
    hash: 'SHA-1'
  }, false, [
    'sign'
  ]);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(baseString));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}
function createAuthorizationHeader(params, signature) {
  const allParams = {
    ...params,
    oauth_signature: signature
  };
  const headerParams = Object.keys(allParams).sort().map((key)=>`${percentEncode(key)}="${percentEncode(allParams[key])}"`).join(', ');
  return `OAuth ${headerParams}`;
}
async function fetchFromGarmin(url, accessToken, tokenSecret) {
  const nonce = generateNonce();
  const timestamp = generateTimestamp();
  const oauthParams = {
    oauth_consumer_key: GARMIN_CONSUMER_KEY,
    oauth_token: accessToken,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_nonce: nonce,
    oauth_version: '1.0'
  };
  const baseString = createSignatureBaseString('GET', url, oauthParams);
  const signature = await createSignature(baseString, GARMIN_CONSUMER_SECRET, tokenSecret);
  const authHeader = createAuthorizationHeader(oauthParams, signature);
  return fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': authHeader
    }
  });
}
// ============================================================================
// Health data processing
// ============================================================================
async function updateFitnessStats(supabase, athleteId, updates) {
  // Filter out undefined/null values
  const validUpdates = Object.fromEntries(
    Object.entries(updates).filter(([_, v]) => v !== undefined && v !== null)
  );

  // Don't update if there's no actual data to save
  if (Object.keys(validUpdates).length === 0) {
    console.log('No valid updates for athlete', athleteId, '- skipping DB write');
    return;
  }

  // Get existing stats
  const { data: athlete } = await supabase.from('athletes').select('garmin_fitness_stats').eq('id', athleteId).single();
  const existingStats = athlete?.garmin_fitness_stats || {};

  // Merge with new data (preserving existing values)
  const mergedStats = {
    ...existingStats,
    ...validUpdates,
    lastUpdated: new Date().toISOString()
  };

  const { error } = await supabase.from('athletes').update({
    garmin_fitness_stats: mergedStats,
    garmin_stats_updated_at: new Date().toISOString()
  }).eq('id', athleteId);

  if (error) {
    console.error('Error updating fitness stats:', error);
  } else {
    console.log('Updated fitness stats for athlete', athleteId, ':', Object.keys(validUpdates));
  }
}
async function processDailySummary(supabase, data, athleteId) {
  console.log('Processing daily summary:', data.calendarDate);
  await updateFitnessStats(supabase, athleteId, {
    bodyBattery: data.bodyBatteryMostRecentValue,
    bodyBatteryHigh: data.bodyBatteryHighestValue,
    bodyBatteryLow: data.bodyBatteryLowestValue,
    stressLevel: data.averageStressLevel,
    restingHeartRate: data.restingHeartRateInBeatsPerMinute,
    steps: data.steps
  });
}
async function processSleepData(supabase, data, athleteId) {
  console.log('Processing sleep data:', data.calendarDate);
  await updateFitnessStats(supabase, athleteId, {
    sleepScore: data.overallSleepScore || data.sleepScores?.overall,
    sleepDuration: data.durationInSeconds ? Math.round(data.durationInSeconds / 60) : undefined,
    deepSleep: data.deepSleepDurationInSeconds ? Math.round(data.deepSleepDurationInSeconds / 60) : undefined,
    lightSleep: data.lightSleepDurationInSeconds ? Math.round(data.lightSleepDurationInSeconds / 60) : undefined,
    remSleep: data.remSleepInSeconds ? Math.round(data.remSleepInSeconds / 60) : undefined,
    restingHeartRate: data.restingHeartRate
  });
}
async function processUserMetrics(supabase, data, athleteId) {
  console.log('Processing user metrics:', data.calendarDate);
  await updateFitnessStats(supabase, athleteId, {
    vo2Max: data.vo2Max || data.vo2MaxPreciseValue,
    vo2MaxCycling: data.vo2MaxCycling,
    fitnessAge: data.fitnessAge
  });
}
async function processHrvData(supabase, data, athleteId) {
  console.log('Processing HRV data:', data.calendarDate);
  await updateFitnessStats(supabase, athleteId, {
    hrvValue: data.hrvValue || data.lastNightAvg,
    hrvWeeklyAvg: data.weeklyAvg,
    hrvStatus: data.status
  });
}
async function processBodyComposition(supabase, data, athleteId) {
  console.log('Processing body composition');
  await updateFitnessStats(supabase, athleteId, {
    weight: data.weightInGrams ? data.weightInGrams / 1000 : undefined,
    bodyFat: data.bodyFatPercentage
  });
}
async function processTrainingStatus(supabase, data, athleteId) {
  console.log('Processing training status:', data.calendarDate);
  const statusDescriptions = {
    'PRODUCTIVE': 'Your training is improving your fitness',
    'MAINTAINING': 'Your training is maintaining your fitness level',
    'RECOVERY': 'Your lighter training is allowing your body to recover',
    'UNPRODUCTIVE': 'Your training load is high but fitness is declining',
    'DETRAINING': 'You\'ve been training less and losing fitness',
    'PEAKING': 'You\'re in ideal race condition',
    'OVERREACHING': 'Your training load is very high - rest needed',
    'NO_STATUS': 'Not enough data to determine training status'
  };
  await updateFitnessStats(supabase, athleteId, {
    trainingStatus: data.trainingStatus,
    trainingStatusDescription: statusDescriptions[data.trainingStatus || ''] || data.trainingStatusDescription,
    trainingLoad: data.trainingLoad || data.acuteLoad,
    recoveryTime: data.recoveryTimeInHours,
    vo2Max: data.vo2Max
  });
}
// ============================================================================
// Activity processing (existing logic)
// ============================================================================
function mapGarminActivityType(garminType) {
  const typeMap = {
    'RUNNING': 'Run',
    'INDOOR_RUNNING': 'Run',
    'TREADMILL_RUNNING': 'Run',
    'TRAIL_RUNNING': 'Trail Run',
    'TRACK_RUNNING': 'Run',
    'WALKING': 'Walk',
    'HIKING': 'Hike',
    'CYCLING': 'Ride',
    'INDOOR_CYCLING': 'Ride',
    'MOUNTAIN_BIKING': 'Ride',
    'SWIMMING': 'Swim',
    'POOL_SWIMMING': 'Swim',
    'OPEN_WATER_SWIMMING': 'Swim',
    'STRENGTH_TRAINING': 'Workout',
    'CARDIO_TRAINING': 'Workout',
    'YOGA': 'Yoga',
    'OTHER': 'Workout'
  };
  return typeMap[garminType] || 'Workout';
}
async function processActivity(supabase, activityData, authUserId, athleteId) {
  const activityDate = new Date(activityData.startTimeInSeconds * 1000);
  const garminActivityId = activityData.activityId || Math.floor(Date.now() / 1000);
  const uniqueId = -Math.abs(garminActivityId);
  const activity = {
    id: uniqueId,
    athlete_id: athleteId,
    auth_user_id: authUserId,
    source: 'garmin',
    external_id: activityData.activityId?.toString() || activityData.summaryId,
    name: activityData.activityName || `${mapGarminActivityType(activityData.activityType)} Activity`,
    type: mapGarminActivityType(activityData.activityType),
    activity_date: activityDate.toISOString(),
    start_date_local: activityDate.toISOString(),
    elapsed_time: activityData.durationInSeconds,
    moving_time: activityData.movingDurationInSeconds || activityData.durationInSeconds,
    distance: activityData.distanceInMeters,
    average_speed: activityData.averageSpeedInMetersPerSecond,
    max_speed: activityData.maxSpeedInMetersPerSecond,
    average_heart_rate: activityData.averageHeartRateInBeatsPerMinute,
    max_heart_rate: activityData.maxHeartRateInBeatsPerMinute,
    elevation_gain: activityData.totalElevationGainInMeters,
    average_cadence: activityData.averageRunCadenceInStepsPerMinute,
    device_name: activityData.deviceName,
    manual: activityData.manual || false,
    raw_data: activityData,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  const { error } = await supabase.from('activities').upsert(activity, {
    onConflict: 'id',
    ignoreDuplicates: false
  });
  if (error) {
    console.error('Error storing activity:', error);
  } else {
    console.log(`Stored Garmin activity: ${activity.name}`);
  }
}
// ============================================================================
// Main webhook handler
// ============================================================================
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: corsHeaders
    });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405
    });
  }
  try {
    const supabaseAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    const body = await req.json();
    console.log('Garmin webhook received:', JSON.stringify(body, null, 2));
    // Find athlete with Garmin connected
    // TODO: Use Garmin user ID from payload to match specific user
    const { data: athlete, error: lookupError } = await supabaseAdmin.from('athletes').select('id, auth_user_id').eq('garmin_connected', true).single();
    if (lookupError || !athlete) {
      console.error('Could not find Garmin-connected athlete:', lookupError);
      return new Response(JSON.stringify({
        success: true
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Handle deregistrations
    if (body.deregistrations?.length > 0) {
      console.log('User deregistered from Garmin');
      await supabaseAdmin.from('athletes').update({
        garmin_connected: false
      }).eq('id', athlete.id);
      return new Response(JSON.stringify({
        success: true
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Process activities
    if (body.activities?.length > 0) {
      for (const activity of body.activities){
        if (activity.activityType) {
          // Push format - activity data included
          await processActivity(supabaseAdmin, activity, athlete.auth_user_id, athlete.id);
        }
      }
    }
    // Process daily summaries (Body Battery, stress, resting HR)
    if (body.dailies?.length > 0) {
      for (const daily of body.dailies){
        await processDailySummary(supabaseAdmin, daily, athlete.id);
      }
    }
    // Process sleep data
    if (body.sleeps?.length > 0) {
      for (const sleep of body.sleeps){
        await processSleepData(supabaseAdmin, sleep, athlete.id);
      }
    }
    // Process user metrics (VO2 max, fitness age)
    if (body.userMetrics?.length > 0) {
      for (const metrics of body.userMetrics){
        await processUserMetrics(supabaseAdmin, metrics, athlete.id);
      }
    }
    // Process HRV data
    if (body.hrv?.length > 0 || body.hrvSummaries?.length > 0) {
      const hrvData = body.hrv || body.hrvSummaries;
      for (const hrv of hrvData){
        await processHrvData(supabaseAdmin, hrv, athlete.id);
      }
    }
    // Process body composition (weight, body fat)
    if (body.bodyCompositions?.length > 0) {
      for (const comp of body.bodyCompositions){
        await processBodyComposition(supabaseAdmin, comp, athlete.id);
      }
    }
    // Process training status
    if (body.trainingStatuses?.length > 0 || body.trainingStatus?.length > 0) {
      const statusData = body.trainingStatuses || body.trainingStatus;
      for (const status of statusData){
        await processTrainingStatus(supabaseAdmin, status, athlete.id);
      }
    }
    // Process stress data
    if (body.stressDetails?.length > 0) {
      for (const stress of body.stressDetails){
        await updateFitnessStats(supabaseAdmin, athlete.id, {
          stressLevel: stress.overallStressLevel
        });
      }
    }
    // Process moveIQ activities
    if (body.moveIQActivities?.length > 0) {
      for (const activity of body.moveIQActivities){
        await processActivity(supabaseAdmin, activity, athlete.auth_user_id, athlete.id);
      }
    }
    // Process manually updated activities
    if (body.manuallyUpdatedActivities?.length > 0) {
      for (const activity of body.manuallyUpdatedActivities){
        await processActivity(supabaseAdmin, activity, athlete.auth_user_id, athlete.id);
      }
    }
    return new Response(JSON.stringify({
      success: true
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Garmin webhook error:', error);
    return new Response(JSON.stringify({
      success: true,
      warning: 'Error processing'
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});
