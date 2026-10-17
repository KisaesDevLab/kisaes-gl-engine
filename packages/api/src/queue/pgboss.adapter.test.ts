// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// pg-boss adapter specifics: the job-id mapping, the spec → pg-boss option
// mapping, and (against the test database, own schema) that a duplicate
// producer id is a no-op in the pinned pg-boss version. The cross-backend
// behavior is pinned by adapter-parity.test.ts.

import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { PgBossQueue, pgBossJobId, pgBossSendOptions, uuidV5 } from './pgboss.adapter.js';
import { JOB_SPECS, PGBOSS_KEEP_SECONDS } from './specs.js';
import type { JobSpecTable } from './job-queue.js';

const SCHEMA = 'pgboss_adapter_test';
const url = process.env['DATABASE_URL']!;

async function sql<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

afterAll(async () => {
  await sql(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
});

describe('job id mapping', () => {
  it('uuidV5 matches the RFC 4122 reference vector', () => {
    // python: uuid.uuid5(uuid.NAMESPACE_DNS, 'www.example.com')
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('is deterministic, per queue, and a valid v5 UUID', () => {
    const a = pgBossJobId('statement-parse', 'stmt-1');
    expect(a).toBe(pgBossJobId('statement-parse', 'stmt-1'));
    expect(a).not.toBe(pgBossJobId('report-pack', 'stmt-1'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('spec → pg-boss options', () => {
  it('retrying jobs: attempts 3 → retryLimit 2, exponential 5 s', () => {
    expect(pgBossSendOptions(JOB_SPECS['doc-extract'])).toEqual({
      retryLimit: 2,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: JOB_SPECS['doc-extract'].activeTimeoutSeconds,
      deleteAfterSeconds: PGBOSS_KEEP_SECONDS,
    });
  });

  it('single-shot jobs never retry', () => {
    for (const name of ['statement-parse', 'bill-capture', 'report-pack', 'tax-param-ai-check'] as const) {
      expect(pgBossSendOptions(JOB_SPECS[name])).toMatchObject({ retryLimit: 0, retryDelay: 0, retryBackoff: false });
    }
  });
});

describe('PgBossQueue against Postgres', () => {
  const specs: JobSpecTable<{ dup: { v: number } }> = {
    dup: { attempts: 1, keepCompleted: 1, keepFailed: 1, activeTimeoutSeconds: 60, concurrency: () => 1, bullmqJobName: 'dup', logLabel: 'dup', logCompleted: false },
  };

  it('creates its schema and treats a duplicate producer id as a no-op', async () => {
    const q = new PgBossQueue(specs, { connectionString: url, schema: SCHEMA });
    try {
      await q.enqueue('dup', { v: 1 }, { jobId: 'dup-1' });
      await q.enqueue('dup', { v: 2 }, { jobId: 'dup-1' });
      const rows = await sql<{ id: string; data: { v: number } }>(`SELECT id, data FROM ${SCHEMA}.job WHERE name = 'dup'`);
      expect(rows).toEqual([{ id: pgBossJobId('dup', 'dup-1'), data: { v: 1 } }]);
      const h = await q.health({ name: 'dup' });
      expect(h).toMatchObject({ ok: true, consumers: 0 });
    } finally {
      await q.close();
    }
  });

  it('refuses to work after close()', async () => {
    const q = new PgBossQueue(specs, { connectionString: url, schema: SCHEMA });
    await q.close();
    await expect(q.enqueue('dup', { v: 3 }, { jobId: 'dup-2' })).rejects.toMatchObject({ code: 'QUEUE_UNAVAILABLE' });
  });
});
