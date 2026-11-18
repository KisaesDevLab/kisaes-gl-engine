// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// P31 review S1: an import batch's JSON holds ids (prior_values keyed by
// account and contact id, accountAliases values, stamps.accountsAfter,
// result.historyAccounts, the stored tie-out) and imported open items carry
// transactions.source_id = '<sessionId>:<row>'. The archive import
// substitutes every known uuid token in each row line, so all of them must
// follow their rows to the new ids, and the archive must still verify (the
// id-keyed objects are re-sorted by the new ids). Runs in server mode against
// the test database.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { runExport, type ExportResult } from './export.service.js';
import { _importTestHooks, runImport } from './import.service.js';
import { buildPortabilityPlan, scopeSql, type PortabilityPlan } from './plan.js';
import type { IdMap } from './remap.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;

const PASS = 'import batch round trip passphrase 2026!';
const stamp = crypto.randomUUID().slice(0, 8);
let plan: PortabilityPlan;
let archiveRoot = '';
const createdTenants: string[] = [];
const createdUsers: string[] = [];

async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.execute(sql.raw(text.replace(/\$(\d+)/g, (_m, n) => {
    const v = params[Number(n) - 1];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  })));
  return r.rows as T[];
}

async function insertUser(tenantId: string, email: string, superAdmin: boolean): Promise<string> {
  const id = crypto.randomUUID();
  await q(`INSERT INTO users (id, tenant_id, email, password_hash, display_name, role, is_super_admin, is_active)
           VALUES ($1, $2, $3, $5, 'User', 'owner', $4, true)`,
  [id, tenantId, email, superAdmin, '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789']);
  createdUsers.push(id);
  return id;
}

let tenantId = '';
let callerId = '';
let companyId = '';
let accts: string[] = [];
let contactId = '';
let sessionId = '';
let batchId = '';
let txnId = '';
let exported: ExportResult;
let capturedMap: IdMap | null = null;

beforeAll(async () => {
  plan = await buildPortabilityPlan(db);
  archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-archives-imports-'));
  process.env['CL_ARCHIVE_DIR'] = archiveRoot;
  tenantId = crypto.randomUUID();
  await q(`INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)`, [tenantId, `RTI ${stamp}`, `rti-${stamp}`]);
  createdTenants.push(tenantId);
  const ownerId = await insertUser(tenantId, `rti-owner-${stamp}@example.test`, false);
  callerId = await insertUser(tenantId, `rti-caller-${stamp}@example.test`, true);
  await q(`INSERT INTO user_tenant_access (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`, [ownerId, tenantId]);
  companyId = (await q<{ id: string }>(`INSERT INTO companies (tenant_id, business_name, entity_type, setup_complete) VALUES ($1, 'RTI One', 'llc', true) RETURNING id`, [tenantId]))[0]!.id;
  accts = [];
  for (let i = 0; i < 4; i++) {
    accts.push((await q<{ id: string }>(`INSERT INTO accounts (tenant_id, company_id, name, account_type, account_number) VALUES ($1, $2, $3, 'expense', $4) RETURNING id`,
      [tenantId, companyId, `Imported ${i + 1}`, `6${i}${stamp.slice(0, 2)}`]))[0]!.id);
  }
  contactId = (await q<{ id: string }>(`INSERT INTO contacts (tenant_id, company_id, contact_type, display_name) VALUES ($1, $2, 'both', 'RTI Name') RETURNING id`,
    [tenantId, companyId]))[0]!.id;
  batchId = crypto.randomUUID();
  sessionId = crypto.randomUUID();
  const before = (n: number) => ({ name: `Old ${n}`, accountType: 'expense', detailType: null, description: null, parentId: null });
  const priorValues = {
    accounts: { [accts[0]!]: before(1), [accts[1]!]: before(2), [accts[2]!]: before(3) },
    adoptedSystemAccounts: { [accts[3]!]: { systemTag: null, isSystem: false } },
    contacts: { [contactId]: { contactType: 'customer' } },
    accountAliases: { 'n:6000': accts[0], 'name:imported 2': accts[1] },
    stamps: { linesCreatedMax: null, updatedMax: {}, accountsAfter: { [accts[0]!]: before(9), [accts[1]!]: before(8), [accts[2]!]: before(7) } },
  };
  const result = { sessions: { [sessionId]: { created: 1 } }, historyAccounts: { ar: accts[1], ap: null } };
  await q(`INSERT INTO import_batches (id, tenant_id, company_id, source_system, kind, status, options, prior_values, result, created_by)
           VALUES ($1, $2, $3, 'quickbooks_desktop', 'conversion', 'committed', $4::jsonb, $5::jsonb, $6::jsonb, $7)`,
  [batchId, tenantId, companyId, JSON.stringify({ accountMap: { '6000': accts[0] } }), JSON.stringify(priorValues), JSON.stringify(result), ownerId]);
  await q(`INSERT INTO import_sessions (id, tenant_id, company_id, batch_id, kind, source_system, original_filename, file_hash, status)
           VALUES ($1, $2, $3, $4, 'open_invoices', 'quickbooks_desktop', 'open.csv', $5, 'committed')`,
  [sessionId, tenantId, companyId, batchId, crypto.randomBytes(32).toString('hex')]);
  txnId = (await q<{ id: string }>(`INSERT INTO transactions (tenant_id, company_id, txn_type, txn_date, status, contact_id, import_batch_id, source, source_id)
           VALUES ($1, $2, 'invoice', '2026-10-31', 'draft', $3, $4, 'import_open_item', $5) RETURNING id`,
  [tenantId, companyId, contactId, batchId, `${sessionId}:3`]))[0]!.id;
  const tieout = {
    batchId, asOf: '2026-10-31', accounts: [{ accountId: accts[0], sourceRow: 2 }, { accountId: accts[2], sourceRow: 3 }],
    arItems: [{ sourceRow: 3, sessionId, transactionId: txnId }], balanceRows: [{ key: 'history_ar', accountId: accts[1] }],
    referenceTrialBalance: { sessionId, reportDate: '2026-10-31' },
  };
  await q(`UPDATE import_batches SET tieout = $2::jsonb WHERE id = $1`, [batchId, JSON.stringify(tieout)]);
  _importTestHooks.beforeVerify = async ({ idMap }) => { capturedMap = idMap; };
  exported = await runExport(tenantId, callerId, { passphrase: PASS, host: { app: 'ClientLedger', kind: 'backup' } });
}, 180_000);

