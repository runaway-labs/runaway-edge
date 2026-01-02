# Supabase Edge Functions Migration Plan

## Overview
Migrate Node.js/Express APIs from Cloud Run to Supabase Edge Functions (Deno) for better performance, lower costs, and simpler architecture.

---

## Phase 1: Setup & Infrastructure (Day 1)

### 1.1 Initialize Edge Functions Project
```bash
cd /Users/jack.rudelic/projects/labs/runaway-edge

# Create function structure
supabase functions new chat
supabase functions new journal
supabase functions new oauth-callback
supabase functions new sync-beta
```

### 1.2 Set Up Environment Variables
```bash
# Set secrets for Edge Functions
supabase secrets set OPENAI_API_KEY=your_key_here
supabase secrets set ANTHROPIC_API_KEY=your_key_here
supabase secrets set STRAVA_CLIENT_ID=your_client_id
supabase secrets set STRAVA_CLIENT_SECRET=your_client_secret
```

### 1.3 Create Shared Utilities
```typescript
// supabase/functions/_shared/supabase.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export const createSupabaseClient = () => {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )
}
```

```typescript
// supabase/functions/_shared/anthropic.ts
import Anthropic from 'npm:@anthropic-ai/sdk@0.24.3'

export const createAnthropicClient = () => {
  return new Anthropic({
    apiKey: Deno.env.get('ANTHROPIC_API_KEY')!
  })
}
```

```typescript
// supabase/functions/_shared/cors.ts
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
```

---

## Phase 2: Chat API Migration (Day 2)

