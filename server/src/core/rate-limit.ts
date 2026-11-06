/**
 * Fixed-window counter per key, held in memory.
 *
 * Enough to stop one account hammering the export or list endpoints (OWASP A04, API4). It is
 * per process: behind a load balancer with N instances the effective limit is N times higher,
 * which is acceptable for a guard whose job is to blunt abuse rather than to meter usage.
 */
export interface RateDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

const MAX_TRACKED_KEYS = 10_000;

export function createRateLimiter(windowMs = 60_000) {
  const windows = new Map<string, { start: number; count: number }>();

  function prune(now: number) {
    for (const [key, window] of windows) {
      if (now - window.start >= windowMs) windows.delete(key);
    }
  }

  return {
    take(key: string, limit: number, now = Date.now()): RateDecision {
      let window = windows.get(key);

      if (!window || now - window.start >= windowMs) {
        // A flood of distinct keys must not grow this map without bound.
        if (!window && windows.size >= MAX_TRACKED_KEYS) prune(now);
        window = { start: now, count: 0 };
        windows.set(key, window);
      }

      if (window.count >= limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((window.start + windowMs - now) / 1000)),
        };
      }

      window.count += 1;
      return { allowed: true, remaining: limit - window.count, retryAfterSeconds: 0 };
    },

    reset() {
      windows.clear();
    },

    size() {
      return windows.size;
    },
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;
