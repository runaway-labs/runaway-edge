---
# Edge Functions Deployment Guide
Complete guide for deploying Runaway APIs to Supabase Edge Functions

## Prerequisites

1. **Supabase CLI** installed
```bash
brew install supabase/tap/supabase
```

2. **Supabase Project** created at https://supabase.com

3. **API Keys** ready:
   - Anthropic API key
   - Strava Client ID
   - Strava Client Secret

## Step 1: Link Your Supabase Project

```bash
cd /Users/jack.rudelic/projects/labs/runaway-edge

# Login to Supabase
supabase login

# Link your project
supabase link --project-ref your-project-ref
```

## Step 2: Run Database Migrations

```bash
# Apply migrations in order
supabase db push

# This will create:
# - sync_jobs table
# - strava_tokens table
# - athletes table
# - activities table
# - Helper functions (cleanup, reset, stats)
# - pg_cron schedules
```

## Step 3: Set Environment Secrets

```bash
# Set Anthropic API key
supabase secrets set ANTHROPIC_API_KEY=your_anthropic_key_here

# Set Strava OAuth credentials
supabase secrets set STRAVA_CLIENT_ID=your_strava_client_id
supabase secrets set STRAVA_CLIENT_SECRET=your_strava_client_secret

# Verify secrets are set
supabase secrets list
```

## Step 4: Deploy Edge Functions

```bash
# Deploy all functions at once
supabase functions deploy chat
supabase functions deploy journal
supabase functions deploy oauth-callback
supabase functions deploy sync-beta
supabase functions deploy sync-processor

# Or deploy individually
supabase functions deploy chat
```

## Step 5: Update pg_cron Configuration

After deployment, update the pg_cron schedule to use your actual project URL:

```sql
-- Connect to your database
-- Go to Supabase Dashboard > SQL Editor

-- Update the sync-processor cron job with your actual URL
SELECT cron.unschedule('process-sync-jobs');

SELECT cron.schedule(
  'process-sync-jobs',
  '*/5 * * * *',
  $$
  SELECT
    net.http_post(
      url := 'https://your-actual-project-ref.supabase.co/functions/v1/sync-processor',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY'
      ),
      body := '{}'::jsonb
    ) AS request_id;
  $$
);
```

## Step 6: Test Edge Functions Locally (Optional)

```bash
# Create .env.local file
cat > .env.local << EOF
SUPABASE_URL=http://localhost:54321
SUPABASE_SERVICE_ROLE_KEY=your-local-key
ANTHROPIC_API_KEY=your-anthropic-key
STRAVA_CLIENT_ID=your-strava-client-id
STRAVA_CLIENT_SECRET=your-strava-secret
EOF

# Start local Supabase
supabase start

# Serve a function locally
supabase functions serve chat --env-file .env.local

# Test in another terminal
curl -X POST http://localhost:54321/functions/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "athlete_id": 94451852,
    "message": "How was my training this week?"
  }'
```

## Step 7: Verify Deployment

### Test Chat Function
```bash
curl -X POST https://your-project-ref.supabase.co/functions/v1/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -d '{
    "athlete_id": 94451852,
    "message": "Hello coach"
  }'
```

### Test Journal Function
```bash
curl -X POST https://your-project-ref.supabase.co/functions/v1/journal/generate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -d '{
    "athlete_id": 94451852
  }'
```

### Test OAuth Flow
1. Visit: `https://www.strava.com/oauth/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=https://your-project-ref.supabase.co/functions/v1/oauth-callback&response_type=code&scope=activity:read_all`
2. Authorize with Strava
3. Should redirect to oauth-callback function
4. Verify tokens are stored in database

### Test Sync Beta
```bash
curl -X POST https://your-project-ref.supabase.co/functions/v1/sync-beta \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -d '{
    "user_id": 94451852
  }'
```

### Verify pg_cron is Running
```sql
-- Check scheduled jobs
SELECT * FROM cron.job;

-- Check cron job history
SELECT * FROM cron.job_run_details
ORDER BY start_time DESC
LIMIT 10;
```

## Step 8: Update iOS App Endpoints

Update your iOS app to use the new Edge Functions:

```swift
// Old Cloud Run endpoints
let oldChatURL = "https://your-cloud-run-url/api/chat"
let oldJournalURL = "https://your-cloud-run-url/api/journal"

// New Edge Function endpoints
let newChatURL = "https://your-project-ref.supabase.co/functions/v1/chat"
let newJournalURL = "https://your-project-ref.supabase.co/functions/v1/journal/generate"
```

## Step 9: Monitor and Debug

### View Function Logs
```bash
# View logs in real-time
supabase functions logs chat --tail

# View specific function logs
supabase functions logs journal --limit 100
```

### Check Database Logs
```sql
-- Check sync job status
SELECT * FROM sync_jobs
ORDER BY created_at DESC
LIMIT 10;

-- Get job statistics
SELECT * FROM get_sync_job_stats();

-- Check recent activities
SELECT COUNT(*), athlete_id
FROM activities
WHERE activity_date > NOW() - INTERVAL '7 days'
GROUP BY athlete_id;
```

### Common Issues

**1. Token Expired Errors**
- The sync-processor automatically refreshes tokens
- Check `strava_tokens` table for `expires_at` values
- Manually trigger sync-processor if needed

**2. pg_cron Not Running**
```sql
-- Verify pg_cron is enabled
SELECT * FROM pg_extension WHERE extname = 'pg_cron';

-- Check cron job status
SELECT * FROM cron.job;
```

**3. Edge Function Timeouts**
- Edge Functions have a 150-second timeout
- For large syncs, pg_cron will handle batching
- Check function logs for timeout errors

## Step 10: Performance Monitoring

### Key Metrics to Watch

1. **Sync Job Processing Time**
```sql
SELECT
  AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) / 60 AS avg_minutes,
  MAX(EXTRACT(EPOCH FROM (completed_at - started_at))) / 60 AS max_minutes
FROM sync_jobs
WHERE status = 'completed'
  AND completed_at > NOW() - INTERVAL '24 hours';
```

2. **Success Rate**
```sql
SELECT
  status,
  COUNT(*) AS count,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) AS percentage
FROM sync_jobs
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY status;
```

3. **Activities Synced**
```sql
SELECT
  DATE(activity_date) AS date,
  COUNT(*) AS activities_synced
FROM activities
WHERE activity_date > NOW() - INTERVAL '7 days'
GROUP BY DATE(activity_date)
ORDER BY date DESC;
```

## Rollback Plan

If issues arise, you can rollback:

1. **Revert iOS app to Cloud Run endpoints**
2. **Keep Edge Functions running** (no cost)
3. **Investigate and fix issues**
4. **Re-deploy when ready**

Cloud Run can continue running in parallel during testing.

## Cost Comparison

### Before (Cloud Run)
- Compute: ~$40-50/month
- Bandwidth: ~$10/month
- **Total: ~$60/month**

### After (Edge Functions)
- Compute: $0 (within free tier: 500K requests/month)
- Bandwidth: $0 (within free tier)
- Database: $0 (existing Supabase plan)
- **Total: $0/month**

## Next Steps

1. Monitor for 48 hours
2. Check error rates in logs
3. Verify sync jobs completing successfully
4. Once stable, deprecate Cloud Run services
5. Update documentation

## Support

For issues:
1. Check function logs: `supabase functions logs <function-name>`
2. Check database logs in Supabase Dashboard
3. Review migration progress: `MIGRATION_PROGRESS.md`
4. Check Supabase status: https://status.supabase.com
