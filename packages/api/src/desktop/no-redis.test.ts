// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Every Redis touchpoint in the api package, exercised in desktop mode:
// none of them may construct an ioredis client or a BullMQ queue. The
// server-mode control at the end proves the counters do see constructions.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';

const counts = vi.hoisted(() => ({ redis: 0, queue: 0 }));

vi.mock('ioredis', () => {
  class FakeRedis {
    status = 'wait';
    constructor() {
      counts.redis += 1;
    }
    on() {
      return this;
    }
    once() {
      return this;
    }
    off() {
      return this;
    }
    async connect() {
      throw new Error('fake redis: no server');
    }
    async ping() {
      throw new Error('fake redis: no server');
    }
    async quit() {
      return 'OK';
    }
    disconnect() {}
  }
  return { default: FakeRedis, Redis: FakeRedis };
});

vi.mock('bullmq', () => {
  class FakeQueue {
    constructor() {
      counts.queue += 1;
    }
    async add() {
      return {};
    }
    async getWorkers() {
      return [];
    }
    async close() {}
  }
  return { Queue: FakeQueue };
});

import { loadDesktopProfile, redisEnabled, _resetDesktopProfileForTests } from './profile.js';
import { redisPing } from '../utils/health-redis.js';
import { readHeartbeats, startHeartbeat, _resetHeartbeatClientsForTest } from '../utils/worker-heartbeat.js';
import { getRateLimitStore } from '../utils/rate-limit-store.js';
import {
  storeRegistrationChallenge,
  consumeRegistrationChallenge,
  storeAuthenticationChallenge,
  consumeAuthenticationChallenge,
} from '../services/passkey-challenge-store.js';
import { consumeJti, JtiStoreUnavailableError } from '../utils/peer-jti-store.js';
import { tbCacheGet, tbCacheSet } from '../services/tb/tb-redis.js';
import { shareRedis } from '../services/share/share-redis.js';
import {
  enqueueRender,
  enqueueExtract,
  enqueueStatementParse,
  enqueueReportPack,
  enqueueBillCapture,
  enqueueTaxParamAiCheck,
  getReportPackQueueHealth,
} from '../services/extraction/queue.js';
import { QueueUnavailableError } from '../queue/none.adapter.js';

const ID = '00000000-0000-4000-8000-000000000001';

describe('desktop mode touches no Redis', () => {
  beforeAll(() => {
    loadDesktopProfile({
      CL_MODE: 'desktop',
      CL_TOKEN: 'n'.repeat(48),
      CL_BIND: '127.0.0.1:0',
      CL_DATA_DIR: path.join(os.tmpdir(), 'cl-no-redis-test'),
    });
    counts.redis = 0;
    counts.queue = 0;
  });

  it('redisEnabled() is false', () => {
    expect(redisEnabled()).toBe(false);
  });

  it('health probe reports Redis as disabled without dialing', async () => {
    expect(await redisPing()).toEqual({ ok: true, latencyMs: 0, disabled: true });
  });

  it('worker heartbeat is a no-op', async () => {
    _resetHeartbeatClientsForTest();
    const h = startHeartbeat('desktop-test');
    await h.stop();
    expect((await readHeartbeats()).count).toBe(0);
  });

  it('rate-limit store stays in memory even if RATE_LIMIT_REDIS=1 leaks through', () => {
    const saved = process.env['RATE_LIMIT_REDIS'];
    process.env['RATE_LIMIT_REDIS'] = '1';
    try {
      expect(getRateLimitStore('global')).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env['RATE_LIMIT_REDIS'];
      else process.env['RATE_LIMIT_REDIS'] = saved;
    }
  });

  it('passkey challenges work from the in-memory store, single use', async () => {
    await storeRegistrationChallenge(ID, 'reg-challenge');
    expect(await consumeRegistrationChallenge(ID)).toBe('reg-challenge');
    expect(await consumeRegistrationChallenge(ID)).toBeNull();
    await storeAuthenticationChallenge('auth-challenge');
    expect(await consumeAuthenticationChallenge('auth-challenge')).toBe(true);
    expect(await consumeAuthenticationChallenge('auth-challenge')).toBe(false);
  });

  it('peer jti store fails closed', async () => {
    await expect(consumeJti('issuer', 'jti-1')).rejects.toBeInstanceOf(JtiStoreUnavailableError);
  });

  it('TB cache is off', async () => {
    await tbCacheSet('k', { a: 1 });
    expect(await tbCacheGet('k')).toBeNull();
  });

  it('screen share refuses to dial', () => {
    expect(() => shareRedis()).toThrow(/not available without Redis/);
  });

  it('every enqueue rejects immediately with QueueUnavailableError', async () => {
    const started = Date.now();
    const attempts = [
      enqueueRender({ jobId: ID, tenantId: ID }),
      enqueueExtract({ jobId: ID, tenantId: ID, pageNo: 1 }),
      enqueueStatementParse({ jobId: ID, tenantId: ID, attachmentId: ID }),
      enqueueReportPack({ runId: ID, tenantId: ID }),
      enqueueBillCapture({ captureId: ID, tenantId: ID, attempt: 1 }),
      enqueueTaxParamAiCheck({ runId: ID }),
    ];
    for (const a of attempts) await expect(a).rejects.toBeInstanceOf(QueueUnavailableError);
    expect(Date.now() - started).toBeLessThan(500);
    expect(await getReportPackQueueHealth()).toEqual({ redisReachable: false, workerRunning: false });
  });

  it('constructed no ioredis client and no BullMQ queue', () => {
    expect(counts).toEqual({ redis: 0, queue: 0 });
  });
});

describe('server-mode control (CL_MODE unset)', () => {
  beforeAll(() => {
    _resetDesktopProfileForTests();
    loadDesktopProfile({});
  });
  afterAll(() => _resetDesktopProfileForTests());

  it('the same calls do construct clients, so the counters are live', async () => {
    expect(redisEnabled()).toBe(true);
    const ping = await redisPing();
    expect(ping.ok).toBe(false);
    expect(ping.disabled).toBeUndefined();
    await enqueueRender({ jobId: ID, tenantId: ID });
    expect(counts.redis).toBeGreaterThan(0);
    expect(counts.queue).toBeGreaterThan(0);
  });
});
