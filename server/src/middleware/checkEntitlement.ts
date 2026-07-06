import { Response, NextFunction } from 'express';
import { supabase, AuthenticatedRequest } from './requireAuth';

export const FREE_TIER_DAILY_LIMIT_MINUTES = 5;

/**
 * checkEntitlement middleware for Express routes.
 * Ensures the authenticated user has active usage allowance
 * (unlimited for 'pro' subscribers, capped for free tier).
 */
export async function checkEntitlement(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized: Authentication required' });
  }

  try {
    const { data: profile, error } = await supabase
      .from('users')
      .select('subscription_tier, daily_voice_minutes_used')
      .eq('id', req.user.id)
      .single();

    if (error || !profile) {
      return res.status(500).json({ error: 'Failed to verify entitlement' });
    }

    const isPro = profile.subscription_tier === 'pro';
    const minutesUsed = (profile as any).daily_voice_minutes_used ?? 0;

    if (!isPro && minutesUsed >= FREE_TIER_DAILY_LIMIT_MINUTES) {
      return res.status(403).json({
        error: 'Entitlement limit reached',
        code: 'LIMIT_REACHED',
        message: `Free tier users are limited to ${FREE_TIER_DAILY_LIMIT_MINUTES} minutes of voice sessions per day. Upgrade to Pro for unlimited practice.`,
      });
    }

    next();
  } catch (err) {
    return res.status(500).json({ error: 'Entitlement check exception' });
  }
}

/**
 * Entitlement verification helper for WebSocket upgrades.
 */
export async function verifyUserEntitlement(userId: string): Promise<boolean> {
  const { data: profile, error } = await supabase
    .from('users')
    .select('subscription_tier, daily_voice_minutes_used')
    .eq('id', userId)
    .single();

  if (error || !profile) {
    return false;
  }

  if (profile.subscription_tier === 'pro') {
    return true;
  }

  const minutesUsed = (profile as any).daily_voice_minutes_used ?? 0;
  return minutesUsed < FREE_TIER_DAILY_LIMIT_MINUTES;
}
