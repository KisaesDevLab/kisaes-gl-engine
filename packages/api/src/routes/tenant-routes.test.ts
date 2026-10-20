// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Lifecycle and archive routes in desktop mode (U-05 step 36a): list,
// create, rename (STALE), export job, download, path and upload import,
// workspace refusals, owner checks, scratch refusals, job lookup.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';

const TOKEN = 'tenantroutes_' + 'r'.repeat(40);
let dataDir = '';
let app: Express;
let server: http.Server;
let port = 0;
let ownerJwt = '';
let readonlyJwt = '';
let workspaceId = '';
let ownerId = '';
let readonlyId = '';
const stamp = crypto.randomUUID().slice(0, 8);
const PASS = 'routes passphrase strong 2026';
const tenantsToClean: string[] = [];

type Db = typeof import('../db/index.js');
let dbm: Db;

async function call(method: string, p: string, body?: unknown, token = ownerJwt, raw?: { form?: FormData }): Promise<{ status: number; json: Record<string, unknown>; headers: Headers; bytes?: Buffer }> {
  const headers: Record<string, string> = { 'x-cl-token': TOKEN, authorization: `Bearer ${token}` };
  let payload: RequestInit['body'];
  if (raw?.form) payload = raw.form;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: payload });
  const ct = r.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return { status: r.status, json: (await r.json()) as Record<string, unknown>, headers: r.headers };
  return { status: r.status, json: {}, headers: r.headers, bytes: Buffer.from(await r.arrayBuffer()) };
}

type Listed = { id: string; name: string; role: string };
/** The listed companies created by this file (the test database is shared, and the owner is a super admin who sees every company, Q-244). */
function mine(list: Record<string, unknown>): Listed[] {
  return (list as unknown as Listed[]).filter((t) => t.name.includes(stamp));
}

async function waitJob(jobId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 2400; i++) {
    const r = await call('GET', `/api/v1/tenant-archives/jobs/${jobId}`);
    expect(r.status).toBe(200);
    if (r.json['status'] === 'succeeded' || r.json['status'] === 'failed') return r.json;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('job timeout');
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-tenant-routes-'));
  // bootstrap.ts loads the profile over process.env; here the profile gets its
  // own object, so the archive dir the services read must be set explicitly.
  process.env['CL_ARCHIVE_DIR'] = path.join(dataDir, 'archives');
  vi.resetModules();
  const profile = await import('../desktop/profile.js');
  profile.loadDesktopProfile({ CL_MODE: 'desktop', CL_TOKEN: TOKEN, CL_BIND: '127.0.0.1:0', CL_DATA_DIR: dataDir });
  ({ app } = await import('../app.js'));
  dbm = await import('../db/index.js');
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  const { setDesktopBoundAddress } = await import('../middleware/desktop-gate.js');
  setDesktopBoundAddress('127.0.0.1', port);
  const ws = await import('../desktop/workspace.js');
  ws._resetWorkspaceCacheForTests();
  const created = await ws.createWorkspaceWithOwner({ email: `routes-owner-${stamp}@example.test`, displayName: 'Owner', password: 'owner password 1234' });
  workspaceId = created.workspaceTenantId;
  ownerId = created.userId;
  tenantsToClean.push(workspaceId);
  const { sql } = await import('drizzle-orm');
  const [ro] = (await dbm.db.execute(sql`
    INSERT INTO users (tenant_id, email, password_hash, display_name, role, is_super_admin)
    VALUES (${workspaceId}, ${`routes-ro-${stamp}@example.test`}, 'x', 'RO', 'readonly', false) RETURNING id`)).rows as Array<{ id: string }>;
  readonlyId = ro!.id;
  await dbm.db.execute(sql`INSERT INTO user_tenant_access (user_id, tenant_id, role) VALUES (${readonlyId}, ${workspaceId}, 'readonly')`);
  const { env } = await import('../config/env.js');
  ownerJwt = jwt.sign({ userId: ownerId, tenantId: workspaceId, role: 'owner', isSuperAdmin: true }, env.JWT_SECRET, { expiresIn: '30m' });
  readonlyJwt = jwt.sign({ userId: readonlyId, tenantId: workspaceId, role: 'readonly', isSuperAdmin: false }, env.JWT_SECRET, { expiresIn: '30m' });
}, 120_000);

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  const { sql } = await import('drizzle-orm');
  const { buildPortabilityPlan, scopeSql } = await import('../services/tenant-portability/plan.js');
  const plan = await buildPortabilityPlan(dbm.db);
  for (const id of tenantsToClean.filter((t) => t !== workspaceId)) {
    for (const t of [...plan.scoped].reverse()) {
      const where = scopeSql(plan, t, 'a').replace('$1', `'${id}'::uuid`);
      await dbm.db.execute(sql.raw(`DELETE FROM "${t}" a WHERE ${where}`)).catch(() => undefined);
    }
    await dbm.db.execute(sql`DELETE FROM tenant_archive_imports WHERE tenant_id = ${id}`);
    await dbm.db.execute(sql`DELETE FROM user_tenant_access WHERE tenant_id = ${id}`);
    await dbm.db.execute(sql`DELETE FROM tenants WHERE id = ${id}`);
  }
  await dbm.db.execute(sql`DELETE FROM sessions WHERE user_id IN (${ownerId}, ${readonlyId})`);
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