### 2.1 Port ChatService Logic
```typescript
// supabase/functions/chat/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createSupabaseClient } from '../_shared/supabase.ts'
import { createAnthropicClient } from '../_shared/anthropic.ts'
import { corsHeaders } from '../_shared/cors.ts'

interface ChatRequest {
  athlete_id: number
  message: string
  conversation_id?: string
}

serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { athlete_id, message, conversation_id }: ChatRequest = await req.json()

    if (!athlete_id || !message) {
      return new Response(
        JSON.stringify({ error: 'athlete_id and message are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createSupabaseClient()
    const anthropic = createAnthropicClient()

    // 1. Fetch recent activities for context
    const { data: activities } = await supabase
      .from('activities')
      .select('*')
      .eq('athlete_id', athlete_id)
      .order('activity_date', { ascending: false })
      .limit(20)

    // 2. Get or create conversation
    let convId = conversation_id
    if (!convId) {
      const { data: conv } = await supabase
        .from('conversations')
        .insert({ athlete_id, created_at: new Date().toISOString() })
        .select()
        .single()
      convId = conv?.id
    }

    // 3. Build context from activities
    const activityContext = activities?.map(a =>
      `${a.activity_date}: ${a.type} - ${(a.distance / 1000).toFixed(2)}km in ${Math.floor(a.moving_time / 60)} minutes`
    ).join('\n') || 'No recent activities'

    // 4. Get conversation history
    const { data: history } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: true })
      .limit(10)

    const messages = [
      {
        role: 'user',
        content: `You are a running coach. Here are the athlete's recent activities:\n${activityContext}\n\nAnswer their question: ${message}`
      }
    ]

    // Add conversation history
    history?.forEach(h => {
      messages.push({ role: h.role, content: h.content })
    })

    // 5. Call Anthropic API
    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: messages
    })

    const answer = response.content[0].type === 'text'
      ? response.content[0].text
      : 'Unable to generate response'

    // 6. Save messages to database
    await supabase.from('messages').insert([
      { conversation_id: convId, role: 'user', content: message },
      { conversation_id: convId, role: 'assistant', content: answer }
    ])

    return new Response(
      JSON.stringify({
        answer,
        conversationId: convId,
        usage: {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens
        }
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Chat error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
```

### 2.2 Deploy Chat Function
```bash
supabase functions deploy chat --no-verify-jwt
```

### 2.3 Test Chat Function
```bash
curl -X POST 'https://your-project.supabase.co/functions/v1/chat' \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "athlete_id": 94451852,
    "message": "When was my last run over 10 miles?"
  }'
```

### 2.4 Update iOS App
```swift
// Change APIConfiguration.swift
struct APIConfiguration {
    static let baseURL = "https://your-project.supabase.co/functions/v1"

    static func chatEndpoint() -> String {
        return "\(baseURL)/chat"
    }
}
```

---

## Phase 3: Journal API Migration (Day 3)

### 3.1 Create Journal Function
```typescript
// supabase/functions/journal/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createSupabaseClient } from '../_shared/supabase.ts'
import { createAnthropicClient } from '../_shared/anthropic.ts'
import { corsHeaders } from '../_shared/cors.ts'

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { athlete_id, activity_ids } = await req.json()

    if (!athlete_id || !activity_ids?.length) {
      return new Response(
        JSON.stringify({ error: 'athlete_id and activity_ids required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createSupabaseClient()
    const anthropic = createAnthropicClient()

    // Fetch activities
    const { data: activities } = await supabase
      .from('activities')
      .select('*')
      .in('id', activity_ids)
      .eq('athlete_id', athlete_id)

    if (!activities?.length) {
      return new Response(
        JSON.stringify({ error: 'No activities found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Build activity summary
    const summary = activities.map(a =>
      `${new Date(a.activity_date).toLocaleDateString()}: ${a.type} - ${(a.distance / 1000).toFixed(2)}km, ${Math.floor(a.moving_time / 60)} min, avg HR: ${a.average_heart_rate || 'N/A'}`
    ).join('\n')

    // Generate journal entry
    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `You are a running coach. Write a reflective journal entry for these activities:\n${summary}\n\nInclude: overall assessment, what went well, areas for improvement, and recommendations for next week. Be encouraging but honest.`
      }]
    })

    const journalEntry = response.content[0].type === 'text'
      ? response.content[0].text
      : 'Unable to generate journal entry'

    // Save to database
    const { data: journal } = await supabase
      .from('journal_entries')
      .insert({
        athlete_id,
        activity_ids,
        content: journalEntry,
        created_at: new Date().toISOString()
      })
      .select()
      .single()

    return new Response(
      JSON.stringify({ journal_entry: journalEntry, id: journal?.id }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Journal error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
```

### 3.2 Deploy & Test
```bash
supabase functions deploy journal --no-verify-jwt

# Test
curl -X POST 'https://your-project.supabase.co/functions/v1/journal' \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "athlete_id": 94451852,
    "activity_ids": [123, 124, 125]
  }'
```

---

## Phase 4: OAuth Callback (Day 4)

### 4.1 Create OAuth Callback Function
```typescript
// supabase/functions/oauth-callback/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createSupabaseClient } from '../_shared/supabase.ts'

serve(async (req) => {
  try {
    const url = new URL(req.url)
    const code = url.searchParams.get('code')
    const scope = url.searchParams.get('scope')

    if (!code) {
      return new Response('Missing authorization code', { status: 400 })
    }

    // Exchange code for token
    const tokenResponse = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: Deno.env.get('STRAVA_CLIENT_ID'),
        client_secret: Deno.env.get('STRAVA_CLIENT_SECRET'),
        code,
        grant_type: 'authorization_code'
      })
    })

    const tokenData = await tokenResponse.json()

    if (!tokenResponse.ok) {
      console.error('Strava token exchange failed:', tokenData)
      return new Response('Failed to exchange code', { status: 400 })
    }

    const supabase = createSupabaseClient()

    // Store tokens and athlete info
    const { data: athlete } = await supabase
      .from('athletes')
      .upsert({
        id: tokenData.athlete.id,
        first_name: tokenData.athlete.firstname,
        last_name: tokenData.athlete.lastname,
        profile: tokenData.athlete.profile,
        strava_connected: true,
        strava_connected_at: new Date().toISOString()
      })
      .select()
      .single()

    await supabase
      .from('strava_tokens')
      .upsert({
        athlete_id: tokenData.athlete.id,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
      })

    // Redirect to app with success
    return Response.redirect(
      `runaway://oauth-success?athlete_id=${tokenData.athlete.id}`,
      302
    )

  } catch (error) {
    console.error('OAuth callback error:', error)
    return Response.redirect('runaway://oauth-error', 302)
  }
})
```

### 4.2 Update Strava OAuth Settings
- Go to https://www.strava.com/settings/api
- Update Authorization Callback Domain to: `your-project.supabase.co`
- Update callback URL to: `https://your-project.supabase.co/functions/v1/oauth-callback`

---

## Phase 5: Sync-Beta for iOS (Day 5)

### 5.1 Create Sync-Beta Function
```typescript
// supabase/functions/sync-beta/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createSupabaseClient } from '../_shared/supabase.ts'
import { corsHeaders } from '../_shared/cors.ts'

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { athlete_id } = await req.json()

    if (!athlete_id) {
      return new Response(
        JSON.stringify({ error: 'athlete_id required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createSupabaseClient()

    // Get valid access token
    const { data: tokenData } = await supabase
      .from('strava_tokens')
      .select('*')
      .eq('athlete_id', athlete_id)
      .single()

    if (!tokenData) {
      return new Response(
        JSON.stringify({ error: 'No Strava connection found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Check if token needs refresh
    let accessToken = tokenData.access_token
    if (new Date(tokenData.expires_at) < new Date()) {
      // Refresh token
      const refreshResponse = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: Deno.env.get('STRAVA_CLIENT_ID'),
          client_secret: Deno.env.get('STRAVA_CLIENT_SECRET'),
          refresh_token: tokenData.refresh_token,
          grant_type: 'refresh_token'
        })
      })

      const newTokenData = await refreshResponse.json()
      accessToken = newTokenData.access_token

      // Update token in database
      await supabase
        .from('strava_tokens')
        .update({
          access_token: newTokenData.access_token,
          refresh_token: newTokenData.refresh_token,
          expires_at: new Date(Date.now() + newTokenData.expires_in * 1000).toISOString()
        })
        .eq('athlete_id', athlete_id)
    }

    // Fetch latest 20 activities from Strava
    const activitiesResponse = await fetch(
      'https://www.strava.com/api/v3/athlete/activities?per_page=20',
      {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      }
    )

    const activities = await activitiesResponse.json()

    // Upsert activities into database
    const activitiesToInsert = activities.map((a: any) => ({
      id: a.id,
      athlete_id,
      activity_type_id: a.type === 'Run' ? 1 : 2, // Simplified
      name: a.name,
      distance: a.distance,
      moving_time: a.moving_time,
      elapsed_time: a.elapsed_time,
      activity_date: a.start_date,
      elevation_gain: a.total_elevation_gain,
      average_speed: a.average_speed,
      max_speed: a.max_speed,
      average_heart_rate: a.average_heartrate,
      max_heart_rate: a.max_heartrate,
      map_summary_polyline: a.map?.summary_polyline
    }))

    const { data: inserted } = await supabase
      .from('activities')
      .upsert(activitiesToInsert, { onConflict: 'id' })
      .select()

    return new Response(
      JSON.stringify({
        success: true,
        activities_synced: inserted?.length || 0,
        activities: inserted
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Sync error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
```

---

## Phase 6: Database Functions for Long-Running Jobs (Day 6)

### 6.1 Create Sync Job Function in Postgres
```sql
-- Function to sync activities for a single athlete
CREATE OR REPLACE FUNCTION sync_athlete_activities(athlete_id_param BIGINT)
RETURNS TABLE (
  activities_synced INT,
  success BOOLEAN,
  error_message TEXT
) AS $$
DECLARE
  token_data RECORD;
  activity_data JSONB;
  new_access_token TEXT;
BEGIN
  -- Get token
  SELECT * INTO token_data
  FROM strava_tokens
  WHERE athlete_id = athlete_id_param;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 0, FALSE, 'No Strava connection found';
    RETURN;
  END IF;

  -- Check token expiry and refresh if needed
  IF token_data.expires_at < NOW() THEN
    -- TODO: Call edge function to refresh token
    -- For now, return error
    RETURN QUERY SELECT 0, FALSE, 'Token expired - needs refresh';
    RETURN;
  END IF;

  -- Fetch activities via HTTP extension
  -- Note: Requires http extension
  SELECT content::jsonb INTO activity_data
  FROM http((
    'GET',
    'https://www.strava.com/api/v3/athlete/activities?per_page=200',
    ARRAY[http_header('Authorization', 'Bearer ' || token_data.access_token)],
    NULL,
    NULL
  )::http_request);

  -- Insert activities
  INSERT INTO activities (
    id, athlete_id, name, distance, moving_time, activity_date
    -- Add more fields as needed
  )
  SELECT
    (activity->>'id')::BIGINT,
    athlete_id_param,
    activity->>'name',
    (activity->>'distance')::NUMERIC,
    (activity->>'moving_time')::INT,
    (activity->>'start_date')::TIMESTAMPTZ
  FROM jsonb_array_elements(activity_data) activity
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    distance = EXCLUDED.distance,
    moving_time = EXCLUDED.moving_time;

  RETURN QUERY SELECT
    jsonb_array_length(activity_data)::INT,
    TRUE,
    NULL::TEXT;

EXCEPTION WHEN OTHERS THEN
  RETURN QUERY SELECT 0, FALSE, SQLERRM;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 6.2 Set Up Cron Job
```sql
-- Enable pg_cron extension
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule sync every 6 hours for active athletes
SELECT cron.schedule(
  'sync-active-athletes',
  '0 */6 * * *',
  $$
  SELECT sync_athlete_activities(athlete_id)
  FROM athletes
  WHERE strava_connected = true
    AND strava_connected_at > NOW() - INTERVAL '30 days';
  $$
);
```

---

## Phase 7: Testing & Cutover (Day 7)

### 7.1 Parallel Testing
```bash
# Test all endpoints side by side
# Node.js
curl http://localhost:8080/api/chat -d '{"athlete_id": 123, "message": "test"}'

# Edge Functions
curl https://your-project.supabase.co/functions/v1/chat \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{"athlete_id": 123, "message": "test"}'
```

### 7.2 Update iOS App URLs
```swift
// APIConfiguration.swift
struct APIConfiguration {
    struct RunawayCoach {
        #if DEBUG
        static let baseURL = "http://localhost:54321/functions/v1"
        #else
        static let baseURL = "https://your-project.supabase.co/functions/v1"
        #endif
    }
}
```

### 7.3 Deploy iOS App Update
- Update API endpoints to point to Edge Functions
- Test thoroughly in TestFlight
- Monitor for errors

### 7.4 Cutover Checklist
- [ ] All Edge Functions deployed
- [ ] Database functions created
- [ ] Cron jobs scheduled
- [ ] iOS app updated and tested
- [ ] OAuth callback working
- [ ] Monitoring/logging in place
- [ ] Backup plan ready

---

## Post-Migration

### Decommission Cloud Run
```bash
# Once Edge Functions are stable for 1 week:
gcloud run services delete strava-sync-service --region=us-central1
```

### Monitor Performance
```sql
-- Track Edge Function usage
SELECT
  function_name,
  COUNT(*) as invocations,
  AVG(execution_time_ms) as avg_time,
  MAX(execution_time_ms) as max_time
FROM edge_functions_logs
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY function_name;
```

### Cost Savings
**Before (Cloud Run):**
- Instance hours: ~$50/month
- Networking: ~$10/month
- **Total: ~$60/month**

**After (Supabase Edge Functions):**
- Included in Supabase Pro plan
- 2M invocations/month free
- **Total: $0 additional cost**

---

## Rollback Plan

If issues arise:

1. **Immediate**: Point iOS app back to Cloud Run
   ```swift
   static let baseURL = "https://your-cloud-run-url.run.app/api"
   ```

2. **Within 1 hour**: Revert DNS/routing changes

3. **Within 24 hours**: Keep Cloud Run instance running for 1 week as backup

---

## Success Metrics

Track these metrics to validate migration:

- ✅ **Response time** < 200ms (vs ~500ms on Cloud Run)
- ✅ **Cold start time** < 100ms (vs 2-3s on Cloud Run)
- ✅ **Error rate** < 0.1%
- ✅ **Cost reduction** ~$60/month → $0
- ✅ **Deployment time** < 30 seconds

---

## Next Steps

1. Review this plan
2. Set up staging environment
3. Migrate chat endpoint first (lowest risk)
4. Test thoroughly before moving to production
5. Migrate remaining endpoints
6. Monitor and optimize
