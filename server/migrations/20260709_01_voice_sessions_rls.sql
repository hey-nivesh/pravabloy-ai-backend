-- RLS policies for voice_sessions, analytics_reports, and vocab_vault
-- Safe to run multiple times.

-- ── voice_sessions ────────────────────────────────────────────────────────────
alter table public.voice_sessions enable row level security;

drop policy if exists "Users read own voice sessions" on public.voice_sessions;
create policy "Users read own voice sessions"
  on public.voice_sessions for select
  using (auth.uid() = user_id);

drop policy if exists "Users insert own voice sessions" on public.voice_sessions;
create policy "Users insert own voice sessions"
  on public.voice_sessions for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users update own voice sessions" on public.voice_sessions;
create policy "Users update own voice sessions"
  on public.voice_sessions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── analytics_reports ─────────────────────────────────────────────────────────
alter table public.analytics_reports enable row level security;

drop policy if exists "Users read own analytics reports" on public.analytics_reports;
create policy "Users read own analytics reports"
  on public.analytics_reports for select
  using (auth.uid() = user_id);

drop policy if exists "Users insert own analytics reports" on public.analytics_reports;
create policy "Users insert own analytics reports"
  on public.analytics_reports for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users update own analytics reports" on public.analytics_reports;
create policy "Users update own analytics reports"
  on public.analytics_reports for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── vocab_vault ───────────────────────────────────────────────────────────────
create table if not exists public.vocab_vault (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null,
  word text not null,
  phonetic text,
  part_of_speech text,
  definition text,
  example_sentence text,
  usage_tip text,
  source text default 'curated',
  srs_interval_days integer not null default 1,
  srs_ease_factor numeric(4,2) not null default 2.5,
  next_review_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_vocab_vault_user_id
  on public.vocab_vault(user_id);

alter table public.vocab_vault enable row level security;

drop policy if exists "Users read own vocab" on public.vocab_vault;
create policy "Users read own vocab"
  on public.vocab_vault for select
  using (auth.uid() = user_id);

drop policy if exists "Users insert own vocab" on public.vocab_vault;
create policy "Users insert own vocab"
  on public.vocab_vault for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users update own vocab" on public.vocab_vault;
create policy "Users update own vocab"
  on public.vocab_vault for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
