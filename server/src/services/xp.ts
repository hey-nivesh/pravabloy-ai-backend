import { supabaseAdmin } from '../middleware/requireAuth';
import {
  computeLevelFromXp,
  XP_DAILY_CHALLENGE_BONUS,
  XP_PER_VOCAB_MASTERED,
  XP_PER_VOICE_MINUTE,
} from '../constants/xp';
import { notifyLevelUp } from './notifications';

export type AwardXpResult = {
  xpAwarded: number;
  xpTotal: number;
  xpLevel: number;
  leveledUp: boolean;
};

export async function awardXp(
  userId: string,
  amount: number,
): Promise<AwardXpResult | null> {
  if (!userId || amount <= 0) return null;

  const { data: userRow, error: fetchErr } = await supabaseAdmin
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
  const xpLevel = computeLevelFromXp(xpTotal);

  const { error: updateErr } = await supabaseAdmin
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
    void notifyLevelUp(userId, xpLevel).catch(() => {});
  }

  return {
    xpAwarded: amount,
    xpTotal,
    xpLevel,
    leveledUp: xpLevel > previousLevel,
  };
}

export async function awardVoiceSessionXp(
  userId: string,
  durationMinutes: number,
): Promise<AwardXpResult | null> {
  const minutes = Math.max(1, Math.ceil(durationMinutes));
  const amount = minutes * XP_PER_VOICE_MINUTE;
  return awardXp(userId, amount);
}

export async function awardVocabMasteredXp(userId: string): Promise<AwardXpResult | null> {
  return awardXp(userId, XP_PER_VOCAB_MASTERED);
}

export async function awardDailyChallengeBonus(userId: string): Promise<AwardXpResult | null> {
  return awardXp(userId, XP_DAILY_CHALLENGE_BONUS);
}

export { XP_PER_VOICE_MINUTE, XP_PER_VOCAB_MASTERED, XP_DAILY_CHALLENGE_BONUS };
