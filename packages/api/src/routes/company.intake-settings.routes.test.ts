// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-93 (intake-settings-v1): GET/PUT /api/v1/company/intake-settings.
// Two companies in one tenant, the owner, a readonly user and a bookkeeper
// excluded from company A. Full replace with expectedUpdatedAt (409 STALE),
// validation (400 VALIDATION_ERROR with the field path), permissions,
// company scope, and no folder path in any audit row or company response.

import 'express-async-errors';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { eq, inArray, sql } from 'drizzle-orm';
import { INTAKE_SETTINGS_DEFAULT_JSON } from '@kis-books/shared';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, auditLog, userPermissions, accountantCompanyExclusions, accounts,
} from '../db/schema/index.js';
import { companyRouter } from './company.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

let server: Server | null = null;
let port = 0;
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);
// A distinctive path fragment: it must never show up anywhere but GET /intake-settings.
const MARKER = `u93marker${crypto.randomUUID().slice(0, 8)}`;

interface Res { status: number; json: any; raw: string }

function send(method: string, pathname: string, token: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (ch) => chunks.push(ch));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
        resolve({ status: res.statusCode ?? 0, json, raw });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

interface Ctx {
  tenantId: string; ownerToken: string; companyA: string; companyB: string;
  readonlyToken: string; bkToken: string;
}
let c: Ctx;

async function cleanTenant(tid: string) {
  await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  await db.delete(accounts).where(eq(accounts.tenantId, tid));
  const staff = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tid));
  if (staff.length) {
    await db.delete(accountantCompanyExclusions).where(inArray(accountantCompanyExclusions.userId, staff.map((u) => u.id)));
    await db.delete(sessions).where(inArray(sessions.userId, staff.map((u) => u.id)));
  }
  await db.delete(companies).where(eq(companies.tenantId, tid));
  await db.delete(userPermissions).where(eq(userPermissions.tenantId, tid));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tid));
  await db.delete(users).where(eq(users.tenantId, tid));
  await db.delete(tenants).where(eq(tenants.id, tid));
}

async function staffUser(tenantId: string, role: 'readonly' | 'bookkeeper' | 'accountant') {
  const [u] = await db.insert(users).values({
    tenantId, email: `${role}-${suffix()}@example.com`, passwordHash: 'x', displayName: role, role,
  }).returning();
  await db.insert(userTenantAccess).values({ userId: u!.id, tenantId, role });
  return { id: u!.id, token: (await authService.issueSession({ userId: u!.id, tenantId, role, email: u!.email } as never)).accessToken };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/company', companyRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  const reg = await authService.register({
    email: `u93-${suffix()}@example.com`, password: 'password123', displayName: 'Owner', companyName: 'Ozark Excavating',
  });
  const tenantId = reg.user.tenantId;
  const [companyA] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  // Raw insert: the database default, not Drizzle's, fills intake_settings.
  const inserted = await db.execute(sql`INSERT INTO companies (tenant_id, business_name, setup_complete) VALUES (${tenantId}, 'Table Rock Marina', true) RETURNING id`);
  const companyB = (inserted.rows[0] as { id: string }).id;
  const ro = await staffUser(tenantId, 'readonly');
  const bk = await staffUser(tenantId, 'bookkeeper');
  await db.insert(accountantCompanyExclusions).values({ userId: bk.id, companyId: companyA!.id } as never);
  c = { tenantId, ownerToken: reg.tokens.accessToken, companyA: companyA!.id, companyB, readonlyToken: ro.token, bkToken: bk.token };
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (c?.tenantId) await cleanTenant(c.tenantId);
});

const resetAll = async () => {
  await db.update(companies).set({ intakeSettings: JSON.parse(INTAKE_SETTINGS_DEFAULT_JSON) }).where(eq(companies.tenantId, c.tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, c.tenantId));
};
beforeEach(resetAll);

const A = () => ({ 'X-Company-Id': c.companyA });
const B = () => ({ 'X-Company-Id': c.companyB });
const URL = '/api/v1/company/intake-settings';

