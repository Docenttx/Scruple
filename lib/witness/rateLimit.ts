// Per-tenant sliding-window rate limiter.
//
// In-process only — fine for Sprint 1 single-node deployment. Multi-node
// deploy would swap the Map backing for Redis. Not worth building that
// until we're past demo.
//
// Cost: O(1) per allow() call — the window is bookkept as a rolling count
// with second-resolution buckets. Not perfectly precise but never
// under-counts, which is what "back off vendors overshooting rps" needs.

interface Bucket {
  ts: number; // second-resolution
  count: number;
}

const state: Map<string, Bucket> = new Map();

/**
 * Try to consume `cost` req-slots against `tenantId`'s per-second budget.
 * Returns true if allowed; false + retry_after_secs if not.
 */
export function tryConsume(
  tenantId: string,
  costRps: number,
  budgetRps: number,
  now: number = Math.floor(Date.now() / 1000),
): { allowed: true } | { allowed: false; retryAfterSecs: number } {
  const b = state.get(tenantId);
  if (!b || b.ts !== now) {
    // New second — reset the bucket. (Sliding window collapses to a fixed
    // per-second window; acceptable for the coarse-grained backpressure
    // we need.)
    state.set(tenantId, { ts: now, count: costRps });
    if (costRps > budgetRps) {
      // Even one leaf blows the budget — reject with 1s retry.
      return { allowed: false, retryAfterSecs: 1 };
    }
    return { allowed: true };
  }
  if (b.count + costRps > budgetRps) {
    return { allowed: false, retryAfterSecs: 1 };
  }
  b.count += costRps;
  return { allowed: true };
}

/** For tests: wipe state. */
export function _resetRateLimitState(): void {
  state.clear();
}
