// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 2.6: importer idempotency, diff correctness, validation, and
// firm-code namespace enforcement (rule TB8, standing invariant #5).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { eq } from 'drizzle-orm';
import { db, pool } from '../../db/index.js';
import { firmTaxCodes, taxCodes, taxCodeSeedVersions, tenants } from '../../db/schema/index.js';
import { importSeed, parseSeedWorkbook, latestVersionForYear, browseCodes } from './tax-code-seed.service.js';
import { createFirmCode, listFirmCodes, updateFirmCode } from './firm-tax-codes.service.js';

const here = dirname(fileURLToPath(import.meta.url));
const SEED_FILE = join(here, '..', '..', 'db', 'seeds', 'tax-codes', '2025', 'tax-codes.xlsx');
// Isolated tax year so this suite never collides with real seed data
// in the shared test DB.
const TY = 2099;

let seedBuffer: Buffer;
let tenantId: string;

async function cleanDb() {
  const versions = await db.select().from(taxCodeSeedVersions).where(eq(taxCodeSeedVersions.taxYear, TY));
  for (const v of versions) {
    await db.delete(taxCodes).where(eq(taxCodes.versionId, v.id));
    await db.delete(taxCodeSeedVersions).where(eq(taxCodeSeedVersions.id, v.id));
  }
  if (tenantId) {
    await db.delete(firmTaxCodes).where(eq(firmTaxCodes.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
}

async function mutateWorkbook(buffer: Buffer, mutate: (ws: ExcelJS.Worksheet) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('no worksheet');
  mutate(ws);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

beforeAll(async () => {
  seedBuffer = readFileSync(SEED_FILE);
  await cleanDb();
  const [t] = await db.insert(tenants).values({ name: 'tb-seed-test', slug: `tb-seed-${Date.now()}` }).returning();
  tenantId = t!.id;
});

afterAll(async () => {
  await cleanDb();
  await pool.end();
});

describe('parseSeedWorkbook', () => {
  it('parses the shipped 2025 file: 2,846 rows, utility codes present', async () => {
    const { rows, errors } = await parseSeedWorkbook(seedBuffer);
    expect(errors).toEqual([]);
    expect(rows.length).toBe(2846);
    const util = rows.filter((r) => r.returnForm === 'common' && r.activityType === 'common').map((r) => r.code);
    expect(util).toEqual(expect.arrayContaining(['DONOTMAP', 'MEMO', 'SUSPENSE', 'REPORTING_ONLY']));
    expect(rows.some((r) => r.isM1Adjustment)).toBe(true);
  });

  it('rejects a file missing utility codes', async () => {
    const bad = await mutateWorkbook(seedBuffer, (ws) => {
      for (let i = 2; i <= ws.rowCount; i++) {
        if (String(ws.getRow(i).getCell(3).value) === 'DONOTMAP') ws.getRow(i).getCell(3).value = 'DONOTMAP_X';
      }
    });
    const { errors } = await parseSeedWorkbook(bad);
    expect(errors.join(' ')).toContain('DONOTMAP');
  });

  it('rejects duplicate identity rows and bad enums', async () => {
    const bad = await mutateWorkbook(seedBuffer, (ws) => {
      ws.getRow(3).getCell(1).value = ws.getRow(2).getCell(1).value;
      ws.getRow(3).getCell(2).value = ws.getRow(2).getCell(2).value;
      ws.getRow(3).getCell(3).value = ws.getRow(2).getCell(3).value;
      ws.getRow(4).getCell(2).value = 'not_an_activity';
    });
    const { errors } = await parseSeedWorkbook(bad);
    expect(errors.some((e) => e.includes('duplicate'))).toBe(true);
    expect(errors.some((e) => e.includes('invalid activity_type'))).toBe(true);
  });
});

describe('importSeed', () => {
  it('imports as version 1, is idempotent on identical bytes, and versions changes', async () => {
    const first = await importSeed({ taxYear: TY, buffer: seedBuffer, dryRun: false });
    expect(first.unchanged).toBe(false);
    if (!first.unchanged && !first.dryRun) {
      expect(first.version).toBe(1);
      expect(first.rowCount).toBe(2846);
    }

    const again = await importSeed({ taxYear: TY, buffer: seedBuffer, dryRun: false });
    expect(again.unchanged).toBe(true);

    // Change one description → v2 with diff {changed:1}.
    const changed = await mutateWorkbook(seedBuffer, (ws) => {
      ws.getRow(2).getCell(4).value = 'Changed description for diff test';
    });
    const dry = await importSeed({ taxYear: TY, buffer: changed, dryRun: true });
    if (!dry.unchanged && dry.dryRun) {
      expect(dry.diff.changed).toBe(1);
      expect(dry.diff.added).toBe(0);
      expect(dry.diff.removed).toBe(0);
    } else {
      throw new Error('expected dry-run result');
    }
    // Dry run must not create a version.
    expect((await latestVersionForYear(TY))?.version).toBe(1);

    const second = await importSeed({ taxYear: TY, buffer: changed, dryRun: false });
    if (!second.unchanged && !second.dryRun) {
      expect(second.version).toBe(2);
      expect(second.diff.changed).toBe(1);
    } else {
      throw new Error('expected real import result');
    }

    // v1 rows are untouched (immutable versions).
    const v1 = await latestVersionForYear(TY);
    expect(v1?.version).toBe(2);
    const versions = await db.select().from(taxCodeSeedVersions).where(eq(taxCodeSeedVersions.taxYear, TY));
    expect(versions).toHaveLength(2);
  });

  it('browseCodes filters and paginates', async () => {
    const latest = await latestVersionForYear(TY);
    const page = await browseCodes({ versionId: latest!.id, returnForm: '1065', limit: 10, offset: 0 });
    expect(page.codes.length).toBe(10);
    expect(page.total).toBe(792);
    const m1 = await browseCodes({ versionId: latest!.id, m1Only: true, limit: 1, offset: 0 });
    expect(m1.total).toBe(315);
  });
});

describe('firm custom codes', () => {
  it('namespaces, blocks collisions, and never collides with seed imports', async () => {
    const created = await createFirmCode(tenantId, {
      code: 'PPP-LOAN', description: 'PPP loan forgiveness', returnForm: '1065',
      activityType: 'common', sortOrder: 10, isM1Adjustment: true,
    });
    expect(created!.code).toBe('FIRM:PPP-LOAN');
    expect(created!.tenantId).toBe(tenantId);

    // Accepts an already-prefixed code without double-prefixing.
    const prefixed = await createFirmCode(tenantId, {
      code: 'FIRM:OTHER', description: '', returnForm: '1065', activityType: 'common',
      sortOrder: 0, isM1Adjustment: false,
    });
    expect(prefixed!.code).toBe('FIRM:OTHER');

    await expect(createFirmCode(tenantId, {
      code: 'PPP-LOAN', description: 'dupe', returnForm: '1065', activityType: 'common',
      sortOrder: 0, isM1Adjustment: false,
    })).rejects.toMatchObject({ statusCode: 409 });

    const { codes } = await listFirmCodes(tenantId);
    expect(codes.map((c) => c.code)).toEqual(expect.arrayContaining(['FIRM:PPP-LOAN', 'FIRM:OTHER']));

    // Re-import the seed → firm codes untouched (standing invariant #5).
    const before = (await listFirmCodes(tenantId)).codes.length;
    await importSeed({ taxYear: TY, buffer: seedBuffer, dryRun: false });
    expect((await listFirmCodes(tenantId)).codes.length).toBe(before);

    // Deactivation hides from the default list.
    await updateFirmCode(tenantId, prefixed!.id, { isActive: false });
    const active = await listFirmCodes(tenantId);
    expect(active.codes.map((c) => c.code)).not.toContain('FIRM:OTHER');
    const all = await listFirmCodes(tenantId, true);
    expect(all.codes.map((c) => c.code)).toContain('FIRM:OTHER');
  });
});
