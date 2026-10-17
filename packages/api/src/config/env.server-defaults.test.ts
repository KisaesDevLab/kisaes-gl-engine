// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseEnv } from './env.js';

// The server appliance must see exactly the configuration it saw before the
// desktop profile existed. The fixture was produced by the PRE-change
// env.ts (engine 13ebd2ba) from SERVER_INPUT below, so any changed default
// or newly-required variable fails this test. The only allowed difference
// is the new QUEUE_BACKEND key with its server default.

const here = dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(
  readFileSync(join(here, '__fixtures__', 'env-server-baseline.json'), 'utf8'),
) as Record<string, unknown>;

const SERVER_INPUT = {
  DATABASE_URL: 'postgresql://u:p@db:5432/books',
  REDIS_URL: 'redis://redis:6379',
  JWT_SECRET: '0123456789abcdef0123456789abcdef',
  ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  PLAID_ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
};

function sorted(o: Record<string, unknown>): string {
  return JSON.stringify(o, Object.keys(o).sort());
}

describe('env.ts server defaults (CL_MODE unset)', () => {
  it('parses a server environment exactly as before, plus QUEUE_BACKEND=bullmq', () => {
    const r = parseEnv({ ...SERVER_INPUT });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const { QUEUE_BACKEND, ...rest } = r.data as Record<string, unknown>;
    expect(QUEUE_BACKEND).toBe('bullmq');
    expect(sorted(rest)).toBe(sorted(baseline));
  });

  it('still requires REDIS_URL with the default (bullmq) backend', () => {
    const { REDIS_URL: _drop, ...noRedis } = SERVER_INPUT;
    void _drop;
    const r = parseEnv(noRedis);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.flatten().fieldErrors['REDIS_URL']?.[0]).toMatch(/Required/);
  });

  it('still rejects a non-redis REDIS_URL', () => {
    const r = parseEnv({ ...SERVER_INPUT, REDIS_URL: 'http://redis:6379' });
    expect(r.success).toBe(false);
  });

  it('QUEUE_BACKEND=none makes REDIS_URL optional', () => {
    const { REDIS_URL: _drop, ...noRedis } = SERVER_INPUT;
    void _drop;
    const r = parseEnv({ ...noRedis, QUEUE_BACKEND: 'none' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.REDIS_URL).toBeUndefined();
  });

  it('QUEUE_BACKEND=none still requires REDIS_URL for RATE_LIMIT_REDIS=1 or SHARE_ENABLED', () => {
    const { REDIS_URL: _drop, ...noRedis } = SERVER_INPUT;
    void _drop;
    expect(parseEnv({ ...noRedis, QUEUE_BACKEND: 'none', RATE_LIMIT_REDIS: '1' }).success).toBe(false);
    expect(parseEnv({ ...noRedis, QUEUE_BACKEND: 'none', SHARE_ENABLED: 'true' }).success).toBe(false);
  });

  it('rejects an unknown QUEUE_BACKEND', () => {
    expect(parseEnv({ ...SERVER_INPUT, QUEUE_BACKEND: 'kafka' }).success).toBe(false);
  });

  it('ENGINE_COMMIT is optional and passed through', () => {
    const r = parseEnv({ ...SERVER_INPUT, ENGINE_COMMIT: '13ebd2ba' });
    expect(r.success && r.data.ENGINE_COMMIT).toBe('13ebd2ba');
  });
});
