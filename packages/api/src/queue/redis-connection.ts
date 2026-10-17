// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Redis connection factory for the BullMQ backend. Constructing the client
// is the first point where a socket can be opened; importing this module
// (like every other ioredis importer in the api package) opens nothing.

import RedisPkg from 'ioredis';
import { QueueUnavailableError } from './none.adapter.js';
import { redisEnabled } from '../desktop/profile.js';

const Redis = (RedisPkg as unknown as { default?: typeof import('ioredis').default }).default
  ?? (RedisPkg as unknown as typeof import('ioredis').default);
export type RedisClient = InstanceType<typeof Redis>;

// BullMQ requires `maxRetriesPerRequest: null` on the connection it uses for
// blocking commands (BRPOPLPUSH etc.). Each Worker should get its OWN
// connection; the shared one in the adapter backs the Queue producers only.
// Because of that setting a command against a missing Redis waits instead of
// failing — which is why desktop mode never selects this backend.
export function makeRedisConnection(): RedisClient {
  // Never dial Redis when the install runs without it (desktop mode, or a
  // server with QUEUE_BACKEND=none and no REDIS_URL): fail fast instead of
  // a connection that retries forever (maxRetriesPerRequest: null).
  if (!redisEnabled()) throw new QueueUnavailableError('redis');
  const url = process.env['REDIS_URL'] || 'redis://redis:6379';
  return new Redis(url, { maxRetriesPerRequest: null });
}
