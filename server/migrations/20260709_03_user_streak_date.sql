-- Track the calendar date of the user's last streak-eligible activity.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS last_streak_date date;

COMMENT ON COLUMN public.users.last_streak_date IS
  'UTC calendar date (YYYY-MM-DD) when streak was last incremented';