const folder = (n: number, over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), name: `Folder ${n}`, path: `\\\\nas\\scans\\${MARKER}-${n}`,
  defaultKind: 'bills', autoRead: false, keepOriginals: false, ...over,
});

async function stored(companyId: string) {
  const [row] = await db.select({ s: companies.intakeSettings }).from(companies).where(eq(companies.id, companyId));
  return row!.s;
}

describe('U-93: GET and PUT', () => {
  it('a new company has the column default; GET answers no folders, never saved', async () => {
    const r = await db.execute(sql`SELECT intake_settings AS s FROM companies WHERE id = ${c.companyB}`);
    expect((r.rows[0] as { s: unknown }).s).toEqual(JSON.parse(INTAKE_SETTINGS_DEFAULT_JSON));
    const g = await send('GET', URL, c.ownerToken, undefined, B());
    expect(g.status, g.raw).toBe(200);
    expect(g.json).toEqual({ folders: [], updatedAt: null });
  });

  it('PUT replaces the list, answers and stores it; the next PUT needs the new token', async () => {
    const f1 = folder(1, { name: '  Bills  ', keepOriginals: undefined });
    const p = await send('PUT', URL, c.ownerToken, { folders: [f1], expectedUpdatedAt: null }, A());
    expect(p.status, p.raw).toBe(200);
    expect(p.json.folders).toEqual([{ ...f1, name: 'Bills', keepOriginals: false }]);
    expect(typeof p.json.updatedAt).toBe('string');
    const g = await send('GET', URL, c.ownerToken, undefined, A());
    expect(g.json).toEqual(p.json);
    expect(await stored(c.companyA)).toEqual({ version: 1, folders: p.json.folders, updatedAt: p.json.updatedAt });

    const f2 = folder(2, { defaultKind: 'receipts', autoRead: true, keepOriginals: true });
    const p2 = await send('PUT', URL, c.ownerToken, { folders: [f2], expectedUpdatedAt: p.json.updatedAt }, A());
    expect(p2.status, p2.raw).toBe(200);
    expect(p2.json.folders).toEqual([f2]);
    expect(Date.parse(p2.json.updatedAt)).toBeGreaterThan(Date.parse(p.json.updatedAt));
    // Emptying the list is a replace too.
    const p3 = await send('PUT', URL, c.ownerToken, { folders: [], expectedUpdatedAt: p2.json.updatedAt }, A());
    expect(p3.status).toBe(200);
    expect(p3.json.folders).toEqual([]);
  });

  it('a stale token is 409 STALE with details.updatedAt; nothing changes', async () => {
    const p = await send('PUT', URL, c.ownerToken, { folders: [folder(1)], expectedUpdatedAt: null }, A());
    expect(p.status).toBe(200);
    const before = await stored(c.companyA);
    // Never-saved token against a saved list.
    const s1 = await send('PUT', URL, c.ownerToken, { folders: [folder(2)], expectedUpdatedAt: null }, A());
    expect(s1.status).toBe(409);
    expect(s1.json.error.code).toBe('STALE');
    expect(s1.json.error.details).toEqual({ updatedAt: p.json.updatedAt });
    // An older token.
    const older = new Date(Date.parse(p.json.updatedAt) - 1).toISOString();
    const s2 = await send('PUT', URL, c.ownerToken, { folders: [folder(3)], expectedUpdatedAt: older }, A());
    expect(s2.status).toBe(409);
    expect(s2.json.error.code).toBe('STALE');
    // The same instant in another offset is the same token.
    const sameInstant = new Date(Date.parse(p.json.updatedAt)).toISOString().replace('Z', '+00:00');
    expect(await stored(c.companyA)).toEqual(before);
    // No 409 body names a path.
    expect(s1.raw).not.toContain(MARKER);
    const ok = await send('PUT', URL, c.ownerToken, { folders: [folder(4)], expectedUpdatedAt: sameInstant }, A());
    expect(ok.status, ok.raw).toBe(200);
    // Only the successful saves wrote audit rows.
    const rows = await db.select().from(auditLog).where(eq(auditLog.tenantId, c.tenantId));
    expect(rows.filter((r) => r.entityType === 'company_intake_settings')).toHaveLength(2);
  });

  it('two writers with the same token: exactly one wins', async () => {
    const results = await Promise.all([1, 2, 3].map((n) =>
      send('PUT', URL, c.ownerToken, { folders: [folder(n)], expectedUpdatedAt: null }, A())));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
  });

  it('a save of other company settings never makes the list stale', async () => {
    const p = await send('PUT', URL, c.ownerToken, { folders: [folder(1)], expectedUpdatedAt: null }, A());
    const s = await send('PUT', '/api/v1/company/settings', c.ownerToken, { dateFormat: 'MM/DD/YYYY' }, A());
    expect(s.status, s.raw).toBe(200);
    const again = await send('PUT', URL, c.ownerToken, { folders: [folder(2)], expectedUpdatedAt: p.json.updatedAt }, A());
    expect(again.status, again.raw).toBe(200);
  });
});

