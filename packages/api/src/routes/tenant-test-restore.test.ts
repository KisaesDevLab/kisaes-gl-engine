// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Test restore (U-296, ClientLedger P34) in desktop mode: a backup passes,
// a trial balance difference is passed:false with exact figures, nothing of
// the test remains, a wrong passphrase and a transfer file fail the job,
// the backup permission on the source tenant decides (Q-P34v), the verdict
// is audited, and the change feed's horizon skips only a test restore's open
// transaction while a real import still holds it (Q-P34u).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';

const TOKEN = 'testrestore_' + 't'.repeat(40);
let dataDir = '';
let app: Express;
let server: http.Server;
let port = 0;
let ownerJwt = '';
let adminJwt = '';
let otherAdminJwt = '';
let workspaceId = '';
let ownerId = '';
const extraUsers: string[] = [];
const stamp = crypto.randomUUID().slice(0, 8);
const PASS = 'test restore passphrase 2026';
const tenantsToClean: string[] = [];
/** The first backup made in this file (not the transfer file). */
let firstBackup = '';

type Db = typeof import('../db/index.js');
let dbm: Db;
type Imp = typeof import('../services/tenant-portability/import.service.js');
let imp: Imp;

async function call(method: string, p: string, body?: unknown, token = ownerJwt): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'x-cl-token': TOKEN, authorization: `Bearer ${token}` };
  let payload: string | undefined;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: payload });
  const ct = r.headers.get('content-type') ?? '';
  return { status: r.status, json: ct.includes('application/json') ? (await r.json()) as Record<string, unknown> : {} };
}

async function waitJob(jobId: string, token = ownerJwt): Promise<Record<string, unknown>> {
  for (let i = 0; i < 2400; i++) {
    const r = await call('GET', `/api/v1/tenant-archives/jobs/${jobId}`, undefined, token);
    expect(r.status).toBe(200);
    if (r.json['status'] === 'succeeded' || r.json['status'] === 'failed') return r.json;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('job timeout');
}

async function q<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const { sql } = await import('drizzle-orm');
  const chunks = text.split(/\$(\d+)/);
  let query = sql.raw(chunks[0]!);
  for (let i = 1; i < chunks.length; i += 2) {
    query = sql`${query}${params[Number(chunks[i]) - 1]}${sql.raw(chunks[i + 1]!)}`;
  }
  return (await dbm.db.execute(query)).rows as T[];
}

async function tenantCount(): Promise<number> {
  return Number((await q<{ n: number }>('SELECT count(*)::int AS n FROM tenants'))[0]!.n);
}

