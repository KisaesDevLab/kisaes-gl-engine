// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Verify Data (U-12, integrity-v1, ClientLedger P34) in desktop mode: each
// check finds its SQL-seeded fault with exact amounts, a fix recomputes a
// drifted balance only (idempotent, guarded by the ledger version, audited,
// never touching journal lines or the ledger version), permissions, stored
// runs and retention, and the desktop profile's daily auto-repair is off.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';

const TOKEN = 'integrity_' + 'i'.repeat(40);
let dataDir = '';
let app: Express;
let server: http.Server;
let port = 0;
let workspaceId = '';
let ownerId = '';
let tenantId = '';
let otherTenant = '';
let companyId = '';
let ownerJwt = '';
let viewerJwt = '';
const users: string[] = [];
const stamp = crypto.randomUUID().slice(0, 8);

type Db = typeof import('../db/index.js');
let dbm: Db;

async function call(method: string, p: string, body?: unknown, token = ownerJwt): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'x-cl-token': TOKEN, authorization: `Bearer ${token}`, 'x-company-id': companyId };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const ct = r.headers.get('content-type') ?? '';
  return { status: r.status, json: ct.includes('application/json') ? (await r.json()) as Record<string, unknown> : {} };
}

async function q<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const { sql } = await import('drizzle-orm');
  const chunks = text.split(/\$(\d+)/);
  let query = sql.raw(chunks[0]!);
  for (let i = 1; i < chunks.length; i += 2) query = sql`${query}${params[Number(chunks[i]) - 1]}${sql.raw(chunks[i + 1]!)}`;
  return (await dbm.db.execute(query)).rows as T[];
}

/** Writes rows the posting rules would refuse, with triggers off (test superuser only). */
async function raw(statements: Array<[string, unknown[]]>): Promise<void> {
  await dbm.db.transaction(async (tx) => {
    const { sql } = await import('drizzle-orm');
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    for (const [text, params] of statements) {
      const chunks = text.split(/\$(\d+)/);
      let query = sql.raw(chunks[0]!);
      for (let i = 1; i < chunks.length; i += 2) query = sql`${query}${params[Number(chunks[i]) - 1]}${sql.raw(chunks[i + 1]!)}`;
      await tx.execute(query);
    }
  });
}

