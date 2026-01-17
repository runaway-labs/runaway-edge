# Runaway Edge Functions

Supabase Edge Functions for **Runaway** — an AI-powered running coach that connects to your Strava and Garmin accounts to provide personalized coaching, training insights, and weekly journals.

## Project Structure

```
runaway-edge/
└── supabase/
    ├── config.toml           # Supabase project configuration
    ├── functions/            # Edge functions (Deno)
    │   ├── _shared/          # Shared utilities (cors, logging)
    │   ├── chat/             # AI coaching conversations
    │   ├── journal/          # Weekly training summaries
    │   ├── oauth-callback/   # Strava OAuth handler
    │   ├── sync-beta/        # Activity sync from Strava
    │   ├── garmin-auth/      # Garmin OAuth initiation
    │   ├── garmin-callback/  # Garmin OAuth handler
    │   ├── garmin-webhook/   # Garmin push notifications
    │   ├── strava-webhook/   # Strava push notifications
    │   └── ... (18 functions total)
    └── migrations/           # Database schema
```

## Edge Functions

| Function | Description |
|----------|-------------|
| `chat` | AI coaching powered by Claude with RAG over activity history |
| `journal` | AI-generated weekly training summaries |
| `oauth-callback` | Strava OAuth flow handler |
| `sync-beta` | Fetch and sync activities from Strava |
| `garmin-auth` | Initiate Garmin OAuth flow |
| `garmin-callback` | Handle Garmin OAuth callback |
| `garmin-webhook` | Receive Garmin activity push notifications |
| `strava-webhook` | Receive Strava activity push notifications |
| `comprehensive-analysis` | Deep training analysis |
| `daily-research-brief` | Daily research summaries |
| `delete-account` | Account deletion (App Store compliance) |
| `disconnect` | Disconnect integrations |
| `fetch-daily-articles` | Fetch running articles |
| `generate-training-plan` | AI training plan generation |
| `regenerate-training-plan` | Regenerate training plans |
| `training-plan` | Training plan management |
| `job-status` | Background job status |
| `notify-activity-insert` | Activity notification trigger |

## Local Development

```bash
# Start local Supabase
supabase start

# Serve a function
supabase functions serve chat --env-file .env.local

# Test
curl -X POST http://localhost:54321/functions/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"athlete_id": 123, "message": "How was my week?"}'
```

## Deployment

```bash
# Link project
supabase link --project-ref your-ref

# Run migrations
supabase db push

# Set secrets
supabase secrets set ANTHROPIC_API_KEY=xxx
supabase secrets set STRAVA_CLIENT_ID=xxx
supabase secrets set STRAVA_CLIENT_SECRET=xxx

# Deploy all functions
supabase functions deploy
```

## Tech Stack

- **Runtime**: Deno + Supabase Edge Functions
- **Database**: PostgreSQL 17
- **AI**: Anthropic Claude
- **External APIs**: Strava API v3, Garmin Health API

## License

Proprietary - Runaway App
