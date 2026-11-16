// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Per-company 1099 thresholds (U-215, 1099-thresholds-v1): GET/PUT
// /company/1099-thresholds (decimal strings, null = the year table, owner
// only), and every 1099 threshold check following the override: the 1099
// Summary, 1099 Preparation and the 1099 Center (tiles, statuses, threshold
// scan). A tenant with several companies keeps the year table on the
// tenant-wide 1099 Center.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, accounts, companies, auditLog, contacts, transactions, journalLines,
  vendor1099AccountMappings, company1099Thresholds,
} from '../db/schema/index.js';
import { companyRouter } from './company.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as accountsService from '../services/accounts.service.js';
import * as ledger from '../services/ledger.service.js';
import { buildAp1099Prep } from '../services/ap-report.service.js';
import { buildVendor1099SummaryByBox } from '../services/vendor-1099-summary.service.js';
import * as portal1099 from '../services/portal-1099.service.js';
import { threshold1099Resolver } from '../services/company-1099-thresholds.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

const YEAR = 2026;

let server: Server | null = null;
let port = 0;
let tenantId = '';
let companyId = '';
let ownerToken = '';
let vendorId = '';

function call(method: string, path: string, body?: unknown, token = ownerToken): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Company-Id': companyId,
        ...(data ? { 'Content-Length': String(data.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function seedUser(role: string) {
  const [u] = await db.insert(users).values({
    tenantId, email: `${role}-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'x', role, displayName: role,
  }).returning();
  const token = jwt.sign({ userId: u!.id, tenantId, role, isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  return { id: u!.id, token };
}

const box = (json: any, code: string) => (json.boxes as any[]).find((b) => b.box === code);

beforeEach(async () => {
  const [t] = await db.insert(tenants).values({ name: 'U-215', slug: 'u215-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Threshold Co', setupComplete: true }).returning();
  companyId = c!.id;
  ownerToken = (await seedUser('owner')).token;

  const bank = await accountsService.create(tenantId, { name: 'Checking', accountType: 'asset', detailType: 'bank', accountNumber: '1010' });
  const labor = await accountsService.create(tenantId, { name: 'Contract Labor', accountType: 'expense', accountNumber: '6110' });
  await db.insert(vendor1099AccountMappings).values({ tenantId, accountId: labor.id, formBox: 'NEC-1' });
  const [v] = await db.insert(contacts).values({
    tenantId, contactType: 'vendor', displayName: 'Nora Contractor', is1099Eligible: true, taxId: '12-3456789',
  } as typeof contacts.$inferInsert).returning();
  vendorId = v!.id;
  // $1,500.00 paid in 2026: under the $2,000 year-table threshold.
  await ledger.postTransaction(tenantId, {
    txnType: 'expense', txnDate: '2026-04-01', contactId: vendorId, total: '1500.00', memo: 'Work',
    lines: [
      { accountId: labor.id, debit: '1500.00', credit: '0' },
      { accountId: bank.id, debit: '0', credit: '1500.00' },
    ],
  });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/company', companyRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  await db.delete(company1099Thresholds).where(eq(company1099Thresholds.tenantId, tenantId));
  await db.delete(vendor1099AccountMappings).where(eq(vendor1099AccountMappings.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

describe('GET/PUT /company/1099-thresholds (U-215)', () => {
  it('is advertised as 1099-thresholds-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('1099-thresholds-v1');
  });

  it('reads the year table when nothing is set', async () => {
    const r = await call('GET', `/api/v1/company/1099-thresholds?year=${YEAR}`);
    expect(r.status).toBe(200);
    expect(r.json.year).toBe(YEAR);
    expect(r.json.boxes.map((b: any) => b.box)).toEqual(['NEC-1', 'MISC-1', 'MISC-2', 'MISC-3', 'MISC-6', 'MISC-10']);
    expect(box(r.json, 'NEC-1')).toMatchObject({ amount: null, defaultExact: '2000.0000', effectiveExact: '2000.0000', form: '1099-NEC', boxNumber: '1' });
    expect(box(r.json, 'MISC-2')).toMatchObject({ amount: null, defaultExact: '10.0000' });
    const y2025 = await call('GET', '/api/v1/company/1099-thresholds?year=2025');
    expect(box(y2025.json, 'NEC-1').defaultExact).toBe('600.0000');
  });

  it('the owner sets, keeps and clears amounts as decimal strings; audited', async () => {
    const set = await call('PUT', `/api/v1/company/1099-thresholds?year=${YEAR}`, { thresholds: { 'NEC-1': '1000', 'MISC-2': '25.5' } });
    expect(set.status).toBe(200);
    expect(box(set.json, 'NEC-1')).toMatchObject({ amount: '1000.0000', defaultExact: '2000.0000', effectiveExact: '1000.0000' });
    expect(box(set.json, 'MISC-2')).toMatchObject({ amount: '25.5000', effectiveExact: '25.5000' });
    // Boxes left out keep their amount; null clears one.
    const cleared = await call('PUT', `/api/v1/company/1099-thresholds?year=${YEAR}`, { thresholds: { 'MISC-2': null } });
    expect(box(cleared.json, 'NEC-1').amount).toBe('1000.0000');
    expect(box(cleared.json, 'MISC-2')).toMatchObject({ amount: null, effectiveExact: '10.0000' });
    // Zero is a valid amount (every payment reports).
    expect(box((await call('PUT', '/api/v1/company/1099-thresholds', { thresholds: { 'MISC-1': '0' } })).json, 'MISC-1').amount).toBe('0.0000');

    const [row] = await db.select().from(company1099Thresholds)
      .where(and(eq(company1099Thresholds.companyId, companyId), eq(company1099Thresholds.formBox, 'NEC-1')));
    expect(row!.amount).toBe('1000.0000');
    const audits = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'company_1099_thresholds')));
    expect(audits).toHaveLength(3);
    const first = audits.find((a) => JSON.stringify(a.afterData).includes('25.5'))!;
    const after = typeof first.afterData === 'string' ? JSON.parse(first.afterData) : first.afterData;
    expect(after).toEqual({ 'NEC-1': '1000.0000', 'MISC-2': '25.5000' });
    // Saving the same amount again changes nothing and adds no audit row.
    await call('PUT', '/api/v1/company/1099-thresholds', { thresholds: { 'NEC-1': '1000.00' } });
    expect(await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'company_1099_thresholds')))).toHaveLength(3);
  });

  it('refuses numbers, signs, exponents, more than 4 places and unknown boxes', async () => {
    for (const thresholds of [
      { 'NEC-1': 600 }, { 'NEC-1': '-1' }, { 'NEC-1': '1e3' }, { 'NEC-1': '600.00001' }, { 'NEC-1': '1,000' }, { 'NEC-1': '' },
      { 'MISC-4': '600' },
    ]) {
      const r = await call('PUT', '/api/v1/company/1099-thresholds', { thresholds });
      expect(r.status).toBe(400);
    }
    expect(await db.select().from(company1099Thresholds).where(eq(company1099Thresholds.tenantId, tenantId))).toHaveLength(0);
  });

  it('only the owner writes (403 OWNER_REQUIRED); others with company settings rights can read', async () => {
    for (const role of ['accountant', 'bookkeeper']) {
      const staff = await seedUser(role);
      const r = await call('PUT', '/api/v1/company/1099-thresholds', { thresholds: { 'NEC-1': '1' } }, staff.token);
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe('OWNER_REQUIRED');
      expect((await call('GET', '/api/v1/company/1099-thresholds', undefined, staff.token)).status).toBe(200);
    }
    expect(await db.select().from(company1099Thresholds).where(eq(company1099Thresholds.tenantId, tenantId))).toHaveLength(0);
  });
});

describe('the 1099 reports and the 1099 Center use the override (U-215)', () => {
  async function flags() {
    const prep = (await buildAp1099Prep(tenantId, YEAR, null, { exactAmounts: true })).data.find((r) => r.contact_id === vendorId)!;
    const summary = await buildVendor1099SummaryByBox(tenantId, YEAR, null);
    const center = await portal1099.summary(tenantId, YEAR);
    const hits = await portal1099.scanThresholds(tenantId, YEAR);
    const status = (await portal1099.listVendors(tenantId, YEAR)).find((v) => v.contactId === vendorId)!.status;
    return {
      prepOver: prep.over_threshold,
      prepMeets: prep.reportable_meets_threshold,
      summaryMeets: summary.rows.find((r) => r.contactId === vendorId)!.meetsThreshold,
      catalogNec: summary.boxCatalog.find((b) => b.box === 'NEC-1')!.thresholdExact,
      centerOver: center.vendorsOverThreshold,
      hits: hits.map((h) => h.contactId),
      status,
    };
  }

  it('null falls back to the year table; an override moves every flag; clearing it moves them back', async () => {
    const before = await flags();
    expect(before).toMatchObject({ prepOver: false, prepMeets: false, summaryMeets: false, catalogNec: '2000.0000', centerOver: 0, hits: [] });

    expect((await call('PUT', '/api/v1/company/1099-thresholds', { thresholds: { 'NEC-1': '1500.00' } })).status).toBe(200);
    const after = await flags();
    expect(after).toMatchObject({ prepOver: true, prepMeets: true, summaryMeets: true, catalogNec: '1500.0000', centerOver: 1, hits: [vendorId] });
    expect(after.status).not.toBe(before.status);

    // One cent over the payment: not met (exact comparison).
    await call('PUT', '/api/v1/company/1099-thresholds', { thresholds: { 'NEC-1': '1500.01' } });
    expect(await flags()).toMatchObject({ prepMeets: false, summaryMeets: false, centerOver: 0 });

    await call('PUT', '/api/v1/company/1099-thresholds', { thresholds: { 'NEC-1': null } });
    expect(await flags()).toEqual(before);
  });

  it('a company-scoped report uses its company; the tenant-wide Center of a multi-company tenant uses the year table', async () => {
    await call('PUT', '/api/v1/company/1099-thresholds', { thresholds: { 'NEC-1': '1000' } });
    const [other] = await db.insert(companies).values({ tenantId, businessName: 'Second Co', setupComplete: true }).returning();
    expect((await threshold1099Resolver(tenantId, companyId)).box('NEC-1', YEAR)).toBe('1000.0000');
    expect((await threshold1099Resolver(tenantId, other!.id)).box('NEC-1', YEAR)).toBe('2000.00');
    expect((await threshold1099Resolver(tenantId, null)).general(YEAR)).toBe('2000.00');
    expect((await portal1099.summary(tenantId, YEAR)).vendorsOverThreshold).toBe(0);
  });

  it('deleting the company removes its thresholds (cascade)', async () => {
    await call('PUT', '/api/v1/company/1099-thresholds', { thresholds: { 'NEC-1': '1000' } });
    await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
    await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
    await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
    await db.delete(companies).where(eq(companies.id, companyId));
    expect(await db.select().from(company1099Thresholds).where(eq(company1099Thresholds.tenantId, tenantId))).toHaveLength(0);
  });
});
