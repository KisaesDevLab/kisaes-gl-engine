// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Super-admin direct CRUD on seed codes + the Excel download. Uses a
// synthetic seed version so nothing here depends on (or disturbs) the
// bundled TY2025 library.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { db, pool } from '../../db/index.js';
import {
  accountTaxAssignments, accounts, auditLog, companies, taxCodeSeedVersions, taxCodes, tenants,
} from '../../db/schema/index.js';
import { createCode, updateCode, deleteCode, exportCodesXlsx } from './tax-code-seed.service.js';

let versionId: string;
let tenantId: string;
let companyId: string;
let accountId: string;

beforeAll(async () => {
  const [ver] = await db.insert(taxCodeSeedVersions).values({
    taxYear: 2099, version: 1, label: 'admin-crud-test', sourceFileHash: `test-${Date.now()}`, rowCount: 2,
  }).returning();
  versionId = ver!.id;
  await db.insert(taxCodes).values([
    { versionId, returnForm: '1065', activityType: 'business', code: 'ADM100', description: 'Gross receipts', sortOrder: 1 },
    { versionId, returnForm: 'common', activityType: 'common', code: 'DONOTMAP', description: 'Do not map', sortOrder: 999 },
  ]);
  const [t] = await db.insert(tenants).values({ name: 'tb-admin-crud', slug: `tb-admin-crud-${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Admin CRUD Co', fiscalYearStartMonth: 1 }).returning();
  companyId = c!.id;
  const [a] = await db.insert(accounts).values({ tenantId, companyId, accountNumber: '1000', name: 'Cash', accountType: 'asset' }).returning();
  accountId = a!.id;
});

afterAll(async () => {
  await db.delete(accountTaxAssignments).where(eq(accountTaxAssignments.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  await db.delete(taxCodes).where(eq(taxCodes.versionId, versionId));
  await db.delete(auditLog).where(eq(auditLog.entityType, 'tax_code'));
  await db.delete(taxCodeSeedVersions).where(eq(taxCodeSeedVersions.id, versionId));
  await pool.end();
});

describe('admin tax-code CRUD', () => {
  it('creates a code, bumps the version row count, and audit-logs', async () => {
    const created = await createCode(versionId, {
      returnForm: '1065', activityType: 'business', code: 'ADM200',
      description: 'Returns and allowances', sortOrder: 2, isM1Adjustment: false, ultrataxCode: 'UT-200',
    });
    expect(created.code).toBe('ADM200');
    const [ver] = await db.select().from(taxCodeSeedVersions).where(eq(taxCodeSeedVersions.id, versionId));
    expect(ver!.rowCount).toBe(3);
    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, created.id));
    expect(audits.some((a) => a.action === 'create')).toBe(true);
  });

  it('rejects duplicates within the version', async () => {
    await expect(createCode(versionId, {
      returnForm: '1065', activityType: 'business', code: 'ADM100', description: 'dupe',
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('updates metadata freely, and identity only while unreferenced', async () => {
    const [row] = await db.select().from(taxCodes)
      .where(eq(taxCodes.versionId, versionId)).then((rows) => rows.filter((r) => r.code === 'ADM200'));
    const updated = await updateCode(row!.id, { description: 'R&A (updated)', lacerteCode: 'LC-9' });
    expect(updated.description).toBe('R&A (updated)');
    expect(updated.lacerteCode).toBe('LC-9');

    // Identity rename while unreferenced: allowed.
    const renamed = await updateCode(row!.id, { code: 'ADM201' });
    expect(renamed.code).toBe('ADM201');

    // Reference it, then renames/deletes must refuse.
    await db.insert(accountTaxAssignments).values({
      tenantId, companyId, accountId, activityUnitId: null,
      seedCode: 'ADM201', seedActivityType: 'business', source: 'manual',
    });
    await expect(updateCode(row!.id, { code: 'ADM202' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'TB_CODE_IN_USE' });
    await expect(deleteCode(row!.id))
      .rejects.toMatchObject({ statusCode: 409, code: 'TB_CODE_IN_USE' });

    // Metadata edits stay allowed while referenced.
    const still = await updateCode(row!.id, { description: 'still editable' });
    expect(still.description).toBe('still editable');
  });

  it('refuses to delete required utility codes, deletes normal rows', async () => {
    const rows = await db.select().from(taxCodes).where(eq(taxCodes.versionId, versionId));
    const utility = rows.find((r) => r.code === 'DONOTMAP')!;
    await expect(deleteCode(utility.id)).rejects.toMatchObject({ statusCode: 409 });

    const disposable = await createCode(versionId, {
      returnForm: '1120', activityType: 'business', code: 'ADM300', description: 'temp',
    });
    await deleteCode(disposable.id);
    const after = await db.select().from(taxCodes).where(eq(taxCodes.id, disposable.id));
    expect(after).toHaveLength(0);
    const [ver] = await db.select().from(taxCodeSeedVersions).where(eq(taxCodeSeedVersions.id, versionId));
    expect(ver!.rowCount).toBe(3); // +ADM200/ADM201, +ADM300, -ADM300
  });

  it('exports the version as a re-importable workbook', async () => {
    const file = await exportCodesXlsx(versionId);
    expect(file.fileName).toBe('tax-codes-TY2099-v1.xlsx');
    expect(file.rowCount).toBe(3);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    const header = (ws.getRow(1).values as unknown[]).slice(1).map(String);
    expect(header).toEqual([
      'return_form', 'activity_type', 'tax_code', 'description', 'sort_order',
      'is_m1_adjustment', 'notes', 'ultratax_code', 'cch_code', 'lacerte_code', 'gosystem_code', 'generic_code',
    ]);
    const codes: string[] = [];
    for (let i = 2; i <= ws.rowCount; i++) codes.push(String(ws.getRow(i).getCell(3).value ?? ''));
    expect(codes).toContain('ADM201');
    expect(codes).toContain('DONOTMAP');
  });
});
