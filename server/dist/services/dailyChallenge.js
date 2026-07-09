"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOrCreateTodayChallenge = getOrCreateTodayChallenge;
exports.updateChallengeOnVoiceSession = updateChallengeOnVoiceSession;
exports.updateChallengeOnVocabReview = updateChallengeOnVocabReview;
const requireAuth_1 = require("../middleware/requireAuth");
const xp_1 = require("./xp");
const notifications_1 = require("./notifications");
function todayUtcDate() {
    return new Date().toISOString().slice(0, 10);
}
function defaultTasks() {
    return [
        {
            id: 'voice-session',
            type: 'voice_session',
            label: 'Complete a voice practice session',
            target: 1,
            progress: 0,
            completed: false,
        },
        {
            id: 'voice-minutes',
            type: 'voice_session',
            label: 'Practice speaking for 5 minutes',
            target: 5,
            progress: 0,
            completed: false,
            trackMinutes: true,
        },
        {
            id: 'vocab-review',
            type: 'vocab_review',
            label: 'Review 3 vocabulary words',
            target: 3,
            progress: 0,
            completed: false,
        },
        {
            id: 'vocab-master',
            type: 'vocab_review',
            label: 'Master 2 words with "Got it"',
            target: 2,
            progress: 0,
            completed: false,
            masteryOnly: true,
        },
        {
            id: 'grammar-check',
            type: 'grammar_check',
            label: 'Complete a fluency check',
            target: 1,
            progress: 0,
            completed: false,
        },
    ];
}
function bumpTask(task, increment) {
    if (task.completed)
        return task;
    const progress = Math.min(task.target, task.progress + increment);
    return {
        ...task,
        progress,
        completed: progress >= task.target,
    };
}
function allTasksComplete(tasks) {
    return tasks.length > 0 && tasks.every((t) => t.completed);
}
async function getOrCreateTodayChallenge(userId) {
    const challengeDate = todayUtcDate();
    const { data: existing } = await requireAuth_1.supabaseAdmin
        .from('daily_challenges')
        .select('*')
        .eq('user_id', userId)
        .eq('challenge_date', challengeDate)
        .maybeSingle();
    if (existing) {
        return {
            ...existing,
            tasks: existing.tasks ?? defaultTasks(),
        };
    }
    const tasks = defaultTasks();
    const { data: created, error } = await requireAuth_1.supabaseAdmin
        .from('daily_challenges')
        .insert({
        user_id: userId,
        challenge_date: challengeDate,
        tasks,
        xp_reward: 50,
        streak_protection: false,
        completed: false,
    })
        .select('*')
        .single();
    if (error || !created) {
        throw new Error(error?.message ?? 'Failed to create daily challenge.');
    }
    return { ...created, tasks };
}
async function persistChallenge(challenge, tasks, completed, streakProtection) {
    const { data, error } = await requireAuth_1.supabaseAdmin
        .from('daily_challenges')
        .update({
        tasks,
        completed,
        streak_protection: streakProtection,
        updated_at: new Date().toISOString(),
    })
        .eq('id', challenge.id)
        .select('*')
        .single();
    if (error || !data) {
        throw new Error(error?.message ?? 'Failed to update daily challenge.');
    }
    return { ...data, tasks };
}
async function updateChallengeOnVoiceSession(userId, durationMinutes, hasAnalysis) {
    const challenge = await getOrCreateTodayChallenge(userId);
    if (challenge.completed) {
        return { challenge, justCompleted: false, xpAwarded: 0 };
    }
    let tasks = [...challenge.tasks];
    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        if (task.type !== 'voice_session' || task.completed)
            continue;
        if (task.trackMinutes) {
            tasks[i] = bumpTask(task, Math.max(1, Math.ceil(durationMinutes)));
        }
        else {
            tasks[i] = bumpTask(task, 1);
        }
    }
    if (hasAnalysis) {
        tasks = tasks.map((task) => task.type === 'grammar_check' && !task.completed ? bumpTask(task, 1) : task);
    }
    const completed = allTasksComplete(tasks);
    let xpAwarded = 0;
    let streakProtection = challenge.streak_protection;
    if (completed && !challenge.completed) {
        const xpResult = await (0, xp_1.awardDailyChallengeBonus)(userId);
        xpAwarded = xpResult?.xpAwarded ?? 0;
        streakProtection = true;
        void (0, notifications_1.notifyDailyChallengeComplete)(userId).catch(() => { });
    }
    const updated = await persistChallenge(challenge, tasks, completed, streakProtection);
    return {
        challenge: updated,
        justCompleted: completed && !challenge.completed,
        xpAwarded,
    };
}
async function updateChallengeOnVocabReview(userId, mastered) {
    const challenge = await getOrCreateTodayChallenge(userId);
    if (challenge.completed) {
        return { challenge, justCompleted: false, xpAwarded: 0 };
    }
    let tasks = challenge.tasks.map((task) => {
        if (task.type !== 'vocab_review' || task.completed)
            return task;
        if (task.masteryOnly && !mastered)
            return task;
        return bumpTask(task, 1);
    });
    const completed = allTasksComplete(tasks);
    let xpAwarded = 0;
    let streakProtection = challenge.streak_protection;
    if (completed && !challenge.completed) {
        const xpResult = await (0, xp_1.awardDailyChallengeBonus)(userId);
        xpAwarded = xpResult?.xpAwarded ?? 0;
        streakProtection = true;
        void (0, notifications_1.notifyDailyChallengeComplete)(userId).catch(() => { });
    }
    const updated = await persistChallenge(challenge, tasks, completed, streakProtection);
    return {
        challenge: updated,
        justCompleted: completed && !challenge.completed,
        xpAwarded,
    };
}
