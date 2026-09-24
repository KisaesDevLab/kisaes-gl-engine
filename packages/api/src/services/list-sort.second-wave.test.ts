// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Second-wave server-side column sort: every list here paginates, so the
// ORDER BY must run in SQL. Each case seeds rows whose natural (default)
// order differs from the sorted order, asks for the whitelisted key both
// ways, and checks page 2 continues the sequence.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, companies, accounts, contacts, transactions, recurringSchedules,
  portalReceipts, portalContacts, portalQuestions, documentRequests,
  dailySalesTemplates, dailySalesEntries, payrollImportSessions,
  bankConnections, bankFeedItems, transactionClassificationState,
} from '../db/schema/index.js';
import * as recurring from './recurring.service.js';
import * as vendorCredits from './vendor-credit.service.js';
import * as receipts from './portal-receipts.service.js';
import * as questions from './portal-question.service.js';
import * as docRequests from './recurring-doc-request.service.js';
import * as dailySales from './daily-sales.service.js';
import * as payroll from './payroll-import.service.js';
import * as admin from './admin.service.js';
import * as classification from './practice-classification.service.js';
import { listAjes } from './tb/aje.service.js';

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let tenantId = '';
let companyId = '';
let userId = '';
const extraTenants: string[] = [];

beforeAll(async () => {
  const [t] = await db.insert(tenants).values({ name: `Sort middle ${stamp}`, slug: `sort-${stamp}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Sort Co', fiscalYearStartMonth: 1 }).returning();
  companyId = c!.id;
  const [u] = await db.insert(users).values({
    tenantId, email: `sort-${stamp}@example.com`, passwordHash: 'x'.repeat(60), displayName: 'Sorter', role: 'owner',
  }).returning();
  userId = u!.id;
});

afterAll(async () => {
  if (!tenantId) return;
  await db.delete(transactionClassificationState).where(eq(transactionClassificationState.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(payrollImportSessions).where(eq(payrollImportSessions.tenantId, tenantId));
  await db.delete(dailySalesEntries).where(eq(dailySalesEntries.tenantId, tenantId));
  await db.delete(dailySalesTemplates).where(eq(dailySalesTemplates.tenantId, tenantId));
  await db.delete(documentRequests).where(eq(documentRequests.tenantId, tenantId));
  await db.delete(portalQuestions).where(eq(portalQuestions.tenantId, tenantId));
  await db.delete(portalReceipts).where(eq(portalReceipts.tenantId, tenantId));
  await db.delete(portalContacts).where(eq(portalContacts.tenantId, tenantId));
  await db.delete(recurringSchedules).where(eq(recurringSchedules.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  if (extraTenants.length) await db.delete(tenants).where(inArray(tenants.id, extraTenants));
});

describe('recurring.list', () => {
  it('sorts by name and status server-side, page 2 continues', async () => {
    const [tpl] = await db.insert(transactions).values({ tenantId, txnType: 'expense', txnDate: '2026-01-01' }).returning();
    const rows = [
      { name: 'Rent', nextOccurrence: '2026-07-01', isActive: true },
      { name: 'Alarm', nextOccurrence: '2026-07-05', isActive: false },
      { name: 'Mowing', nextOccurrence: '2026-07-03', isActive: true, archivedAt: new Date() },
    ];
    for (const r of rows) {
      await db.insert(recurringSchedules).values({
        tenantId, templateTransactionId: tpl!.id, frequency: 'monthly', startDate: '2026-01-01', ...r,
      });
    }
    const names = async (o: Parameters<typeof recurring.list>[1]) => (await recurring.list(tenantId, o)).data.map((s) => s.name);
    expect(await names({ sortBy: 'name', sortDir: 'asc' })).toEqual(['Alarm', 'Mowing', 'Rent']);
    expect(await names({ sortBy: 'name', sortDir: 'desc' })).toEqual(['Rent', 'Mowing', 'Alarm']);
    // active → paused → archived, matching the badge order.
    expect(await names({ sortBy: 'status', sortDir: 'asc' })).toEqual(['Rent', 'Alarm', 'Mowing']);
    expect(await names({})).toEqual(['Rent', 'Mowing', 'Alarm']); // default: next occurrence
    expect(await names({ sortBy: 'name', sortDir: 'asc', limit: 2, offset: 2 })).toEqual(['Rent']);
  });
});

describe('vendorCredits.listVendorCredits', () => {
  it('sorts by vendor and numeric total', async () => {
    const [a] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: 'Zed Supply' }).returning();
    const [b] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: 'Abe Parts' }).returning();
    await db.insert(transactions).values([
      { tenantId, companyId, txnType: 'vendor_credit', txnDate: '2026-03-01', contactId: a!.id, total: '9.0000', txnNumber: 'VC-1' },
      { tenantId, companyId, txnType: 'vendor_credit', txnDate: '2026-03-02', contactId: b!.id, total: '100.0000', txnNumber: 'VC-2' },
      { tenantId, companyId, txnType: 'vendor_credit', txnDate: '2026-03-03', contactId: a!.id, total: '25.0000', txnNumber: 'VC-3' },
    ]);
    const nums = async (f: Parameters<typeof vendorCredits.listVendorCredits>[1]) =>
      (await vendorCredits.listVendorCredits(tenantId, f, companyId)).data.map((r) => r.txnNumber);
    expect(await nums({})).toEqual(['VC-3', 'VC-2', 'VC-1']);
    expect(await nums({ sortBy: 'contactName', sortDir: 'asc' })).toEqual(['VC-2', 'VC-3', 'VC-1']);
    // numeric, not lexical: 9 < 25 < 100
    expect(await nums({ sortBy: 'total', sortDir: 'asc' })).toEqual(['VC-1', 'VC-3', 'VC-2']);
    expect(await nums({ sortBy: 'total', sortDir: 'asc', limit: 1, offset: 1 })).toEqual(['VC-3']);
  });
});

describe('receipts.listInbox', () => {
  it('sorts by vendor and numeric amount', async () => {
    const base = { tenantId, companyId, captureSource: 'portal', uploadedBy: companyId, uploadedByType: 'contact', mimeType: 'image/jpeg' };
    await db.insert(portalReceipts).values([
      { ...base, filename: 'a.jpg', storageKey: `t/${stamp}/a`, extractedVendor: 'Zeta', extractedTotal: '5.0000', capturedAt: new Date('2026-05-01') },
      { ...base, filename: 'b.jpg', storageKey: `t/${stamp}/b`, extractedVendor: 'alpha', extractedTotal: '50.0000', capturedAt: new Date('2026-05-02') },
      { ...base, filename: 'c.jpg', storageKey: `t/${stamp}/c`, extractedVendor: null, extractedTotal: '10.0000', capturedAt: new Date('2026-05-03') },
    ]);
    const files = async (o: Parameters<typeof receipts.listInbox>[1]) =>
      (await receipts.listInbox(tenantId, o)).receipts.map((r) => r.filename);
    expect(await files({})).toEqual(['c.jpg', 'b.jpg', 'a.jpg']);
    // case-insensitive, NULL last
    expect(await files({ sortBy: 'extractedVendor', sortDir: 'asc' })).toEqual(['b.jpg', 'a.jpg', 'c.jpg']);
    expect(await files({ sortBy: 'extractedTotal', sortDir: 'desc' })).toEqual(['b.jpg', 'c.jpg', 'a.jpg']);
    expect(await files({ sortBy: 'extractedTotal', sortDir: 'desc', limit: 2, offset: 2 })).toEqual(['a.jpg']);
  });
});

describe('questions.listForBookkeeper', () => {
  it('sorts by body and status', async () => {
    await db.insert(portalQuestions).values([
      { tenantId, companyId, body: 'Why this fee?', createdBy: userId, status: 'open', createdAt: new Date('2026-04-01') },
      { tenantId, companyId, body: 'Amazon charge', createdBy: userId, status: 'responded', createdAt: new Date('2026-04-02') },
      { tenantId, companyId, body: 'Mileage log', createdBy: userId, status: 'resolved', createdAt: new Date('2026-04-03') },
    ]);
    const bodies = async (o: Parameters<typeof questions.listForBookkeeper>[1]) =>
      (await questions.listForBookkeeper(tenantId, { status: 'all', ...o })).data.map((q) => q.body);
    expect(await bodies({})).toEqual(['Mileage log', 'Amazon charge', 'Why this fee?']);
    expect(await bodies({ sortBy: 'body', sortDir: 'asc' })).toEqual(['Amazon charge', 'Mileage log', 'Why this fee?']);
    expect(await bodies({ sortBy: 'status', sortDir: 'desc' })).toEqual(['Amazon charge', 'Mileage log', 'Why this fee?']);
    expect(await bodies({ sortBy: 'body', sortDir: 'asc', limit: 1, offset: 2 })).toEqual(['Why this fee?']);
  });
});

describe('docRequests.listOpenRequests', () => {
  it('keeps the unread-first inbox order by default and honours an explicit sort', async () => {
    const [c1] = await db.insert(portalContacts).values({ tenantId, email: `zz-${stamp}@example.com`, firstName: 'Zoe', lastName: 'Young' }).returning();
    const [c2] = await db.insert(portalContacts).values({ tenantId, email: `aa-${stamp}@example.com` }).returning();
    await db.insert(documentRequests).values([
      { tenantId, contactId: c1!.id, documentType: 'bank_statement', description: 'Jan', periodLabel: '2026-01', requestedAt: new Date('2026-02-01'), status: 'pending', dueDate: new Date('2026-02-20') },
      { tenantId, contactId: c2!.id, documentType: 'bank_statement', description: 'Feb', periodLabel: '2026-02', requestedAt: new Date('2026-03-01'), status: 'submitted', submittedAt: new Date('2026-03-05') },
      { tenantId, contactId: c1!.id, documentType: 'bank_statement', description: 'Mar', periodLabel: '2026-03', requestedAt: new Date('2026-04-01'), status: 'pending', dueDate: new Date('2026-04-10') },
    ]);
    const periods = async (f: Partial<Parameters<typeof docRequests.listOpenRequests>[1]>) =>
      (await docRequests.listOpenRequests(tenantId, { limit: 100, offset: 0, ...f })).items.map((r) => r.periodLabel);
    // unread submission first, then newest request
    expect(await periods({})).toEqual(['2026-02', '2026-03', '2026-01']);
    expect(await periods({ sortBy: 'requestedAt', sortDir: 'asc' })).toEqual(['2026-01', '2026-02', '2026-03']);
    // contact: name when present, else email; 'aa-…' < 'zoe young'
    expect(await periods({ sortBy: 'contact', sortDir: 'asc' })).toEqual(['2026-02', '2026-03', '2026-01']);
    // due date asc with NULLS LAST
    expect(await periods({ sortBy: 'dueDate', sortDir: 'asc' })).toEqual(['2026-01', '2026-03', '2026-02']);
    expect(await periods({ sortBy: 'requestedAt', sortDir: 'asc', limit: 2, offset: 2 })).toEqual(['2026-03']);
  });
});

describe('dailySales.listEntries', () => {
  it('sorts by template name and numeric sales', async () => {
    const [t1] = await db.insert(dailySalesTemplates).values({ tenantId, name: 'Bar', presetType: 'custom' }).returning();
    const [t2] = await db.insert(dailySalesTemplates).values({ tenantId, name: 'Kitchen', presetType: 'custom' }).returning();
    await db.insert(dailySalesEntries).values([
      { tenantId, templateId: t2!.id, businessDate: '2026-06-01', totalSales: '900.0000' },
      { tenantId, templateId: t1!.id, businessDate: '2026-06-02', totalSales: '1200.0000' },
      { tenantId, templateId: t1!.id, businessDate: '2026-06-03', totalSales: '80.0000' },
    ]);
    const dates = async (f: Parameters<typeof dailySales.listEntries>[1]) =>
      (await dailySales.listEntries(tenantId, f)).entries.map((e) => e.businessDate);
    expect(await dates({})).toEqual(['2026-06-03', '2026-06-02', '2026-06-01']);
    expect(await dates({ sortBy: 'templateName', sortDir: 'asc' })).toEqual(['2026-06-03', '2026-06-02', '2026-06-01']);
    expect(await dates({ sortBy: 'templateName', sortDir: 'desc' })).toEqual(['2026-06-01', '2026-06-03', '2026-06-02']);
    expect(await dates({ sortBy: 'totalSales', sortDir: 'asc' })).toEqual(['2026-06-03', '2026-06-01', '2026-06-02']);
    expect(await dates({ sortBy: 'totalSales', sortDir: 'asc', limit: 2, offset: 1 })).toEqual(['2026-06-01', '2026-06-02']);
  });
});

describe('payroll.listSessions', () => {
  it('sorts by pay period (falling back to check date) and error count', async () => {
    const base = { tenantId, importMode: 'employee_level', filePath: '/tmp/x', fileHash: 'h', status: 'uploaded' as const };
    await db.insert(payrollImportSessions).values([
      { ...base, originalFilename: 'p1.csv', payPeriodStart: '2026-01-01', payPeriodEnd: '2026-01-15', errorCount: 3, createdAt: new Date('2026-01-20') },
      { ...base, originalFilename: 'p2.csv', checkDate: '2026-03-01', errorCount: 0, createdAt: new Date('2026-01-21') },
      { ...base, originalFilename: 'p3.csv', payPeriodStart: '2026-02-01', payPeriodEnd: '2026-02-15', errorCount: 1, createdAt: new Date('2026-01-22') },
    ]);
    const files = async (f: Parameters<typeof payroll.listSessions>[1]) =>
      (await payroll.listSessions(tenantId, f)).data.map((s) => s.originalFilename);
    expect(await files({})).toEqual(['p3.csv', 'p2.csv', 'p1.csv']);
    expect(await files({ sortBy: 'payPeriod', sortDir: 'asc' })).toEqual(['p1.csv', 'p3.csv', 'p2.csv']);
    expect(await files({ sortBy: 'errorCount', sortDir: 'desc' })).toEqual(['p1.csv', 'p3.csv', 'p2.csv']);
    expect(await files({ sortBy: 'errorCount', sortDir: 'desc', limit: 1, offset: 1 })).toEqual(['p3.csv']);
  });
});

describe('listAjes', () => {
  it('sorts by memo and numeric total', async () => {
    await db.insert(transactions).values([
      { tenantId, companyId, txnType: 'aje', txnDate: '2026-02-01', ajeNumber: 1, memo: 'depreciation', total: '500.0000' },
      { tenantId, companyId, txnType: 'aje', txnDate: '2026-03-01', ajeNumber: 2, memo: 'Accrual', total: '60.0000' },
      { tenantId, companyId, txnType: 'aje', txnDate: '2026-04-01', ajeNumber: 3, memo: 'bad debt', total: '1000.0000' },
    ]);
    const memos = async (f: Partial<Parameters<typeof listAjes>[2]>) =>
      (await listAjes(tenantId, companyId, { limit: 50, offset: 0, ...f })).ajes.map((a) => a.memo);
    expect(await memos({})).toEqual(['bad debt', 'Accrual', 'depreciation']);
    expect(await memos({ sortBy: 'memo', sortDir: 'asc' })).toEqual(['Accrual', 'bad debt', 'depreciation']);
    expect(await memos({ sortBy: 'total', sortDir: 'asc' })).toEqual(['Accrual', 'depreciation', 'bad debt']);
    expect(await memos({ sortBy: 'total', sortDir: 'asc', limit: 1, offset: 2 })).toEqual(['bad debt']);
  });
});

describe('admin.listTenants', () => {
  it('sorts by name and user count within the delegated scope', async () => {
    const [ta] = await db.insert(tenants).values({ name: `Sort zulu ${stamp}`, slug: `sort-z-${stamp}` }).returning();
    const [tb] = await db.insert(tenants).values({ name: `Sort alpha ${stamp}`, slug: `sort-a-${stamp}` }).returning();
    extraTenants.push(ta!.id, tb!.id);
    const scope = [tenantId, ta!.id, tb!.id];
    const names = async (o: admin.AdminListOptions) =>
      (await admin.listTenants({ tenantIds: scope, ...o })).tenants.map((t) => t.name);
    expect(await names({ tenantSortBy: 'name', sortDir: 'asc' })).toEqual([`Sort alpha ${stamp}`, `Sort middle ${stamp}`, `Sort zulu ${stamp}`]);
    expect(await names({ tenantSortBy: 'name', sortDir: 'desc' })).toEqual([`Sort zulu ${stamp}`, `Sort middle ${stamp}`, `Sort alpha ${stamp}`]);
    // only the main tenant has a user
    expect((await names({ tenantSortBy: 'userCount', sortDir: 'desc' }))[0]).toBe(`Sort middle ${stamp}`);
    expect(await names({ tenantSortBy: 'name', sortDir: 'asc', limit: 1, offset: 1 })).toEqual([`Sort middle ${stamp}`]);
  });
});

describe('classification.listManualQueue', () => {
  it('sorts by description and numeric amount', async () => {
    const [bank] = await db.insert(accounts).values({ tenantId, companyId, name: 'Checking', accountType: 'asset', detailType: 'bank', accountNumber: '10100' }).returning();
    const [conn] = await db.insert(bankConnections).values({ tenantId, accountId: bank!.id, provider: 'manual', institutionName: 'Bank' }).returning();
    // Orphans (no classification state row) are queue members.
    await db.insert(bankFeedItems).values([
      { tenantId, companyId, bankConnectionId: conn!.id, feedDate: '2026-06-01', description: 'zeta', amount: '-5.0000', status: 'pending' },
      { tenantId, companyId, bankConnectionId: conn!.id, feedDate: '2026-06-02', description: 'Alpha', amount: '-50.0000', status: 'pending' },
      { tenantId, companyId, bankConnectionId: conn!.id, feedDate: '2026-06-03', description: 'mid', amount: '-10.0000', status: 'pending' },
    ]);
    const descs = async (o: Parameters<typeof classification.listManualQueue>[1]) =>
      (await classification.listManualQueue(tenantId, { companyId, ...o })).rows.map((r) => r.description);
    expect(await descs({})).toEqual(['mid', 'Alpha', 'zeta']);
    expect(await descs({ sortBy: 'description', sortDir: 'asc' })).toEqual(['Alpha', 'mid', 'zeta']);
    expect(await descs({ sortBy: 'amount', sortDir: 'asc' })).toEqual(['Alpha', 'mid', 'zeta']);
    expect(await descs({ sortBy: 'amount', sortDir: 'desc', limit: 2, offset: 1 })).toEqual(['mid', 'Alpha']);
  });
});
