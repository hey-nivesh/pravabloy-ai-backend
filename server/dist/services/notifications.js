"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createNotification = createNotification;
exports.listNotifications = listNotifications;
exports.countUnreadNotifications = countUnreadNotifications;
exports.markNotificationsRead = markNotificationsRead;
exports.notifyLevelUp = notifyLevelUp;
exports.notifyDailyChallengeComplete = notifyDailyChallengeComplete;
exports.notifyJourneyUnlock = notifyJourneyUnlock;
exports.notifyStreakMilestone = notifyStreakMilestone;
exports.notifySessionComplete = notifySessionComplete;
const requireAuth_1 = require("../middleware/requireAuth");
async function createNotification(params) {
    const { userId, type, title, body, metadata } = params;
    if (!userId)
        return null;
    const { data, error } = await requireAuth_1.supabaseAdmin
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
    return data;
}
async function listNotifications(userId, limit = 50) {
    const { data, error } = await requireAuth_1.supabaseAdmin
        .from('user_notifications')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) {
        throw new Error(error.message);
    }
    return (data ?? []);
}
async function countUnreadNotifications(userId) {
    const { count, error } = await requireAuth_1.supabaseAdmin
        .from('user_notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('read', false);
    if (error)
        return 0;
    return count ?? 0;
}
async function markNotificationsRead(userId, notificationId) {
    let query = requireAuth_1.supabaseAdmin
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
async function notifyLevelUp(userId, newLevel) {
    await createNotification({
        userId,
        type: 'achievement_level_up',
        title: `Level ${newLevel} Unlocked!`,
        body: `You reached Level ${newLevel}. Keep practicing to climb higher.`,
        metadata: { level: newLevel },
    });
}
async function notifyDailyChallengeComplete(userId) {
    await createNotification({
        userId,
        type: 'achievement_daily_challenge',
        title: 'Daily Challenge Complete!',
        body: 'You finished all 5 tasks and earned bonus XP plus streak protection.',
        metadata: { xpBonus: 50 },
    });
}
async function notifyJourneyUnlock(userId, nodeId, nodeLabel) {
    const { data: existing } = await requireAuth_1.supabaseAdmin
        .from('user_notifications')
        .select('id')
        .eq('user_id', userId)
        .eq('type', 'achievement_journey_unlock')
        .contains('metadata', { nodeId })
        .limit(1);
    if (existing && existing.length > 0)
        return;
    await createNotification({
        userId,
        type: 'achievement_journey_unlock',
        title: `${nodeLabel} Unlocked`,
        body: `You've unlocked a new stop on your Fluency Journey: ${nodeLabel}.`,
        metadata: { nodeId, nodeLabel },
    });
}
async function notifyStreakMilestone(userId, streakCount) {
    await createNotification({
        userId,
        type: 'achievement_streak',
        title: `${streakCount}-Day Streak!`,
        body: `Amazing consistency — ${streakCount} days of practice in a row.`,
        metadata: { streakCount },
    });
}
async function notifySessionComplete(userId, durationMinutes, xpAwarded) {
    await createNotification({
        userId,
        type: 'achievement_session',
        title: 'Session Complete',
        body: `Great work! ${Math.round(durationMinutes)} min practiced · +${xpAwarded} XP earned.`,
        metadata: { durationMinutes, xpAwarded },
    });
}
