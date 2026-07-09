-- Gamification: XP totals and computed level on public.users
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS xp_total integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS xp_level integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.users.xp_total IS 'Lifetime experience points earned from practice activities';
COMMENT ON COLUMN public.users.xp_level IS 'Current level derived from xp_total via shared leveling curve';
