-- ============================================================
-- Migration: user_word_history
-- Purpose:   Track EVERY word ever shown to a user via the
--            Daily Vocab / word-discovery flow — so nothing is
--            lost and words are never repeated as "new".
--
--            This is DISTINCT from public.vocab_vault (SRS):
--              • user_word_history = "everything I've ever seen"
--              • vocab_vault       = "what I'm actively studying"
-- ============================================================

create extension if not exists "uuid-ossp";

create table if not exists public.user_word_history (
  id                uuid        primary key default uuid_generate_v4(),
  user_id           uuid        not null references public.users(id) on delete cascade,
  word_id           uuid        not null references public.vocabulary_words(id) on delete cascade,
  first_shown_at    timestamptz not null default now(),
  times_revisited   int         not null default 0,
  last_viewed_at    timestamptz not null default now(),
  -- true when user has also added this word to vocab_vault for SRS review
  is_saved_to_vault boolean     not null default false,
  unique (user_id, word_id)
);

-- Row-level security: users can only see and modify their own rows
alter table public.user_word_history enable row level security;

create policy "history_owner_all"
  on public.user_word_history
  for all
  using (auth.uid() = user_id);

-- Efficient descending-chronological listing of a user's history
create index if not exists user_word_history_user_time_idx
  on public.user_word_history (user_id, first_shown_at desc);

-- For fast lookup of seen word IDs during anti-repeat query
create index if not exists user_word_history_user_word_idx
  on public.user_word_history (user_id, word_id);

-- RPC for clean atomic upsert
create or replace function public.upsert_user_word_history(p_user_id uuid, p_word_id uuid)
returns void
language plpgsql
security definer
as $$
begin
  insert into public.user_word_history (user_id, word_id, first_shown_at, times_revisited, last_viewed_at, is_saved_to_vault)
  values (p_user_id, p_word_id, now(), 0, now(), false)
  on conflict (user_id, word_id)
  do update set
    times_revisited = public.user_word_history.times_revisited + 1,
    last_viewed_at = now();
end;
$$;