async function makeUser(role: 'admin' | 'owner', tenantId: string): Promise<string> {
  const [u] = await q<{ id: string }>(`INSERT INTO users (tenant_id, email, password_hash, display_name, role, is_super_admin)
    VALUES ($1, $2, 'x', 'Admin', 'admin', false) RETURNING id`, [workspaceId, `tr-${role}-${crypto.randomUUID().slice(0, 6)}-${stamp}@example.test`]);
  extraUsers.push(u!.id);
  await q(`INSERT INTO user_tenant_access (user_id, tenant_id, role) VALUES ($1, $2, $3)`, [u!.id, tenantId, role]);
  return u!.id;
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-test-restore-'));
  process.env['CL_ARCHIVE_DIR'] = path.join(dataDir, 'archives');
  vi.resetModules();
  const profile = await import('../desktop/profile.js');
  profile.loadDesktopProfile({ CL_MODE: 'desktop', CL_TOKEN: TOKEN, CL_BIND: '127.0.0.1:0', CL_DATA_DIR: dataDir });
  ({ app } = await import('../app.js'));
  dbm = await import('../db/index.js');
  imp = await import('../services/tenant-portability/import.service.js');
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  const { setDesktopBoundAddress } = await import('../middleware/desktop-gate.js');
  setDesktopBoundAddress('127.0.0.1', port);
  const ws = await import('../desktop/workspace.js');
  ws._resetWorkspaceCacheForTests();
  const created = await ws.createWorkspaceWithOwner({ email: `tr-owner-${stamp}@example.test`, displayName: 'Owner', password: 'owner password 1234' });
  workspaceId = created.workspaceTenantId;
  ownerId = created.userId;
  const { env } = await import('../config/env.js');
  ownerJwt = jwt.sign({ userId: ownerId, tenantId: workspaceId, role: 'owner', isSuperAdmin: true }, env.JWT_SECRET, { expiresIn: '30m' });
}, 120_000);

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  const { sql } = await import('drizzle-orm');
  const { buildPortabilityPlan, scopeSql } = await import('../services/tenant-portability/plan.js');
  const plan = await buildPortabilityPlan(dbm.db);
  for (const id of tenantsToClean) {
    for (const t of [...plan.scoped].reverse()) {
      const where = scopeSql(plan, t, 'a').replace('$1', `'${id}'::uuid`);
      await dbm.db.execute(sql.raw(`DELETE FROM "${t}" a WHERE ${where}`)).catch(() => undefined);
    }
    await dbm.db.execute(sql`DELETE FROM user_tenant_access WHERE tenant_id = ${id}`);
    await dbm.db.execute(sql`DELETE FROM tenants WHERE id = ${id}`);
  }
  for (const u of [...extraUsers, ownerId]) {
    await dbm.db.execute(sql`DELETE FROM sessions WHERE user_id = ${u}`);
    await dbm.db.execute(sql`DELETE FROM user_tenant_access WHERE user_id = ${u}`);
  }
  await dbm.db.execute(sql`DELETE FROM audit_log WHERE tenant_id = ${workspaceId}`);
  await dbm.db.execute(sql`DELETE FROM user_tenant_access WHERE tenant_id = ${workspaceId}`);
  await dbm.db.execute(sql`DELETE FROM users WHERE tenant_id = ${workspaceId}`);
  await dbm.db.execute(sql`DELETE FROM tenants WHERE id = ${workspaceId}`);
  const ws = await import('../desktop/workspace.js');
  ws._resetWorkspaceCacheForTests();
  (await import('../desktop/profile.js'))._resetDesktopProfileForTests();
  delete process.env['CL_ARCHIVE_DIR'];
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('test restore (U-296)', () => {
  let companyTenant = '';
  let archivePath = '';
  let archiveId = '';

  it('is advertised, and a fresh backup passes with an equal trial balance and leaves nothing behind', async () => {
    const info = await call('GET', '/api/v1/desktop/info');
    expect(info.json['capabilities']).toEqual(expect.arrayContaining(['tenant-archive-test-restore-v1']));
    const created = await call('POST', '/api/v1/tenants', { name: `TR Co ${stamp}`, businessType: 'default' });
    expect(created.status).toBe(201);
    companyTenant = created.json['id'] as string;
    tenantsToClean.push(companyTenant);
    // One posted entry, exact to the fourth place.
    const [co] = await q<{ id: string }>('SELECT id FROM companies WHERE tenant_id = $1 LIMIT 1', [companyTenant]);
    const accts = await q<{ id: string }>('SELECT id FROM accounts WHERE tenant_id = $1 ORDER BY account_number LIMIT 2', [companyTenant]);
    const [txn] = await q<{ id: string }>(`INSERT INTO transactions (tenant_id, company_id, txn_type, txn_date, status, memo)
      VALUES ($1, $2, 'journal_entry', '2026-01-15', 'posted', 'tr') RETURNING id`, [companyTenant, co!.id]);
    await q(`INSERT INTO journal_lines (tenant_id, company_id, transaction_id, account_id, debit, credit) VALUES
      ($1, $2, $3, $4, 1234.5678, 0), ($1, $2, $3, $5, 0, 1234.5678)`, [companyTenant, co!.id, txn!.id, accts[0]!.id, accts[1]!.id]);

    const started = await call('POST', `/api/v1/tenants/${companyTenant}/archives`, { passphrase: PASS });
    expect(started.status).toBe(202);
    const exp = await waitJob(started.json['jobId'] as string);
    expect(exp['status']).toBe('succeeded');
    archivePath = (exp['result'] as Record<string, unknown>)['path'] as string;
    firstBackup = archivePath;
    archiveId = (exp['result'] as Record<string, unknown>)['archiveId'] as string;

    const before = await tenantCount();
    const t = await call('POST', '/api/v1/tenant-archives/test-restore', { path: archivePath, passphrase: PASS });
    expect(t.status).toBe(202);
    const job = await waitJob(t.json['jobId'] as string);
    expect(job['status'], JSON.stringify(job['error'])).toBe('succeeded');
    expect(job['kind']).toBe('test-restore');
    const r = (job['result'] as { testRestore: Record<string, unknown> }).testRestore;
    expect(r['passed']).toBe(true);
    expect(r['failures']).toEqual([]);
    expect(r['archiveId']).toBe(archiveId);
    expect(r['sourceTenantId']).toBe(companyTenant);
    const tb = r['trialBalance'] as Record<string, Record<string, unknown> | boolean>;
    expect(tb['rowsEqual']).toBe(true);
    expect(tb['totalsEqual']).toBe(true);
    expect((tb['actual'] as Record<string, unknown>)['debitExact']).toBe('1234.5678');
    expect(tb['differenceExact']).toEqual({ debit: '0.0000', credit: '0.0000' });
    expect(r['unbalanced']).toEqual({ expected: 0, actual: 0 });
    expect((r['verificationTotals'] as Record<string, unknown>)['matches']).toBe(true);
    // Nothing remains: no tenant, no upload folder, no pending marker.
    expect(await tenantCount()).toBe(before);
    const uploads = process.env['UPLOAD_DIR'] || '/data/uploads';
    if (fs.existsSync(uploads)) {
      for (const d of fs.readdirSync(uploads)) expect(fs.existsSync(path.join(uploads, d, '.import-pending'))).toBe(false);
    }
    // Audited in the workspace.
    const audit = await q<{ after_data: unknown }>(`SELECT after_data FROM audit_log WHERE tenant_id = $1 AND entity_type = 'tenant_archive_test_restore' ORDER BY created_at DESC LIMIT 1`, [workspaceId]);
    const after = typeof audit[0]!.after_data === 'string' ? JSON.parse(audit[0]!.after_data as string) : audit[0]!.after_data;
    expect(after).toMatchObject({ archiveId, passed: true });
    // /import {scratch:true} is unchanged.
    const scratch = await call('POST', '/api/v1/tenant-archives/import', { path: archivePath, passphrase: PASS, scratch: true });
    expect((scratch.json['error'] as { code: string }).code).toBe('SCRATCH_NOT_AVAILABLE');
  }, 300_000);

  it('a trial balance difference is passed:false with exact figures and no leftovers', async () => {
    const before = await tenantCount();
    imp._importTestHooks.beforeVerify = async ({ client, newTenantId }) => {
      await client.query(`UPDATE journal_lines SET debit = debit + 0.0001 WHERE tenant_id = $1 AND debit > 0`, [newTenantId]);
    };
    try {
      const t = await call('POST', '/api/v1/tenant-archives/test-restore', { path: archivePath, passphrase: PASS });
      const job = await waitJob(t.json['jobId'] as string);
      expect(job['status'], JSON.stringify(job['error'])).toBe('succeeded');
      const r = (job['result'] as { testRestore: Record<string, unknown> }).testRestore;
      expect(r['passed']).toBe(false);
      const checks = (r['failures'] as Array<{ check: string }>).map((f) => f.check);
      expect(checks).toEqual(expect.arrayContaining(['trialBalance', 'trialBalanceTotals', 'unbalancedTransactions']));
      const tb = r['trialBalance'] as Record<string, unknown>;
      expect(tb['rowsEqual']).toBe(false);
      expect(tb['totalsEqual']).toBe(false);
      expect(tb['differenceExact']).toEqual({ debit: '0.0001', credit: '0.0000' });
      expect(r['unbalanced']).toEqual({ expected: 0, actual: 1 });
    } finally {
      delete imp._importTestHooks.beforeVerify;
    }
    expect(await tenantCount()).toBe(before);
  }, 300_000);

  it('a wrong passphrase and a transfer file fail the job; refusals are 403', async () => {
    const wrong = await call('POST', '/api/v1/tenant-archives/test-restore', { path: archivePath, passphrase: 'wrong passphrase 123' });
    expect(wrong.status).toBe(202);
    const failed = await waitJob(wrong.json['jobId'] as string);
    expect(failed['status']).toBe('failed');
    expect((failed['error'] as { code: string }).code).toBe('ARCHIVE_PASSPHRASE_INVALID');

    const tr = await call('POST', `/api/v1/tenants/${companyTenant}/archives`, { passphrase: PASS, transfer: true });
    expect(tr.status).toBe(202);
    const trJob = await waitJob(tr.json['jobId'] as string);
    expect(trJob['status'], JSON.stringify(trJob['error'])).toBe('succeeded');
    const trPath = (trJob['result'] as Record<string, unknown>)['path'] as string;
    const t = await call('POST', '/api/v1/tenant-archives/test-restore', { path: trPath, passphrase: PASS });
    const job = await waitJob(t.json['jobId'] as string);
    expect(job['status']).toBe('failed');
    expect((job['error'] as { code: string }).code).toBe('TRANSFER_NOT_A_BACKUP');

    const relative = await call('POST', '/api/v1/tenant-archives/test-restore', { path: 'x.clbackup', passphrase: PASS });
    expect(relative.status).toBe(400);
  }, 300_000);

  it('uses the backup permission on the source tenant (Q-P34v)', async () => {
    const { env } = await import('../config/env.js');
    const sign = (id: string) => jwt.sign({ userId: id, tenantId: workspaceId, role: 'admin', isSuperAdmin: false }, env.JWT_SECRET, { expiresIn: '30m' });
    adminJwt = sign(await makeUser('admin', companyTenant));
    // An admin of the source company may test its backup.
    const ok = await call('POST', '/api/v1/tenant-archives/test-restore', { path: archivePath, passphrase: PASS }, adminJwt);
    expect(ok.status).toBe(202);
    const okJob = await waitJob(ok.json['jobId'] as string, adminJwt);
    expect(okJob['status'], JSON.stringify(okJob['error'])).toBe('succeeded');
    expect((okJob['result'] as { testRestore: { passed: boolean } }).testRestore.passed).toBe(true);
    // An admin of another company only: refused once the source is known.
    const other = await call('POST', '/api/v1/tenants', { name: `TR Other ${stamp}`, businessType: 'default' });
    tenantsToClean.push(other.json['id'] as string);
    otherAdminJwt = sign(await makeUser('admin', other.json['id'] as string));
    const no = await call('POST', '/api/v1/tenant-archives/test-restore', { path: archivePath, passphrase: PASS }, otherAdminJwt);
    expect(no.status).toBe(202);
    const noJob = await waitJob(no.json['jobId'] as string, otherAdminJwt);
    expect(noJob['status']).toBe('failed');
    expect((noJob['error'] as { code: string }).code).toBe('TENANT_OWNER_REQUIRED');
    // Nobody's admin: refused before any byte is read.
    const [plain] = await q<{ id: string }>(`INSERT INTO users (tenant_id, email, password_hash, display_name, role, is_super_admin)
      VALUES ($1, $2, 'x', 'Plain', 'readonly', false) RETURNING id`, [workspaceId, `tr-plain-${stamp}@example.test`]);
    extraUsers.push(plain!.id);
    const refused = await call('POST', '/api/v1/tenant-archives/test-restore', { path: archivePath, passphrase: PASS }, sign(plain!.id));
    expect(refused.status).toBe(403);
  }, 300_000);
});

