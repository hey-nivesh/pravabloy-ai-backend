  -- PravabloyAI progress rollups and helper view

  create table if not exists public.user_progress_daily (
    id uuid primary key default uuid_generate_v4(),
    user_id uuid not null,
    day_date date not null,
    sessions_count integer not null default 0,
    total_user_words integer not null default 0,
    avg_wpm numeric(8,2),
    avg_filler_count numeric(8,2),
    avg_fluency_score numeric(8,2),
    avg_confidence_score numeric(8,2),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(user_id, day_date)
  );

  create index if not exists idx_user_progress_daily_user_day
    on public.user_progress_daily(user_id, day_date desc);

  create or replace view public.v_user_latest_progress as
  select
    ar.user_id,
    ar.voice_session_id,
    ar.created_at,
    coalesce(ar.fluency_score, ar.score) as fluency_score,
    coalesce(ar.confidence_score, 0) as confidence_score,
    coalesce(ar.wpm, 0) as wpm,
    coalesce(ar.filler_word_count, ar.filler_count, 0) as filler_count,
    coalesce(ar.lexicon_tier_rank, 'Smart Starter') as lexicon_tier_rank,
    ar.strengths,
    ar.improvement_areas
  from public.analytics_reports ar;
