// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// U-91: jsonb objects keyed by ids survive the round trip. The import gives
// every row a new id and PostgreSQL re-sorts the keys of
// companies.check_settings.nextCheckNumbers (keyed by bank account id) by
// the new ids; with three keys the old verification refused about five
// imports in six with ARCHIVE_VERIFY_FAILED content(companies). The same
// archive is imported ten times here and must verify every time. Runs in
// server mode against the test database.

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

const PASS = 'jsonb round trip passphrase 2026!';
const stamp = crypto.randomUUID().slice(0, 8);
const RUNS = 10;
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
let companies: string[] = [];
let banks: string[] = [];
let exported: ExportResult;
let capturedMap: IdMap | null = null;

beforeAll(async () => {
  plan = await buildPortabilityPlan(db);
  archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-archives-jsonb-'));
  process.env['CL_ARCHIVE_DIR'] = archiveRoot;
  tenantId = crypto.randomUUID();
  await q(`INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)`, [tenantId, `RTJ ${stamp}`, `rtj-${stamp}`]);
  createdTenants.push(tenantId);
  const ownerId = await insertUser(tenantId, `rtj-owner-${stamp}@example.test`, false);
  callerId = await insertUser(tenantId, `rtj-caller-${stamp}@example.test`, true);
  await q(`INSERT INTO user_tenant_access (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`, [ownerId, tenantId]);
  companies = [];
  for (const name of ['RTJ One', 'RTJ Two', 'RTJ Three']) {
    companies.push((await q<{ id: string }>(`INSERT INTO companies (tenant_id, business_name, entity_type, setup_complete) VALUES ($1, $2, 'llc', true) RETURNING id`, [tenantId, name]))[0]!.id);
  }
  banks = [];
  for (let i = 0; i < 4; i++) {
    banks.push((await q<{ id: string }>(`INSERT INTO accounts (tenant_id, company_id, name, account_type, detail_type, account_number) VALUES ($1, $2, $3, 'asset', 'bank', $4) RETURNING id`,
      [tenantId, companies[0]!, `Bank ${i + 1}`, `10${i}${stamp.slice(0, 2)}`]))[0]!.id);
  }
  // One counter per bank account (the U-91 shape), plus a nested id-keyed map.
  const nextCheckNumbers = Object.fromEntries(banks.map((b, i) => [b, 1001 + 1000 * i]));
  await q(`UPDATE companies SET check_settings = $2::jsonb WHERE id = $1`, [companies[0]!, JSON.stringify({
    format: 'voucher', defaultBankAccountId: banks[1], nextCheckNumbers,
    byCompany: Object.fromEntries(companies.map((c, i) => [c, { bank: banks[i], n: i }])),
  })]);
  // The tenants row is compared on its own (verify step e): id-keyed maps there too.
  await q(`UPDATE tenants SET report_settings = $2::jsonb, practice_settings = $3::jsonb WHERE id = $1`, [tenantId,
    JSON.stringify({ theme: 'x', perCompany: Object.fromEntries(companies.map((c, i) => [c, { order: i }])) }),
    JSON.stringify({ banks: Object.fromEntries(banks.map((b, i) => [b, i])) })]);
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

describe('id-keyed jsonb round trip (U-91)', () => {
  it(`an archive with ${4} per-bank check counters imports and verifies ${RUNS} times out of ${RUNS}`, async () => {
    let reordered = 0;
    for (let run = 0; run < RUNS; run++) {
      capturedMap = null;
      const imported = await runImport({ filePath: exported.path!, passphrase: PASS, callerUserId: callerId });
      createdTenants.push(imported.tenantId);
      expect(imported.verification, `run ${run + 1}`).toMatchObject({ contentEqual: true, trialBalanceEqual: true });
      const idMap = capturedMap!;
      // The counters follow their bank accounts to the new ids, values unchanged.
      const co = await q<{ s: { nextCheckNumbers: Record<string, number>; defaultBankAccountId: string } }>(
        `SELECT check_settings AS s FROM companies WHERE tenant_id = $1 AND business_name = 'RTJ One'`, [imported.tenantId]);
      const counters = co[0]!.s.nextCheckNumbers;
      expect(counters).toEqual(Object.fromEntries(banks.map((b, i) => [idMap.get(b)!, 1001 + 1000 * i])));
      expect(co[0]!.s.defaultBankAccountId).toBe(idMap.get(banks[1]!));
      // Count the runs in which PostgreSQL really changed the key order (the case the old check refused).
      const newOrder = Object.keys(counters).map((k) => idMap.getOld(k));
      if (JSON.stringify(newOrder) !== JSON.stringify([...banks].sort())) reordered++;
    }
    // With 4 keys the new ids keep the old order with probability 1/24 per run.
    expect(reordered).toBeGreaterThan(0);
  }, 600_000);
});