describe('U-93: validation (400 VALIDATION_ERROR with the field path)', () => {
  const cases: Array<[string, () => unknown, string]> = [
    ['missing expectedUpdatedAt', () => ({ folders: [] }), 'expectedUpdatedAt'],
    ['folders not an array', () => ({ folders: {}, expectedUpdatedAt: null }), 'folders'],
    ['unknown body key', () => ({ folders: [], expectedUpdatedAt: null, version: 2 }), ''],
    ['bad id', () => ({ folders: [folder(1, { id: 'x' })], expectedUpdatedAt: null }), 'folders.0.id'],
    ['empty name', () => ({ folders: [folder(1, { name: ' ' })], expectedUpdatedAt: null }), 'folders.0.name'],
    ['relative path', () => ({ folders: [folder(1, { path: `scans\\${MARKER}` })], expectedUpdatedAt: null }), 'folders.0.path'],
    ['device path', () => ({ folders: [folder(1, { path: `\\\\?\\C:\\${MARKER}` })], expectedUpdatedAt: null }), 'folders.0.path'],
    ['WebDAV', () => ({ folders: [folder(1, { path: `\\\\host@SSL\\DavWWWRoot\\${MARKER}` })], expectedUpdatedAt: null }), 'folders.0.path'],
    ['.. segment', () => ({ folders: [folder(1, { path: `C:\\${MARKER}\\..\\Windows` })], expectedUpdatedAt: null }), 'folders.0.path'],
    ['NUL', () => ({ folders: [folder(1, { path: `C:\\${MARKER}\u0000` })], expectedUpdatedAt: null }), 'folders.0.path'],
    ['unknown kind', () => ({ folders: [folder(1, { defaultKind: 'all' })], expectedUpdatedAt: null }), 'folders.0.defaultKind'],
    ['unknown folder key', () => ({ folders: [folder(1, { owner: 'x' })], expectedUpdatedAt: null }), 'folders.0'],
    ['duplicate name', () => ({ folders: [folder(1, { name: 'Bills' }), folder(2, { name: 'bills' })], expectedUpdatedAt: null }), 'folders.1.name'],
    ['duplicate path', () => {
      const a = folder(1);
      return { folders: [a, folder(2, { path: (a.path as string).toUpperCase().replace(/\\/g, '/') })], expectedUpdatedAt: null };
    }, 'folders.1.path'],
    ['21 folders', () => ({ folders: Array.from({ length: 21 }, (_, i) => folder(i)), expectedUpdatedAt: null }), 'folders'],
    ['reserved device name', () => ({ folders: [folder(1, { path: `C:\\${MARKER}\\NUL.txt` })], expectedUpdatedAt: null }), 'folders.0.path'],
    ['right-to-left override', () => ({ folders: [folder(1, { path: `C:\\${MARKER}\\\u202eslib` })], expectedUpdatedAt: null }), 'folders.0.path'],
    ['alternate data stream', () => ({ folders: [folder(1, { path: `C:\\${MARKER}:stream` })], expectedUpdatedAt: null }), 'folders.0.path'],
    ['credentials in the UNC host', () => ({ folders: [folder(1, { path: `\\\\user:pw@nas\\${MARKER}` })], expectedUpdatedAt: null }), 'folders.0.path'],
    ['segment ending in a dot', () => ({ folders: [folder(1, { path: `C:\\${MARKER}.` })], expectedUpdatedAt: null }), 'folders.0.path'],
    // A lone surrogate reaches the engine as a JSON \ud800 escape; jsonb would refuse it (a 500), validation answers 400.
    ['lone surrogate in a path', () => ({ folders: [folder(1, { path: `C:\\${MARKER}\ud800` })], expectedUpdatedAt: null }), 'folders.0.path'],
    ['lone surrogate in a name', () => ({ folders: [folder(1, { name: 'Bills\udc00' })], expectedUpdatedAt: null }), 'folders.0.name'],
    ['invisible character in a name', () => ({ folders: [folder(1, { name: 'Bi\u200blls' })], expectedUpdatedAt: null }), 'folders.0.name'],
    ['duplicate name by Unicode composition', () => ({
      folders: [folder(1, { name: 'M\u00fcnchen' }), folder(2, { name: 'Mu\u0308nchen' })], expectedUpdatedAt: null,
    }), 'folders.1.name'],
  ];
  for (const [why, body, field] of cases) {
    it(`refuses ${why}`, async () => {
      const r = await send('PUT', URL, c.ownerToken, body(), A());
      expect(r.status, r.raw).toBe(400);
      expect(r.json.error.code).toBe('VALIDATION_ERROR');
      if (field) expect(r.json.error.message.startsWith(`${field}:`), r.json.error.message).toBe(true);
      // The answer never repeats a path.
      expect(r.raw).not.toContain(MARKER);
      expect(await stored(c.companyA)).toEqual(JSON.parse(INTAKE_SETTINGS_DEFAULT_JSON));
    });
  }

  it('accepts exactly 20 folders', async () => {
    const r = await send('PUT', URL, c.ownerToken, { folders: Array.from({ length: 20 }, (_, i) => folder(i)), expectedUpdatedAt: null }, A());
    expect(r.status, r.raw).toBe(200);
    expect(r.json.folders).toHaveLength(20);
  });

  it('GET leaves out a stored folder that fails the rules (a crafted archive)', async () => {
    const good = folder(1);
    await db.update(companies).set({ intakeSettings: {
      version: 1, updatedAt: '2026-10-25T12:00:00.000Z',
      folders: [good, { ...folder(2), path: 'https://evil.example/x' }, { id: 'nope' }] as never,
    } }).where(eq(companies.id, c.companyA));
    const g = await send('GET', URL, c.ownerToken, undefined, A());
    expect(g.json).toEqual({ folders: [good], updatedAt: '2026-10-25T12:00:00.000Z' });
  });

  it('GET shows at most 20 folders and drops repeated ids, names and paths (a crafted archive)', async () => {
    const first = folder(1);
    const dupId = folder(2, { id: first.id.toUpperCase() });
    const dupName = folder(3, { name: 'FOLDER 1' });
    const dupNameNfc = folder(4, { name: 'München' });
    const dupNameNfd = folder(5, { name: 'München' });
    const dupPath = folder(6, { path: (first.path as string).toUpperCase().replace(/\\/g, '/') + '/' });
    const rest = Array.from({ length: 25 }, (_, i) => folder(100 + i));
    await db.update(companies).set({ intakeSettings: {
      version: 1, updatedAt: '2026-10-25T12:00:00.000Z',
      folders: [first, dupId, dupName, dupNameNfc, dupNameNfd, dupPath, ...rest] as never,
    } }).where(eq(companies.id, c.companyA));
    const g = await send('GET', URL, c.ownerToken, undefined, A());
    expect(g.status, g.raw).toBe(200);
    expect(g.json.folders).toHaveLength(20);
    expect(g.json.folders).toEqual([first, dupNameNfc, ...rest.slice(0, 18)]);
  });
});

