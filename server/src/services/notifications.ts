import { supabaseAdmin } from '../middleware/requireAuth';

export type NotificationType =
  | 'achievement_level_up'
  | 'achievement_daily_challenge'
  | 'achievement_journey_unlock'
  | 'achievement_streak'
  | 'achievement_session'
  | 'achievement_vocab';

export type UserNotification = {
  id: string;
  user_id: string;
  type: NotificationType | string;
  title: string;
  body: string;
  metadata: Record<string, unknown> | null;
  read: boolean;
  created_at: string;
};

export async function createNotification(params: {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}): Promise<UserNotification | null> {
  const { userId, type, title, body, metadata } = params;
  if (!userId) return null;

  const { data, error } = await supabaseAdmin
    .from('user_notifications')
    .insert({
      user_id: userId,
      type,
      title,
      body,
      metadata: metadata ?? null,
    })
    .select('*')
    .single();

  if (error) {
    console.warn('[notifications] insert failed:', error.message);
    return null;
  }

  return data as UserNotification;
}

export async function listNotifications(
  userId: string,
  limit = 50,
): Promise<UserNotification[]> {
  const { data, error } = await supabaseAdmin
    .from('user_notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []) as UserNotification[];
}

export async function countUnreadNotifications(userId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('user_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('read', false);

  if (error) return 0;
  return count ?? 0;
}

export async function markNotificationsRead(
  userId: string,
  notificationId?: string,
): Promise<void> {
  let query = supabaseAdmin
    .from('user_notifications')
    .update({ read: true })
    .eq('user_id', userId)
    .eq('read', false);

  if (notificationId) {
    query = query.eq('id', notificationId);
  }

  const { error } = await query;
  if (error) {
    throw new Error(error.message);
  }
}

export async function notifyLevelUp(
  userId: string,
  newLevel: number,
): Promise<void> {
  await createNotification({
    userId,
    type: 'achievement_level_up',
    title: `Level ${newLevel} Unlocked!`,
    body: `You reached Level ${newLevel}. Keep practicing to climb higher.`,
    metadata: { level: newLevel },
  });
}

export async function notifyDailyChallengeComplete(userId: string): Promise<void> {
  await createNotification({
    userId,
    type: 'achievement_daily_challenge',
    title: 'Daily Challenge Complete!',
    body: 'You finished all 5 tasks and earned bonus XP plus streak protection.',
    metadata: { xpBonus: 50 },
  });
}

export async function notifyJourneyUnlock(
  userId: string,
  nodeId: string,
  nodeLabel: string,
): Promise<void> {
  const { data: existing } = await supabaseAdmin
    .from('user_notifications')
    .select('id')
    .eq('user_id', userId)
    .eq('type', 'achievement_journey_unlock')
    .contains('metadata', { nodeId })
    .limit(1);

  if (existing && existing.length > 0) return;

  await createNotification({
    userId,
    type: 'achievement_journey_unlock',
    title: `${nodeLabel} Unlocked`,
    body: `You've unlocked a new stop on your Fluency Journey: ${nodeLabel}.`,
    metadata: { nodeId, nodeLabel },
  });
}

export async function notifyStreakMilestone(
  userId: string,
  streakCount: number,
): Promise<void> {
  await createNotification({
    userId,
    type: 'achievement_streak',
    title: `${streakCount}-Day Streak!`,
    body: `Amazing consistency — ${streakCount} days of practice in a row.`,
    metadata: { streakCount },
  });
}

export async function notifySessionComplete(
  userId: string,
  durationMinutes: number,
  xpAwarded: number,
): Promise<void> {
  await createNotification({
    userId,
    type: 'achievement_session',
    title: 'Session Complete',
    body: `Great work! ${Math.round(durationMinutes)} min practiced · +${xpAwarded} XP earned.`,
    metadata: { durationMinutes, xpAwarded },
  });
}
