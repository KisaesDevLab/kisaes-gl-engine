// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  topoOrderTables,
  mergeBundleSections,
  restoreDatabaseSections,
  buildRestoreChecklist,
  resyncOwnedSequences,
} from './system-restore.service.js';
import { encrypt } from '../utils/encryption.js';

describe('topoOrderTables', () => {
  it('orders parents before children (chain)', () => {
    const { order, cyclic } = topoOrderTables(
      ['journal_lines', 'transactions', 'accounts'],
      [
        { child: 'journal_lines', parent: 'transactions' },
        { child: 'transactions', parent: 'accounts' },
      ],
    );
    expect(order).toEqual(['accounts', 'transactions', 'journal_lines']);
    expect(cyclic).toEqual([]);
  });

  it('handles diamonds deterministically', () => {
    const { order } = topoOrderTables(
      ['d', 'b', 'c', 'a'],
      [
        { child: 'b', parent: 'a' },
        { child: 'c', parent: 'a' },
        { child: 'd', parent: 'b' },
        { child: 'd', parent: 'c' },
      ],
    );
    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('reports cycles and still returns every table', () => {
    const { order, cyclic } = topoOrderTables(
      ['x', 'y', 'z'],
      [
        { child: 'x', parent: 'y' },
        { child: 'y', parent: 'x' },
      ],
    );
    expect(order).toHaveLength(3);
    expect(order[0]).toBe('z');
    expect(cyclic).toEqual(['x', 'y']);
  });

  it('ignores edges pointing outside the table set', () => {
    const { order, cyclic } = topoOrderTables(['a'], [{ child: 'a', parent: 'not_in_bundle' }]);
    expect(order).toEqual(['a']);
    expect(cyclic).toEqual([]);
  });
});

describe('mergeBundleSections', () => {
  it('merges tenant_data across tenants and prefers v2 global_tables', () => {
    const sections = mergeBundleSections({
      tenants: [{ id: 't1' }],
      tenant_data: {
        t1: { budgets: [{ id: 'b1' }] },
        t2: { budgets: [{ id: 'b2' }] },
      },
      global_tables: { plaid_config: [{ id: 'p1' }] },
      system_config: { system_settings: [{ key: 'ignored' }] },
    });
    expect(sections['tenants']).toHaveLength(1);
    expect(sections['budgets']!.map((r) => r['id'])).toEqual(['b1', 'b2']);
    expect(sections['plaid_config']).toHaveLength(1);
    expect(sections['system_settings']).toBeUndefined(); // v2 wins
  });

  it('falls back to v1 system_config when global_tables is absent', () => {
    const sections = mergeBundleSections({
      system_config: { system_settings: [{ key: 'smtp_host', value: 'mail.example.com' }] },
    });
    expect(sections['system_settings']).toHaveLength(1);
  });
});

describe('restoreDatabaseSections (integration)', () => {
  const tenantId = crypto.randomUUID();
  const userId = crypto.randomUUID();

  afterEach(async () => {
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
    await db.execute(sql`DELETE FROM system_settings WHERE key IN ('smtp_host', 'smtp_pass')`);
    await db.execute(sql`DELETE FROM plaid_config WHERE webhook_url = 'https://restore-test.example.com'`);
  });

  it('restores FK-dependent tables regardless of map order and reports stats', async () => {
    // users depends on tenants via FK; feed users FIRST to prove ordering.
    const report = await restoreDatabaseSections(db, {
      users: [
        {
          id: userId,
          tenant_id: tenantId,
          email: `restore-test-${userId}@example.com`,
          password_hash: 'x'.repeat(20),
        },
      ],
      tenants: [{ id: tenantId, name: 'Restore Test', slug: `restore-test-${tenantId.slice(0, 8)}` }],
    });

    expect(report.totals.failed).toBe(0);
    expect(report.perTable['tenants']!.inserted).toBe(1);
    expect(report.perTable['users']!.inserted).toBe(1);

    const check = await db.execute(sql`SELECT id FROM users WHERE id = ${userId}`);
    expect(check.rows).toHaveLength(1);
  });

  it('reports (not swallows) rows that keep failing, without blocking others', async () => {
    const report = await restoreDatabaseSections(db, {
      tenants: [{ id: tenantId, name: 'Restore Test', slug: `restore-test-${tenantId.slice(0, 8)}` }],
      users: [
        {
          id: userId,
          // Dangling FK: this tenant id does not exist and is not in the bundle.
          tenant_id: crypto.randomUUID(),
          email: `restore-test-${userId}@example.com`,
          password_hash: 'x'.repeat(20),
        },
      ],
    });

    expect(report.perTable['tenants']!.inserted).toBe(1);
    expect(report.perTable['users']!.failed).toBe(1);
    expect(report.perTable['users']!.sampleErrors.length).toBeGreaterThan(0);
    expect(report.totals.failed).toBe(1);
  });

  it('applies a v1 bundle end-to-end: exported SMTP settings reach system_settings', async () => {
    const v1Content = {
      system_config: {
        system_settings: [
          { id: crypto.randomUUID(), key: 'smtp_host', value: 'mail.example.com' },
          { id: crypto.randomUUID(), key: 'smtp_pass', value: 'hunter2' },
        ],
      },
    };
    const report = await restoreDatabaseSections(db, mergeBundleSections(v1Content));
    expect(report.totals.failed).toBe(0);

    const host = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'smtp_host'`);
    expect((host.rows as { value: string }[])[0]?.value).toBe('mail.example.com');

    const checklist = await buildRestoreChecklist(db);
    expect(checklist['smtp']!.status).toBe('ok');
  });

  it('checklist probes credential decryptability and flags a key mismatch', async () => {
    // Decryptable with the current PLAID_ENCRYPTION_KEY → ok.
    await restoreDatabaseSections(db, {
      plaid_config: [
        {
          id: crypto.randomUUID(),
          environment: 'sandbox',
          client_id_encrypted: encrypt('plaid-client-id'),
          webhook_url: 'https://restore-test.example.com',
        },
      ],
    });
    let checklist = await buildRestoreChecklist(db);
    expect(checklist['plaid']!.status).toBe('ok');
    expect(checklist['encryption']!.status).toBe('ok');

    // Ciphertext from a DIFFERENT key → warning.
    await db.execute(sql`
      UPDATE plaid_config
      SET client_id_encrypted = ${Buffer.from('aaaaaaaaaaaa').toString('base64') + ':' + Buffer.from('bbbbbbbbbbbbbbbb').toString('base64') + ':' + Buffer.from('cccc').toString('base64')}
      WHERE webhook_url = 'https://restore-test.example.com'
    `);
    checklist = await buildRestoreChecklist(db);
    expect(checklist['encryption']!.status).toBe('warning');
  });
});

describe('resyncOwnedSequences', () => {
  const madeTables: string[] = [];
  afterEach(async () => {
    for (const t of madeTables.splice(0)) {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS ${t} CASCADE`));
    }
  });
  const uniq = (p: string) => p + crypto.randomUUID().replace(/-/g, '').slice(0, 10);

  it('advances an owned sequence past the max existing id', async () => {
    const t = uniq('rzs_ok_');
    madeTables.push(t);
    await db.execute(sql.raw(`CREATE TABLE ${t} (id bigserial PRIMARY KEY, v int)`));
    await db.execute(sql.raw(`INSERT INTO ${t} (id, v) VALUES (500, 1)`));

    await resyncOwnedSequences(db);

    const r = await db.execute(sql.raw(`SELECT nextval(pg_get_serial_sequence('${t}', 'id')) AS n`));
    expect(Number((r.rows[0] as { n: string }).n)).toBeGreaterThan(500);
  });

  it('skips an un-settable sequence instead of aborting, and still resyncs the good ones', async () => {
    const good = uniq('rzs_good_');
    const bad = uniq('rzs_bad_');
    madeTables.push(good, bad);
    await db.execute(sql.raw(`CREATE TABLE ${good} (id bigserial PRIMARY KEY)`));
    await db.execute(sql.raw(`INSERT INTO ${good} (id) VALUES (250)`));
    // An owned sequence capped at MAXVALUE 5, but a column value of 999 above
    // it — setval(seq, 999) throws "out of bounds", the class of failure that
    // used to roll back the entire restore.
    await db.execute(sql.raw(`CREATE TABLE ${bad} (id int PRIMARY KEY)`));
    await db.execute(sql.raw(`CREATE SEQUENCE ${bad}_seq MAXVALUE 5 OWNED BY ${bad}.id`));
    await db.execute(sql.raw(`INSERT INTO ${bad} (id) VALUES (999)`));

    // Must NOT throw despite the un-settable sequence.
    await expect(resyncOwnedSequences(db)).resolves.toBeUndefined();

    // The good sequence was still resynced past its max.
    const r = await db.execute(sql.raw(`SELECT nextval(pg_get_serial_sequence('${good}', 'id')) AS n`));
    expect(Number((r.rows[0] as { n: string }).n)).toBeGreaterThan(250);
  });
});
