"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FREE_TIER_DAILY_LIMIT_MINUTES = void 0;
exports.checkEntitlement = checkEntitlement;
exports.verifyUserEntitlement = verifyUserEntitlement;
const requireAuth_1 = require("./requireAuth");
// ─── NOTE ON ARCHITECTURE ────────────────────────────────────────────────────
// Voice session access is NO LONGER gated by this daily-minutes cap.
// The WebSocket gateway (voiceGateway.ts) uses the server-level session pool
// (sessionPool.ts) which gates on actual Gemini API concurrent capacity.
//
// This middleware remains for REST routes that may want a soft usage guard,
// but the daily limit is set generously high to not interfere with free usage.
// ─────────────────────────────────────────────────────────────────────────────
exports.FREE_TIER_DAILY_LIMIT_MINUTES = 999; // Effectively unlimited; actual cap is concurrent sessions
/**
 * checkEntitlement middleware for Express routes.
 * Ensures the authenticated user has active usage allowance.
 * (Currently a no-op gate since the WS pool handles API capacity.)
 */
async function checkEntitlement(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized: Authentication required' });
    }
    try {
        const { data: profile, error } = await requireAuth_1.supabase
            .from('users')
            .select('subscription_tier, daily_voice_minutes_used')
            .eq('id', req.user.id)
            .single();
        if (error || !profile) {
            // Fail open — don't block if we can't read the profile
            console.warn('[checkEntitlement] Could not verify profile, allowing request:', error?.message);
            return next();
        }
        const isPro = profile.subscription_tier === 'pro';
        const minutesUsed = profile.daily_voice_minutes_used ?? 0;
        if (!isPro && minutesUsed >= exports.FREE_TIER_DAILY_LIMIT_MINUTES) {
            return res.status(403).json({
                error: 'Entitlement limit reached',
                code: 'LIMIT_REACHED',
                message: `Free tier users are limited to ${exports.FREE_TIER_DAILY_LIMIT_MINUTES} minutes of voice sessions per day. Upgrade to Pro for unlimited practice.`,
            });
        }
        next();
    }
    catch (err) {
        // Fail open on exception — the session pool is the real safety valve
        console.warn('[checkEntitlement] Exception during check, allowing request:', err);
        return next();
    }
}
/**
 * Entitlement verification helper — kept for compatibility but no longer used
 * as the WebSocket gate. Use the session pool (sessionPool.ts) instead.
 *
 * @deprecated Use acquireSession() from sessionPool.ts for WS gate.
 */
async function verifyUserEntitlement(userId) {
    const { data: profile, error } = await requireAuth_1.supabase
        .from('users')
        .select('subscription_tier, daily_voice_minutes_used')
        .eq('id', userId)
        .single();
    if (error || !profile) {
        return true; // Fail open — don't block on DB errors
    }
    if (profile.subscription_tier === 'pro') {
        return true;
    }
    const minutesUsed = profile.daily_voice_minutes_used ?? 0;
    return minutesUsed < exports.FREE_TIER_DAILY_LIMIT_MINUTES;
}
