// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-130: migration 0246 adds invoice_templates.line_columns, transactions.
// invoice_layout_id, invoice_templates.is_archived, contacts.default_invoice_layout_id,
// one default per company (uq_invoice_templates_company_default)
// and renames the seeded 'Default' to 'Standard' (invoice-layouts-v1). The
// rollback drops the additions and keeps the name; the forward migration is
// idempotent. Every rollback runs inside a database transaction that is
// rolled back, so the rest of the suite never sees the old schema.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const FORWARD = '0246_invoice_layouts.sql';
const ROLLBACK = '0246_invoice_layouts.rollback.sql';

async function run(tx: Tx, file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await tx.execute(sql.raw(body));
  }
}

async function hasColumn(tx: Tx, table: string, column: string): Promise<boolean> {
  const r = await tx.execute(sql`SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`);
  return r.rows.length > 0;
}

async function hasIndex(tx: Tx, name: string): Promise<boolean> {
  const r = await tx.execute(sql`SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${name}`);
  return r.rows.length > 0;
}

class RolledBack extends Error {}

async function inRolledBackTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await expect(db.transaction(async (tx) => {
    await fn(tx);
    throw new RolledBack('rollback');
  })).rejects.toBeInstanceOf(RolledBack);
}

async function added(tx: Tx) {
  return {
    columns: await hasColumn(tx, 'invoice_templates', 'line_columns'),
    layout: await hasColumn(tx, 'transactions', 'invoice_layout_id'),
    unique: await hasIndex(tx, 'uq_invoice_templates_company_default'),
    inUse: await hasIndex(tx, 'idx_txn_invoice_layout'),
    archived: await hasColumn(tx, 'invoice_templates', 'is_archived'),
    clientDefault: await hasColumn(tx, 'contacts', 'default_invoice_layout_id'),
  };
}

const ALL = { columns: true, layout: true, unique: true, inUse: true, archived: true, clientDefault: true };
const NONE = { columns: false, layout: false, unique: false, inUse: false, archived: false, clientDefault: false };

describe('migration 0246 invoice layouts', () => {
  it('is listed after 0245 and is additive', () => {
    const fwd = readFileSync(path.join(MIGRATIONS, FORWARD), 'utf8');
    expect(fwd).not.toMatch(/drop\s+(table|column|constraint|index)/i);
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === '0246_invoice_layouts');
    expect(entry?.idx).toBe(246);
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 245)!.when);
  });

  it('one default per company; legacy tenant rows and other companies are free', async () => {
    await inRolledBackTx(async (tx) => {
      expect(await added(tx)).toEqual(ALL);
      const t = '00000000-0000-4000-8000-0000000000a1';
      const co = '00000000-0000-4000-8000-0000000000a2';
      const ins = (companyId: string | null, isDefault: boolean) => tx.execute(sql`INSERT INTO invoice_templates
        (tenant_id, company_id, name, is_default) VALUES (${t}, ${companyId}, 'X', ${isDefault})`);
      await ins(co, true);
      await ins(co, false);
      await ins(null, true);
      await ins(null, true);
      await ins('00000000-0000-4000-8000-0000000000a3', true);
      await expect(tx.transaction(async (sp) => {
        await sp.execute(sql`INSERT INTO invoice_templates (tenant_id, company_id, name, is_default) VALUES (${t}, ${co}, 'Y', true)`);
      })).rejects.toThrow();
      const r = await tx.execute(sql`SELECT line_columns AS c FROM invoice_templates WHERE tenant_id = ${t} LIMIT 1`);
      expect((r.rows[0] as { c: unknown }).c).toEqual({ item: false, description: true, serviceDate: false, quantity: true, rate: true });
    });
  });

  it('forward cleans duplicate and missing defaults and renames the seeded Default', async () => {
    await inRolledBackTx(async (tx) => {
      await run(tx, ROLLBACK);
      expect(await added(tx)).toEqual(NONE);
      const t = '00000000-0000-4000-8000-0000000000b1';
      const dup = '00000000-0000-4000-8000-0000000000b2';
      const none = '00000000-0000-4000-8000-0000000000b3';
      const ins = (companyId: string | null, name: string, isDefault: boolean, at: string) => tx.execute(sql`INSERT INTO invoice_templates
        (tenant_id, company_id, name, is_default, updated_at) VALUES (${t}, ${companyId}, ${name}, ${isDefault}, ${at}::timestamptz)`);
      await ins(dup, 'Default', true, '2026-01-01T00:00:00Z');
      await ins(dup, 'Newer', true, '2026-02-01T00:00:00Z');
      await ins(none, 'Old', false, '2026-01-01T00:00:00Z');
      await ins(none, 'New', false, '2026-03-01T00:00:00Z');
      await ins(null, 'Default', true, '2026-01-01T00:00:00Z');
      await run(tx, FORWARD);
      await run(tx, FORWARD);
      expect(await added(tx)).toEqual(ALL);
      const rows = (await tx.execute(sql`SELECT company_id AS c, name AS n, is_default AS d FROM invoice_templates
        WHERE tenant_id = ${t} ORDER BY company_id NULLS FIRST, name`)).rows as Array<{ c: string | null; n: string; d: boolean }>;
      expect(rows).toEqual([
        { c: null, n: 'Standard', d: true },
        { c: dup, n: 'Default', d: false },
        { c: dup, n: 'Newer', d: true },
        { c: none, n: 'New', d: true },
        { c: none, n: 'Old', d: false },
      ]);
      await run(tx, ROLLBACK);
      const back = (await tx.execute(sql`SELECT name AS n FROM invoice_templates WHERE tenant_id = ${t} AND company_id IS NULL`)).rows as Array<{ n: string }>;
      // The rename is kept: a default the owner named 'Standard' stays so.
      expect(back).toEqual([{ n: 'Standard' }]);
    });
  });
});
