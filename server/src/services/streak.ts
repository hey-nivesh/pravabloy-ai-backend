import { supabaseAdmin } from '../middleware/requireAuth';
import { notifyStreakMilestone } from './notifications';

export type StreakRecordResult = {
  streak_count: number;
  incremented: boolean;
  last_streak_date: string;
};

function toDateKey(date = new Date()): string {
  return date.toISOString().split('T')[0];
}

function isYesterday(dateKey: string, today = new Date()): boolean {
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  return toDateKey(yesterday) === dateKey;
}

/**
 * Records daily learning activity and updates the user's streak.
 * - First activity today after yesterday's activity → streak + 1
 * - First activity today with no prior streak date → streak = 1
 * - Missed one or more days → streak resets to 1
 * - Already recorded today → no change
 */
export async function recordStreakActivity(userId: string): Promise<StreakRecordResult> {
  const todayKey = toDateKey();

  const { data: userRow, error } = await supabaseAdmin
    .from('users')
    .select('streak_count, last_streak_date')
    .eq('id', userId)
    .single();

  if (error || !userRow) {
    throw new Error(error?.message ?? 'User profile not found');
  }

  const currentStreak = userRow.streak_count ?? 0;
  const lastDate = userRow.last_streak_date as string | null;

  if (lastDate === todayKey) {
    return {
      streak_count: currentStreak,
      incremented: false,
      last_streak_date: todayKey,
    };
  }

  let nextStreak = 1;
  if (lastDate && isYesterday(lastDate)) {
    nextStreak = currentStreak + 1;
  }

  const { data: updated, error: updateError } = await supabaseAdmin
    .from('users')
    .update({
      streak_count: nextStreak,
      last_streak_date: todayKey,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId)
    .select('streak_count, last_streak_date')
    .single();

  if (updateError || !updated) {
    throw new Error(updateError?.message ?? 'Failed to update streak');
  }

  const milestones = [3, 7, 14, 30, 60, 100];
  if (milestones.includes(nextStreak)) {
    void notifyStreakMilestone(userId, nextStreak).catch(() => {});
  }

  return {
    streak_count: updated.streak_count,
    incremented: true,
    last_streak_date: updated.last_streak_date ?? todayKey,
  };
}
