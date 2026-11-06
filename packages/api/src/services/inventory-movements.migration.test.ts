// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-157: migration 0259 adds inventory_movements and
// journal_lines.inventory_movement_id. Additive; the rollback drops them and
// the forward migration is idempotent. Every rollback runs inside a database
// transaction that is rolled back, so the rest of the suite never sees the
// old schema.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const FORWARD = '0259_inventory_movements.sql';
const ROLLBACK = '0259_inventory_movements.rollback.sql';

async function run(tx: Tx, file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await tx.execute(sql.raw(body));
  }
}

async function shape(tx: Tx) {
  const t = await tx.execute(sql`SELECT to_regclass('public.inventory_movements') IS NOT NULL AS t`);
  const c = await tx.execute(sql`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'journal_lines' AND column_name = 'inventory_movement_id'`);
  return { table: (t.rows[0] as { t: boolean }).t, column: c.rows.length === 1 };
}

class RolledBack extends Error {}
async function inRolledBackTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await expect(db.transaction(async (tx) => { await fn(tx); throw new RolledBack('rollback'); })).rejects.toBeInstanceOf(RolledBack);
}
async function refuses(tx: Tx, stmt: ReturnType<typeof sql>) {
  await tx.execute(sql`SAVEPOINT s1`);
  await expect(tx.execute(stmt)).rejects.toThrow();
  await tx.execute(sql`ROLLBACK TO SAVEPOINT s1`);
}

const row = (txn: string, item: string, source: string | null, kind = 'receipt', mode = 'given') => sql`
  INSERT INTO inventory_movements (tenant_id, company_id, item_id, transaction_id, source_transaction_id, movement_date, txn_created_at, kind, value_mode)
  VALUES (gen_random_uuid(), gen_random_uuid(), ${item}::uuid, ${txn}::uuid, ${source}::uuid, '2026-01-02', now(), ${kind}, ${mode})`;

describe('migration 0259 inventory movements', () => {
  it('is listed after 0258 and is additive', () => {
    const fwd = readFileSync(path.join(MIGRATIONS, FORWARD), 'utf8');
    expect(fwd).not.toMatch(/drop\s+(table|column|constraint)/i);
    expect(fwd).not.toContain('migration-policy: non-additive-exception');
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === '0259_inventory_movements');
    expect(entry?.idx).toBe(259);
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 258)!.when);
  });

  it('one row per (transaction, item, linked sale), NULL counting as one value; kinds and value modes are checked', async () => {
    await inRolledBackTx(async (tx) => {
      const [txn, item, sale] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      await tx.execute(row(txn, item, null));
      await refuses(tx, row(txn, item, null));
      await tx.execute(row(txn, item, sale, 'customer_return', 'linked'));
      await refuses(tx, row(txn, item, sale, 'customer_return', 'linked'));
      await refuses(tx, row(crypto.randomUUID(), item, null, 'restatement'));
      await refuses(tx, row(crypto.randomUUID(), item, null, 'receipt', 'true'));
    });
  });

  it('rollback drops the table and the column; forward again (twice) restores them', async () => {
    await inRolledBackTx(async (tx) => {
      expect(await shape(tx)).toEqual({ table: true, column: true });
      await run(tx, ROLLBACK);
      expect(await shape(tx)).toEqual({ table: false, column: false });
      await run(tx, FORWARD);
      await run(tx, FORWARD);
      expect(await shape(tx)).toEqual({ table: true, column: true });
    });
  });
});
