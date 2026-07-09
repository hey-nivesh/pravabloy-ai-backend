-- Vocabulary corpus (Tier 1 seed) + lazy AI enrichment (Tier 2)
-- Run in Supabase SQL editor or via migration tooling.

create extension if not exists "uuid-ossp";

create table if not exists public.vocabulary_words (
  id uuid primary key default uuid_generate_v4(),
  word text not null unique,
  base_lemma text,
  part_of_speech text,
  difficulty_level text check (difficulty_level in ('beginner','intermediate','advanced','expert')),
  frequency_rank int,
  is_enriched boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists vocabulary_words_enriched_freq_idx
  on public.vocabulary_words (is_enriched, frequency_rank);

create index if not exists vocabulary_words_fts_idx
  on public.vocabulary_words using gin (to_tsvector('english', word));

create table if not exists public.vocabulary_enrichment (
  word_id uuid not null references public.vocabulary_words(id) on delete cascade,
  definition text not null,
  phonetic_spelling text,
  example_sentence text not null,
  usage_tip text,
  word_audio_url text,
  example_audio_url text,
  slow_word_audio_url text,
  generated_language text not null default 'en',
  generated_at timestamptz not null default now(),
  primary key (word_id, generated_language)
);

create index if not exists vocabulary_enrichment_language_idx
  on public.vocabulary_enrichment (generated_language);

-- Link user SRS rows to corpus entries (optional backfill for existing rows)
alter table public.vocab_vault
  add column if not exists corpus_word_id uuid references public.vocabulary_words(id) on delete set null;

create index if not exists vocab_vault_corpus_word_id_idx
  on public.vocab_vault (corpus_word_id);

create or replace function public.search_vocabulary_words(search_query text, result_limit int default 20)
returns setof public.vocabulary_words
language sql
stable
as $$
  select *
  from public.vocabulary_words
  where to_tsvector('english', word) @@ plainto_tsquery('english', search_query)
     or word ilike search_query || '%'
  order by frequency_rank asc nulls last, length(word) asc
  limit greatest(result_limit, 1);
$$;
