// Simple in-memory rate limiter (production should use Redis)
const buckets = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(key: string, maxPerMinute: number): { allowed: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now > bucket.resetAt) {
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
