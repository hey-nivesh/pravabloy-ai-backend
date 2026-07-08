# PravabloyAI Server

## Database migrations

Run the SQL files in `migrations/` in order:

1. `20260708_01_voice_analytics_foundation.sql`
2. `20260708_02_progress_rollups.sql`

Example (Supabase SQL editor):

```sql
-- 1) foundational tables
\i migrations/20260708_01_voice_analytics_foundation.sql

-- 2) progress rollups
\i migrations/20260708_02_progress_rollups.sql
```

If your SQL editor does not support `\i`, paste each file manually in order.

## Key APIs

- `POST /api/analyze-fluency` -> generates and persists analysis for a session
- `GET /api/progress/summary` -> aggregate progress and trend points for dashboard charts
