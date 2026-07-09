"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.XP_DAILY_CHALLENGE_BONUS = exports.XP_PER_VOCAB_MASTERED = exports.XP_PER_VOICE_MINUTE = void 0;
exports.awardXp = awardXp;
exports.awardVoiceSessionXp = awardVoiceSessionXp;
exports.awardVocabMasteredXp = awardVocabMasteredXp;
exports.awardDailyChallengeBonus = awardDailyChallengeBonus;
const requireAuth_1 = require("../middleware/requireAuth");
const xp_1 = require("../constants/xp");
Object.defineProperty(exports, "XP_DAILY_CHALLENGE_BONUS", { enumerable: true, get: function () { return xp_1.XP_DAILY_CHALLENGE_BONUS; } });
Object.defineProperty(exports, "XP_PER_VOCAB_MASTERED", { enumerable: true, get: function () { return xp_1.XP_PER_VOCAB_MASTERED; } });
Object.defineProperty(exports, "XP_PER_VOICE_MINUTE", { enumerable: true, get: function () { return xp_1.XP_PER_VOICE_MINUTE; } });
const notifications_1 = require("./notifications");
async function awardXp(userId, amount) {
    if (!userId || amount <= 0)
        return null;
    const { data: userRow, error: fetchErr } = await requireAuth_1.supabaseAdmin
        .from('users')
        .select('xp_total, xp_level')
        .eq('id', userId)
        .single();
    if (fetchErr || !userRow) {
        console.warn('[xp] Failed to load user row:', fetchErr?.message);
        return null;
    }
    const previousLevel = userRow.xp_level ?? 1;
    const xpTotal = (userRow.xp_total ?? 0) + amount;
    const xpLevel = (0, xp_1.computeLevelFromXp)(xpTotal);
    const { error: updateErr } = await requireAuth_1.supabaseAdmin
        .from('users')
        .update({
        xp_total: xpTotal,
        xp_level: xpLevel,
        updated_at: new Date().toISOString(),
    })
        .eq('id', userId);
    if (updateErr) {
        console.warn('[xp] Failed to update user XP:', updateErr.message);
        return null;
    }
    if (xpLevel > previousLevel) {
        void (0, notifications_1.notifyLevelUp)(userId, xpLevel).catch(() => { });
    }
    return {
        xpAwarded: amount,
        xpTotal,
        xpLevel,
        leveledUp: xpLevel > previousLevel,
    };
}
async function awardVoiceSessionXp(userId, durationMinutes) {
    const minutes = Math.max(1, Math.ceil(durationMinutes));
    const amount = minutes * xp_1.XP_PER_VOICE_MINUTE;
    return awardXp(userId, amount);
}
async function awardVocabMasteredXp(userId) {
    return awardXp(userId, xp_1.XP_PER_VOCAB_MASTERED);
}
async function awardDailyChallengeBonus(userId) {
    return awardXp(userId, xp_1.XP_DAILY_CHALLENGE_BONUS);
}
