// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Migration 0208: tickmark applications, TB notes and leadsheet sign-offs
// are scoped to the workpaper PERIOD END (the TB as-of date), not the
// tax year. Exercised through the real TB router: a mark/note/sign-off
// made on 08/31 never shows on 07/31 and vice versa; writes require
// periodEnd; reads fall back to the tax year's FY end when it is
// omitted; tax_year is derived server-side; the tb_status 'complete'
// gate reads the FY-end period; tenant/company isolation is unchanged.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../../db/index.js';
import { accounts, companies, tenantFeatureFlags, tenants, users } from '../../db/schema/index.js';
import { errorHandler } from '../../middleware/error-handler.js';

const { tbRouter } = await import('../../routes/tb.routes.js');

const JUL = '2026-07-31';
const AUG = '2026-08-31';

let server: Server | null = null;
let port = 0;
let tenantId = '';
let companyId = '';
let julyFyCompanyId = '';
let otherTenantId = '';
let otherCompanyId = '';
let ownerToken = '';
let otherToken = '';
let cashId = '';
let tickmarkId = '';

type Res = { status: number; json: any };
function call(method: string, path: string, opts: { body?: unknown; token?: string; company?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: `/api/v1/tb${path}`, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.token ?? ownerToken}`,
        'X-Company-Id': opts.company ?? companyId,
        ...(data ? { 'Content-Length': String(data.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function mkTenant(label: string) {
  const [t] = await db.insert(tenants).values({ name: label, slug: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }).returning();
  await db.insert(tenantFeatureFlags).values({ tenantId: t!.id, flagKey: 'TRIAL_BALANCE_V1', enabled: true });
  const [u] = await db.insert(users).values({
    tenantId: t!.id, email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    passwordHash: await bcrypt.hash('secret-123-456', 4), role: 'owner', displayName: 'Owner',
  }).returning();
  const token = jwt.sign({ userId: u!.id, tenantId: t!.id, role: 'owner', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '10m' });
  return { tenantId: t!.id, token };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/tb', tbRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });

  const main = await mkTenant('tbps');
  tenantId = main.tenantId;
  ownerToken = main.token;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Period Co', fiscalYearStartMonth: 1 }).returning();
  companyId = c!.id;
  const [cj] = await db.insert(companies).values({ tenantId, businessName: 'July FY Co', fiscalYearStartMonth: 7 }).returning();
  julyFyCompanyId = cj!.id;
  const [cash] = await db.insert(accounts).values({ tenantId, companyId, accountNumber: '1000', name: 'Cash', accountType: 'asset', detailType: 'bank' }).returning();
  cashId = cash!.id;

  const other = await mkTenant('tbps-other');
  otherTenantId = other.tenantId;
  otherToken = other.token;
  const [oc] = await db.insert(companies).values({ tenantId: otherTenantId, businessName: 'Other Tenant Co', fiscalYearStartMonth: 1 }).returning();
  otherCompanyId = oc!.id;

  const seeded = await call('POST', '/tickmarks/seed-defaults');
  expect(seeded.status).toBe(200);
  const lib = await call('GET', '/tickmarks');
  tickmarkId = lib.json.tickmarks[0].id;
  expect((await call('POST', '/groupings/seed-defaults')).status).toBe(200);
});

afterAll(async () => {
  for (const t of [tenantId, otherTenantId]) {
    for (const tbl of ['tb_tickmark_applications', 'tb_notes', 'tb_leadsheet_signoffs', 'tb_tickmarks', 'tb_grouping_accounts', 'tb_groupings', 'tb_status', 'gl_version_stamps', 'audit_log']) {
      await db.execute(sql.raw(`DELETE FROM ${tbl} WHERE tenant_id = '${t}'`));
    }
    await db.delete(accounts).where(eq(accounts.tenantId, t));
    await db.delete(users).where(eq(users.tenantId, t));
    await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, t));
    await db.delete(companies).where(eq(companies.tenantId, t));
    await db.delete(tenants).where(eq(tenants.id, t));
  }
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
  await pool.end();
});

describe('tickmark applications are period-end scoped', () => {
  it('writes require a real periodEnd', async () => {
    const missing = await call('POST', '/tickmark-applications', { body: { taxYear: 2026, accountId: cashId, column: 'adjusted', tickmarkId } });
    expect(missing.status).toBe(400);
    const bogus = await call('POST', '/tickmark-applications', { body: { periodEnd: '2026-02-30', accountId: cashId, column: 'adjusted', tickmarkId } });
    expect(bogus.status).toBe(400);
  });

  it('a mark on 08/31 does not show on 07/31, and vice versa', async () => {
    const aug = await call('POST', '/tickmark-applications', { body: { periodEnd: AUG, taxYear: 1999, accountId: cashId, column: 'adjusted', tickmarkId } });
    expect(aug.status).toBe(201);
    expect(aug.json.application.periodEnd).toBe(AUG);
    expect(aug.json.application.taxYear).toBe(2026); // derived; client taxYear ignored

    const julList = await call('GET', `/tickmark-applications?periodEnd=${JUL}`);
    expect(julList.json.applications).toHaveLength(0);
    const augList = await call('GET', `/tickmark-applications?periodEnd=${AUG}`);
    expect(augList.json.applications.map((a: { id: string }) => a.id)).toEqual([aug.json.application.id]);

    const jul = await call('POST', '/tickmark-applications', { body: { periodEnd: JUL, accountId: cashId, column: 'tax', tickmarkId } });
    expect(jul.status).toBe(201);
    const augAgain = await call('GET', `/tickmark-applications?periodEnd=${AUG}`);
    expect(augAgain.json.applications.map((a: { id: string }) => a.id)).toEqual([aug.json.application.id]);
    const julAgain = await call('GET', `/tickmark-applications?periodEnd=${JUL}`);
    expect(julAgain.json.applications.map((a: { id: string }) => a.id)).toEqual([jul.json.application.id]);
  });

  it('a read without periodEnd falls back to the FY end of taxYear (documented default)', async () => {
    const r = await call('GET', '/tickmark-applications?taxYear=2026');
    expect(r.status).toBe(200);
    expect(r.json.periodEnd).toBe('2026-12-31');
    expect(r.json.applications).toHaveLength(0); // nothing applied on 12/31 — no roll-forward
  });

  it('tax_year derives from the company fiscal calendar (FY starting July: 08/31/2026 → TY2027)', async () => {
    const r = await call('POST', '/notes', { company: julyFyCompanyId, body: { periodEnd: AUG, body: 'FY27 interim note' } });
    expect(r.status).toBe(201);
    expect(r.json.note.taxYear).toBe(2027);
    const fallback = await call('GET', '/notes?taxYear=2026', { company: julyFyCompanyId });
    expect(fallback.json.periodEnd).toBe('2026-06-30');
  });

  it('company + tenant isolation unchanged', async () => {
    const sibling = await call('GET', `/tickmark-applications?periodEnd=${AUG}`, { company: julyFyCompanyId });
    expect(sibling.json.applications).toHaveLength(0);
    const foreign = await call('GET', `/tickmark-applications?periodEnd=${AUG}`, { token: otherToken, company: otherCompanyId });
    expect(foreign.status).toBe(200);
    expect(foreign.json.applications).toHaveLength(0);
    // Another tenant can't target this tenant's company at all.
    const cross = await call('GET', `/tickmark-applications?periodEnd=${AUG}`, { token: otherToken, company: companyId });
    expect(cross.status).toBeGreaterThanOrEqual(400);
  });
});

describe('notes are period-end scoped', () => {
  it('a note on 07/31 does not show on 08/31, and vice versa', async () => {
    expect((await call('POST', '/notes', { body: { body: 'no period' } })).status).toBe(400);
    const jul = await call('POST', '/notes', { body: { periodEnd: JUL, accountId: cashId, body: 'July tie-out' } });
    expect(jul.status).toBe(201);
    const tbLevel = await call('POST', '/notes', { body: { periodEnd: AUG, accountId: null, body: 'August TB-level note' } });
    expect(tbLevel.status).toBe(201);
    const julNotes = await call('GET', `/notes?periodEnd=${JUL}`);
    expect(julNotes.json.notes.map((n: { body: string }) => n.body)).toEqual(['July tie-out']);
    const augNotes = await call('GET', `/notes?periodEnd=${AUG}`);
    expect(augNotes.json.notes.map((n: { body: string }) => n.body)).toEqual(['August TB-level note']);
  });
});

describe('sign-offs are period-end scoped', () => {
  it('signing Aug does not satisfy Jul, and Aug-only reviews do not complete the year', async () => {
    const groupings = (await call('GET', '/groupings')).json.groupings as Array<{ id: string }>;
    expect(groupings.length).toBeGreaterThan(0);
    expect((await call('POST', '/signoffs', { body: { groupingId: groupings[0]!.id, role: 'preparer' } })).status).toBe(400);

    for (const g of groupings) {
      expect((await call('POST', '/signoffs', { body: { periodEnd: AUG, groupingId: g.id, role: 'preparer' } })).status).toBe(201);
      expect((await call('POST', '/signoffs', { body: { periodEnd: AUG, groupingId: g.id, role: 'reviewer' } })).status).toBe(201);
    }
    const aug = await call('GET', `/signoffs?periodEnd=${AUG}`);
    expect(aug.json.signoffs).toHaveLength(groupings.length * 2);
    expect(aug.json.periodEnd).toBe(AUG);
    const jul = await call('GET', `/signoffs?periodEnd=${JUL}`);
    expect(jul.json.signoffs).toHaveLength(0);

    // Reviewer on Jul still needs a Jul preparer.
    const order = await call('POST', '/signoffs', { body: { periodEnd: JUL, groupingId: groupings[0]!.id, role: 'reviewer' } });
    expect(order.status).toBe(422);
    expect(order.json.error.code).toBe('TB_SIGNOFF_ORDER');

    // tb_status is per tax year → gated on the FY-end (12/31) period.
    const complete = await call('PUT', '/status', { body: { taxYear: 2026, workflowState: 'complete' } });
    expect(complete.status).toBe(422);
    expect(complete.json.error.code).toBe('TB_STATUS_GATE');
    expect(complete.json.error.message).toContain('2026-12-31');
  });
});
