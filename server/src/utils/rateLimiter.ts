import crypto from 'crypto';

// Queue to schedule calls to Gemini API to respect 5 RPM (1 request per 12 seconds spacing)
class GeminiRateLimiter {
  private queue: (() => Promise<void>)[] = [];
  private processing = false;
  private lastRequestTime = 0;
  private minSpacingMs = 12000; // 5 RPM = 12s spacing

  async enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const res = await task();
          resolve(res);
        } catch (err) {
          reject(err);
        }
      });
      this.processNext();
    });
  }

  private async processNext() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const now = Date.now();
      const timeSinceLast = now - this.lastRequestTime;
      if (timeSinceLast < this.minSpacingMs) {
        const delay = this.minSpacingMs - timeSinceLast;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const task = this.queue.shift();
      if (task) {
        this.lastRequestTime = Date.now();
        try {
          await task();
        } catch (err) {
          // Task rejection is handled in the promise wrapper
        }
      }
    }

    this.processing = false;
  }
}

export const geminiRateLimiter = new GeminiRateLimiter();

/**
 * Executes a function with exponential backoff on 429 Rate Limit/Resource Exhausted errors.
 */
export async function callWithRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  delayMs = 2000
): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const errMsg = err.message || String(err);
    const isRateLimit =
      err.status === 429 ||
      err.statusCode === 429 ||
      errMsg.includes('429') ||
      errMsg.includes('ResourceExhausted') ||
      errMsg.includes('Quota exceeded') ||
      errMsg.includes('Resource has been exhausted');

    if (isRateLimit && retries > 0) {
      console.warn(`[Gemini RateLimiter] Rate limited. Retrying in ${delayMs}ms... (${retries} retries left)`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return callWithRetry(fn, retries - 1, delayMs * 2);
    }
    throw err;
  }
}

/**
 * Tries executing a block using a primary model; falls back to an alternative model if quota/rate limit error is encountered.
 */
export async function callWithModelFallback<T>(
  primaryModel: string,
  fallbackModel: string,
  fn: (model: string) => Promise<T>
): Promise<T> {
  try {
    return await fn(primaryModel);
  } catch (err: any) {
    const errMsg = err.message || String(err);
    const isQuotaOrRate =
      err.status === 429 ||
      err.statusCode === 429 ||
      errMsg.includes('429') ||
      errMsg.includes('ResourceExhausted') ||
      errMsg.includes('Quota exceeded') ||
      errMsg.includes('Resource has been exhausted');

    if (isQuotaOrRate) {
      console.warn(`[Gemini Fallback] Primary model "${primaryModel}" failed with rate limit or quota exhaustion. Trying fallback model "${fallbackModel}"...`);
      return await fn(fallbackModel);
    }
    throw err;
  }
}

/**
 * Generates a deterministic SHA-256 hash of a text string.
 */
export function getDeterministicHash(text: string, speed = 'normal'): string {
  const normalizedText = text.trim().toLowerCase();
  return crypto.createHash('sha256').update(`${normalizedText}_${speed}`).digest('hex');
}
