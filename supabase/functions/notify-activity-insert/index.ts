import { serve } from "https://deno.land/std@0.177.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { create } from 'https://deno.land/x/djwt@v3.0.1/mod.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Function to get OAuth 2.0 access token for FCM
async function getAccessToken() {
  const serviceAccount = JSON.parse(Deno.env.get('FIREBASE_SERVICE_ACCOUNT') ?? '{}')

  const now = Math.floor(Date.now() / 1000)

  // Import private key
  const privateKeyPem = serviceAccount.private_key
  const privateKeyDer = pemToArrayBuffer(privateKeyPem)

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    privateKeyDer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['sign']
  )

  // Create JWT
  const jwt = await create(
    { alg: 'RS256', typ: 'JWT' },
    {
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    },
    cryptoKey
  )

  // Exchange JWT for access token
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })

  const tokenData = await tokenResponse.json()
  return tokenData.access_token
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '')
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const payload = await req.json()
    console.log('📥 Webhook payload received:', JSON.stringify(payload, null, 2))

    const { record } = payload

    if (!record) {
      console.error('❌ No record in payload')
      return new Response(JSON.stringify({ error: 'No record in payload' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log('🏃 New activity inserted:', record.id)
    console.log('👤 Athlete ID:', record.athlete_id)
    console.log('📋 Activity details:', { name: record.name, type: record.type, distance: record.distance })

    // Create Supabase client
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Get athlete's FCM token
    const { data: athlete, error: athleteError } = await supabaseAdmin
      .from('athletes')
      .select('fcm_token')
      .eq('id', record.athlete_id)
      .single()

    if (athleteError) {
      console.error('❌ Error fetching athlete:', athleteError)
      return new Response(JSON.stringify({ error: 'Failed to fetch athlete', details: athleteError }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (!athlete?.fcm_token) {
      console.log('⚠️ No FCM token found for athlete:', record.athlete_id)
      return new Response(JSON.stringify({ message: 'No FCM token for athlete' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log('✅ FCM token found:', athlete.fcm_token.substring(0, 20) + '...')
    console.log('📤 Sending push notification...')

    // Get OAuth access token
    const accessToken = await getAccessToken()

    // Get Firebase project ID from service account
    const serviceAccount = JSON.parse(Deno.env.get('FIREBASE_SERVICE_ACCOUNT') ?? '{}')
    const projectId = serviceAccount.project_id

    // Build notification content based on activity
    const activityName = record.name || record.type || 'Activity'
    const distance = record.distance ? (record.distance * 0.000621371).toFixed(2) : null
    const notificationBody = distance
      ? `${activityName} - ${distance} miles synced!`
      : `${activityName} synced!`

    // Send FCM notification using v1 API
    const fcmResponse = await fetch(
      `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: athlete.fcm_token,
            // Visible notification
            notification: {
              title: '🏃 Activity Synced',
              body: notificationBody,
            },
            // Data payload for app handling
            data: {
              sync_type: 'new_activity',
              activity_id: record.id.toString(),
            },
            apns: {
              headers: {
                'apns-priority': '10',  // High priority for visible notification
              },
              payload: {
                aps: {
                  'content-available': 1,  // Also trigger background sync
                  sound: 'default',
                  badge: 1,
                }
              }
            }
          }
        })
      }
    )

    const fcmResult = await fcmResponse.json()

    if (fcmResponse.ok) {
      console.log('✅ FCM notification sent successfully:', fcmResult)
    } else {
      console.error('❌ FCM error:', fcmResponse.status, fcmResult)
    }

    return new Response(JSON.stringify({
      success: fcmResponse.ok,
      fcm_status: fcmResponse.status,
      fcm_result: fcmResult,
      notification_body: notificationBody,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error('❌ Error:', error)
    return new Response(JSON.stringify({ error: error.message, stack: error.stack }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
