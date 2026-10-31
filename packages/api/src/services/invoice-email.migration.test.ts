// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-127: migration 0244 adds the form_email_queue table (invoice-email-v1,
// the email Outbox). Additive; the rollback drops it and the forward
// migration is idempotent. Every rollback runs inside a database transaction
// that is rolled back, so the rest of the suite never sees the old schema.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const FORWARD = '0244_invoice_email_queue.sql';
const ROLLBACK = '0244_invoice_email_queue.rollback.sql';

async function run(tx: Tx, file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await tx.execute(sql.raw(body));
  }
}

async function columns(tx: Tx): Promise<string[]> {
  const cols = await tx.execute(sql`
    SELECT column_name AS c FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'form_email_queue' ORDER BY 1`);
  return (cols.rows as Array<{ c: string }>).map((r) => r.c);
}

class RolledBack extends Error {}

async function inRolledBackTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await expect(db.transaction(async (tx) => {
    await fn(tx);
    throw new RolledBack('rollback');
  })).rejects.toBeInstanceOf(RolledBack);
}

const ALL = [
  'bcc_addresses', 'body', 'cc_addresses', 'company_id', 'created_at', 'id', 'subject', 'tenant_id', 'to_addresses',
  'transaction_id', 'user_id',
];

describe('migration 0244 invoice email queue', () => {
  it('is listed after 0243 and is additive', () => {
    const fwd = readFileSync(path.join(MIGRATIONS, FORWARD), 'utf8');
    expect(fwd).not.toMatch(/drop\s+(table|column|constraint)/i);
    expect(fwd).not.toContain('migration-policy: non-additive-exception');
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === '0244_invoice_email_queue');
    expect(entry?.idx).toBe(244);
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 243)!.when);
  });

  it('stores no attachment: the message fields only, recipients default to []', async () => {
    await inRolledBackTx(async (tx) => {
      expect(await columns(tx)).toEqual(ALL);
      const r = await tx.execute(sql`INSERT INTO form_email_queue (tenant_id, transaction_id)
        VALUES (gen_random_uuid(), gen_random_uuid()) RETURNING to_addresses::text AS t, subject AS s, body AS b`);
      expect(r.rows[0]).toEqual({ t: '[]', s: '', b: '' });
    });
  });

  it('rollback drops the table; forward again (twice) restores it', async () => {
    await inRolledBackTx(async (tx) => {
      await run(tx, ROLLBACK);
      expect(await columns(tx)).toEqual([]);
      await run(tx, FORWARD);
      await run(tx, FORWARD);
      expect(await columns(tx)).toEqual(ALL);
    });
  });
});
