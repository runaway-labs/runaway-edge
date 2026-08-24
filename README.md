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
| `chat` | AI coaching conversations via Claude with RAG over activity history; injects runner identity when `adlerian_profile` is set |
| `journal` | AI-generated weekly training summaries |
| `goal-assessment` | Structured goal analysis and insights; reads `running_goals.goal_framing` to frame in identity terms |
| `comprehensive-analysis` | Deep training load and performance analysis |
| `daily-brief` | Race-aware daily training brief (taper mode at 21 days pre-race) |
| `daily-research-brief` | Daily personalized research summary |
| `activity-observations` | Twin observation tracking per activity |
| `micro-wins` | Small win detection from activity data |
| `breakthrough-milestones` | Quality breakthrough detection from activity history; fires APNs push (called fire-and-forget by `notify-activity-insert`) |

### Runner Mindset (Adlerian)
Encouragement-first coaching surfaces backed by an identity model. See `agent/memory/runner_mindset_architecture.md` for the full architecture.

| Function | Description |
|----------|-------------|
| `identity-profile` | Classify runner into one of five identity labels via Claude Haiku 4.5; merge `adlerian_profile` into `core_memory`; seed milestones; write `goal_framing` for active goal |
| `feedback-workout` | 2–3 sentence Adlerian post-workout encouragement; writes to `activity_insights` with `insight_type = 'adlerian_feedback'` |
| `generate-run-cues` | 12 personalized in-run voice cues (Claude Haiku 4.5 dated build); pure generation, no DB writes |
| `check-milestones` | Server-side milestone evaluation across full run history; updates `runner_identity_milestones.earned`; returns `newly_earned` keys |

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

## Runner Mindset Architecture

The Runner Mindset system applies Adlerian psychology to coaching: runners are encouraged for showing up, named for who they are, and never compared to PRs or goals. The word "Adlerian" is internal-only — DB columns and edge function comments use it, but the iOS surface uses "Running Mindset" / "Runner Identity."

```
iOS                                Edge Functions                    Postgres
───                                ──────────────                    ────────
Onboarding step ──────► identity-profile ──► athlete_ai_profiles.core_memory
                                              .adlerian_profile (JSONB)
                                              + runner_identity_milestones (seed)
                                              + running_goals.goal_framing

Activity save  ────┬──► feedback-workout ──► activity_insights
                                              (insight_type = 'adlerian_feedback')
                   └──► check-milestones ──► runner_identity_milestones
                                              (earned = true on detected milestones)

Run start    ──────► generate-run-cues ──► (no DB writes; returns 12 cues)
                                                      │
                                                      ▼
                          AudioCueService speaks cues:
                            • 3s after each split announcement
                            • on ≥20% pace slump (90s shared cooldown)

Chat / Goals / Plan generation ──► identity injected into Claude system prompt
                                   when adlerian_profile is present (graceful no-op when absent)
```

**Five identity labels:** `Morning Runner`, `Trail Explorer`, `Consistent Builder` (default), `Weekend Warrior`, `Comeback Runner`.

**Six seed milestones:** `first_run`, `streak_7`, `distance_5k`, `distance_half`, `consistency_4weeks`, `comeback`.

**Tone rules (enforced in prompts):** open with showing-up acknowledgment, name identity naturally, never compare to goal/PR/previous run, no pivot language ("but"/"however"), no filler ("You've got this"). Identity summary stays under 20 words and never references pace/distance/PRs.

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
