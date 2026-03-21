# Runaway Edge Functions

Supabase Edge Functions for **Runaway** — AI-powered running coach with Strava/Garmin sync, personalized coaching, race features, and background push notifications.

## Project Structure

```
runaway-edge/
└── supabase/
    ├── config.toml               # Supabase project configuration
    ├── functions/
    │   ├── _shared/              # Shared utilities
    │   │   ├── apns.ts           # Native APNs push sender (ES256 JWT)
    │   │   ├── cors.ts           # CORS headers
    │   │   ├── logging.ts        # Structured logging
    │   │   ├── supabase-client.ts
    │   │   ├── threshold-evaluator.ts
    │   │   ├── types.ts
    │   │   ├── resend.ts
    │   │   ├── twilio.ts
    │   │   ├── weather-api.ts
    │   │   └── aqi-api.ts
    │   └── [37 functions]        # See function inventory below
    └── migrations/               # 17 PostgreSQL migrations
```

## Function Inventory

### AI Coaching
| Function | Description |
|----------|-------------|
| `chat` | AI coaching conversations via Claude with RAG over activity history |
| `journal` | AI-generated weekly training summaries |
| `goal-assessment` | Structured goal analysis and insights |
| `comprehensive-analysis` | Deep training load and performance analysis |
| `daily-brief` | Race-aware daily training brief (taper mode at 21 days pre-race) |
| `daily-research-brief` | Daily personalized research summary |
| `activity-observations` | Twin observation tracking per activity |
| `micro-wins` | Small win detection from activity data |

### Integrations
| Function | Description |
|----------|-------------|
| `oauth-callback` | Strava OAuth flow handler |
| `strava-auth` | Strava OAuth initiation |
| `strava-webhook` | Strava activity push notifications (no JWT) |
| `garmin-auth` | Garmin OAuth initiation |
| `garmin-callback` | Garmin OAuth callback handler |
| `garmin-webhook` | Garmin activity push notifications |
| `garmin-stats` | Fetch Garmin health stats |
| `sync-beta` | Multi-source activity sync (Strava + Garmin) |
| `fetch-daily-articles` | Fetch and store running articles |

### Race Features
| Function | Description |
|----------|-------------|
| `get-race-course` | Fetch race course spatial data and polylines |
| `classify-races` | Classify races from activity data |
| `sync-race-directory` | Sync race directory from RunSignUp |
| `user-races` | Manage athlete race entries |

### Notifications & Cron
| Function | Description |
|----------|-------------|
| `notify-activity-insert` | Database trigger → APNs silent push on new activity |
| `check-conditions` | Weather/AQI condition checks (runs every 30 min) |
| `process-deliveries` | Alert delivery processing (runs every 1 min) |
| `send-alert` | Dispatch alerts via Twilio/Resend |
| `check-hooks` / `check-hooks2` | Webhook health checks |

### Account & Training Plans
| Function | Description |
|----------|-------------|
| `delete-account` | Full account deletion (App Store compliance) |
| `disconnect` | Disconnect third-party integrations |
| `generate-training-plan` | AI training plan generation |
| `regenerate-training-plan` | Regenerate existing training plan |
| `training-plan` | Training plan management |
| `job-status` | Background job status polling |

### Utilities
| Function | Description |
|----------|-------------|
| `max-data` | Fetch max data values for an athlete |
| `run-ddl` | Execute DDL statements (admin) |
| `check-webhook-config` | Verify webhook configuration |
| `import-runners` | Bulk runner import |
| `check-hooks` / `check-hooks2` | Hook validation |

## APNs Architecture

Activities sync silently without opening the app via a Postgres trigger + Edge Function:

```
INSERT into activities
    → pg_net.http_post → notify-activity-insert
    → look up athlete.apns_token
    → APNs silent push (content-available: 1)
    → iOS background refresh
    → WidgetCenter.reloadAllTimelines()
```

Required secrets for APNs: `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_PRODUCTION`

## Local Development

```bash
# Start local Supabase
supabase start

# Serve a single function with env vars
supabase functions serve chat --env-file .env.local

# Test locally
curl -X POST http://localhost:54321/functions/v1/chat \
  -H "Authorization: Bearer <anon-key>" \
  -H "Content-Type: application/json" \
  -d '{"athlete_id": 123, "message": "How was my week?"}'
```

## Deployment

```bash
# Link to project
supabase link --project-ref <project-ref>

# Push migrations
supabase db push

# Set secrets
supabase secrets set ANTHROPIC_API_KEY=xxx
supabase secrets set STRAVA_CLIENT_ID=xxx
supabase secrets set STRAVA_CLIENT_SECRET=xxx
supabase secrets set APNS_KEY_P8=xxx
supabase secrets set APNS_KEY_ID=xxx
supabase secrets set APNS_TEAM_ID=xxx
supabase secrets set APNS_BUNDLE_ID=com.jackrudelic.runawayios

# Deploy single function
supabase functions deploy notify-activity-insert

# Deploy all (CI does this automatically on push to main)
supabase functions deploy
```

CI auto-deploys all functions on push to `main` via GitHub Actions (`.github/workflows/deploy-functions.yml`) with Discord build notifications.

## Import Pattern

All functions use JSR imports — not npm:

```ts
// Correct
import { createClient } from "jsr:@supabase/supabase-js@2";

// Wrong — causes bundler failure
import { createClient } from "npm:@supabase/supabase-js@2";
```

## Database Migrations

17 migrations in `supabase/migrations/`:

| Range | Content |
|-------|---------|
| 001–005 | Core schema: sync jobs, activities, training plans, research |
| 006–008 | Garmin OAuth, structured logging |
| 20250107–20250210 | Multi-source activities, Garmin, fitness stats |
| 20260201 | Race tables (course polylines, athlete entries) |
| 20260301–20260305 | Twin observation, goals RLS policies |

## Tech Stack

- **Runtime**: Deno + Supabase Edge Functions
- **Database**: PostgreSQL 17 with pg_cron + pg_net
- **AI**: Anthropic Claude API
- **Push**: Native APNs (ES256 JWT — Firebase removed)
- **Integrations**: Strava API v3, Garmin Health API
- **Alerts**: Twilio (SMS), Resend (email)

## License

Proprietary — Runaway App
