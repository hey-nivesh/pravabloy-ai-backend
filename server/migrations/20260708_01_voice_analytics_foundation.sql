-- PravabloyAI voice analytics foundation
-- Safe to run multiple times where possible.

create extension if not exists "uuid-ossp";

create table if not exists public.voice_sessions (
  id text primary key,
  user_id uuid not null,
  case_study_id text,
  mode text not null default 'casual',
  status text not null default 'in_progress',
  transcript jsonb not null default '[]'::jsonb,
  live_pacing jsonb not null default '[]'::jsonb,
  analytics_report_id uuid,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_voice_sessions_user_created_at
  on public.voice_sessions(user_id, created_at desc);

create index if not exists idx_voice_sessions_status
  on public.voice_sessions(status);

create table if not exists public.analytics_reports (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null,
  voice_session_id text not null,
  wpm integer,
  filler_word_count integer,
  grammar_gaps jsonb,
  lexicon_tier_rank text,
  fluency_score integer,
  confidence_score integer,
  strengths jsonb,
  improvement_areas jsonb,
  score integer,
  filler_count integer,
  grammar_corrections jsonb,
  vocab_feedback text,
  full_report jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_analytics_reports_voice_session_id
  on public.analytics_reports(voice_session_id);

create index if not exists idx_analytics_reports_user_created_at
  on public.analytics_reports(user_id, created_at desc);
