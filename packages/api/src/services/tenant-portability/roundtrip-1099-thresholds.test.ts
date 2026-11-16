// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// U-215: company_1099_thresholds in tenant archives. A company's thresholds
// survive export -> verify -> import exactly, on the imported company's new
// id, with the amounts unchanged and the archive still verifying. Runs in
// server mode against the test database.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { ArchiveReader } from './archive-reader.js';
import { runExport, type ExportResult } from './export.service.js';
import { runImport } from './import.service.js';
import { buildPortabilityPlan, scopeSql, type PortabilityPlan } from './plan.js';

const PASS = '1099 thresholds round trip passphrase 2026!';
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
let ownerId = '';
let archive: ExportResult;

beforeAll(async () => {
  plan = await buildPortabilityPlan(db);
  archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-archives-1099t-'));
  process.env['CL_ARCHIVE_DIR'] = archiveRoot;
  tenantId = crypto.randomUUID();
  await q(`INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)`, [tenantId, `RT1099 ${stamp}`, `rt1099-${stamp}`]);
  createdTenants.push(tenantId);
  ownerId = await insertUser(tenantId, `rt1099-owner-${stamp}@example.test`, false);
  callerId = await insertUser(tenantId, `rt1099-caller-${stamp}@example.test`, true);
  await q(`INSERT INTO user_tenant_access (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`, [ownerId, tenantId]);
  const [one] = await q<{ id: string }>(`INSERT INTO companies (tenant_id, business_name, entity_type, setup_complete) VALUES ($1, 'T One', 'llc', true) RETURNING id`, [tenantId]);
  const [two] = await q<{ id: string }>(`INSERT INTO companies (tenant_id, business_name, entity_type, setup_complete) VALUES ($1, 'T Two', 'llc', true) RETURNING id`, [tenantId]);
  await q(`INSERT INTO company_1099_thresholds (tenant_id, company_id, form_box, amount, updated_by) VALUES
    ($1, $2, 'NEC-1', 1000, $4), ($1, $2, 'MISC-2', 25.5, $4), ($1, $3, 'NEC-1', 0, NULL)`, [tenantId, one!.id, two!.id, ownerId]);
  archive = await runExport(tenantId, callerId, { passphrase: PASS, host: { app: 'ClientLedger', kind: 'backup' } });
}, 180_000);

afterAll(async () => {
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

async function thresholdsByCompany(tid: string) {
  return q<{ business_name: string; form_box: string; amount: string; company_ok: boolean; updated_by_set: boolean }>(
    `SELECT c.business_name, t.form_box, t.amount::text AS amount, (t.tenant_id = c.tenant_id) AS company_ok, (t.updated_by IS NOT NULL) AS updated_by_set
       FROM company_1099_thresholds t JOIN companies c ON c.id = t.company_id
      WHERE t.tenant_id = $1 ORDER BY c.business_name, t.form_box`, [tid]);
}

describe('company_1099_thresholds in tenant archives (U-215)', () => {
  it('is an archived table of the plan', () => {
    expect(plan.byName.has('company_1099_thresholds')).toBe(true);
  });

  it('round-trips onto the imported companies with the amounts unchanged, and verifies', async () => {
    const reader = await ArchiveReader.open(archive.path!, PASS);
    await reader.verifyAll();
    const imported = await runImport({ filePath: archive.path!, passphrase: PASS, callerUserId: callerId });
    createdTenants.push(imported.tenantId);
    expect(imported.verification).toMatchObject({ contentEqual: true, trialBalanceEqual: true });
    const source = await thresholdsByCompany(tenantId);
    const got = await thresholdsByCompany(imported.tenantId);
    expect(got.map(({ business_name, form_box, amount }) => ({ business_name, form_box, amount }))).toEqual([
      { business_name: 'T One', form_box: 'MISC-2', amount: '25.5000' },
      { business_name: 'T One', form_box: 'NEC-1', amount: '1000.0000' },
      { business_name: 'T Two', form_box: 'NEC-1', amount: '0.0000' },
    ]);
    expect(got.map((r) => ({ business_name: r.business_name, form_box: r.form_box, amount: r.amount })))
      .toEqual(source.map((r) => ({ business_name: r.business_name, form_box: r.form_box, amount: r.amount })));
    expect(got.every((r) => r.company_ok)).toBe(true);
    // The rows point at the imported companies, not the source ones.
    const crossed = await q<{ n: number }>(`SELECT count(*)::int AS n FROM company_1099_thresholds t
      JOIN companies c ON c.id = t.company_id WHERE t.tenant_id = $1 AND c.tenant_id <> $1`, [imported.tenantId]);
    expect(crossed[0]!.n).toBe(0);
  }, 600_000);
});
