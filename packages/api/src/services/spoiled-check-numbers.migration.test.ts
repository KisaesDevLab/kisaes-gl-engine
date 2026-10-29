// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-106: migration 0239 adds spoiled_check_numbers (check-reprint-audit-v1).
// Additive; the rollback drops the table and the forward migration is
// idempotent. Every rollback runs inside a database transaction that is
// rolled back, so the rest of the suite never sees the old schema.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const FORWARD = '0239_spoiled_check_numbers.sql';
const ROLLBACK = '0239_spoiled_check_numbers.rollback.sql';

async function run(tx: Tx, file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await tx.execute(sql.raw(body));
  }
}

async function hasTable(tx: Tx): Promise<boolean> {
  const r = await tx.execute(sql`SELECT to_regclass('public.spoiled_check_numbers') AS t`);
  return (r.rows[0] as { t: string | null }).t !== null;
}

class RolledBack extends Error {}

async function inRolledBackTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await expect(db.transaction(async (tx) => {
    await fn(tx);
    throw new RolledBack('rollback');
  })).rejects.toBeInstanceOf(RolledBack);
}

describe('migration 0239 spoiled check numbers', () => {
  it('is listed after 0238 and is additive', () => {
    const fwd = readFileSync(path.join(MIGRATIONS, FORWARD), 'utf8');
    expect(fwd).not.toMatch(/drop\s+(table|column|constraint)/i);
    expect(fwd).not.toContain('migration-policy: non-additive-exception');
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === '0239_spoiled_check_numbers');
    expect(entry?.idx).toBe(239);
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 238)!.when);
  });

  it('takes the same number twice (a spoiled number may be reused and spoiled again)', async () => {
    await inRolledBackTx(async (tx) => {
      const ins = sql`INSERT INTO spoiled_check_numbers (tenant_id, bank_account_id, check_number, transaction_id, reason)
        VALUES (gen_random_uuid(), '00000000-0000-0000-0000-0000000000aa', 1001, gen_random_uuid(), 'reprint')`;
      await tx.execute(ins);
      await tx.execute(ins);
    });
  });

  it('rollback drops the table; forward again (twice) restores it', async () => {
    await inRolledBackTx(async (tx) => {
      expect(await hasTable(tx)).toBe(true);
      await run(tx, ROLLBACK);
      expect(await hasTable(tx)).toBe(false);
      await run(tx, FORWARD);
      await run(tx, FORWARD);
      expect(await hasTable(tx)).toBe(true);
    });
  });
});
