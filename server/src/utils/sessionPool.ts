/**
 * ─── Server-Side Concurrent Live Session Pool ────────────────────────────────
 *
 * The Gemini free tier for `gemini-3.1-flash-live-preview` supports a limited
 * number of concurrent live streaming connections per API project.
 *
 * ARCHITECTURE PRINCIPLE:
 *   Usage is managed here at the SERVER/API level (how many Gemini connections
 *   are open at once) — NOT at the application level with per-user daily minute
 *   caps. A per-user minute cap blocks legitimate usage even when the API has
 *   capacity. This pool correctly models the real constraint.
 *
 * When the pool is full, new WebSocket connections receive a recoverable error
 * and can retry after a few seconds.
 */

// Maximum number of concurrent Gemini Live sessions allowed by our free tier
// quota. Tune this via MAX_CONCURRENT_LIVE_SESSIONS env var if you upgrade.
export const MAX_CONCURRENT_LIVE_SESSIONS = parseInt(
  process.env.MAX_CONCURRENT_LIVE_SESSIONS || '3',
  10
);

let activeSessions = 0;

/**
 * Acquires a slot in the live session pool.
 *
 * @returns A `release` function — MUST be called when the session ends to free
 *   the slot. Safe to call multiple times (idempotent).
 *
 * @throws {Error} When no slot is available (server is at capacity).
 */
export function acquireSession(): () => void {
  if (activeSessions >= MAX_CONCURRENT_LIVE_SESSIONS) {
    throw new Error(
      `Server is at live session capacity (${MAX_CONCURRENT_LIVE_SESSIONS} concurrent sessions). Please try again in a moment.`
    );
  }

  activeSessions++;
  console.log(
    `[SessionPool] Slot acquired. Active sessions: ${activeSessions}/${MAX_CONCURRENT_LIVE_SESSIONS}`
  );

  let released = false;

  return () => {
    if (!released) {
      released = true;
      activeSessions = Math.max(0, activeSessions - 1);
      console.log(
        `[SessionPool] Slot released. Active sessions: ${activeSessions}/${MAX_CONCURRENT_LIVE_SESSIONS}`
      );
    }
  };
}

/** Returns the current number of active Gemini Live sessions. */
export function getActiveSessionCount(): number {
  return activeSessions;
}