type Run = { id: string; ledgerVersion: string; checks: Array<{ code: string; status: string; found: number }>; findings: Array<Record<string, unknown> & { id: string; code: string; fix: string | null; amounts?: Record<string, string> }> };
const found = (run: Run, code: string) => run.checks.find((c) => c.code === code)!;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-integrity-'));
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
  const created = await ws.createWorkspaceWithOwner({ email: `int-owner-${stamp}@example.test`, displayName: 'Owner', password: 'owner password 1234' });
  workspaceId = created.workspaceTenantId;
  ownerId = created.userId;
  const { env } = await import('../config/env.js');
  const wsJwt = jwt.sign({ userId: ownerId, tenantId: workspaceId, role: 'owner', isSuperAdmin: true }, env.JWT_SECRET, { expiresIn: '30m' });
  const mk = async (name: string) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/tenants`, {
      method: 'POST', headers: { 'x-cl-token': TOKEN, authorization: `Bearer ${wsJwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name, businessType: 'default' }),
    });
    expect(r.status).toBe(201);
    return ((await r.json()) as { id: string }).id;
  };
  tenantId = await mk(`Integrity Co ${stamp}`);
  otherTenant = await mk(`Integrity Other ${stamp}`);
  companyId = (await q<{ id: string }>('SELECT id FROM companies WHERE tenant_id = $1 LIMIT 1', [tenantId]))[0]!.id;
  ownerJwt = jwt.sign({ userId: ownerId, tenantId, role: 'owner', isSuperAdmin: true }, env.JWT_SECRET, { expiresIn: '30m' });
  const [viewer] = await q<{ id: string }>(`INSERT INTO users (tenant_id, email, password_hash, display_name, role, is_super_admin)
    VALUES ($1, $2, 'x', 'Viewer', 'readonly', false) RETURNING id`, [workspaceId, `int-ro-${stamp}@example.test`]);
  users.push(viewer!.id);
  await q(`INSERT INTO user_tenant_access (user_id, tenant_id, role) VALUES ($1, $2, 'readonly')`, [viewer!.id, tenantId]);
  viewerJwt = jwt.sign({ userId: viewer!.id, tenantId, role: 'readonly', isSuperAdmin: false }, env.JWT_SECRET, { expiresIn: '30m' });
}, 120_000);

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  const { sql } = await import('drizzle-orm');
  const { buildPortabilityPlan, scopeSql } = await import('../services/tenant-portability/plan.js');
  const plan = await buildPortabilityPlan(dbm.db);
  for (const id of [tenantId, otherTenant].filter(Boolean)) {
    await dbm.db.execute(sql`DELETE FROM integrity_runs WHERE tenant_id = ${id}`);
    await dbm.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      for (const t of [...plan.scoped].reverse()) {
        const where = scopeSql(plan, t, 'a').replace('$1', `'${id}'::uuid`);
        await tx.execute(sql.raw(`DELETE FROM "${t}" a WHERE ${where}`));
      }
      await tx.execute(sql`DELETE FROM user_tenant_access WHERE tenant_id = ${id}`);
      await tx.execute(sql`DELETE FROM tenants WHERE id = ${id}`);
    }).catch(() => undefined);
  }
  for (const u of [...users, ownerId]) {
    await dbm.db.execute(sql`DELETE FROM sessions WHERE user_id = ${u}`);
    await dbm.db.execute(sql`DELETE FROM user_tenant_access WHERE user_id = ${u}`);
  }
  await dbm.db.execute(sql`DELETE FROM audit_log WHERE tenant_id = ${workspaceId}`);
  await dbm.db.execute(sql`DELETE FROM users WHERE tenant_id = ${workspaceId}`);
  await dbm.db.execute(sql`DELETE FROM tenants WHERE id = ${workspaceId}`);
  (await import('../desktop/workspace.js'))._resetWorkspaceCacheForTests();
  (await import('../desktop/profile.js'))._resetDesktopProfileForTests();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('Verify Data (U-12)', () => {
  let cash = '';
  let sales = '';
  let unbalancedTxn = '';
  let draftId = '';
  let run: Run;

  it('is advertised, and a clean company has no findings (inventory off: skipped)', async () => {
    const info = await call('GET', '/api/v1/desktop/info');
    expect(info.json['capabilities']).toEqual(expect.arrayContaining(['integrity-v1']));
    const r = await call('POST', '/api/v1/integrity/checks', { level: 'full' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const clean = r.json as unknown as Run;
    expect(clean.findings).toEqual([]);
    expect(clean.checks.map((c) => c.code)).toEqual([
      'UNBALANCED_TRANSACTION', 'ACCOUNT_BALANCE_DRIFT', 'DRAFT_AFFECTS_BOOKS',
      'LINE_ACCOUNT_SCOPE', 'AR_CONTROL_DIFFERENCE', 'AP_CONTROL_DIFFERENCE', 'INVENTORY_VALUE_DIFFERENCE',
    ]);
    expect(found(clean, 'INVENTORY_VALUE_DIFFERENCE').status).toBe('skipped');
    expect(found(clean, 'AR_CONTROL_DIFFERENCE').status).toBe('ok');
    expect(clean.ledgerVersion).toMatch(/^\d+$/);
  }, 60_000);

  it('finds each seeded fault with exact amounts', async () => {
    const accts = await q<{ id: string }>('SELECT id FROM accounts WHERE tenant_id = $1 ORDER BY account_number NULLS LAST, id LIMIT 2', [tenantId]);
    cash = accts[0]!.id;
    sales = accts[1]!.id;
    const foreign = (await q<{ id: string }>('SELECT id FROM accounts WHERE tenant_id = $1 LIMIT 1', [otherTenant]))[0]!.id;
    unbalancedTxn = crypto.randomUUID();
    const scoped = crypto.randomUUID();
    draftId = crypto.randomUUID();
    await raw([
      // A posted entry whose debits exceed its credits by 0.0100; the account's cached balance follows its lines.
      [`INSERT INTO transactions (id, tenant_id, company_id, txn_type, txn_date, status, txn_number) VALUES ($1, $2, $3, 'journal_entry', '2026-02-01', 'posted', 'U-1')`, [unbalancedTxn, tenantId, companyId]],
      [`INSERT INTO journal_lines (tenant_id, company_id, transaction_id, account_id, debit, credit) VALUES ($1, $2, $3, $4, 100.0100, 0), ($1, $2, $3, $5, 0, 100.0000)`, [tenantId, companyId, unbalancedTxn, sales, cash]],
      [`UPDATE accounts SET balance = balance + 100.0100 WHERE id = $1`, [sales]],
      [`UPDATE accounts SET balance = balance - 100.0000 WHERE id = $1`, [cash]],
      // The cached balance of cash drifts by 5.0001 (the only fixable kind).
      [`UPDATE accounts SET balance = balance + 5.0001 WHERE id = $1`, [cash]],
      // A balanced entry with a line on another tenant's account.
      [`INSERT INTO transactions (id, tenant_id, company_id, txn_type, txn_date, status) VALUES ($1, $2, $3, 'journal_entry', '2026-02-02', 'void')`, [scoped, tenantId, companyId]],
      [`INSERT INTO journal_lines (tenant_id, company_id, transaction_id, account_id, debit, credit) VALUES ($1, $2, $3, $4, 1, 0), ($1, $2, $3, $4, 0, 1)`, [tenantId, companyId, scoped, foreign]],
      // A live draft already linked to a posted entry.
      [`INSERT INTO document_drafts (id, tenant_id, company_id, content_sha256, status, converted_transaction_id, doc_reference) VALUES ($1, $2, $3, $4, 'ready', $5, 'INV-77')`, [draftId, tenantId, companyId, 'a'.repeat(64), unbalancedTxn]],
    ]);
    const r = await call('POST', '/api/v1/integrity/checks', { level: 'full' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    run = r.json as unknown as Run;
    expect(found(run, 'UNBALANCED_TRANSACTION')).toMatchObject({ status: 'found', found: 1 });
    expect(found(run, 'ACCOUNT_BALANCE_DRIFT')).toMatchObject({ status: 'found', found: 1 });
    expect(found(run, 'DRAFT_AFFECTS_BOOKS')).toMatchObject({ status: 'found', found: 1 });
    expect(found(run, 'LINE_ACCOUNT_SCOPE')).toMatchObject({ status: 'found', found: 1 });
    const ub = run.findings.find((f) => f.code === 'UNBALANCED_TRANSACTION')!;
    expect(ub).toMatchObject({ severity: 'error', fix: null, subject: { type: 'transaction', id: unbalancedTxn } });
    expect(ub.amounts).toEqual({ expectedExact: '100.0000', actualExact: '100.0100', differenceExact: '0.0100' });
    const dr = run.findings.find((f) => f.code === 'ACCOUNT_BALANCE_DRIFT')!;
    expect(dr).toMatchObject({ id: `ACCOUNT_BALANCE_DRIFT:${cash}`, severity: 'warning', fix: 'recompute_account_balance' });
    expect(dr.amounts!['differenceExact']).toBe('5.0001');
    expect(run.findings.find((f) => f.code === 'DRAFT_AFFECTS_BOOKS')).toMatchObject({ subject: { type: 'document_draft', id: draftId } });
    // Quick runs only the quick checks.
    const quick = (await call('POST', '/api/v1/integrity/checks', { level: 'quick' })).json as unknown as Run;
    expect(quick.checks.map((c) => c.code)).toEqual(['UNBALANCED_TRANSACTION', 'ACCOUNT_BALANCE_DRIFT', 'DRAFT_AFFECTS_BOOKS']);
  }, 60_000);

  it('fixes a drifted balance only: stale-guarded, idempotent, audited, ledger untouched', async () => {
    const before = await q<{ n: number; v: string }>(`SELECT (SELECT count(*)::int FROM journal_lines WHERE tenant_id = $1) AS n,
      (SELECT COALESCE(sum(counter), 0)::text FROM gl_version_stamps WHERE tenant_id = $1) AS v`, [tenantId]);
    const drift = `ACCOUNT_BALANCE_DRIFT:${cash}`;
    const stale = await call('POST', '/api/v1/integrity/fixes', { runId: run.id, findingIds: [drift], expectedLedgerVersion: `${BigInt(run.ledgerVersion) + 1n}` });
    expect(stale.status).toBe(409);
    expect((stale.json['error'] as { code: string }).code).toBe('INTEGRITY_STALE');
    const unknown = await call('POST', '/api/v1/integrity/fixes', { runId: crypto.randomUUID(), findingIds: [drift], expectedLedgerVersion: run.ledgerVersion });
    expect(unknown.status).toBe(404);
    expect((unknown.json['error'] as { code: string }).code).toBe('INTEGRITY_RUN_UNKNOWN');

    const ok = await call('POST', '/api/v1/integrity/fixes', {
      runId: run.id, findingIds: [drift, `UNBALANCED_TRANSACTION:${unbalancedTxn}`], expectedLedgerVersion: run.ledgerVersion, backupArchiveId: 'arch-1',
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json['fixed']).toEqual([drift]);
    expect(ok.json['skipped']).toEqual([{ id: `UNBALANCED_TRANSACTION:${unbalancedTxn}`, reason: 'NOT_FIXABLE' }]);
    expect(ok.json['ledgerVersion']).toBe(run.ledgerVersion);
    const again = await call('POST', '/api/v1/integrity/fixes', { runId: run.id, findingIds: [drift], expectedLedgerVersion: run.ledgerVersion });
    expect(again.json['skipped']).toEqual([{ id: drift, reason: 'NO_LONGER_FOUND' }]);

    const after = await q<{ n: number; v: string }>(`SELECT (SELECT count(*)::int FROM journal_lines WHERE tenant_id = $1) AS n,
      (SELECT COALESCE(sum(counter), 0)::text FROM gl_version_stamps WHERE tenant_id = $1) AS v`, [tenantId]);
    expect(after).toEqual(before);
    const audit = await q<{ after_data: unknown }>(`SELECT after_data FROM audit_log WHERE tenant_id = $1 AND entity_type = 'integrity_fix' ORDER BY created_at LIMIT 1`, [tenantId]);
    const data = typeof audit[0]!.after_data === 'string' ? JSON.parse(audit[0]!.after_data as string) : audit[0]!.after_data;
    expect(data).toMatchObject({ runId: run.id, findingIds: [drift], backupArchiveId: 'arch-1' });
    // S8: each fix's cached balance before and after, exact strings (the run's stored and ledger figures).
    const dr = run.findings.find((f) => f.id === drift)!;
    expect(data.fixes).toEqual([{ findingId: drift, accountId: cash, before: dr.amounts!['actualExact'], after: dr.amounts!['expectedExact'] }]);
    const [bal] = await q<{ b: string }>('SELECT balance::numeric::text AS b FROM accounts WHERE id = $1', [cash]);
    expect(bal!.b).toBe(dr.amounts!['expectedExact']);
    // The repeat that fixed nothing records no amounts.
    const audit2 = await q<{ after_data: unknown }>(`SELECT after_data FROM audit_log WHERE tenant_id = $1 AND entity_type = 'integrity_fix' ORDER BY created_at DESC LIMIT 1`, [tenantId]);
    const data2 = typeof audit2[0]!.after_data === 'string' ? JSON.parse(audit2[0]!.after_data as string) : audit2[0]!.after_data;
    expect(data2.fixes).toEqual([]);

    const recheck = (await call('POST', '/api/v1/integrity/checks', { level: 'quick' })).json as unknown as Run;
    expect(found(recheck, 'ACCOUNT_BALANCE_DRIFT')).toMatchObject({ status: 'ok', found: 0 });
    expect(found(recheck, 'UNBALANCED_TRANSACTION').found).toBe(1);
  }, 60_000);

  it('summary for any member; checks, runs and fixes for owners and admins', async () => {
    const s = await call('GET', '/api/v1/integrity/summary', undefined, viewerJwt);
    expect(s.status).toBe(200);
    const last = s.json['lastQuick'] as { counts: { error: number; warning: number }; fixable: number };
    expect(last.counts).toEqual({ error: 2, warning: 0 });
    expect(last.fixable).toBe(0);
    expect(s.json['lastFull']).not.toBeNull();
    for (const [m, p, b] of [['POST', '/api/v1/integrity/checks', { level: 'quick' }], ['GET', `/api/v1/integrity/runs/${run.id}`, undefined],
      ['POST', '/api/v1/integrity/fixes', { runId: run.id, findingIds: ['x'], expectedLedgerVersion: '1' }]] as const) {
      const r = await call(m, p, b, viewerJwt);
      expect(r.status, p).toBe(403);
      expect((r.json['error'] as { code: string }).code).toBe('INTEGRITY_ADMIN_REQUIRED');
    }
    const one = await call('GET', `/api/v1/integrity/runs/${run.id}`);
    expect(one.status).toBe(200);
    expect((one.json as unknown as Run).findings.length).toBe(run.findings.length);
  }, 60_000);

  it('keeps the newest 20 runs of the company', async () => {
    for (let i = 0; i < 21; i++) expect((await call('POST', '/api/v1/integrity/checks', { level: 'quick' })).status).toBe(200);
    const n = await q<{ n: number }>('SELECT count(*)::int AS n FROM integrity_runs WHERE tenant_id = $1 AND company_id = $2', [tenantId, companyId]);
    expect(n[0]!.n).toBe(20);
    const gone = await call('GET', `/api/v1/integrity/runs/${run.id}`);
    expect(gone.status).toBe(404);
  }, 120_000);

  it('every check, the inventory valuation included, reads one snapshot (M6)', async () => {
    const svc = await import('../services/integrity.service.js');
    // Inventory on, with an inventory asset account and no stock: the valuation is 0.
    const invAcct = crypto.randomUUID();
    await q('UPDATE companies SET inventory_enabled = true WHERE id = $1', [companyId]);
    await q(`INSERT INTO accounts (id, tenant_id, company_id, name, account_type, system_tag, balance)
      VALUES ($1, $2, $3, $4, 'asset', 'inventory_asset', 0)`, [invAcct, tenantId, companyId, `Inventory Asset ${stamp}`]);
    const jeId = crypto.randomUUID();
    let isolation = '';
    svc._integrityTestHooks.beforeCheck = async (code, ex) => {
      const { sql } = await import('drizzle-orm');
      if (code === 'UNBALANCED_TRANSACTION') {
        isolation = ((await ex.execute(sql`SELECT current_setting('transaction_isolation') AS i`)).rows[0] as { i: string }).i;
      }
      if (code !== 'INVENTORY_VALUE_DIFFERENCE') return;
      // Committed from another connection after the run's snapshot: a balanced entry on the inventory account.
      await raw([
        [`INSERT INTO transactions (id, tenant_id, company_id, txn_type, txn_date, status) VALUES ($1, $2, $3, 'journal_entry', '2026-02-03', 'posted')`, [jeId, tenantId, companyId]],
        [`INSERT INTO journal_lines (tenant_id, company_id, transaction_id, account_id, debit, credit) VALUES ($1, $2, $3, $4, 7.2500, 0), ($1, $2, $3, $5, 0, 7.2500)`, [tenantId, companyId, jeId, invAcct, cash]],
      ]);
    };
    try {
      const r = await call('POST', '/api/v1/integrity/checks', { level: 'full' });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      const inSnap = r.json as unknown as Run;
      expect(isolation).toBe('repeatable read');
      expect(found(inSnap, 'INVENTORY_VALUE_DIFFERENCE')).toMatchObject({ status: 'ok', found: 0 });
    } finally {
      delete svc._integrityTestHooks.beforeCheck;
    }
    // The next run sees the entry: the check itself finds it.
    const next = (await call('POST', '/api/v1/integrity/checks', { level: 'full' })).json as unknown as Run;
    expect(found(next, 'INVENTORY_VALUE_DIFFERENCE')).toMatchObject({ status: 'found', found: 1 });
    expect(next.findings.find((f) => f.code === 'INVENTORY_VALUE_DIFFERENCE')!.amounts).toEqual({
      expectedExact: '0.00', actualExact: '7.25', differenceExact: '7.25',
    });
    await raw([
      [`DELETE FROM journal_lines WHERE transaction_id = $1`, [jeId]],
      [`DELETE FROM transactions WHERE id = $1`, [jeId]],
      [`DELETE FROM accounts WHERE id = $1`, [invAcct]],
    ]);
    await q('UPDATE companies SET inventory_enabled = false WHERE id = $1', [companyId]);
  }, 60_000);

  it('the time budget is per run, not per statement (M6)', async () => {
    const svc = await import('../services/integrity.service.js');
    const { sql } = await import('drizzle-orm');
    svc._integrityTestHooks.budgetMs = 1_500;
    // Each check waits 0.6 s: every statement is under the budget, the run is not.
    svc._integrityTestHooks.beforeCheck = async (_code, ex) => { await ex.execute(sql`SELECT pg_sleep(0.6)`); };
    try {
      const r = await call('POST', '/api/v1/integrity/checks', { level: 'full' });
      expect(r.status, JSON.stringify(r.json)).toBe(503);
      expect((r.json['error'] as { code: string }).code).toBe('INTEGRITY_TIMEOUT');
    } finally {
      delete svc._integrityTestHooks.beforeCheck;
      delete svc._integrityTestHooks.budgetMs;
    }
    // A JS-side wait past the deadline (no statement running) fails the same way.
    svc._integrityTestHooks.budgetMs = 300;
    svc._integrityTestHooks.beforeCheck = async () => { await new Promise((res) => setTimeout(res, 200)); };
    try {
      const r = await call('POST', '/api/v1/integrity/checks', { level: 'quick' });
      expect(r.status, JSON.stringify(r.json)).toBe(503);
      expect((r.json['error'] as { code: string }).code).toBe('INTEGRITY_TIMEOUT');
    } finally {
      delete svc._integrityTestHooks.beforeCheck;
      delete svc._integrityTestHooks.budgetMs;
    }
    expect((await call('POST', '/api/v1/integrity/checks', { level: 'quick' })).status).toBe(200);
  }, 60_000);

  it('A/R and A/P count company-less entries alike (M7)', async () => {
    const ap = (await q<{ id: string }>(`SELECT id FROM accounts WHERE tenant_id = $1 AND system_tag = 'accounts_payable' LIMIT 1`, [tenantId]))[0];
    const ar = (await q<{ id: string }>(`SELECT id FROM accounts WHERE tenant_id = $1 AND system_tag = 'accounts_receivable' LIMIT 1`, [tenantId]))[0];
    expect(ap && ar).toBeTruthy();
    const other = cash;
    const bill = crypto.randomUUID();
    const inv = crypto.randomUUID();
    // Company-less posted entries (company_id NULL), as posting stores when a write names no company.
    await raw([
      [`INSERT INTO transactions (id, tenant_id, company_id, txn_type, txn_date, status, txn_number) VALUES ($1, $2, NULL, 'bill', '2026-02-04', 'posted', 'NC-B')`, [bill, tenantId]],
      [`INSERT INTO journal_lines (tenant_id, company_id, transaction_id, account_id, debit, credit) VALUES ($1, NULL, $2, $3, 12.3400, 0), ($1, NULL, $2, $4, 0, 12.3400)`, [tenantId, bill, other, ap!.id]],
      [`INSERT INTO transactions (id, tenant_id, company_id, txn_type, txn_date, status, txn_number) VALUES ($1, $2, NULL, 'invoice', '2026-02-04', 'posted', 'NC-I')`, [inv, tenantId]],
      [`INSERT INTO journal_lines (tenant_id, company_id, transaction_id, account_id, debit, credit) VALUES ($1, NULL, $2, $3, 4.5600, 0), ($1, NULL, $2, $4, 0, 4.5600)`, [tenantId, inv, ar!.id, other]],
    ]);
    try {
      const { db } = dbm;
      const { apOpenItemsAsOf } = await import('../services/ap-open-items.js');
      const strict = await apOpenItemsAsOf(db, { tenantId, companyId, asOf: '2026-12-31' });
      const wide = await apOpenItemsAsOf(db, { tenantId, companyId, asOf: '2026-12-31', includeCompanyless: true });
      // The A/P reports' strict default is unchanged; the integrity scope includes the company-less bill.
      expect(strict.some((i) => i.txnId === bill)).toBe(false);
      expect(wide.find((i) => i.txnId === bill)?.openExact).toBe('12.3400');
      const r = await call('POST', '/api/v1/integrity/checks', { level: 'full' });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      const full = r.json as unknown as Run;
      expect(found(full, 'AR_CONTROL_DIFFERENCE')).toMatchObject({ status: 'ok', found: 0 });
      expect(found(full, 'AP_CONTROL_DIFFERENCE')).toMatchObject({ status: 'ok', found: 0 });
    } finally {
      await raw([
        [`DELETE FROM journal_lines WHERE transaction_id IN ($1, $2)`, [bill, inv]],
        [`DELETE FROM transactions WHERE id IN ($1, $2)`, [bill, inv]],
      ]);
    }
  }, 60_000);
});

describe('desktop profile (Q-P34b)', () => {
  it('the daily balance auto-repair is off on desktop', async () => {
    const { schedulerEnabled } = await import('../desktop/features.js');
    expect(schedulerEnabled('balanceValidation')).toBe(false);
  });
});
