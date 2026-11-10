// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Saved report definitions (U-118, report-defs-v1; ClientLedger P28 PR-F):
//   - CRUD of definitions and groups; audit rows; soft delete;
//   - 409 STALE_VERSION {current} on PUT / DELETE with an old version;
//   - Q-310: anyone with report access saves and sees every saved report;
//     only the author, an owner or a super admin changes or deletes one
//     (403 NOT_AUTHOR), also for an Idempotency-Key replay;
//   - 409 NAME_TAKEN per company, case-insensitive, free again after delete;
//   - 400 DEFINITION_INVALID (shape, uuid outside the id paths, an id of
//     another company), 413 DEFINITION_TOO_LARGE;
//   - another company's or tenant's report is 404 and left out of lists;
//   - deleting a group moves its reports to no group with new versions;
//   - Idempotency-Key replays a POST.

import 'express-async-errors';
import crypto from 'node:crypto';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, auditLog, reportDefinitions, userPermissions, users, userTenantAccess } from '../db/schema/index.js';
import { reportBuilderRouter } from './report-builder.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import { makeCompany, cleanTenant, suffix, type Co } from '../services/templates/templates.test-helpers.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { DESKTOP_KEPT } from '../desktop/features.js';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
let c: Co;

interface Res { status: number; json: ReturnType<typeof JSON.parse> }

