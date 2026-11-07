// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-162 (ClientLedger PR-4): migration 0261 adds
// inventory_movements.correction_share and the linked sale's position
// (source_movement_date, source_txn_created_at), and puts them,
// source_transaction_id and id in the position index. Additive; the rollback
// restores the 0259 index and drops the columns (always allowed), and the
// forward migration is idempotent. Every rollback runs inside a database transaction that is
// rolled back, so the rest of the suite never sees the old schema.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, type Tx } from '../db/index.js';
import { positionAsc } from './inventory-position.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const FORWARD = '0261_inventory_position.sql';
const ROLLBACK = '0261_inventory_position.rollback.sql';

async function run(tx: Tx, file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await tx.execute(sql.raw(body));
  }
}

async function shape(tx: Tx) {
  const col = await tx.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'inventory_movements' AND column_name IN ('correction_share', 'source_movement_date', 'source_txn_created_at')`);
  const idx = await tx.execute(sql`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_inventory_movements_position'`);
  return { column: col.rows.length === 3, gone: col.rows.length === 0, index: String((idx.rows[0] as { indexdef?: string } | undefined)?.indexdef ?? '') };
}

class RolledBack extends Error {}
async function inRolledBackTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await expect(db.transaction(async (tx) => { await fn(tx); throw new RolledBack('rollback'); })).rejects.toBeInstanceOf(RolledBack);
}

describe('migration 0261 inventory position', () => {
  it('is listed after 0260 and is additive', () => {
    const fwd = readFileSync(path.join(MIGRATIONS, FORWARD), 'utf8');
    expect(fwd).not.toMatch(/drop\s+(table|column|constraint)/i);
    expect(fwd).not.toContain('migration-policy: non-additive-exception');
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === '0261_inventory_position');
    expect(entry?.idx).toBe(261);
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 260)!.when);
  });

  it('forward: the column and the full position index; rollback restores 0259; forward again (twice) restores it', async () => {
    await inRolledBackTx(async (tx) => {
      const now = await shape(tx);
      expect(now.column).toBe(true);
      expect(now.index).toMatch(/transaction_id, source_movement_date NULLS FIRST, source_txn_created_at NULLS FIRST, source_transaction_id NULLS FIRST, id\)/);
      await run(tx, ROLLBACK);
      const old = await shape(tx);
      expect(old.gone).toBe(true);
      expect(old.index).toMatch(/\(company_id, item_id, movement_date, txn_created_at, transaction_id\)$/);
      await run(tx, FORWARD);
      await run(tx, FORWARD);
      expect(await shape(tx)).toEqual(now);
    });
  });

  it('data step (RB1): linked rows get their sale position; a memo\'s rows of one part get running figures in the new order; nothing else moves', async () => {
    await inRolledBackTx(async (tx) => {
      await run(tx, ROLLBACK);
      const [t, co, item] = [randomUUID(), randomUUID(), randomUUID()];
      // Sale Y (Mar 1) sorts before sale X (Mar 2), but X's id sorts first: the old tiebreak put X's return row first.
      const [bill, saleX, saleY, memo] = [randomUUID(), `00000000-0000-4000-8000-${randomUUID().slice(-12)}`, `ffffffff-ffff-4fff-bfff-${randomUUID().slice(-12)}`, randomUUID()];
      const row = (id: string, txn: string, src: string | null, date: string, created: string, kind: string, mode: string, q: string, v: string, rq: string, rv: string) =>
        sql`INSERT INTO inventory_movements (id, tenant_id, company_id, item_id, transaction_id, source_transaction_id, movement_date, txn_created_at, kind,
          quantity, value_mode, value, running_qty, running_value, last_cost)
          VALUES (${id}, ${t}, ${co}, ${item}, ${txn}, ${src}, ${date}, ${created}::timestamptz, ${kind}, ${q}, ${mode}, ${v}, ${rq}, ${rv}, '4')`;
      const [rx, ry] = [randomUUID(), randomUUID()];
      await tx.execute(row(randomUUID(), bill, null, '2026-02-01', '2026-02-01T10:00:00Z', 'receipt', 'given', '5', '20', '5', '20'));
      await tx.execute(row(randomUUID(), saleY, null, '2026-03-01', '2026-03-01T10:00:00Z', 'sale', 'derived', '-1', '-4', '4', '16'));
      await tx.execute(row(randomUUID(), saleX, null, '2026-03-02', '2026-03-02T10:00:00Z', 'sale', 'derived', '-1', '-6', '3', '10'));
      // Stored as the old order walked them: X's row first.
      await tx.execute(row(rx, memo, saleX, '2026-03-05', '2026-03-05T10:00:00Z', 'customer_return', 'linked', '1', '6', '4', '16'));
      await tx.execute(row(ry, memo, saleY, '2026-03-05', '2026-03-05T10:00:00Z', 'customer_return', 'linked', '1', '4', '5', '20'));
      const before = (await tx.execute(sql`SELECT id, running_qty::text AS q, running_value::text AS v FROM inventory_movements
        WHERE tenant_id = ${t} AND transaction_id <> ${memo} ORDER BY id`)).rows;
      await run(tx, FORWARD);
      const got = (await tx.execute(sql`SELECT source_transaction_id::text AS src, source_movement_date::text AS sd, source_txn_created_at AS sc,
          running_qty::text AS q, running_value::text AS v, last_cost::text AS l
        FROM inventory_movements WHERE tenant_id = ${t} AND transaction_id = ${memo} ORDER BY ${positionAsc()}`)).rows as Array<Record<string, unknown>>;
      expect(got.map((r) => [r['src'], r['sd'], r['q'], r['v'], r['l']])).toEqual([
        [saleY, '2026-03-01', '4.0000', '14.0000', '3.500000'],
        [saleX, '2026-03-02', '5.0000', '20.0000', '4.000000'],
      ]);
      expect(new Date(String(got[0]!['sc'])).toISOString()).toBe('2026-03-01T10:00:00.000Z');
      expect((await tx.execute(sql`SELECT id, running_qty::text AS q, running_value::text AS v FROM inventory_movements
        WHERE tenant_id = ${t} AND transaction_id <> ${memo} ORDER BY id`)).rows).toEqual(before);
      const unlinked = await tx.execute(sql`SELECT 1 FROM inventory_movements WHERE tenant_id = ${t} AND source_transaction_id IS NULL
        AND (source_movement_date IS NOT NULL OR source_txn_created_at IS NOT NULL)`);
      expect(unlinked.rows).toHaveLength(0);
    });
  });
});
