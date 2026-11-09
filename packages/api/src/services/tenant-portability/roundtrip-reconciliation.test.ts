// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Tenant archive round trip of the reconciliation Begin columns (migration
// 0271, U-189): service charge / interest amount, date, account (remapped)
// and posted entry (remapped), and include_later_lines. One completed
// reconciliation whose charges were posted by Finish, and one in progress
// with pending charges.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { accounts, companies } from '../../db/schema/index.js';
import * as authService from '../auth.service.js';
import * as ledger from '../ledger.service.js';
import * as reconciliation from '../reconciliation.service.js';
import { ArchiveReader } from './archive-reader.js';
import { runExport, type ExportResult } from './export.service.js';
import { runImport } from './import.service.js';
import { buildPortabilityPlan, SOFT_REFS, scopeSql, type PortabilityPlan } from './plan.js';

const PASS = 'reconciliation round trip passphrase 2026!';
const stamp = crypto.randomUUID().slice(0, 8);
let plan: PortabilityPlan;
let archiveRoot = '';
const createdTenants: string[] = [];
const createdUsers: string[] = [];
let tenantId = '';
let callerId = '';
let archive: ExportResult;

async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.execute(sql.raw(text.replace(/\$(\d+)/g, (_m, n) => {
    const v = params[Number(n) - 1];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  })));
  return r.rows as T[];
}

/** The reconciliations with ids replaced by what they point at. */
async function reconShape(tid: string) {
  return q(`
    SELECT r.status, r.statement_date::text AS statement_date, r.include_later_lines AS later,
      r.service_charge_amount::text AS sc_amount, r.service_charge_date::text AS sc_date, sca.name AS sc_account,
      sct.txn_type AS sc_txn_type, sct.total::text AS sc_txn_total,
      r.interest_amount::text AS int_amount, r.interest_date::text AS int_date, ia.name AS int_account,
      it.txn_type AS int_txn_type, it.total::text AS int_txn_total
    FROM reconciliations r
    LEFT JOIN accounts sca ON sca.tenant_id = r.tenant_id AND sca.id = r.service_charge_account_id
    LEFT JOIN transactions sct ON sct.tenant_id = r.tenant_id AND sct.id = r.service_charge_txn_id
    LEFT JOIN accounts ia ON ia.tenant_id = r.tenant_id AND ia.id = r.interest_account_id
    LEFT JOIN transactions it ON it.tenant_id = r.tenant_id AND it.id = r.interest_txn_id
    WHERE r.tenant_id = $1 ORDER BY r.statement_date`, [tid]);
}

beforeAll(async () => {
  plan = await buildPortabilityPlan(db);
  archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-archives-recon-'));
  process.env['CL_ARCHIVE_DIR'] = archiveRoot;
  const reg = await authService.register({
    email: `rtr-${stamp}@example.test`, password: 'password123', displayName: 'Owner', companyName: `RTR ${stamp}`,
  });
  tenantId = reg.user.tenantId;
  createdTenants.push(tenantId);
  callerId = crypto.randomUUID();
  await q(`INSERT INTO users (id, tenant_id, email, password_hash, display_name, role, is_super_admin, is_active)
           VALUES ($1, $2, $3, $4, 'Caller', 'owner', true, true)`,
  [callerId, tenantId, `rtr-caller-${stamp}@example.test`, '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789']);
  createdUsers.push(callerId);

  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const companyId = company!.id;
  const bank = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) }))!;
  const [fee] = await db.insert(accounts).values({ tenantId, companyId, name: 'RT Bank Fees', accountType: 'expense', accountNumber: '6190' }).returning();
  const [income] = await db.insert(accounts).values({ tenantId, companyId, name: 'RT Interest', accountType: 'revenue', accountNumber: '4190' }).returning();
  await ledger.postTransaction(tenantId, {
    txnType: 'journal_entry', txnDate: '2026-01-05', memo: 'Opening deposit',
    lines: [{ accountId: bank.id, debit: '500.0000', credit: '0' }, { accountId: income.id, debit: '0', credit: '500.0000' }],
  }, undefined, companyId);

  // January: finished, both charges posted.
  const jan = await reconciliation.start(tenantId, bank.id, '2026-01-31', '488.50', {
    serviceCharge: { amount: '12.00', date: '2026-01-31', accountId: fee!.id },
    interest: { amount: '0.50', date: '2026-01-31', accountId: income!.id },
  });
  const janView = await reconciliation.getReconciliation(tenantId, jan.id);
  await reconciliation.updateLines(tenantId, jan.id, janView.lines.map((l: any) => ({ journalLineId: l.journal_line_id, isCleared: true })));
  await reconciliation.complete(tenantId, jan.id, callerId);

  // February: in progress, a pending service charge, later lines on.
  await reconciliation.start(tenantId, bank.id, '2026-02-28', '478.50', {
    serviceCharge: { amount: '10.00', date: '2026-02-28', accountId: fee!.id },
    includeLaterLines: true,
  });

  archive = await runExport(tenantId, callerId, { passphrase: PASS, host: { app: 'ClientLedger', kind: 'backup' } });
}, 180_000);