function call(method: string, path: string, token: string, body?: unknown, opts: { co?: string; key?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: `/api/v1/report-builder${path}`, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Company-Id': opts.co ?? c.companyId,
        ...(opts.key ? { 'Idempotency-Key': opts.key } : {}),
        ...(data ? { 'Content-Length': String(data.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (x) => chunks.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); } catch { resolve({ status: res.statusCode ?? 0, json: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const def = (options: Record<string, unknown> = {}, reportKey = 'profit_and_loss') => ({ schemaVersion: 1, kind: 'standard', reportKey, options });
const create = (body: unknown, token = c.token, opts: { co?: string; key?: string } = {}) => call('POST', '/definitions', token, body, opts);

/** A bookkeeper of c's tenant with exactly these permissions. */
async function bookkeeper(overrides: Record<string, string>, displayName = 'Bookkeeper') {
  const [u] = await db.insert(users).values({
    tenantId: c.tenantId, email: `rd-bk-${suffix()}@example.com`, passwordHash: 'x', displayName, role: 'bookkeeper',
  }).returning();
  await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: c.tenantId, role: 'bookkeeper' });
  await db.insert(userPermissions).values({ tenantId: c.tenantId, userId: u!.id, overrides: overrides as never });
  const token = (await authService.issueSession({ userId: u!.id, tenantId: c.tenantId, role: 'bookkeeper', email: u!.email } as never)).accessToken;
  return { id: u!.id, token };
}

beforeAll(async () => {
  const app = express();
  // Larger than the 64 KB definition limit, so the engine's own 413 is what answers.
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1/report-builder', reportBuilderRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

beforeEach(async () => {
  c = await makeCompany(`rd${tenantIds.length}`, tenantIds);
});

describe('report-defs-v1 (U-118)', () => {
  it('is advertised and kept on the desktop', () => {
    expect(DESKTOP_CAPABILITIES).toContain('report-defs-v1');
    expect(DESKTOP_KEPT).toContain('/api/v1/report-builder');
  });

  it('CRUD: create, list, get, update, soft delete; audit rows', async () => {
    const options = { dateRange: { preset: 'this_year' }, basis: 'accrual', filters: { accountIds: [c.bank, c.expense], contactIds: [c.vendor], tagIds: [c.tag] } };
    const r = await create({ name: 'Monthly P&L', definition: def(options) });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const row = r.json;
    expect(row).toMatchObject({
      groupId: null, name: 'Monthly P&L', kind: 'standard', definition: def(options), version: 1,
      createdBy: c.userId, createdByName: expect.stringMatching(/^Owner rd/), canEdit: true,
    });
    expect(typeof row.updatedAt).toBe('string');

    const list = await call('GET', '/definitions', c.token);
    expect(list.status).toBe(200);
    expect(list.json.definitions.map((d: { id: string }) => d.id)).toEqual([row.id]);
    const got = await call('GET', `/definitions/${row.id}`, c.token);
    expect(got.json).toEqual(row);

    // The desktop sends the whole write body: name, groupId, kind, definition, version.
    const wrongKind = await call('PUT', `/definitions/${row.id}`, c.token, { version: 1, kind: 'builder', definition: def() });
    expect(wrongKind.status).toBe(400);
    const up = await call('PUT', `/definitions/${row.id}`, c.token, { version: 1, name: 'P&L by month', groupId: null, kind: 'standard', definition: def({ basis: 'cash' }) });
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    expect(up.json).toMatchObject({ name: 'P&L by month', version: 2, definition: def({ basis: 'cash' }) });

    const del = await call('DELETE', `/definitions/${row.id}?version=2`, c.token);
    expect(del.status).toBe(204);
    expect((await call('GET', `/definitions/${row.id}`, c.token)).status).toBe(404);
    expect((await call('GET', '/definitions', c.token)).json.definitions).toEqual([]);
    const [stored] = await db.select().from(reportDefinitions).where(eq(reportDefinitions.id, row.id));
    expect(stored!.deletedAt).not.toBeNull();
    expect(stored!.version).toBe(3);

    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityId, row.id)));
    expect(audits.map((a) => a.action).sort()).toEqual(['create', 'delete', 'update']);
    // Names are not logged.
    expect(JSON.stringify(audits.map((a) => [a.beforeData, a.afterData]))).not.toContain('P&L');
  });

  it('409 STALE_VERSION with details.current on PUT and DELETE', async () => {
    const row = (await create({ name: 'AR', definition: def({}, 'ar_aging_summary') })).json;
    expect((await call('PUT', `/definitions/${row.id}`, c.token, { version: 1, name: 'AR aging' })).status).toBe(200);
    const stalePut = await call('PUT', `/definitions/${row.id}`, c.token, { version: 1, name: 'Again' });
    expect(stalePut.status).toBe(409);
    expect(stalePut.json.error).toMatchObject({ code: 'STALE_VERSION', details: { current: 2 } });
    const staleDel = await call('DELETE', `/definitions/${row.id}?version=1`, c.token);
    expect(staleDel.status).toBe(409);
    expect(staleDel.json.error).toMatchObject({ code: 'STALE_VERSION', details: { current: 2 } });
  });

  it('Q-310: report access saves and sees all; only author, owner or super admin edits', async () => {
    const viewer = await bookkeeper({ reports: 'view' }, 'Viewer');
    const other = await bookkeeper({ reports: 'view' }, 'Other');
    const none = await bookkeeper({ reports: 'none' }, 'NoReports');

    const mine = await create({ name: 'Viewer report', definition: def() }, viewer.token);
    expect(mine.status, JSON.stringify(mine.json)).toBe(201);
    const id = mine.json.id;
    expect(mine.json).toMatchObject({ createdBy: viewer.id, createdByName: 'Viewer', canEdit: true });

    // Visible to everyone with report access, with canEdit false for another user.
    const seen = await call('GET', '/definitions', other.token);
    expect(seen.json.definitions).toEqual([expect.objectContaining({ id, canEdit: false, createdByName: 'Viewer' })]);
    expect((await call('GET', '/definitions', none.token)).status).toBe(403);
    expect((await create({ name: 'x', definition: def() }, none.token)).status).toBe(403);

    const denied = await call('PUT', `/definitions/${id}`, other.token, { version: 1, name: 'Hijack' });
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe('NOT_AUTHOR');
    // A replay key does not get around it.
    const deniedKeyed = await call('PUT', `/definitions/${id}`, other.token, { version: 1, name: 'Hijack' }, { key: `rd-deny-${suffix()}` });
    expect(deniedKeyed.json.error.code).toBe('NOT_AUTHOR');
    expect((await call('DELETE', `/definitions/${id}?version=1`, other.token)).json.error.code).toBe('NOT_AUTHOR');

    // The author edits; the owner (not the author) edits and deletes.
    expect((await call('PUT', `/definitions/${id}`, viewer.token, { version: 1, name: 'Viewer report 2' })).status).toBe(200);
    const byOwner = await call('PUT', `/definitions/${id}`, c.token, { version: 2, name: 'Viewer report 3' });
    expect(byOwner.status, JSON.stringify(byOwner.json)).toBe(200);
    expect(byOwner.json).toMatchObject({ createdBy: viewer.id, version: 3, canEdit: true });
    expect((await call('DELETE', `/definitions/${id}?version=3`, c.token)).status).toBe(204);
  });

  it('409 NAME_TAKEN per company, case-insensitive; free again after delete; other company may reuse', async () => {
    const a = (await create({ name: 'Cash Flow', definition: def() })).json;
    const dup = await create({ name: 'cash flow', definition: def() });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('NAME_TAKEN');
    const b = (await create({ name: 'Other', definition: def() })).json;
    const rename = await call('PUT', `/definitions/${b.id}`, c.token, { version: 1, name: 'CASH FLOW' });
    expect(rename.json.error.code).toBe('NAME_TAKEN');
    expect((await create({ name: 'Cash Flow', definition: def() }, c.token, { co: c.companyB })).status).toBe(201);
    expect((await call('DELETE', `/definitions/${a.id}?version=1`, c.token)).status).toBe(204);
    expect((await create({ name: 'Cash Flow', definition: def() })).status).toBe(201);
  });

  it('another company or tenant: 404 and not listed', async () => {
    const row = (await create({ name: 'Mine', definition: def() })).json;
    expect((await call('GET', `/definitions/${row.id}`, c.token, undefined, { co: c.companyB })).status).toBe(404);
    expect((await call('GET', '/definitions', c.token, undefined, { co: c.companyB })).json.definitions).toEqual([]);
    expect((await call('PUT', `/definitions/${row.id}`, c.token, { version: 1, name: 'x' }, { co: c.companyB })).status).toBe(404);
    expect((await call('DELETE', `/definitions/${row.id}?version=1`, c.token, undefined, { co: c.companyB })).status).toBe(404);
    const first = c;
    const d = await makeCompany(`rdx${tenantIds.length}`, tenantIds);
    expect((await call('GET', `/definitions/${row.id}`, d.token, undefined, { co: d.companyId })).status).toBe(404);
    c = first;
    expect((await call('GET', '/definitions/not-a-uuid', c.token)).status).toBe(404);
  });

  it('400 DEFINITION_INVALID and 413 DEFINITION_TOO_LARGE', async () => {
    const bad = async (definition: unknown, path: string) => {
      const r = await create({ name: `Bad ${suffix()}`, definition });
      expect(r.status, JSON.stringify(r.json)).toBe(400);
      expect(r.json.error).toMatchObject({ code: 'DEFINITION_INVALID', details: { path } });
    };
    await bad({ schemaVersion: 2, kind: 'standard', reportKey: 'pl', options: {} }, 'definition.schemaVersion');
    await bad({ schemaVersion: 1, kind: 'builder', reportKey: 'pl', options: {} }, 'definition.kind');
    await bad({ schemaVersion: 1, kind: 'standard', reportKey: 'Profit-Loss', options: {} }, 'definition.reportKey');
    await bad({ schemaVersion: 1, kind: 'standard', reportKey: 'pl', options: {}, extra: 1 }, 'definition');
    await bad(def({ accountId: c.bank }), 'options.accountId');
    await bad(def({ columns: [{ caption: `x ${c.bank}` }] }), 'options.columns.0.caption');
    await bad(def({ filters: { accountIds: ['nope'] } }), 'options.filters.accountIds');
    await bad(def({ filters: { tagIds: [crypto.randomUUID()] } }), 'options.filters.tagIds');
    await bad(def({ budgetId: crypto.randomUUID() }), 'options.budgetId');
    // An account of the other company.
    const [foreign] = await db.insert(accounts).values({ tenantId: c.tenantId, companyId: c.companyB, name: `B only ${suffix()}`, accountType: 'expense' }).returning();
    await bad(def({ filters: { accountIds: [foreign!.id] } }), 'options.filters.accountIds');
    // kind must match.
    const mismatch = await create({ name: 'k', kind: 'builder', definition: def() });
    expect(mismatch.status).toBe(400);

    const big = await create({ name: 'Big', definition: def({ note: 'x'.repeat(70 * 1024) }) });
    expect(big.status).toBe(413);
    expect(big.json.error).toMatchObject({ code: 'DEFINITION_TOO_LARGE', details: { limit: 65536 } });
    expect(await db.select().from(reportDefinitions).where(eq(reportDefinitions.tenantId, c.tenantId))).toEqual([]);
  });

  it('groups: CRUD, stale, name taken; deleting a group moves its reports to no group', async () => {
    const g = await call('POST', '/definition-groups', c.token, { name: 'Monthly', sort: 1 });
    expect(g.status, JSON.stringify(g.json)).toBe(201);
    expect(g.json).toMatchObject({ name: 'Monthly', sort: 1, version: 1, definitionCount: 0 });
    const gid = g.json.id;
    expect((await call('POST', '/definition-groups', c.token, { name: 'MONTHLY' })).json.error.code).toBe('NAME_TAKEN');
    const r1 = (await create({ name: 'One', groupId: gid, definition: def() })).json;
    const r2 = (await create({ name: 'Two', definition: def() })).json;
    expect((await call('PUT', `/definitions/${r2.id}`, c.token, { version: 1, groupId: gid })).json.groupId).toBe(gid);
    expect((await call('GET', `/definitions?groupId=${gid}`, c.token)).json.definitions).toHaveLength(2);
    expect((await call('GET', '/definitions?groupId=none', c.token)).json.definitions).toEqual([]);
    expect((await call('GET', '/definition-groups', c.token)).json.groups).toEqual([expect.objectContaining({ id: gid, definitionCount: 2 })]);
    // A group of another company is refused.
    const gb = (await call('POST', '/definition-groups', c.token, { name: 'B' }, { co: c.companyB })).json;
    const cross = await create({ name: 'Cross', groupId: gb.id, definition: def() });
    expect(cross.status).toBe(400);

    const ren = await call('PUT', `/definition-groups/${gid}`, c.token, { version: 1, name: 'Month end' });
    expect(ren.json).toMatchObject({ name: 'Month end', version: 2 });
    const staleG = await call('PUT', `/definition-groups/${gid}`, c.token, { version: 1, name: 'x' });
    expect(staleG.json.error).toMatchObject({ code: 'STALE_VERSION', details: { current: 2 } });
    expect((await call('DELETE', `/definition-groups/${gid}?version=1`, c.token)).json.error.code).toBe('STALE_VERSION');

    expect((await call('DELETE', `/definition-groups/${gid}?version=2`, c.token)).status).toBe(204);
    expect((await call('GET', '/definition-groups', c.token)).json.groups).toEqual([]);
    const after = (await call('GET', '/definitions?groupId=none', c.token)).json.definitions;
    expect(after.map((d: { id: string; groupId: string | null; version: number }) => [d.id, d.groupId, d.version]).sort())
      .toEqual([[r1.id, null, 2], [r2.id, null, 3]].sort());
    // The name is free again.
    expect((await call('POST', '/definition-groups', c.token, { name: 'Month end' })).status).toBe(201);
    const moved = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'report_definition'), eq(auditLog.entityId, r1.id)));
    expect(moved.some((a) => (a.afterData as { reason?: string } | null)?.reason === 'group_deleted')).toBe(true);
  });

  it('Idempotency-Key replays a POST and a PUT', async () => {
    const key = `rd-create-${suffix()}`;
    const first = await create({ name: 'Keyed', definition: def() }, c.token, { key });
    expect(first.status).toBe(201);
    const again = await create({ name: 'Keyed', definition: def() }, c.token, { key });
    expect(again.status).toBe(201);
    expect(again.json.id).toBe(first.json.id);
    const putKey = `rd-put-${suffix()}`;
    const p1 = await call('PUT', `/definitions/${first.json.id}`, c.token, { version: 1, name: 'Keyed 2' }, { key: putKey });
    const p2 = await call('PUT', `/definitions/${first.json.id}`, c.token, { version: 1, name: 'Keyed 2' }, { key: putKey });
    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);
    expect(p2.json.version).toBe(2);
    expect(await db.select().from(reportDefinitions).where(eq(reportDefinitions.tenantId, c.tenantId))).toHaveLength(1);
  });
});
