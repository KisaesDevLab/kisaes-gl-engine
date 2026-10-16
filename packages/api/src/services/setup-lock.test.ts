// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
// withSetupLock against the real test database: the session advisory lock
// must be taken and released on the same connection, so it never leaks to
// an idle pooled connection, and a concurrent call is refused.

import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { withSetupLock } from './setup.service.js';
import { db } from '../db/index.js';

const KEY = 4242424242;

/** Whether an independent session could take the setup lock right now. */
async function lockIsFree(): Promise<boolean> {
  const c = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
  await c.connect();
  try {
    const r = await c.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [KEY]);
    if (r.rows[0]?.locked === true) await c.query('SELECT pg_advisory_unlock($1::bigint)', [KEY]);
    return r.rows[0]?.locked === true;
  } finally {
    await c.end();
  }
}

afterAll(async () => {
  // Leave nothing behind for other suites.
  expect(await lockIsFree()).toBe(true);
});

describe('withSetupLock', () => {
  it('holds the lock while fn runs and always releases it, even with the pool busy', async () => {
    for (let i = 0; i < 15; i++) {
      // Keep other pool connections busy so a pooled unlock would very
      // likely land on a different connection than the lock.
      const noise = Array.from({ length: 5 }, () => db.execute(sql`SELECT pg_sleep(0.01)`));
      const held = await withSetupLock(async () => {
        await Promise.all(noise);
        return lockIsFree();
      });
      expect(held, `iteration ${i}: lock not held inside fn`).toBe(false);
      expect(await lockIsFree(), `iteration ${i}: lock leaked`).toBe(true);
    }
  }, 60_000);

  it('releases the lock when fn throws', async () => {
    await expect(withSetupLock(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await lockIsFree()).toBe(true);
  });

  it('concurrent calls: exactly one runs, the others are refused', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let ran = 0;
    const first = withSetupLock(async () => {
      ran += 1;
      await gate;
      return 'first';
    });
    // Give the first call time to take the lock.
    await new Promise((r) => setTimeout(r, 200));
    const others = await Promise.allSettled(
      Array.from({ length: 4 }, () => withSetupLock(async () => {
        ran += 1;
        return 'other';
      })),
    );
    for (const o of others) {
      expect(o.status).toBe('rejected');
      if (o.status === 'rejected') expect(String(o.reason)).toMatch(/already in progress/);
    }
    release();
    expect(await first).toBe('first');
    expect(ran).toBe(1);
    // And the next call succeeds.
    expect(await withSetupLock(async () => 'next')).toBe('next');
  }, 60_000);
});
