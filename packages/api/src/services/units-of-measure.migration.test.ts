// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-161: migration 0260 adds unit_sets, unit_set_units, the items' unit set
// and default units, and journal_lines.unit_id / base_quantity. Additive; the
// rollback drops them, refused while a line of a posted transaction names a
// unit (a void or deleted one does not stop it), and the forward migration
// is idempotent. Every rollback runs inside a database transaction that is
// rolled back, so the rest of the suite never sees the old schema.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const FORWARD = '0260_units_of_measure.sql';
const ROLLBACK = '0260_units_of_measure.rollback.sql';

async function run(tx: Tx, file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await tx.execute(sql.raw(body));
  }
}

async function shape(tx: Tx) {
  const t = await tx.execute(sql`SELECT to_regclass('public.unit_sets') IS NOT NULL AS a, to_regclass('public.unit_set_units') IS NOT NULL AS b`);
  const c = await tx.execute(sql`SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = 'public'
    AND ((table_name = 'journal_lines' AND column_name IN ('unit_id', 'base_quantity'))
      OR (table_name = 'items' AND column_name IN ('unit_set_id', 'default_purchase_unit_id', 'default_sale_unit_id'))) ORDER BY 1`);
  const r = t.rows[0] as { a: boolean; b: boolean };
  return { tables: r.a && r.b, columns: (c.rows as Array<{ c: string }>).map((x) => x.c) };
}

const ALL = ['items.default_purchase_unit_id', 'items.default_sale_unit_id', 'items.unit_set_id', 'journal_lines.base_quantity', 'journal_lines.unit_id'];

class RolledBack extends Error {}
async function inRolledBackTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await expect(db.transaction(async (tx) => { await fn(tx); throw new RolledBack('rollback'); })).rejects.toBeInstanceOf(RolledBack);
}

/** A transaction with one line naming a unit, in `status`. */
async function lineWithUnit(tx: Tx, status: string) {
  const tenant = crypto.randomUUID();
  // A real tenant: the GL version stamp trigger references it.
  await tx.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${tenant}::uuid, 'Units rollback', ${`units-rollback-${tenant}`})`);
  const [t] = (await tx.execute(sql`INSERT INTO transactions (tenant_id, txn_type, txn_date, status) VALUES (${tenant}::uuid, 'bill', '2026-01-02', ${status})
    RETURNING id`)).rows as Array<{ id: string }>;
  await tx.execute(sql`INSERT INTO journal_lines (tenant_id, transaction_id, account_id, debit, credit, quantity, unit_id, base_quantity)
    VALUES (${tenant}::uuid, ${t!.id}::uuid, gen_random_uuid(), 12, 0, 1, gen_random_uuid(), 12)`);
}

describe('migration 0260 units of measure', () => {
  it('is listed after 0259 and is additive', () => {
    const fwd = readFileSync(path.join(MIGRATIONS, FORWARD), 'utf8');
    expect(fwd).not.toMatch(/drop\s+(table|column|constraint)/i);
    expect(fwd).not.toContain('migration-policy: non-additive-exception');
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === '0260_units_of_measure');
    expect(entry?.idx).toBe(260);
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 259)!.when);
  });

  it('rollback is refused while a posted line names a unit; nothing is dropped', async () => {
    await inRolledBackTx(async (tx) => {
      await tx.execute(sql`UPDATE journal_lines SET unit_id = NULL, base_quantity = NULL WHERE unit_id IS NOT NULL`);
      await lineWithUnit(tx, 'posted');
      await tx.execute(sql`SAVEPOINT s1`);
      await expect(run(tx, ROLLBACK)).rejects.toThrow(/Rollback of 0260 stopped/);
      await tx.execute(sql`ROLLBACK TO SAVEPOINT s1`);
      expect(await shape(tx)).toEqual({ tables: true, columns: ALL });
    });
  });

  it('a void or deleted line with a unit does not stop it; rollback drops everything, forward again (twice) restores it', async () => {
    await inRolledBackTx(async (tx) => {
      await tx.execute(sql`UPDATE journal_lines SET unit_id = NULL, base_quantity = NULL WHERE unit_id IS NOT NULL`);
      await lineWithUnit(tx, 'void');
      await lineWithUnit(tx, 'deleted');
      await run(tx, ROLLBACK);
      expect(await shape(tx)).toEqual({ tables: false, columns: [] });
      await run(tx, FORWARD);
      await run(tx, FORWARD);
      expect(await shape(tx)).toEqual({ tables: true, columns: ALL });
    });
  });
});