afterAll(async () => {
  delete _importTestHooks.beforeVerify;
  for (const id of createdTenants) {
    for (const t of [...plan.scoped].reverse()) {
      const where = scopeSql(plan, t, 'a').replace('$1', `'${id}'::uuid`);
      await q(`DELETE FROM "${t}" a WHERE ${where}`).catch(() => undefined);
    }
    await q(`DELETE FROM tenant_archive_imports WHERE tenant_id = $1`, [id]).catch(() => undefined);
    await q(`DELETE FROM user_tenant_access WHERE tenant_id = $1`, [id]);
    await q(`DELETE FROM users WHERE tenant_id = $1 AND id <> ALL($2::uuid[])`, [id, `{${createdUsers.join(',')}}`]).catch(() => undefined);
  }
  for (const u of createdUsers) await q(`DELETE FROM users WHERE id = $1`, [u]).catch(() => undefined);
  for (const id of createdTenants) await q(`DELETE FROM tenants WHERE id = $1`, [id]).catch(() => undefined);
  fs.rmSync(archiveRoot, { recursive: true, force: true });
  delete process.env['CL_ARCHIVE_DIR'];
});

describe('import batch ids survive an archive restore (P31 review S1)', () => {
  it('prior_values, result, tie-out and open-item source ids follow their rows to the new ids, and the archive verifies', async () => {
    capturedMap = null;
    const imported = await runImport({ filePath: exported.path!, passphrase: PASS, callerUserId: callerId });
    createdTenants.push(imported.tenantId);
    expect(imported.verification).toMatchObject({ contentEqual: true, trialBalanceEqual: true });
    const m = capturedMap!;
    const n = (id: string) => m.get(id)!;
    for (const id of [...accts, contactId, sessionId, batchId, txnId]) expect(m.has(id), id).toBe(true);

    const [b] = await q<{ id: string; prior_values: Body; result: Body; tieout: Body; options: Body }>(
      `SELECT id::text AS id, prior_values, result, tieout, options FROM import_batches WHERE tenant_id = $1`, [imported.tenantId]);
    expect(b!.id).toBe(n(batchId));
    const pv = b!.prior_values;
    expect(Object.keys(pv.accounts).sort()).toEqual([n(accts[0]!), n(accts[1]!), n(accts[2]!)].sort());
    expect(pv.accounts[n(accts[1]!)].name).toBe('Old 2');
    expect(Object.keys(pv.adoptedSystemAccounts)).toEqual([n(accts[3]!)]);
    expect(Object.keys(pv.contacts)).toEqual([n(contactId)]);
    expect(pv.accountAliases).toEqual({ 'n:6000': n(accts[0]!), 'name:imported 2': n(accts[1]!) });
    expect(Object.keys(pv.stamps.accountsAfter).sort()).toEqual([n(accts[0]!), n(accts[1]!), n(accts[2]!)].sort());
    expect(pv.stamps.accountsAfter[n(accts[2]!)].name).toBe('Old 7');
    expect(b!.result.historyAccounts.ar).toBe(n(accts[1]!));
    expect(Object.keys(b!.result.sessions)).toEqual([n(sessionId)]);
    expect(b!.options.accountMap['6000']).toBe(n(accts[0]!));
    expect(b!.tieout.batchId).toBe(n(batchId));
    expect(b!.tieout.accounts.map((a: { accountId: string }) => a.accountId)).toEqual([n(accts[0]!), n(accts[2]!)]);
    expect(b!.tieout.arItems[0]).toMatchObject({ sessionId: n(sessionId), transactionId: n(txnId) });
    expect(b!.tieout.balanceRows[0].accountId).toBe(n(accts[1]!));
    expect(b!.tieout.referenceTrialBalance.sessionId).toBe(n(sessionId));

    const [t] = await q<{ id: string; source_id: string; import_batch_id: string }>(
      `SELECT id::text AS id, source_id, import_batch_id::text AS import_batch_id FROM transactions WHERE tenant_id = $1`, [imported.tenantId]);
    expect(t!.id).toBe(n(txnId));
    expect(t!.source_id).toBe(`${n(sessionId)}:3`);
    expect(t!.import_batch_id).toBe(n(batchId));
    // Nothing of the source tenant's ids is left in the restored batch.
    const text = JSON.stringify(b);
    for (const id of [...accts, contactId, sessionId, batchId, txnId]) expect(text).not.toContain(id);
  }, 600_000);
});