describe('U-93: permissions and company scope', () => {
  it('readonly may read but PUT is 403 and changes nothing', async () => {
    const p = await send('PUT', URL, c.ownerToken, { folders: [folder(1)], expectedUpdatedAt: null }, A());
    const g = await send('GET', URL, c.readonlyToken, undefined, A());
    expect(g.status, g.raw).toBe(200);
    expect(g.json).toEqual(p.json);
    const w = await send('PUT', URL, c.readonlyToken, { folders: [], expectedUpdatedAt: p.json.updatedAt }, A());
    expect(w.status).toBe(403);
    expect(w.json.error.code).toBe('PERMISSION_DENIED');
    expect((await stored(c.companyA) as { folders: unknown[] }).folders).toHaveLength(1);
  });

  it('a user without company_settings view gets 403 on GET', async () => {
    const bk = await staffUser(c.tenantId, 'bookkeeper');
    await db.insert(userPermissions).values({ tenantId: c.tenantId, userId: bk.id, overrides: { company_settings: 'none' } as never });
    const g = await send('GET', URL, bk.token, undefined, B());
    expect(g.status).toBe(403);
  });

  it('each company has its own list; company B never sees A\'s folders', async () => {
    const a = await send('PUT', URL, c.ownerToken, { folders: [folder(1, { name: 'A bills' })], expectedUpdatedAt: null }, A());
    expect(a.status).toBe(200);
    const gB = await send('GET', URL, c.ownerToken, undefined, B());
    expect(gB.json).toEqual({ folders: [], updatedAt: null });
    expect(gB.raw).not.toContain(MARKER);
    // A write in B leaves A alone.
    const b = await send('PUT', URL, c.ownerToken, { folders: [folder(2, { name: 'B bills' })], expectedUpdatedAt: null }, B());
    expect(b.status).toBe(200);
    expect((await stored(c.companyA) as { folders: Array<{ name: string }> }).folders.map((f) => f.name)).toEqual(['A bills']);
    // The bookkeeper excluded from A: 403 on A for read and write, B is theirs.
    expect((await send('GET', URL, c.bkToken, undefined, A())).status).toBe(403);
    expect((await send('PUT', URL, c.bkToken, { folders: [], expectedUpdatedAt: a.json.updatedAt }, A())).status).toBe(403);
    const bkB = await send('GET', URL, c.bkToken, undefined, B());
    expect(bkB.status).toBe(200);
    expect(bkB.json.folders.map((f: { name: string }) => f.name)).toEqual(['B bills']);
    // No header: the excluded bookkeeper resolves to B, never A.
    const bkNone = await send('GET', URL, c.bkToken);
    expect(bkNone.json.folders.map((f: { name: string }) => f.name)).toEqual(['B bills']);
  });

  it('an accountant excluded from company A can neither read nor write A\'s folders, and can B\'s', async () => {
    const acc = await staffUser(c.tenantId, 'accountant');
    await db.insert(accountantCompanyExclusions).values({ userId: acc.id, companyId: c.companyA } as never);
    const a = await send('PUT', URL, c.ownerToken, { folders: [folder(1, { name: 'A bills' })], expectedUpdatedAt: null }, A());
    expect(a.status).toBe(200);
    const before = await stored(c.companyA);

    const r = await send('GET', URL, acc.token, undefined, A());
    expect(r.status, r.raw).toBe(403);
    expect(r.raw).not.toContain(MARKER);
    const w = await send('PUT', URL, acc.token, { folders: [folder(9, { name: 'Taken over' })], expectedUpdatedAt: a.json.updatedAt }, A());
    expect(w.status, w.raw).toBe(403);
    expect(w.raw).not.toContain(MARKER);
    expect(await stored(c.companyA)).toEqual(before);

    // Not a role denial: the same accountant reads and writes company B.
    const gB = await send('GET', URL, acc.token, undefined, B());
    expect(gB.status, gB.raw).toBe(200);
    const pB = await send('PUT', URL, acc.token, { folders: [folder(10, { name: 'B receipts' })], expectedUpdatedAt: gB.json.updatedAt }, B());
    expect(pB.status, pB.raw).toBe(200);
    // Without a header the accountant never lands on A.
    const none = await send('GET', URL, acc.token);
    expect(none.status).toBe(200);
    expect(none.json.folders.map((f: { name: string }) => f.name)).toEqual(['B receipts']);
    expect(await stored(c.companyA)).toEqual(before);
  });
});

