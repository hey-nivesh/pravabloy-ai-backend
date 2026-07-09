/**
 * Shared XP rules and leveling curve.
 * Keep in sync with pravabloyai/src/constants/xp.ts
 */

/** XP awarded per completed minute of voice practice */
export const XP_PER_VOICE_MINUTE = 10;

/** XP awarded when a vocab word is mastered ("got_it" review) */
export const XP_PER_VOCAB_MASTERED = 5;

/** Bonus XP when all daily challenge tasks are completed */
export const XP_DAILY_CHALLENGE_BONUS = 50;

/** Base XP required to advance from level 1 → 2; grows by this increment each level */
export const XP_LEVEL_BASE = 500;

/**
 * Escalating curve: level N requires sum(500 * i) for i=1..N-1 total XP.
 * L1: 0–499, L2: 500–1499 (+1000 threshold), L3: 1500–2999, etc.
 * threshold(level) = 500 * level * (level - 1) / 2 ... simpler: cumulative at level L = 500 * (L-1)^2 for L>=2? 
 *
 * Using linear 500 XP per level band:
 * Level 1: xp 0..499
 * Level 2: xp 500..999
 */
export function computeLevelFromXp(xpTotal: number): number {
  const safe = Math.max(0, Math.floor(xpTotal));
  return Math.floor(safe / XP_LEVEL_BASE) + 1;
}

/** XP at the start of the given level (inclusive) */
export function xpAtLevelStart(level: number): number {
  return Math.max(0, level - 1) * XP_LEVEL_BASE;
}

/** XP required to reach the next level (exclusive upper bound) */
export function xpForNextLevel(level: number): number {
  return level * XP_LEVEL_BASE;
}

export function xpProgressInCurrentLevel(xpTotal: number): {
  level: number;
  current: number;
  needed: number;
  percent: number;
} {
  const level = computeLevelFromXp(xpTotal);
  const start = xpAtLevelStart(level);
  const end = xpForNextLevel(level);
  const current = Math.max(0, xpTotal - start);
  const needed = end - start;
  const percent = needed > 0 ? Math.min(100, (current / needed) * 100) : 100;
  return { level, current, needed, percent };
}
