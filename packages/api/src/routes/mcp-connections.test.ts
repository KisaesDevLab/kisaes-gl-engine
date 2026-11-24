// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Agent principals (U-297, agent-principal-v1, ClientLedger A11) in desktop
// mode: a signed-in Admin mints an AI connection (agent user + API key in one
// transaction); the agent's role is read live on every request (T12), a
// permission template applies to it; an owner-role agent never passes the
// Q-332 powers; agents never sign in; their audit rows carry origin (T11);
// revocation ends the key at once.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';

const TOKEN = 'agentprin_' + 'a'.repeat(40);
let dataDir = '';
let app: Express;
let server: http.Server;
let port = 0;
let workspaceId = '';
let ownerId = '';
let tenantId = '';
let companyId = '';
let ownerJwt = '';
let viewerJwt = '';
let jwtSecret = '';
const users: string[] = [];
const stamp = crypto.randomUUID().slice(0, 8);

type Db = typeof import('../db/index.js');
let dbm: Db;

type Res = { status: number; json: Record<string, any> };

async function call(method: string, p: string, body?: unknown, auth: { jwt?: string; key?: string } = { jwt: ownerJwt }): Promise<Res> {
  const headers: Record<string, string> = { 'x-cl-token': TOKEN, 'x-company-id': companyId };
  if (auth.key) headers['x-api-key'] = auth.key;
  else if (auth.jwt) headers['authorization'] = `Bearer ${auth.jwt}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const ct = r.headers.get('content-type') ?? '';
  return { status: r.status, json: ct.includes('application/json') ? (await r.json()) as Record<string, any> : {} };
}
const code = (r: Res): string | undefined => r.json['error']?.code ?? r.json['code'];

async function q<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const { sql } = await import('drizzle-orm');
  const chunks = text.split(/\$(\d+)/);
  let query = sql.raw(chunks[0]!);
  for (let i = 1; i < chunks.length; i += 2) query = sql`${query}${params[Number(chunks[i]) - 1]}${sql.raw(chunks[i + 1]!)}`;
  return (await dbm.db.execute(query)).rows as T[];
}

async function mint(body: Record<string, unknown>): Promise<{ id: string; key: string }> {
  const r = await call('POST', '/api/v1/mcp-connections', body);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  users.push(r.json['connection'].id);
  return { id: r.json['connection'].id, key: r.json['apiKey'] };
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-agent-'));
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
  const created = await ws.createWorkspaceWithOwner({ email: `agent-owner-${stamp}@example.test`, displayName: 'Owner', password: 'owner password 1234' });
  workspaceId = created.workspaceTenantId;
  ownerId = created.userId;
  const { env } = await import('../config/env.js');
  jwtSecret = env.JWT_SECRET;
  const wsJwt = jwt.sign({ userId: ownerId, tenantId: workspaceId, role: 'owner', isSuperAdmin: true }, jwtSecret, { expiresIn: '30m' });
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/tenants`, {
    method: 'POST', headers: { 'x-cl-token': TOKEN, authorization: `Bearer ${wsJwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: `Agent Co ${stamp}`, businessType: 'default' }),
  });
  expect(r.status).toBe(201);
  tenantId = ((await r.json()) as { id: string }).id;
  companyId = (await q<{ id: string }>('SELECT id FROM companies WHERE tenant_id = $1 LIMIT 1', [tenantId]))[0]!.id;
  ownerJwt = jwt.sign({ userId: ownerId, tenantId, role: 'owner', isSuperAdmin: true }, jwtSecret, { expiresIn: '30m' });
  const [viewer] = await q<{ id: string }>(`INSERT INTO users (tenant_id, email, password_hash, display_name, role, is_super_admin)
    VALUES ($1, $2, 'x', 'Viewer', 'readonly', false) RETURNING id`, [workspaceId, `agent-ro-${stamp}@example.test`]);
  users.push(viewer!.id);
  await q(`INSERT INTO user_tenant_access (user_id, tenant_id, role) VALUES ($1, $2, 'readonly')`, [viewer!.id, tenantId]);
  viewerJwt = jwt.sign({ userId: viewer!.id, tenantId, role: 'readonly', isSuperAdmin: false }, jwtSecret, { expiresIn: '30m' });
}, 300_000);

afterAll(async () => {
  server?.closeAllConnections();
  if (!dbm) return;
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  const { sql } = await import('drizzle-orm');
  const { buildPortabilityPlan, scopeSql } = await import('../services/tenant-portability/plan.js');
  const plan = await buildPortabilityPlan(dbm.db);
  if (tenantId) {
    await dbm.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      for (const t of [...plan.scoped].reverse()) {
        const where = scopeSql(plan, t, 'a').replace('$1', `'${tenantId}'::uuid`);
        await tx.execute(sql.raw(`DELETE FROM "${t}" a WHERE ${where}`));
      }
      await tx.execute(sql`DELETE FROM api_keys WHERE tenant_id = ${tenantId}`);
      await tx.execute(sql`DELETE FROM user_tenant_access WHERE tenant_id = ${tenantId}`);
      await tx.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
    }).catch(() => undefined);
  }
  for (const u of [...users, ownerId]) {
    await dbm.db.execute(sql`DELETE FROM api_keys WHERE user_id = ${u}`);
    await dbm.db.execute(sql`DELETE FROM sessions WHERE user_id = ${u}`);
    await dbm.db.execute(sql`DELETE FROM user_permissions WHERE user_id = ${u}`);
    await dbm.db.execute(sql`DELETE FROM user_tenant_access WHERE user_id = ${u}`);
  }
  await dbm.db.execute(sql`DELETE FROM audit_log WHERE tenant_id = ${workspaceId}`);
  await dbm.db.execute(sql`DELETE FROM users WHERE tenant_id = ${workspaceId}`);
  await dbm.db.execute(sql`DELETE FROM tenants WHERE id = ${workspaceId}`);
  (await import('../desktop/workspace.js'))._resetWorkspaceCacheForTests();
  (await import('../desktop/profile.js'))._resetDesktopProfileForTests();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('agent principals (U-297)', () => {
  let admin: { id: string; key: string };

  it('is advertised; a signed-in Admin mints the agent user and its key in one go', async () => {
    const info = await call('GET', '/api/v1/desktop/info');
    expect(info.json['capabilities']).toEqual(expect.arrayContaining(['agent-principal-v1']));

    const r = await call('POST', '/api/v1/mcp-connections', { name: 'Claude', role: 'owner' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json['apiKey']).toMatch(/^sk_live_[0-9a-f]{64}$/);
    expect(r.json['connection']).toMatchObject({ name: 'Claude', role: 'owner', templateId: null, isActive: true });
    admin = { id: r.json['connection'].id, key: r.json['apiKey'] };
    users.push(admin.id);

    const [u] = await q<{ user_type: string; tenant_id: string; is_super_admin: boolean; email: string }>(
      'SELECT user_type, tenant_id, is_super_admin, email FROM users WHERE id = $1', [admin.id]);
    expect(u).toMatchObject({ user_type: 'agent', tenant_id: workspaceId, is_super_admin: false });
    expect(u!.email).toMatch(/@agents\.invalid$/);
    const access = await q<{ tenant_id: string; role: string }>('SELECT tenant_id, role FROM user_tenant_access WHERE user_id = $1 ORDER BY role', [admin.id]);
    expect(access).toEqual(expect.arrayContaining([{ tenant_id: tenantId, role: 'owner' }, { tenant_id: workspaceId, role: 'readonly' }]));
    const [key] = await q<{ role: string; tenant_id: string }>('SELECT role, tenant_id FROM api_keys WHERE user_id = $1', [admin.id]);
    expect(key).toEqual({ role: 'readonly', tenant_id: tenantId });
    const audit = await q<{ entity_type: string; user_id: string; origin: string | null }>(
      `SELECT entity_type, user_id, origin FROM audit_log WHERE tenant_id = $1 AND entity_id = $2`, [tenantId, admin.id]);
    expect(audit).toEqual([{ entity_type: 'mcp_connection', user_id: ownerId, origin: null }]);

    const list = await call('GET', '/api/v1/mcp-connections');
    expect(list.json['connections']).toEqual([expect.objectContaining({ id: admin.id, role: 'owner', isActive: true })]);
    const team = await call('GET', '/api/v1/company/users');
    expect(team.json['users']).toEqual(expect.arrayContaining([expect.objectContaining({ id: admin.id, isAgent: true, userType: 'staff' })]));
  });

  it('only a signed-in human with team_management mints: never an API key, an agent or a viewer', async () => {
    const human = await call('POST', '/api/v1/api-keys', { name: 'human key', role: 'owner' });
    expect(human.status, JSON.stringify(human.json)).toBe(201);
    const byKey = await call('POST', '/api/v1/mcp-connections', { name: 'x', role: 'owner' }, { key: human.json['apiKey'] });
    expect([byKey.status, code(byKey)]).toEqual([403, 'SESSION_AUTH_REQUIRED']);
    const byAgent = await call('POST', '/api/v1/mcp-connections', { name: 'x', role: 'owner' }, { key: admin.key });
    expect([byAgent.status, code(byAgent)]).toEqual([403, 'SESSION_AUTH_REQUIRED']);
    const byViewer = await call('POST', '/api/v1/mcp-connections', { name: 'x', role: 'owner' }, { jwt: viewerJwt });
    expect(byViewer.status).toBe(403);
    const badTemplate = await call('POST', '/api/v1/mcp-connections', { name: 'x', role: 'owner', templateId: crypto.randomUUID() });
    expect([badTemplate.status, code(badTemplate)]).toEqual([400, 'AGENT_TEMPLATE_ROLE']);
    // The /api-keys router neither lists nor changes an agent's key.
    const keys = await call('GET', '/api/v1/api-keys');
    expect((keys.json['keys'] as Array<{ name: string }>).map((k) => k.name)).not.toContain('Claude');
    const [agentKey] = await q<{ id: string }>('SELECT id FROM api_keys WHERE user_id = $1', [admin.id]);
    const put = await call('PUT', `/api/v1/api-keys/${agentKey!.id}`, { isActive: false });
    expect(put.status).toBe(404);
    expect((await q<{ is_active: boolean }>('SELECT is_active FROM api_keys WHERE id = $1', [agentKey!.id]))[0]!.is_active).toBe(true);
  });

  it('an agent key works with owner book rights, and its audit rows carry origin mcp:<id> (T11)', async () => {
    const read = await call('GET', '/api/v1/accounts', undefined, { key: admin.key });
    expect(read.status, JSON.stringify(read.json)).toBe(200);
    const made = await call('POST', '/api/v1/contacts', { contactType: 'vendor', displayName: `Agent Vendor ${stamp}` }, { key: admin.key });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const human = await call('POST', '/api/v1/contacts', { contactType: 'vendor', displayName: `Human Vendor ${stamp}` });
    expect(human.status, JSON.stringify(human.json)).toBe(201);
    const rows = await q<{ entity_id: string; user_id: string; origin: string | null; action_id: string | null }>(
      `SELECT entity_id, user_id, origin, action_id FROM audit_log WHERE tenant_id = $1 AND entity_type = 'contact' AND entity_id IN ($2, $3)`,
      [tenantId, made.json['contact'].id, human.json['contact'].id]);
    expect(rows).toEqual(expect.arrayContaining([
      { entity_id: made.json['contact'].id, user_id: admin.id, origin: `mcp:${admin.id}`, action_id: null },
      { entity_id: human.json['contact'].id, user_id: ownerId, origin: null, action_id: null },
    ]));
    const audit = await call('GET', `/api/v1/audit-log?entity_id=${made.json['contact'].id}`);
    expect(audit.json['data'][0]).toMatchObject({ origin: `mcp:${admin.id}`, action_id: null });
  });

  it('an owner-role agent never passes the Q-332 powers', async () => {
    const asAgent = { key: admin.key };
    const invite = await call('POST', '/api/v1/company/invite-user', { email: `x-${stamp}@example.test`, displayName: 'X', role: 'owner' }, asAgent);
    expect([invite.status, code(invite)]).toEqual([403, 'OWNER_REQUIRED']);
    const role = await call('PATCH', `/api/v1/company/users/${ownerId}`, { role: 'readonly' }, asAgent);
    expect(role.status).toBe(403);
    const templates = await call('GET', '/api/v1/company/permission-templates', undefined, asAgent);
    expect(templates.status).toBe(403);
    const accounts = await call('GET', '/api/v1/accounts', undefined, asAgent);
    const acct = (accounts.json['data'] ?? accounts.json['accounts']) as Array<{ id: string }>;
    const sensitive = await call('PUT', `/api/v1/accounts/${acct[0]!.id}/sensitive`, { isSensitive: true }, asAgent);
    expect(sensitive.status).toBe(403);
    const lockDate = await call('PUT', '/api/v1/company/settings', { lockDate: '2026-01-31' }, asAgent);
    expect([lockDate.status, code(lockDate)]).toEqual([403, 'CLOSING_DATE_ADMIN_ONLY']);
    const pw = await call('PUT', '/api/v1/company/closing-password', { newPassword: 'agent closing pw 1' }, asAgent);
    expect([pw.status, code(pw)]).toEqual([403, 'CLOSING_PASSWORD_OWNER_REQUIRED']);
    await q(`INSERT INTO tenant_feature_flags (tenant_id, flag_key, enabled) VALUES ($1, 'TRIAL_BALANCE_V1', true)
      ON CONFLICT (tenant_id, flag_key) DO UPDATE SET enabled = true`, [tenantId]);
    const tb = await call('PUT', '/api/v1/tb/closing-date', { closingDate: '2026-01-31' }, asAgent);
    expect([tb.status, code(tb)]).toEqual([403, 'AGENT_NOT_ALLOWED']);
    const undo = await call('POST', `/api/v1/banking/reconciliations/${crypto.randomUUID()}/undo`, {}, asAgent);
    expect([undo.status, code(undo)]).toEqual([403, 'AGENT_NOT_ALLOWED']);
    const archive = await call('POST', `/api/v1/tenants/${tenantId}/archives`, { passphrase: 'x' }, asAgent);
    expect(archive.status).toBe(403);
    const del = await call('DELETE', `/api/v1/company/${companyId}`, undefined, asAgent);
    expect([del.status, code(del)]).toEqual([403, 'AGENT_NOT_ALLOWED']);
    const keys = await call('GET', '/api/v1/api-keys', undefined, asAgent);
    expect([keys.status, code(keys)]).toEqual([403, 'SESSION_AUTH_REQUIRED']);
    // Nothing above changed: no closing date, no password, no new user.
    const [co] = await q<{ lock_date: string | null; closing_password_hash: string | null }>(
      'SELECT lock_date, closing_password_hash FROM companies WHERE id = $1', [companyId]);
    expect(co).toEqual({ lock_date: null, closing_password_hash: null });
  });

  it('an owner-role agent is never counted as the last owner', async () => {
    const [h] = await q<{ id: string }>(`INSERT INTO users (tenant_id, email, password_hash, display_name, role, is_super_admin)
      VALUES ($1, $2, 'x', 'Human Owner', 'owner', false) RETURNING id`, [workspaceId, `agent-ho-${stamp}@example.test`]);
    users.push(h!.id);
    await q(`INSERT INTO user_tenant_access (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`, [h!.id, tenantId]);
    // The super-admin caller keeps team_management but is not an owner of this company.
    await q(`UPDATE user_tenant_access SET role = 'accountant' WHERE user_id = $1 AND tenant_id = $2`, [ownerId, tenantId]);
    try {
      const r = await call('PATCH', `/api/v1/company/users/${h!.id}`, { role: 'accountant' });
      expect([r.status, code(r)]).toEqual([400, 'CANNOT_DEMOTE_LAST_OWNER']);
    } finally {
      await q(`UPDATE user_tenant_access SET role = 'owner' WHERE user_id = $1 AND tenant_id = $2`, [ownerId, tenantId]);
    }
  });

  it('a role change in Team applies on the next request; the key role is never replayed (T12)', async () => {
    const before = await call('POST', '/api/v1/contacts', { contactType: 'vendor', displayName: `T12 a ${stamp}` }, { key: admin.key });
    expect(before.status).toBe(201);
    const demote = await call('PATCH', `/api/v1/company/users/${admin.id}`, { role: 'readonly' });
    expect(demote.status, JSON.stringify(demote.json)).toBe(200);
    const after = await call('POST', '/api/v1/contacts', { contactType: 'vendor', displayName: `T12 b ${stamp}` }, { key: admin.key });
    expect([after.status, code(after)]).toEqual([403, 'PERMISSION_DENIED']);
    expect((await call('GET', '/api/v1/contacts', undefined, { key: admin.key })).status).toBe(200);
    const promote = await call('PATCH', `/api/v1/company/users/${admin.id}`, { role: 'owner' });
    expect(promote.status).toBe(200);
    const again = await call('POST', '/api/v1/contacts', { contactType: 'vendor', displayName: `T12 c ${stamp}` }, { key: admin.key });
    expect(again.status).toBe(201);
  });

  it('a Payables-template agent key is refused POST /invoices, and a template change applies at once', async () => {
    const tpl = await call('POST', '/api/v1/company/permission-templates', {
      name: `Payables ${stamp}`, permissions: { bills: 'full', contacts: 'full', invoices: 'none' },
    });
    expect(tpl.status, JSON.stringify(tpl.json)).toBe(201);
    const templateId = (tpl.json['template'] ?? tpl.json)['id'] as string;
    const payables = await mint({ name: 'Payables helper', role: 'bookkeeper', templateId });
    const inv = await call('POST', '/api/v1/invoices', {}, { key: payables.key });
    expect([inv.status, code(inv)]).toEqual([403, 'PERMISSION_DENIED']);
    expect((await call('GET', '/api/v1/bills', undefined, { key: payables.key })).status).toBe(200);
    // The Admin grants invoices in the template: the next request passes the guard.
    const upd = await call('PUT', `/api/v1/company/permission-templates/${templateId}`, {
      permissions: { bills: 'full', contacts: 'full', invoices: 'full' },
    });
    expect(upd.status, JSON.stringify(upd.json)).toBe(200);
    const inv2 = await call('POST', '/api/v1/invoices', {}, { key: payables.key });
    expect(code(inv2)).not.toBe('PERMISSION_DENIED');
  });

  it('an agent never signs in, holds a session or gets a temporary password', async () => {
    const [u] = await q<{ email: string }>('SELECT email FROM users WHERE id = $1', [admin.id]);
    const login = await call('POST', '/api/v1/auth/login', { email: u!.email, password: 'anything at all 1' }, {});
    expect(login.status).toBe(401);
    const forged = jwt.sign({ userId: admin.id, tenantId, role: 'owner', isSuperAdmin: false }, jwtSecret, { expiresIn: '5m' });
    const viaJwt = await call('GET', '/api/v1/accounts', undefined, { jwt: forged });
    expect(viaJwt.status).toBe(401);
    const temp = await call('POST', `/api/v1/company/users/${admin.id}/temporary-password`);
    expect([temp.status, code(temp)]).toEqual([400, 'AGENT_USER']);
    expect((await q('SELECT 1 FROM sessions WHERE user_id = $1', [admin.id])).length).toBe(0);
  });

  it('removing the connection ends its key at once', async () => {
    const del = await call('DELETE', `/api/v1/mcp-connections/${admin.id}`);
    expect(del.status, JSON.stringify(del.json)).toBe(200);
    const after = await call('GET', '/api/v1/accounts', undefined, { key: admin.key });
    expect(after.status).toBe(401);
    const list = await call('GET', '/api/v1/mcp-connections');
    expect(list.json['connections']).toEqual(expect.arrayContaining([expect.objectContaining({ id: admin.id, isActive: false })]));
    expect((await call('DELETE', `/api/v1/mcp-connections/${admin.id}`)).status).toBe(200);
    expect((await call('DELETE', `/api/v1/mcp-connections/${ownerId}`)).status).toBe(404);
  });
});

describe('principal store (U-297)', () => {
  it('stamps action_id once a validated action is named, and leaves human rows alone', async () => {
    const pc = await import('../services/principal-context.js');
    const { auditLog } = await import('../middleware/audit.js');
    const entity = crypto.randomUUID();
    const action = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    const req = { principalKind: 'agent', userId: agentId } as unknown as import('express').Request;
    await new Promise<void>((resolve, reject) => {
      pc.runAsPrincipal(req, () => {
        pc.setPrincipalActionId(req, action);
        auditLog(tenantId, 'create', 'u297_probe', entity, null, { n: 1 }, agentId).then(resolve, reject);
      });
    });
    await auditLog(tenantId, 'update', 'u297_probe', entity, null, { n: 2 }, ownerId);
    const rows = await q<{ action: string; origin: string | null; action_id: string | null }>(
      `SELECT action, origin, action_id FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 ORDER BY id`, [tenantId, entity]);
    expect(rows).toEqual([
      { action: 'create', origin: `mcp:${agentId}`, action_id: action },
      { action: 'update', origin: null, action_id: null },
    ]);
    expect(() => pc.setPrincipalActionId({} as import('express').Request, action)).toThrow();
    expect(() => pc.refuseAgentPrincipal(req, {} as import('express').Response, () => undefined)).toThrow(/AI connection/);
  });
});
