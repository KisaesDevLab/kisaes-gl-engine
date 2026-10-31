// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-123, U-126: migration 0242 adds journal_lines.service_date,
// transactions.po_number / customer_message / hide_zero_lines and the
// document_send_events table (invoice-fields-v1, invoice-sent-history-v1).
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
const FORWARD = '0242_invoice_core.sql';
const ROLLBACK = '0242_invoice_core.rollback.sql';

async function run(tx: Tx, file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await tx.execute(sql.raw(body));
  }
}

async function shape(tx: Tx) {
  const t = await tx.execute(sql`SELECT to_regclass('public.document_send_events') AS t`);
  const cols = await tx.execute(sql`
    SELECT table_name || '.' || column_name AS c FROM information_schema.columns
    WHERE table_schema = 'public' AND (
      (table_name = 'journal_lines' AND column_name = 'service_date')
      OR (table_name = 'transactions' AND column_name IN ('po_number', 'customer_message', 'hide_zero_lines')))
    ORDER BY 1`);
  return { table: (t.rows[0] as { t: string | null }).t !== null, columns: (cols.rows as Array<{ c: string }>).map((r) => r.c) };
}

class RolledBack extends Error {}

async function inRolledBackTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await expect(db.transaction(async (tx) => {
    await fn(tx);
    throw new RolledBack('rollback');
  })).rejects.toBeInstanceOf(RolledBack);
}

const ALL = ['journal_lines.service_date', 'transactions.customer_message', 'transactions.hide_zero_lines', 'transactions.po_number'];

describe('migration 0242 invoice core', () => {
  it('is listed after 0241 and is additive', () => {
    const fwd = readFileSync(path.join(MIGRATIONS, FORWARD), 'utf8');
    expect(fwd).not.toMatch(/drop\s+(table|column|constraint)/i);
    expect(fwd).not.toContain('migration-policy: non-additive-exception');
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === '0242_invoice_core');
    expect(entry?.idx).toBe(242);
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 241)!.when);
  });

  it('refuses an unknown send method; recipients default to []', async () => {
    await inRolledBackTx(async (tx) => {
      const r = await tx.execute(sql`INSERT INTO document_send_events (tenant_id, transaction_id, method)
        VALUES (gen_random_uuid(), gen_random_uuid(), 'printed') RETURNING recipients::text AS r`);
      expect((r.rows[0] as { r: string }).r).toBe('[]');
      await expect(tx.execute(sql`SAVEPOINT s1`).then(() => tx.execute(sql`INSERT INTO document_send_events (tenant_id, transaction_id, method)
        VALUES (gen_random_uuid(), gen_random_uuid(), 'fax')`))).rejects.toThrow();
      await tx.execute(sql`ROLLBACK TO SAVEPOINT s1`);
    });
  });

  it('rollback drops the columns and the table; forward again (twice) restores them', async () => {
    await inRolledBackTx(async (tx) => {
      expect(await shape(tx)).toEqual({ table: true, columns: ALL });
      await run(tx, ROLLBACK);
      expect(await shape(tx)).toEqual({ table: false, columns: [] });
      await run(tx, FORWARD);
      await run(tx, FORWARD);
      expect(await shape(tx)).toEqual({ table: true, columns: ALL });
    });
  });
});