describe('lifecycle routes', () => {
  let companyId = '';
  let updatedAt = '';
  let archivePath = '';
  let fileName = '';
  let archiveId = '';

  it('advertises the tenant capabilities on /desktop/info', async () => {
    const info = await call('GET', '/api/v1/desktop/info');
    expect(info.status).toBe(200);
    expect(info.json['capabilities']).toEqual(['tenants-list-v1', 'tenant-archive-v1']);
    expect(info.json['workspaceTenantId']).toBe(workspaceId);
  });

  it('creates and lists companies from the workspace session, never the workspace itself', async () => {
    const before = await call('GET', '/api/v1/tenants');
    expect(before.status).toBe(200);
    expect(Array.isArray(before.json)).toBe(true);
    expect(mine(before.json)).toEqual([]);
    const created = await call('POST', '/api/v1/tenants', { name: `Routes Co ${stamp}`, businessType: 'default' });
    expect(created.status).toBe(201);
    companyId = created.json['id'] as string;
    tenantsToClean.push(companyId);
    const list = await call('GET', '/api/v1/tenants');
    expect(mine(list.json)).toEqual([{ id: companyId, name: `Routes Co ${stamp}`, role: 'owner', createdAt: expect.any(String), updatedAt: expect.any(String) }]);
    updatedAt = (mine(list.json)[0] as unknown as { updatedAt: string }).updatedAt;
    expect((list.json as unknown as Array<{ id: string }>).some((t) => t.id === workspaceId)).toBe(false);
    // Zero firm rows on desktop (F15).
    const { sql } = await import('drizzle-orm');
    const firms = await dbm.db.execute(sql`SELECT count(*)::int AS n FROM tenant_firm_assignments WHERE tenant_id = ${companyId}`);
    expect((firms.rows[0] as { n: number }).n).toBe(0);
  }, 60_000);

  it('seeds only the system accounts when systemAccountsOnly is set', async () => {
    const created = await call('POST', '/api/v1/tenants', { name: `Routes Sys ${stamp}`, systemAccountsOnly: true });
    expect(created.status).toBe(201);
    tenantsToClean.push(created.json['id'] as string);
    const { sql } = await import('drizzle-orm');
    const count = async (id: string) => Number(((await dbm.db.execute(sql`SELECT count(*)::int AS n FROM accounts WHERE tenant_id = ${id}`)).rows[0] as { n: number }).n);
    const full = await count(companyId);
    const system = await count(created.json['id'] as string);
    expect(system).toBeGreaterThan(0);
    expect(system).toBeLessThan(full);
    const only = await dbm.db.execute(sql`SELECT count(*)::int AS n FROM accounts WHERE tenant_id = ${created.json['id'] as string} AND is_system = false`);
    expect((only.rows[0] as { n: number }).n).toBe(0);
  }, 60_000);

  it('renames with an expectedUpdatedAt check and refuses the workspace', async () => {
    const stale = await call('PATCH', `/api/v1/tenants/${companyId}`, { name: 'Nope', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' });
    expect(stale.status).toBe(409);
    expect((stale.json['error'] as { code: string }).code).toBe('STALE');
    const ok = await call('PATCH', `/api/v1/tenants/${companyId}`, { name: `Routes Co renamed ${stamp}`, expectedUpdatedAt: updatedAt });
    expect(ok.status).toBe(200);
    expect(ok.json['name']).toBe(`Routes Co renamed ${stamp}`);
    expect(ok.json['updatedAt']).not.toBe(updatedAt);
    const ws = await call('PATCH', `/api/v1/tenants/${workspaceId}`, { name: 'W', expectedUpdatedAt: updatedAt });
    expect(ws.status).toBe(409);
    expect((ws.json['error'] as { code: string }).code).toBe('WORKSPACE_TENANT');
    const ro = await call('PATCH', `/api/v1/tenants/${companyId}`, { name: 'X', expectedUpdatedAt: updatedAt }, readonlyJwt);
    expect(ro.status).toBe(403);
    const missing = await call('PATCH', `/api/v1/tenants/${crypto.randomUUID()}`, { name: 'X', expectedUpdatedAt: updatedAt });
    expect(missing.status).toBe(404);
  });

  it('exports through a job, refuses weak passphrases, the workspace and non-owners, and downloads the file', async () => {
    const weak = await call('POST', `/api/v1/tenants/${companyId}/archives`, { passphrase: 'short' });
    expect(weak.status).toBe(400);
    expect((weak.json['error'] as { code: string }).code).toBe('PASSPHRASE_TOO_WEAK');
    const ws = await call('POST', `/api/v1/tenants/${workspaceId}/archives`, { passphrase: PASS });
    expect(ws.status).toBe(409);
    expect((ws.json['error'] as { code: string }).code).toBe('WORKSPACE_TENANT');
    const ro = await call('POST', `/api/v1/tenants/${companyId}/archives`, { passphrase: PASS }, readonlyJwt);
    expect(ro.status).toBe(403);
    const big = await call('POST', `/api/v1/tenants/${companyId}/archives`, { passphrase: PASS, host: { pad: 'x'.repeat(17 * 1024) } });
    expect(big.status).toBe(400);
    const started = await call('POST', `/api/v1/tenants/${companyId}/archives`, { passphrase: PASS, host: { app: 'ClientLedger', kind: 'backup' } });
    expect(started.status).toBe(202);
    archiveId = started.json['archiveId'] as string;
    const job = await waitJob(started.json['jobId'] as string);
    expect(job['status']).toBe('succeeded');
    const result = job['result'] as Record<string, unknown>;
    expect(result['archiveId']).toBe(archiveId);
    expect(result['path']).toMatch(new RegExp(`${archiveId}\\.zip$`));
    // Every user's hash travels (Q-234): no warning about password hashes.
    expect(result['warnings']).toEqual([]);
    archivePath = result['path'] as string;
    fileName = result['fileName'] as string;
    expect(path.resolve(archivePath).startsWith(path.resolve(process.env['CL_ARCHIVE_DIR']!))).toBe(true);
    // The readonly user cannot read someone else's job or download the file.
    const other = await call('GET', `/api/v1/tenant-archives/jobs/${started.json['jobId']}`, undefined, readonlyJwt);
    expect(other.status).toBe(404);
    const roDl = await call('GET', `/api/v1/tenant-archives/${fileName}/download`, undefined, readonlyJwt);
    expect(roDl.status).toBe(403);
    const dl = await call('GET', `/api/v1/tenant-archives/${fileName}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('application/zip');
    expect(dl.bytes!.equals(fs.readFileSync(archivePath))).toBe(true);
    // M4: a client that goes away mid-download leaves no open stream or hanging response behind; the next download works.
    await new Promise<void>((resolve) => {
      const aborted = http.get({ host: '127.0.0.1', port, path: `/api/v1/tenant-archives/${fileName}/download`, headers: { 'x-cl-token': TOKEN, authorization: `Bearer ${ownerJwt}` } }, (res) => {
        res.once('data', () => { aborted.destroy(); resolve(); });
      });
      aborted.on('error', () => resolve());
    });
    const again = await call('GET', `/api/v1/tenant-archives/${fileName}/download`);
    expect(again.status).toBe(200);
    expect(again.bytes!.equals(fs.readFileSync(archivePath))).toBe(true);
    expect((await call('GET', `/api/v1/tenant-archives/${crypto.randomUUID()}.zip/download`)).status).toBe(404);
    // An encoded separator never matches a file; the workspace fence refuses it first (409), a company session gets 404.
    expect([404, 409]).toContain((await call('GET', `/api/v1/tenant-archives/..%2Fx.zip/download`)).status);
    const unknown = await call('GET', `/api/v1/tenant-archives/jobs/${crypto.randomUUID()}`);
    expect(unknown.status).toBe(404);
    expect((unknown.json['error'] as { code: string }).code).toBe('JOB_UNKNOWN');
  }, 180_000);

  it('imports by path (desktop, no LAN) and by upload; scratch is not available yet', async () => {
    // H1: on desktop only a super admin imports, by path or by upload, and a
    // refused upload never reaches the imports directory.
    const roPath = await call('POST', '/api/v1/tenant-archives/import', { path: archivePath, passphrase: PASS }, readonlyJwt);
    expect(roPath.status).toBe(403);
    expect((roPath.json['error'] as { code: string }).code).toBe('SUPER_ADMIN_REQUIRED');
    const roForm = new FormData();
    roForm.append('passphrase', PASS);
    roForm.append('file', new Blob([fs.readFileSync(archivePath)]), 'copy.clbackup');
    const roUpload = await call('POST', '/api/v1/tenant-archives/import', undefined, readonlyJwt, { form: roForm });
    expect(roUpload.status).toBe(403);
    const importsDir = path.join(process.env['CL_ARCHIVE_DIR']!, 'imports');
    expect(fs.existsSync(importsDir) ? fs.readdirSync(importsDir) : []).toEqual([]);

    const scratch = await call('POST', '/api/v1/tenant-archives/import', { path: archivePath, passphrase: PASS, scratch: true });
    expect(scratch.status).toBe(400);
    expect((scratch.json['error'] as { code: string }).code).toBe('SCRATCH_NOT_AVAILABLE');
    const neither = await call('POST', '/api/v1/tenant-archives/import', { passphrase: PASS });
    expect(neither.status).toBe(400);
    const relative = await call('POST', '/api/v1/tenant-archives/import', { path: 'relative.zip', passphrase: PASS });
    expect(relative.status).toBe(400);
    const dir = await call('POST', '/api/v1/tenant-archives/import', { path: path.dirname(archivePath), passphrase: PASS });
    expect(dir.status).toBe(400);
    expect((dir.json['error'] as { code: string }).code).toBe('FILE_NOT_FOUND');
    expect(JSON.stringify(dir.json)).not.toContain(PASS);
    const unc = await call('POST', '/api/v1/tenant-archives/import', { path: '\\\\server\\share\\backup.zip', passphrase: PASS });
    expect(unc.status).toBe(400);
    expect((unc.json['error'] as { code: string }).code).toBe('VALIDATION_ERROR');
    const shortPass = await call('POST', '/api/v1/tenant-archives/import', { path: archivePath, passphrase: 'short' });
    expect(shortPass.status).toBe(400);
    expect(JSON.stringify(shortPass.json)).not.toContain('short"');

    const byPath = await call('POST', '/api/v1/tenant-archives/import', { path: archivePath, passphrase: PASS, name: `Restored by path ${stamp}` });
    expect(byPath.status).toBe(202);
    const job = await waitJob(byPath.json['jobId'] as string);
    expect(job['status']).toBe('succeeded');
    const result = job['result'] as Record<string, unknown>;
    tenantsToClean.push(result['tenantId'] as string);
    expect(result['name']).toBe(`Restored by path ${stamp}`);
    expect((result['verification'] as Record<string, unknown>)['contentEqual']).toBe(true);
    expect(result['host']).toEqual({ app: 'ClientLedger', kind: 'backup' });
    expect(fs.existsSync(archivePath)).toBe(true); // a path import never consumes the file

    const wrong = await call('POST', '/api/v1/tenant-archives/import', { path: archivePath, passphrase: 'wrong passphrase 123' });
    expect(wrong.status).toBe(202);
    const failed = await waitJob(wrong.json['jobId'] as string);
    expect(failed['status']).toBe('failed');
    expect((failed['error'] as { code: string }).code).toBe('ARCHIVE_PASSPHRASE_INVALID');
    // M3: after the limit of wrong passphrases the user waits (429), before any key derivation; a right one clears it.
    const limiter = await import('../services/tenant-portability/passphrase-limiter.js');
    limiter._configurePassphraseLimiterForTests({ maxFailures: 2 });
    try {
      const wrong2 = await call('POST', '/api/v1/tenant-archives/import', { path: archivePath, passphrase: 'wrong passphrase 456' });
      expect((await waitJob(wrong2.json['jobId'] as string))['status']).toBe('failed');
      const limited = await call('POST', '/api/v1/tenant-archives/import', { path: archivePath, passphrase: 'wrong passphrase 789' });
      expect(limited.status).toBe(429);
      expect((limited.json['error'] as { code: string }).code).toBe('PASSPHRASE_RATE_LIMITED');
      expect(JSON.stringify(limited.json)).not.toContain('wrong passphrase 789');
    } finally {
      limiter._resetPassphraseLimiterForTests();
    }

    // A renamed .clbackup imports byte-for-byte, uploaded as multipart.
    const clbackup = path.join(dataDir, 'copy.clbackup');
    fs.copyFileSync(archivePath, clbackup);
    const form = new FormData();
    form.append('passphrase', PASS);
    form.append('name', `Restored by upload ${stamp}`);
    form.append('file', new Blob([fs.readFileSync(clbackup)]), 'copy.clbackup');
    const byUpload = await call('POST', '/api/v1/tenant-archives/import', undefined, ownerJwt, { form });
    expect(byUpload.status).toBe(202);
    const job2 = await waitJob(byUpload.json['jobId'] as string);
    expect(job2['status']).toBe('succeeded');
    tenantsToClean.push((job2['result'] as Record<string, unknown>)['tenantId'] as string);
    expect(fs.readdirSync(path.join(process.env['CL_ARCHIVE_DIR']!, 'imports'))).toEqual([]); // the upload is removed after the job

    const list = await call('GET', '/api/v1/tenants');
    expect(mine(list.json).map((t) => t.name).sort()).toEqual([
      `Restored by path ${stamp}`, `Restored by upload ${stamp}`, `Routes Co renamed ${stamp}`, `Routes Sys ${stamp}`,
    ]);
  }, 300_000);

  it('the owner (super admin) sees every company, access row or not; other users see only their own (Q-244)', async () => {
    const { sql } = await import('drizzle-orm');
    const orphanId = crypto.randomUUID();
    await dbm.db.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${orphanId}, ${`Routes Orphan ${stamp}`}, ${`orphan-${stamp}`})`);
    tenantsToClean.push(orphanId);
    // No access row for anyone: the owner still sees it, as 'owner' (the role switch-tenant issues there), and can open it.
    const ownerList = await call('GET', '/api/v1/tenants');
    expect(mine(ownerList.json).find((t) => t.id === orphanId)).toMatchObject({ name: `Routes Orphan ${stamp}`, role: 'owner' });
    const sw = await call('POST', '/api/v1/auth/switch-tenant', { tenantId: orphanId });
    expect(sw.status).toBe(200);
    // The readonly user sees nothing until given a row, then exactly that company with its role.
    const roBefore = await call('GET', '/api/v1/tenants', undefined, readonlyJwt);
    expect(roBefore.status).toBe(200);
    expect(roBefore.json).toEqual([]);
    await dbm.db.execute(sql`INSERT INTO user_tenant_access (user_id, tenant_id, role) VALUES (${readonlyId}, ${companyId}, 'bookkeeper')`);
    const roAfter = await call('GET', '/api/v1/tenants', undefined, readonlyJwt);
    expect((roAfter.json as unknown as Listed[]).map((t) => ({ id: t.id, role: t.role }))).toEqual([{ id: companyId, role: 'bookkeeper' }]);
    // An inactive row hides the company again.
    await dbm.db.execute(sql`UPDATE user_tenant_access SET is_active = false WHERE user_id = ${readonlyId} AND tenant_id = ${companyId}`);
    expect((await call('GET', '/api/v1/tenants', undefined, readonlyJwt)).json).toEqual([]);
    await dbm.db.execute(sql`DELETE FROM user_tenant_access WHERE user_id = ${readonlyId} AND tenant_id = ${companyId}`);
    // A super admin flag in an old token is not enough: the caller's own row decides.
    const forged = jwt.sign({ userId: readonlyId, tenantId: workspaceId, role: 'readonly', isSuperAdmin: true }, (await import('../config/env.js')).env.JWT_SECRET, { expiresIn: '30m' });
    const forgedList = await call('GET', '/api/v1/tenants', undefined, forged);
    expect(forgedList.status).toBe(200);
    expect(forgedList.json).toEqual([]);
  }, 60_000);

  it('a scratch tenant is never listed and cannot be switched into, even by the owner (N4)', async () => {
    const { sql } = await import('drizzle-orm');
    const scratchId = crypto.randomUUID();
    await dbm.db.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${scratchId}, 'Scratch', ${`scratch-${stamp}`})`);
    tenantsToClean.push(scratchId);
    await dbm.db.execute(sql`INSERT INTO user_tenant_access (user_id, tenant_id, role) VALUES (${ownerId}, ${scratchId}, 'owner')`);
    await dbm.db.execute(sql`INSERT INTO tenant_archive_imports (tenant_id, scratch, archive_id, archive_sha256, fingerprint) VALUES (${scratchId}, true, ${crypto.randomUUID()}, 'ab', '{}'::jsonb)`);
    const list = await call('GET', '/api/v1/tenants');
    expect((list.json as unknown as Array<{ id: string }>).some((t) => t.id === scratchId)).toBe(false);
    const sw = await call('POST', '/api/v1/auth/switch-tenant', { tenantId: scratchId });
    expect(sw.status).toBe(403);
    expect((sw.json['error'] as { code: string }).code).toBe('SCRATCH_TENANT');
    const ok = await call('POST', '/api/v1/auth/switch-tenant', { tenantId: companyId });
    expect(ok.status).toBe(200);
  }, 60_000);
});
