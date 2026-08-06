// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// TB workpaper cache (ADR-TB-01). Keys embed the glVersionStamp, so
// invalidation is exact by construction — the TTL below is garbage
// collection, not correctness. Redis-optional: every failure path
// degrades to compute-fresh (the engine is the source of truth).

import { Redis } from 'ioredis';
import { log } from '../../utils/logger.js';

const TTL_SECONDS = 6 * 60 * 60;

let client: Redis | null = null;
let disabled = false;

function getClient(): Redis | null {
  if (disabled) return null;
  if (client) return client;
  const url = process.env['REDIS_URL'];
  if (!url) {
    disabled = true;
    return null;
  }
  client = new Redis(url, {
    maxRetriesPerRequest: 1,
    lazyConnect: false,
    enableOfflineQueue: false,
  });
  client.on('error', (err) => {
    // One log line per process burst, not one per failed command.
    log.debug({ component: 'tb', event: 'cache_redis_error', message: err.message });
  });
  return client;
}

export async function tbCacheGet<T>(key: string): Promise<T | null> {
  try {
    const c = getClient();
    if (!c) return null;
    const raw = await c.get(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

export async function tbCacheSet(key: string, value: unknown): Promise<void> {
  try {
    const c = getClient();
    if (!c) return;
    await c.set(key, JSON.stringify(value), 'EX', TTL_SECONDS);
  } catch {
    // Cache write failures are invisible to correctness.
  }
}

export async function closeTbRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => undefined);
    client = null;
  }
}