describe('U-93: paths never leave through audit rows or the company row', () => {
  it('audit rows carry ids, names, kinds and switches only', async () => {
    const f1 = folder(1, { autoRead: true });
    const p = await send('PUT', URL, c.ownerToken, { folders: [f1], expectedUpdatedAt: null }, A());
    const f2 = folder(2, { defaultKind: 'auto' });
    await send('PUT', URL, c.ownerToken, { folders: [f1, f2], expectedUpdatedAt: p.json.updatedAt }, A());
    // Other company writes that audit the whole company row.
    expect((await send('PUT', '/api/v1/company/settings', c.ownerToken, { dateFormat: 'DD/MM/YYYY' }, A())).status).toBe(200);
    expect((await send('PUT', '/api/v1/company', c.ownerToken, { businessName: 'Ozark Excavating LLC' }, A())).status).toBe(200);

    const rows = await db.select().from(auditLog).where(eq(auditLog.tenantId, c.tenantId));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const r of rows) {
      expect(JSON.stringify(r.beforeData ?? null)).not.toContain(MARKER);
      expect(JSON.stringify(r.afterData ?? null)).not.toContain(MARKER);
      expect(JSON.stringify(r.afterData ?? null)).not.toMatch(/intake_?settings/i);
    }
    const intake = rows.filter((r) => r.entityType === 'company_intake_settings');
    expect(intake).toHaveLength(2);
    const last = intake.find((r) => JSON.stringify(r.afterData).includes(f2.id))!;
    expect(last.entityId).toBe(c.companyA);
    const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
    const strip = ({ path: _p, ...rest }: Record<string, unknown>) => rest;
    expect(parse(last.beforeData)).toEqual({ folders: [strip(f1)] });
    expect(parse(last.afterData)).toEqual({ folders: [strip(f1), strip(f2)] });
    // Also checked in SQL, whatever the column type.
    const hits = await db.execute(sql`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = ${c.tenantId}
      AND (coalesce(before_data::text, '') LIKE ${'%' + MARKER + '%'} OR coalesce(after_data::text, '') LIKE ${'%' + MARKER + '%'})`);
    expect((hits.rows[0] as { n: number }).n).toBe(0);
  });

  it('company responses leave the column out', async () => {
    await send('PUT', URL, c.ownerToken, { folders: [folder(1)], expectedUpdatedAt: null }, A());
    for (const [method, path, body] of [
      ['GET', '/api/v1/company', undefined],
      ['GET', '/api/v1/company/settings', undefined],
      ['PUT', '/api/v1/company', { businessName: 'Ozark Excavating' }],
      ['PUT', '/api/v1/company/settings', { dateFormat: 'MM/DD/YYYY' }],
    ] as const) {
      const r = await send(method, path, c.ownerToken, body, A());
      expect(r.status, `${method} ${path} ${r.raw}`).toBe(200);
      expect(r.raw, `${method} ${path}`).not.toContain(MARKER);
      expect(r.raw, `${method} ${path}`).not.toMatch(/intakeSettings/);
    }
  });
});

describe('U-93: capability', () => {
  it('advertises intake-settings-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('intake-settings-v1');
  });
});
