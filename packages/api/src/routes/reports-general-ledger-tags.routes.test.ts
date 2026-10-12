// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// General Ledger "Tag" column (GET /reports/general-ledger).
// Guards:
//   - each line carries tagLabel: its OWN tag (tagSource 'line'), else its
//     transaction's tags — the distinct tags on the transaction's other
//     lines plus header tags in transaction_tags — sorted, ', '-joined
//     (tagSource 'transaction'); '' / null when neither
//   - tenant isolation: a foreign tenant's tag or junction row never
//     surfaces on this tenant's lines
//   - the line-level tag filter is unchanged (only lines carrying the tag)
//   - cash basis carries the column too
//   - CSV has a Tag column between Description and Debit
//   - PDF (real render, where Chromium exists) prints the TAG header and
//     the tag names

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import { existsSync } from 'fs';
import type { AddressInfo, Server } from 'net';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import {
  accounts, auditLog, companies, journalLines, sessions, tags, tenants, transactionTags, transactions, users,
} from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import * as ledger from '../services/ledger.service.js';
import { reportsRouter } from './reports.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { extractTextLayer } from '../services/extraction/pdf-detect.service.js';

let server: Server | null = null;
let port = 0;
let token = '';
let tenantId = '';
let otherTenantId = '';
let eastId = '';
const stamp = Date.now();
const RANGE = 'start_date=2026-01-01&end_date=2026-12-31';

async function cleanTenant(tid: string) {
  if (!tid) return;
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tid));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tid));
  await db.delete(transactions).where(eq(transactions.tenantId, tid));
  await db.delete(tags).where(eq(tags.tenantId, tid));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  await db.delete(accounts).where(eq(accounts.tenantId, tid));
  await db.delete(companies).where(eq(companies.tenantId, tid));
  await db.delete(sessions).where(
    inArray(sessions.userId, db.select({ id: users.id }).from(users).where(eq(users.tenantId, tid))),
  );
  await db.delete(users).where(eq(users.tenantId, tid));
  await db.delete(tenants).where(eq(tenants.id, tid));
}

function get(path: string): Promise<{ status: number; contentType: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const r = http.request({
      method: 'GET', hostname: '127.0.0.1', port, path: `/api/v1/reports${path}`,
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode!, contentType: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks),
      }));
    });
    r.on('error', reject);
    r.end();
  });
}

interface GLLine { description: string; debit: number; credit: number; tagId: string | null; tagName: string | null; tagLabel: string; tagSource: 'line' | 'transaction' | null }
interface GLAcct { name: string; lines: GLLine[] }

async function gl(qs = ''): Promise<GLAcct[]> {
  const r = await get(`/general-ledger?${RANGE}${qs}`);
  expect(r.status).toBe(200);
  return (JSON.parse(r.body.toString('utf8')) as { accounts: GLAcct[] }).accounts;
}

/** "<account> | <description>" → [tagLabel, tagSource] for every line. */
function labels(accts: GLAcct[]): Record<string, [string, string | null]> {
  const out: Record<string, [string, string | null]> = {};
  for (const a of accts) for (const l of a.lines) out[`${a.name} | ${l.description}`] = [l.tagLabel, l.tagSource];
  return out;
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/reports', reportsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });

  const reg = await authService.register({
    email: `gl-tags-${stamp}@example.com`, password: 'password123456', displayName: 'GL Tags', companyName: 'GL Tags Co',
  });
  token = reg.tokens.accessToken;
  tenantId = reg.user.tenantId;
  const company = await db.query.companies.findFirst({ where: (c, { eq: e }) => e(c.tenantId, tenantId) });
  const companyId = company!.id;

  const other = await authService.register({
    email: `gl-tags-other-${stamp}@example.com`, password: 'password123456', displayName: 'Other', companyName: 'Other Co',
  });
  otherTenantId = other.user.tenantId;

  const mk = async (name: string, accountNumber: string, accountType: 'asset' | 'expense') =>
    (await db.insert(accounts).values({ tenantId, name, accountNumber, accountType }).returning())[0]!.id;
  const cash = await mk('GLT Cash', '1001', 'asset');
  const rent = await mk('GLT Rent', '6000', 'expense');
  const mkTag = async (tid: string, name: string) =>
    (await db.insert(tags).values({ tenantId: tid, name }).returning())[0]!.id;
  eastId = await mkTag(tenantId, 'East Region');
  const westId = await mkTag(tenantId, 'West');
  const legacyId = await mkTag(tenantId, 'Header Only');
  const foreignTag = await mkTag(otherTenantId, 'FOREIGN SECRET TAG');

  const post = (memo: string, lines: Array<{ accountId: string; debit: string; credit: string; tagId?: string; description: string }>) =>
    ledger.postTransaction(tenantId, { txnType: 'journal_entry', txnDate: '2026-03-01', memo, lines }, undefined, companyId);

  // 1. Expense line tagged; cash side untagged → cash inherits.
  await post('one', [
    { accountId: rent, debit: '100.00', credit: '0', tagId: eastId, description: 'T1 rent' },
    { accountId: cash, debit: '0', credit: '100.00', description: 'T1 cash' },
  ]);
  // 2. Split across two tags; cash side shows both, sorted.
  await post('two', [
    { accountId: rent, debit: '30.00', credit: '0', tagId: westId, description: 'T2 rent west' },
    { accountId: rent, debit: '20.00', credit: '0', tagId: eastId, description: 'T2 rent east' },
    { accountId: cash, debit: '0', credit: '50.00', description: 'T2 cash' },
  ]);
  // 3. Header-only (legacy) tag: no line tags, one transaction_tags row.
  const t3 = await post('three', [
    { accountId: rent, debit: '7.00', credit: '0', description: 'T3 rent' },
    { accountId: cash, debit: '0', credit: '7.00', description: 'T3 cash' },
  ]);
  await db.insert(transactionTags).values({ tenantId, companyId, transactionId: t3.id, tagId: legacyId });
  // 4. Untagged; a FOREIGN tenant's junction row points at it and one of
  //    its lines is (corruptly) stamped with the foreign tag.
  const t4 = await post('four', [
    { accountId: rent, debit: '9.00', credit: '0', description: 'T4 rent' },
    { accountId: cash, debit: '0', credit: '9.00', description: 'T4 cash' },
  ]);
  await db.insert(transactionTags).values({ tenantId: otherTenantId, transactionId: t4.id, tagId: foreignTag });
  await db.execute(sql`UPDATE journal_lines SET tag_id = ${foreignTag}
    WHERE tenant_id = ${tenantId} AND transaction_id = ${t4.id} AND description = 'T4 rent'`);
}, 30000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await cleanTenant(tenantId);
  await cleanTenant(otherTenantId);
  await pool.end();
});

