// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-39a, U-40, U-129: migration 0243 adds items.item_type /
// discount_percent, contacts.price_level_id, journal_lines.discount_percent
// / unit_price_source and the price_levels / price_level_items tables.
// Additive; the rollback drops them and the forward migration is
// idempotent. Every rollback runs inside a database transaction that is
// rolled back, so the rest of the suite never sees the old schema.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const FORWARD = '0243_item_pricing.sql';
const ROLLBACK = '0243_item_pricing.rollback.sql';

async function run(tx: Tx, file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await tx.execute(sql.raw(body));
  }
}

async function shape(tx: Tx) {
  const t = await tx.execute(sql`SELECT to_regclass('public.price_levels') IS NOT NULL AS a, to_regclass('public.price_level_items') IS NOT NULL AS b`);
  const cols = await tx.execute(sql`
    SELECT table_name || '.' || column_name AS c FROM information_schema.columns
    WHERE table_schema = 'public' AND (
      (table_name = 'items' AND column_name IN ('item_type', 'discount_percent'))
      OR (table_name = 'contacts' AND column_name = 'price_level_id')
      OR (table_name = 'journal_lines' AND column_name IN ('discount_percent', 'unit_price_source')))
    ORDER BY 1`);
  const row = t.rows[0] as { a: boolean; b: boolean };
  return { tables: row.a && row.b, columns: (cols.rows as Array<{ c: string }>).map((r) => r.c) };
}

class RolledBack extends Error {}

async function inRolledBackTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await expect(db.transaction(async (tx) => {
    await fn(tx);
    throw new RolledBack('rollback');
  })).rejects.toBeInstanceOf(RolledBack);
}

const ALL = ['contacts.price_level_id', 'items.discount_percent', 'items.item_type',
  'journal_lines.discount_percent', 'journal_lines.unit_price_source'];

async function refuses(tx: Tx, stmt: ReturnType<typeof sql>) {
  await tx.execute(sql`SAVEPOINT s1`);
  await expect(tx.execute(stmt)).rejects.toThrow();
  await tx.execute(sql`ROLLBACK TO SAVEPOINT s1`);
}

describe('migration 0243 item pricing', () => {
  it('is listed after 0242 and is additive', () => {
    const fwd = readFileSync(path.join(MIGRATIONS, FORWARD), 'utf8');
    expect(fwd).not.toMatch(/drop\s+(table|column|constraint)/i);
    expect(fwd).not.toContain('migration-policy: non-additive-exception');
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === '0243_item_pricing');
    expect(entry?.idx).toBe(243);
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 242)!.when);
  });

  it('existing items read as service; the checks refuse an unknown kind, a bad percent and a negative level price', async () => {
    await inRolledBackTx(async (tx) => {
      const acct = sql`gen_random_uuid()`;
      const r = await tx.execute(sql`INSERT INTO items (tenant_id, name, income_account_id)
        VALUES (gen_random_uuid(), 'mig-0243', ${acct}) RETURNING item_type`);
      expect((r.rows[0] as { item_type: string }).item_type).toBe('service');
      await refuses(tx, sql`INSERT INTO items (tenant_id, name, income_account_id, item_type) VALUES (gen_random_uuid(), 'x', gen_random_uuid(), 'inventory_assembly')`);
      await refuses(tx, sql`INSERT INTO items (tenant_id, name, income_account_id, item_type, discount_percent) VALUES (gen_random_uuid(), 'x', gen_random_uuid(), 'discount', 0)`);
      await refuses(tx, sql`INSERT INTO items (tenant_id, name, income_account_id, item_type, discount_percent) VALUES (gen_random_uuid(), 'x', gen_random_uuid(), 'discount', 100.5)`);
      await refuses(tx, sql`INSERT INTO price_levels (tenant_id, name, percent) VALUES (gen_random_uuid(), 'x', -100.01)`);
      await refuses(tx, sql`INSERT INTO price_level_items (tenant_id, price_level_id, item_id, unit_price) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), -1)`);
      const lvl = gen();
      const item = gen();
      await tx.execute(sql`INSERT INTO price_level_items (tenant_id, price_level_id, item_id, unit_price) VALUES (gen_random_uuid(), ${lvl}, ${item}, 1)`);
      await refuses(tx, sql`INSERT INTO price_level_items (tenant_id, price_level_id, item_id, unit_price) VALUES (gen_random_uuid(), ${lvl}, ${item}, 2)`);
    });
  });

  it('rollback drops the columns and the tables; forward again (twice) restores them', async () => {
    await inRolledBackTx(async (tx) => {
      expect(await shape(tx)).toEqual({ tables: true, columns: ALL });
      await run(tx, ROLLBACK);
      expect(await shape(tx)).toEqual({ tables: false, columns: [] });
      await run(tx, FORWARD);
      await run(tx, FORWARD);
      expect(await shape(tx)).toEqual({ tables: true, columns: ALL });
    });
  });
});

function gen(): string {
  return crypto.randomUUID();
}
