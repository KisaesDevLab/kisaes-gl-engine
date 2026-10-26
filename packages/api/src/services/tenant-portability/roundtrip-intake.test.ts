// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// U-93: companies.intake_settings in tenant archives. Without the option the
// folders (paths included) survive export -> verify -> import exactly; with
// omitIntakeSettings the archive carries the column default, the manifest
// says so, no path is in the archive, and the import restores a company
// with no folders. Both imports must verify (the U-91 class of bug: a
// digest over a value other than the one written). Runs in server mode
// against the test database.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { INTAKE_SETTINGS_DEFAULT_JSON } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { ArchiveReader } from './archive-reader.js';
import { runExport, type ExportResult } from './export.service.js';
import { tablePartName } from './format.js';
import { runImport } from './import.service.js';
import { buildPortabilityPlan, JSON_CONFIG_COLUMNS, OMITTABLE_COLUMNS, scopeSql, type PortabilityPlan } from './plan.js';

const PASS = 'intake round trip passphrase 2026!';
const stamp = crypto.randomUUID().slice(0, 8);
const MARKER = `u93rt${stamp}`;
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
let withFolders: ExportResult;
let omitted: ExportResult;
const settingsOne = {
  version: 1,
  updatedAt: '2026-10-25T12:34:56.789Z',
  folders: [
    { id: crypto.randomUUID(), name: 'Bills', path: `\\\\nas\\scans\\${MARKER}\\bills`, defaultKind: 'bills', autoRead: false, keepOriginals: false },
    { id: crypto.randomUUID(), name: 'Receipts', path: `C:\\Users\\owner\\${MARKER}\\Receipts`, defaultKind: 'receipts', autoRead: true, keepOriginals: true },
    { id: crypto.randomUUID(), name: 'Mac', path: `/Users/owner/Dropbox/${MARKER}`, defaultKind: 'auto', autoRead: false, keepOriginals: false },
  ],
};
const settingsTwo = {
  version: 1,
  updatedAt: '2026-10-24T08:00:00.001Z',
  folders: [{ id: crypto.randomUUID(), name: 'Other', path: `D:/${MARKER}/other`, defaultKind: 'auto', autoRead: false, keepOriginals: false }],
};

