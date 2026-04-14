// Simple in-memory rate limiter (production should use Redis). The Map is
// capped so an attacker pumping unique keys can't grow it without bound —
// when we're at the ceiling and need to insert a new bucket we evict the
// oldest entry instead of accumulating indefinitely until the periodic
// sweep runs.
const MAX_BUCKETS = 10_000;
const buckets = new Map<string, { count: number; resetAt: number }>();

function evictOldestIfFull(): void {
  if (buckets.size < MAX_BUCKETS) return;
  // Map iteration order is insertion order — the first key is the oldest
  // write. Good enough as an approximate LRU for a rate-limiter bucket.
  const oldest = buckets.keys().next().value;
  if (oldest !== undefined) buckets.delete(oldest);
}

export function checkRateLimit(key: string, maxPerMinute: number): { allowed: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    evictOldestIfFull();
    buckets.set(key, { count: 1, resetAt: now + 60_000 });
    return { allowed: true };
  }

  if (bucket.count >= maxPerMinute) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
    return { allowed: false, retryAfterSeconds: retryAfter };
  }

  bucket.count++;
  return { allowed: true };
}

// Cleanup old buckets periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt + 60_000) buckets.delete(key);
  }
}, 60_000);