describe('GET /reports/general-ledger — Tag column', () => {
  it('uses the line tag, else the transaction tags (sorted, comma-joined), else empty', async () => {
    const l = labels(await gl());
    expect(l['GLT Rent | T1 rent']).toEqual(['East Region', 'line']);
    expect(l['GLT Cash | T1 cash']).toEqual(['East Region', 'transaction']);
    expect(l['GLT Rent | T2 rent west']).toEqual(['West', 'line']);
    expect(l['GLT Rent | T2 rent east']).toEqual(['East Region', 'line']);
    expect(l['GLT Cash | T2 cash']).toEqual(['East Region, West', 'transaction']);
    expect(l['GLT Rent | T3 rent']).toEqual(['Header Only', 'transaction']);
    expect(l['GLT Cash | T3 cash']).toEqual(['Header Only', 'transaction']);
  });

  it('keeps tagId / tagName as the line’s own tag (unchanged contract)', async () => {
    const cash = (await gl()).find((a) => a.name === 'GLT Cash')!;
    const t1 = cash.lines.find((x) => x.description === 'T1 cash')!;
    expect(t1.tagId).toBeNull();
    expect(t1.tagName).toBeNull();
  });

  it('never surfaces another tenant’s tag or junction row', async () => {
    const accts = await gl();
    const l = labels(accts);
    expect(l['GLT Rent | T4 rent']).toEqual(['', null]);
    expect(l['GLT Cash | T4 cash']).toEqual(['', null]);
    expect(JSON.stringify(accts)).not.toContain('FOREIGN SECRET TAG');
  });

  it('the tag filter stays line-level: only lines carrying the tag, labelled with it', async () => {
    const l = labels(await gl(`&tag_id=${eastId}`));
    expect(Object.keys(l).sort()).toEqual(['GLT Rent | T1 rent', 'GLT Rent | T2 rent east']);
    expect(Object.values(l)).toEqual([['East Region', 'line'], ['East Region', 'line']]);
  });

  it('cash basis carries the column too', async () => {
    const l = labels(await gl('&basis=cash'));
    expect(l['GLT Cash | T1 cash']).toEqual(['East Region', 'transaction']);
    expect(l['GLT Rent | T1 rent']).toEqual(['East Region', 'line']);
  });

  it('CSV puts Tag between Description and Debit', async () => {
    const r = await get(`/general-ledger?${RANGE}&format=csv`);
    expect(r.status).toBe(200);
    const lines = r.body.toString('utf8').split('\n');
    expect(lines[0]).toBe('"Date","Type","Ref","Name","Description","Tag","Debit","Credit","Balance"');
    const t2 = lines.find((x) => x.includes('"T2 cash"'))!;
    expect(t2).toContain('"T2 cash","East Region, West","","50.00"');
    const t4 = lines.find((x) => x.includes('"T4 cash"'))!;
    expect(t4).toContain('"T4 cash","",""');
    expect(r.body.toString('utf8')).not.toContain('FOREIGN SECRET TAG');
  });
});

async function chromeAvailable(): Promise<boolean> {
  try {
    const exe: string = process.env['PUPPETEER_EXECUTABLE_PATH'] || await (await import('puppeteer')).default.executablePath();
    return !!exe && existsSync(exe);
  } catch { return false; }
}
const HAS_CHROME = await chromeAvailable();

describe.skipIf(!HAS_CHROME)('GET /reports/general-ledger — Tag column in the PDF (real render)', () => {
  it('prints a TAG header and the tag names, landscape', async () => {
    const r = await get(`/general-ledger?${RANGE}&format=pdf`);
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('application/pdf');
    const text = (await extractTextLayer(r.body)).map((p) => p.text).join('\n');
    for (const h of ['DESCRIPTION', 'TAG', 'DEBIT', 'CREDIT', 'BALANCE']) expect(text).toContain(h);
    expect(text).toContain('East Region');
    expect(text).toContain('Header Only');
    expect(text).not.toContain('FOREIGN SECRET TAG');
  }, 60_000);
});