describe('change feed horizon during a test restore (Q-P34u)', () => {
  it('names match between the import and the feed', async () => {
    const feed = await import('../services/change-feed.service.js');
    expect(imp.TEST_RESTORE_APPLICATION_NAME).toBe(feed.FEED_SKIPPED_APPLICATION_NAME);
  });

  it('a real import holds the horizon and never runs under the skipped name', async () => {
    const archive = firstBackup;
    expect(archive).toBeTruthy();
    const feed = await import('../services/change-feed.service.js');
    let seen: { xid: string; horizon: string; app: string } | null = null;
    imp._importTestHooks.beforeVerify = async ({ client }) => {
      const r = await client.query(`SELECT pg_current_xact_id()::text AS x, current_setting('application_name') AS a`);
      const row = r.rows[0] as { x: string; a: string };
      seen = { xid: row.x, app: row.a, horizon: await feed.feedHorizon() };
    };
    let tenantId = '';
    try {
      // A non-test import of the first backup made in this file (owner = super admin).
      const t = await call('POST', '/api/v1/tenant-archives/import', { path: archive, passphrase: PASS, name: `TR Real ${stamp}` });
      const job = await waitJob(t.json['jobId'] as string);
      if (job['status'] === 'succeeded') tenantId = (job['result'] as { tenantId: string }).tenantId;
      expect(job['status'], JSON.stringify(job['error'])).toBe('succeeded');
    } finally {
      delete imp._importTestHooks.beforeVerify;
      if (tenantId) tenantsToClean.push(tenantId);
    }
    expect(seen).not.toBeNull();
    const s = seen as unknown as { xid: string; horizon: string; app: string };
    expect(s.app).not.toBe(imp.TEST_RESTORE_APPLICATION_NAME);
    // The open import transaction is at or above the horizon: workstations wait for it.
    expect(BigInt(s.horizon) <= BigInt(s.xid)).toBe(true);
  }, 300_000);

  it('a test restore does not hold the horizon, and only that backend is skipped', async () => {
    const feed = await import('../services/change-feed.service.js');
    const { withArchiveConnection } = await import('../services/tenant-portability/session.js');
    // Two writing transactions side by side: one plain, one named as a test restore.
    await withArchiveConnection(async (plain) => {
      await withArchiveConnection(async (named) => {
        await named.query('BEGIN');
        await named.query(`SET LOCAL application_name = '${imp.TEST_RESTORE_APPLICATION_NAME}'`);
        const nx = ((await named.query('SELECT pg_current_xact_id()::text AS x')).rows[0] as { x: string }).x;
        try {
          // A later transaction completes (autocommit), so the snapshot's xmax passes the named one.
          await plain.query('SELECT pg_current_xact_id()');
          const h1 = await feed.feedHorizon();
          // The named transaction is not what holds the horizon.
          expect(h1).not.toBe(nx);
          const blocking = await dbm.db.execute((await import('drizzle-orm')).sql`
            SELECT count(*)::int AS n FROM pg_snapshot_xip(pg_current_snapshot()) x
            WHERE x < ${nx}::xid8 AND xid(x) <> ALL (ARRAY(SELECT backend_xid FROM pg_stat_activity
              WHERE application_name = ${imp.TEST_RESTORE_APPLICATION_NAME} AND backend_xid IS NOT NULL))`);
          if ((blocking.rows[0] as { n: number }).n === 0) expect(BigInt(h1) > BigInt(nx)).toBe(true);

          await plain.query('BEGIN');
          const px = ((await plain.query('SELECT pg_current_xact_id()::text AS x')).rows[0] as { x: string }).x;
          try {
            // A plain open transaction still holds it.
            expect(BigInt(await feed.feedHorizon()) <= BigInt(px)).toBe(true);
          } finally {
            await plain.query('ROLLBACK');
          }
        } finally {
          await named.query('ROLLBACK');
        }
        // SET LOCAL ends with the transaction: the backend is no longer skipped.
        const app = ((await named.query(`SELECT current_setting('application_name') AS a`)).rows[0] as { a: string }).a;
        expect(app).not.toBe(imp.TEST_RESTORE_APPLICATION_NAME);
      });
    });
  }, 60_000);
});
