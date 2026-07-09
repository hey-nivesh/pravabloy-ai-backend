# Deploy PravabloyAI Backend (Free Tier)

Recommended platform: **[Render](https://render.com)** free Web Service (750 hrs/month, sleeps after 15 min idle).

Supabase stays on the free tier for Postgres + Auth. The Expo app points at the deployed API URL.

## Prerequisites

1. GitHub repo with this monorepo pushed
2. Supabase project with all migrations applied (`apps/server/migrations/*.sql`)
3. Google AI Studio API key (Gemini)
4. `SUPABASE_SERVICE_ROLE_KEY` from Supabase → Settings → API

## Step 1 — Run database migrations

In Supabase SQL Editor, run in order:

- `20260708_01_voice_analytics_foundation.sql`
- `20260708_02_progress_rollups.sql`
- `20260709_01_voice_sessions_rls.sql`
- `20260709_02_vocabulary_corpus.sql`
- `20260709_03_user_streak_date.sql`
- `20260709_04_user_xp.sql`
- `20260709_05_daily_challenges.sql`
- `20260709_06_user_notifications.sql`

## Step 2 — Deploy to Render

1. Go to [render.com](https://render.com) → **New** → **Blueprint**
2. Connect your GitHub repo
3. Render reads `render.yaml` at repo root
4. Set secret env vars in the dashboard:
   - `EXPO_PUBLIC_SUPABASE_URL`
   - `EXPO_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `GOOGLE_API_KEY`
5. Deploy. Note your service URL, e.g. `https://pravabloyai-api.onrender.com`

## Step 3 — Configure the Expo app

In `pravabloyai/.env`:

```env
EXPO_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
EXPO_PUBLIC_VOICE_GATEWAY_URL=wss://pravabloyai-api.onrender.com/ws/voice-session
EXPO_PUBLIC_API_BASE_URL=https://pravabloyai-api.onrender.com
```

Rebuild or restart Expo after changing env.

## Step 4 — Verify production

```bash
curl https://YOUR-SERVICE.onrender.com/health
# → {"status":"healthy","timestamp":"..."}
```

Test authenticated REST from the app (history, notifications, daily challenge).

## WebSocket notes (Render free tier)

- Render supports WebSockets on web services
- Free tier **spins down** after ~15 min idle — first request may take 30–60s (cold start)
- For MVP demos, wake the server before voice sessions: open Home screen (triggers API calls)

## Alternative free platforms

| Platform | WebSocket | Free tier caveat |
|----------|-----------|------------------|
| **Render** | Yes | Sleeps when idle |
| **Fly.io** | Yes | Requires credit card; small free allowance |
| **Railway** | Yes | Limited free credits/month |

Render is the simplest zero-cost MVP path with Docker + health checks already configured.

## What is production-ready in this repo

- `Dockerfile` multi-stage build
- `render.yaml` blueprint
- `GET /health` liveness probe
- CORS via `CORS_ORIGINS` env
- `trust proxy` for HTTPS behind Render
- Session history via `voice_sessions` + `GET /api/voice-sessions/history`
- Achievement notifications via `user_notifications` table + hooks on XP, streak, daily challenge, sessions, journey

## Agent prompt (copy-paste for future work)

```
Act as a Senior DevOps + Full-Stack engineer on PravabloyAI.

GOAL: Keep the Express/WebSocket server (apps/server) production-ready on Render free tier.

TASKS:
1. Ensure all SQL migrations in apps/server/migrations are applied to Supabase.
2. Deploy using render.yaml — Docker build from apps/server/Dockerfile.
3. Set env: SUPABASE_*, GOOGLE_API_KEY, NODE_ENV=production, PORT=10000, CORS_ORIGINS=*.
4. Point pravabloyai/.env EXPO_PUBLIC_VOICE_GATEWAY_URL and EXPO_PUBLIC_API_BASE_URL to the Render URL.
5. Verify /health, /api/voice-sessions/history, /api/v1/notifications, WebSocket /ws/voice-session.
6. Session history saves automatically when voiceGateway finalizeSession marks voice_sessions completed.
7. Notifications fire on: level up, streak milestones (3/7/14/30/60/100), daily challenge complete, session complete, journey node unlock.

Do not mock data. Use existing hooks useSessionHistory and useNotifications on client.
```
