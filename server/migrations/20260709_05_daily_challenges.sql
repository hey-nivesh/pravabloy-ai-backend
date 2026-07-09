-- Daily Challenge gamification table
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.daily_challenges (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  challenge_date date NOT NULL DEFAULT CURRENT_DATE,
  tasks jsonb NOT NULL,
  xp_reward integer NOT NULL DEFAULT 50,
  streak_protection boolean NOT NULL DEFAULT false,
  completed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, challenge_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_challenges_user_date
  ON public.daily_challenges (user_id, challenge_date DESC);

COMMENT ON TABLE public.daily_challenges IS
  'Per-user daily task list with JSON task progress and completion rewards';