beforeAll(async () => {
  plan = await buildPortabilityPlan(db);
  archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-archives-intake-'));
  process.env['CL_ARCHIVE_DIR'] = archiveRoot;
  tenantId = crypto.randomUUID();
  await q(`INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)`, [tenantId, `RTI ${stamp}`, `rti-${stamp}`]);
  createdTenants.push(tenantId);
  const ownerId = await insertUser(tenantId, `rti-owner-${stamp}@example.test`, false);
  callerId = await insertUser(tenantId, `rti-caller-${stamp}@example.test`, true);
  await q(`INSERT INTO user_tenant_access (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`, [ownerId, tenantId]);
  for (const [name, s] of [['RTI One', settingsOne], ['RTI Two', settingsTwo], ['RTI Three', null]] as const) {
    await q(`INSERT INTO companies (tenant_id, business_name, entity_type, setup_complete${s ? ', intake_settings' : ''})
             VALUES ($1, $2, 'llc', true${s ? ', $3::jsonb' : ''})`, [tenantId, name, s ? JSON.stringify(s) : null]);
  }
  withFolders = await runExport(tenantId, callerId, { passphrase: PASS, host: { app: 'ClientLedger', kind: 'backup' } });
  omitted = await runExport(tenantId, callerId, { passphrase: PASS, omitIntakeSettings: true, host: { app: 'ClientLedger', kind: 'transfer' } });
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

async function settingsByName(tid: string): Promise<Record<string, unknown>> {
  const rows = await q<{ business_name: string; s: unknown }>(`SELECT business_name, intake_settings AS s FROM companies WHERE tenant_id = $1`, [tid]);
  return Object.fromEntries(rows.map((r) => [r.business_name, r.s]));
}

async function companiesPart(file: string): Promise<string> {
  const reader = await ArchiveReader.open(file, PASS);
  return (await reader.readPart(tablePartName('companies'), 64 * 1024 * 1024)).toString('utf8');
}

describe('companies.intake_settings in tenant archives (U-93)', () => {
  it('is classified plain JSON config and omittable', () => {
    expect(JSON_CONFIG_COLUMNS['companies.intake_settings']).toBe('plain');
    expect(OMITTABLE_COLUMNS['companies.intake_settings']).toMatchObject({ option: 'omitIntakeSettings' });
    const companies = plan.byName.get('companies')!;
    expect(companies.canonical).toContain('intake_settings');
  });

  it('the omit replacement is exactly the database column default', async () => {
    const r = await q<{ d: unknown; e: unknown }>(
      `SELECT ${OMITTABLE_COLUMNS['companies.intake_settings']!.replacement}::jsonb AS d,
              (SELECT column_default FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'intake_settings') AS e`);
    expect(r[0]!.d).toEqual(JSON.parse(INTAKE_SETTINGS_DEFAULT_JSON));
    expect(String(r[0]!.e)).toContain('jsonb');
    const def = await q<{ v: unknown }>(`SELECT (${String(r[0]!.e)}) AS v`);
    expect(def[0]!.v).toEqual(JSON.parse(INTAKE_SETTINGS_DEFAULT_JSON));
  });

  it('without the option: the manifest omits nothing and the folders round-trip exactly', async () => {
    const reader = await ArchiveReader.open(withFolders.path!, PASS);
    await reader.verifyAll();
    expect(reader.manifest.options.omitIntakeSettings).toBe(false);
    expect(reader.manifest.omitted).toEqual([]);
    expect(await companiesPart(withFolders.path!)).toContain(MARKER);
    for (let run = 0; run < 3; run++) {
      const imported = await runImport({ filePath: withFolders.path!, passphrase: PASS, callerUserId: callerId });
      createdTenants.push(imported.tenantId);
      expect(imported.verification, `run ${run + 1}`).toMatchObject({ contentEqual: true, trialBalanceEqual: true });
      const got = await settingsByName(imported.tenantId);
      expect(got['RTI One']).toEqual(settingsOne);
      expect(got['RTI Two']).toEqual(settingsTwo);
      expect(got['RTI Three']).toEqual(JSON.parse(INTAKE_SETTINGS_DEFAULT_JSON));
    }
  }, 600_000);

  it('with omitIntakeSettings: the archive holds no path, verifies, and imports with no folders', async () => {
    const reader = await ArchiveReader.open(omitted.path!, PASS);
    await reader.verifyAll();
    expect(reader.manifest.options.omitIntakeSettings).toBe(true);
    expect(reader.manifest.omitted).toEqual(['companies.intake_settings']);
    const part = await companiesPart(omitted.path!);
    expect(part).not.toContain(MARKER);
    expect(part.split('\n').filter(Boolean)).toHaveLength(3);
    for (let run = 0; run < 3; run++) {
      const imported = await runImport({ filePath: omitted.path!, passphrase: PASS, callerUserId: callerId });
      createdTenants.push(imported.tenantId);
      expect(imported.verification, `run ${run + 1}`).toMatchObject({ contentEqual: true, trialBalanceEqual: true });
      const got = await settingsByName(imported.tenantId);
      for (const name of ['RTI One', 'RTI Two', 'RTI Three']) expect(got[name], name).toEqual(JSON.parse(INTAKE_SETTINGS_DEFAULT_JSON));
    }
    // The source tenant keeps its folders.
    expect((await settingsByName(tenantId))['RTI One']).toEqual(settingsOne);
    // The import audit row says no reset was asked for.
    const audit = await q<{ a: Record<string, unknown> }>(`SELECT after_data AS a FROM audit_log WHERE tenant_id = $1 AND entity_type = 'tenant_import'`, [createdTenants[createdTenants.length - 1]!]);
    expect(audit[0]!.a['resetIntakeSettings']).toBe(false);
    // No audit row of the source tenant names a path.
    const hits = await q<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1
      AND (coalesce(before_data::text, '') LIKE $2 OR coalesce(after_data::text, '') LIKE $2)`, [tenantId, `%${MARKER}%`]);
    expect(hits[0]!.n).toBe(0);
  }, 600_000);

  it('the import route takes resetIntakeSettings (default false)', async () => {
    const { importArchiveSchema } = await import('../../routes/tenant-archives.routes.js');
    expect(importArchiveSchema.parse({ passphrase: PASS }).resetIntakeSettings).toBe(false);
    expect(importArchiveSchema.parse({ passphrase: PASS, resetIntakeSettings: true }).resetIntakeSettings).toBe(true);
    expect(importArchiveSchema.safeParse({ passphrase: PASS, resetIntakeSettings: 'yes' }).success).toBe(false);
  });

  it('resetIntakeSettings on import: an archive with folders verifies and imports with no folders', async () => {
    const imported = await runImport({ filePath: withFolders.path!, passphrase: PASS, callerUserId: callerId, resetIntakeSettings: true });
    createdTenants.push(imported.tenantId);
    expect(imported.verification).toMatchObject({ contentEqual: true, trialBalanceEqual: true });
    const got = await settingsByName(imported.tenantId);
    for (const name of ['RTI One', 'RTI Two', 'RTI Three']) expect(got[name], name).toEqual(JSON.parse(INTAKE_SETTINGS_DEFAULT_JSON));
    const audit = await q<{ a: Record<string, unknown> }>(`SELECT after_data AS a FROM audit_log WHERE tenant_id = $1 AND entity_type = 'tenant_import'`, [imported.tenantId]);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.a['resetIntakeSettings']).toBe(true);
    // The source tenant keeps its folders.
    expect((await settingsByName(tenantId))['RTI One']).toEqual(settingsOne);
  }, 600_000);
});