afterAll(async () => {
  for (const id of createdTenants) {
    for (const t of [...plan.scoped].reverse()) {
      const where = scopeSql(plan, t, 'a').replace('$1', `'${id}'::uuid`);
      await q(`DELETE FROM "${t}" a WHERE ${where}`).catch(() => undefined);
    }
    await q(`DELETE FROM tenant_archive_imports WHERE tenant_id = $1`, [id]).catch(() => undefined);
    await q(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)`, [id]).catch(() => undefined);
    await q(`DELETE FROM user_tenant_access WHERE tenant_id = $1`, [id]).catch(() => undefined);
    await q(`DELETE FROM users WHERE tenant_id = $1`, [id]).catch(() => undefined);
  }
  for (const u of createdUsers) await q(`DELETE FROM users WHERE id = $1`, [u]).catch(() => undefined);
  for (const id of createdTenants) await q(`DELETE FROM tenants WHERE id = $1`, [id]).catch(() => undefined);
  fs.rmSync(archiveRoot, { recursive: true, force: true });
  delete process.env['CL_ARCHIVE_DIR'];
});

describe('reconciliation Begin columns in tenant archives (U-189)', () => {
  it('classifies the new columns', () => {
    expect(SOFT_REFS['reconciliations.service_charge_account_id']).toBe('tenant-ref:accounts');
    expect(SOFT_REFS['reconciliations.service_charge_txn_id']).toBe('tenant-ref:transactions');
    expect(SOFT_REFS['reconciliations.interest_account_id']).toBe('tenant-ref:accounts');
    expect(SOFT_REFS['reconciliations.interest_txn_id']).toBe('tenant-ref:transactions');
  });

  it('charges, posted entries and the later-lines flag survive with remapped ids', async () => {
    const reader = await ArchiveReader.open(archive.path!, PASS);
    await reader.verifyAll();
    const before = await reconShape(tenantId);
    expect(before).toEqual([
      expect.objectContaining({
        status: 'complete', later: false,
        sc_amount: '12.0000', sc_date: '2026-01-31', sc_account: 'RT Bank Fees', sc_txn_type: 'expense', sc_txn_total: '12.0000',
        int_amount: '0.5000', int_date: '2026-01-31', int_account: 'RT Interest', int_txn_type: 'deposit', int_txn_total: '0.5000',
      }),
      expect.objectContaining({
        status: 'in_progress', later: true,
        sc_amount: '10.0000', sc_account: 'RT Bank Fees', sc_txn_type: null, int_amount: null,
      }),
    ]);
    const imported = await runImport({ filePath: archive.path!, passphrase: PASS, callerUserId: callerId });
    createdTenants.push(imported.tenantId);
    expect(imported.verification).toMatchObject({ contentEqual: true, trialBalanceEqual: true });
    expect(await reconShape(imported.tenantId)).toEqual(before);
    const leaked = await q<{ n: number }>(`SELECT count(*)::int AS n FROM reconciliations r
      WHERE r.tenant_id = $1 AND (
        r.service_charge_account_id IN (SELECT id FROM accounts WHERE tenant_id = $2)
        OR r.interest_account_id IN (SELECT id FROM accounts WHERE tenant_id = $2)
        OR r.service_charge_txn_id IN (SELECT id FROM transactions WHERE tenant_id = $2)
        OR r.interest_txn_id IN (SELECT id FROM transactions WHERE tenant_id = $2))`, [imported.tenantId, tenantId]);
    expect(leaked[0]!.n).toBe(0);
  }, 600_000);
});
