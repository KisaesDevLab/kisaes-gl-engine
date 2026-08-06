// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax-code seed importer (docs/tb/BUILD_PLAN.md Phase 2, ADR-TB-05).
// Seed versions are immutable: an import always creates a NEW version
// for its tax year (rule TB8); assignments reference codes by stable
// (activity_type, code) identity so newer versions never orphan them.
// Firm custom codes live in firm_tax_codes and are never touched here
// (standing invariant #5).

import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { taxCodeSeedVersions, taxCodes } from '../../db/schema/index.js';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../middleware/audit.js';
import { log } from '../../utils/logger.js';

export const SEED_RETURN_FORMS = ['1040', '1065', '1120', '1120S', 'common'] as const;
export const SEED_ACTIVITY_TYPES = ['common', 'business', 'rental', 'farm', 'farm_rental'] as const;
// The common/common utility rows every seed must carry (11.8a relies on
// REPORTING_ONLY; the diagnostics panel lists DONOTMAP/SUSPENSE usage).
export const REQUIRED_UTILITY_CODES = ['DONOTMAP', 'MEMO', 'SUSPENSE', 'REPORTING_ONLY'] as const;

export interface SeedRow {
  returnForm: string;
  activityType: string;
  code: string;
  description: string;
  sortOrder: number;
  isM1Adjustment: boolean;
  notes: string | null;
  ultrataxCode: string | null;
  cchCode: string | null;
  lacerteCode: string | null;
  gosystemCode: string | null;
  genericCode: string | null;
}

const HEADER = ['return_form', 'activity_type', 'tax_code', 'description', 'sort_order', 'is_m1_adjustment', 'notes', 'ultratax_code', 'cch_code', 'lacerte_code', 'gosystem_code', 'generic_code'];

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    // exceljs rich text / formula results
    const o = v as { text?: string; result?: unknown };
    if (typeof o.text === 'string') return o.text.trim();
    if (o.result !== undefined) return String(o.result).trim();
  }
  return String(v).trim();
}

function nullable(v: unknown): string | null {
  const s = cell(v);
  return s === '' ? null : s;
}

export interface ParseResult {
  rows: SeedRow[];
  errors: string[];
}

// Parses + validates the exact xlsx layout documented in
// db/seeds/tax-codes/2025/README.md. Collects up to 50 row errors so an
// admin sees the whole shape of a bad file, not just its first problem.
export async function parseSeedWorkbook(buffer: Buffer): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return { rows: [], errors: ['Workbook has no worksheets'] };

  const errors: string[] = [];
  const headerVals = (ws.getRow(1).values as unknown[]).slice(1).map(cell);
  HEADER.forEach((h, i) => {
    if ((headerVals[i] ?? '').toLowerCase() !== h) {
      errors.push(`Header column ${i + 1} expected "${h}", found "${headerVals[i] ?? ''}"`);
    }
  });
  if (errors.length) return { rows: [], errors };

  const rows: SeedRow[] = [];
  const seen = new Set<string>();
  for (let i = 2; i <= ws.rowCount; i++) {
    const v = ws.getRow(i).values as unknown[];
    // Wholly empty trailing rows are common in hand-edited sheets.
    if (v.length === 0 || v.every((x) => cell(x) === '')) continue;
    const returnForm = cell(v[1]);
    const activityType = cell(v[2]);
    const code = cell(v[3]);
    const m1Raw = cell(v[6]).toLowerCase();
    const rowErr = (msg: string) => errors.length < 50 && errors.push(`Row ${i}: ${msg}`);

    if (!(SEED_RETURN_FORMS as readonly string[]).includes(returnForm)) rowErr(`invalid return_form "${returnForm}"`);
    if (!(SEED_ACTIVITY_TYPES as readonly string[]).includes(activityType)) rowErr(`invalid activity_type "${activityType}"`);
    if (!code) rowErr('empty tax_code');
    if (m1Raw !== 'true' && m1Raw !== 'false' && m1Raw !== '') rowErr(`is_m1_adjustment must be true/false, found "${m1Raw}"`);
    const key = `${returnForm}|${activityType}|${code}`;
    if (seen.has(key)) rowErr(`duplicate (return_form, activity_type, tax_code): ${key}`);
    seen.add(key);

    rows.push({
      returnForm,
      activityType,
      code,
      description: cell(v[4]),
      sortOrder: Number(cell(v[5])) || 0,
      isM1Adjustment: m1Raw === 'true',
      notes: nullable(v[7]),
      ultrataxCode: nullable(v[8]),
      cchCode: nullable(v[9]),
      lacerteCode: nullable(v[10]),
      gosystemCode: nullable(v[11]),
      genericCode: nullable(v[12]),
    });
  }

  for (const u of REQUIRED_UTILITY_CODES) {
    if (!seen.has(`common|common|${u}`)) errors.push(`Missing required common/common utility code ${u}`);
  }
  if (rows.length === 0) errors.push('No data rows found');
  return { rows, errors };
}

export interface SeedDiff {
  added: number;
  changed: number;
  removed: number;
  samples: { added: string[]; changed: string[]; removed: string[] };
}

const rowKey = (r: { returnForm: string; activityType: string; code: string }) => `${r.returnForm}|${r.activityType}|${r.code}`;

// Diff against the latest existing version for the tax year (dry-run
// report: added / changed / removed vs prior). First import for a year
// reports everything as added.
export async function diffAgainstLatest(taxYear: number, rows: SeedRow[]): Promise<SeedDiff & { priorVersion: number | null }> {
  const [prior] = await db.select().from(taxCodeSeedVersions)
    .where(eq(taxCodeSeedVersions.taxYear, taxYear))
    .orderBy(desc(taxCodeSeedVersions.version)).limit(1);
  const diff: SeedDiff = { added: 0, changed: 0, removed: 0, samples: { added: [], changed: [], removed: [] } };
  if (!prior) {
    diff.added = rows.length;
    diff.samples.added = rows.slice(0, 10).map(rowKey);
    return { ...diff, priorVersion: null };
  }
  const priorRows = await db.select().from(taxCodes).where(eq(taxCodes.versionId, prior.id));
  const priorMap = new Map(priorRows.map((r) => [rowKey(r), r]));
  const nextKeys = new Set<string>();
  for (const r of rows) {
    const k = rowKey(r);
    nextKeys.add(k);
    const p = priorMap.get(k);
    if (!p) {
      diff.added++;
      if (diff.samples.added.length < 10) diff.samples.added.push(k);
      continue;
    }
    const changed = p.description !== r.description || p.sortOrder !== r.sortOrder ||
      p.isM1Adjustment !== r.isM1Adjustment || (p.notes ?? null) !== r.notes ||
      (p.ultrataxCode ?? null) !== r.ultrataxCode || (p.cchCode ?? null) !== r.cchCode ||
      (p.lacerteCode ?? null) !== r.lacerteCode || (p.gosystemCode ?? null) !== r.gosystemCode ||
      (p.genericCode ?? null) !== r.genericCode;
    if (changed) {
      diff.changed++;
      if (diff.samples.changed.length < 10) diff.samples.changed.push(k);
    }
  }
  for (const k of priorMap.keys()) {
    if (!nextKeys.has(k)) {
      diff.removed++;
      if (diff.samples.removed.length < 10) diff.samples.removed.push(k);
    }
  }
  return { ...diff, priorVersion: prior.version };
}

export interface ImportInput {
  taxYear: number;
  label?: string;
  buffer: Buffer;
  dryRun: boolean;
  userId?: string;
}

export async function importSeed(input: ImportInput) {
  const { rows, errors } = await parseSeedWorkbook(input.buffer);
  if (errors.length) {
    throw AppError.unprocessableEntity('Seed file failed validation', 'TB_SEED_INVALID', { errors });
  }
  const hash = createHash('sha256').update(input.buffer).digest('hex');
  const [latest] = await db.select().from(taxCodeSeedVersions)
    .where(eq(taxCodeSeedVersions.taxYear, input.taxYear))
    .orderBy(desc(taxCodeSeedVersions.version)).limit(1);
  // Idempotency: re-importing the byte-identical file is a no-op.
  if (latest && latest.sourceFileHash === hash) {
    return { unchanged: true as const, version: latest.version, versionId: latest.id, rowCount: latest.rowCount };
  }
  const diff = await diffAgainstLatest(input.taxYear, rows);
  if (input.dryRun) {
    return { unchanged: false as const, dryRun: true as const, rowCount: rows.length, diff };
  }
  const nextVersion = (latest?.version ?? 0) + 1;
  const versionId = await db.transaction(async (tx) => {
    const [ver] = await tx.insert(taxCodeSeedVersions).values({
      taxYear: input.taxYear,
      version: nextVersion,
      label: input.label ?? null,
      sourceFileHash: hash,
      rowCount: rows.length,
      importedBy: input.userId ?? null,
    }).returning();
    if (!ver) throw AppError.internal('Seed version insert failed');
    // Chunked inserts: 2,846 rows × 13 params would blow the 65k
    // parameter limit in one statement.
    const chunk = 500;
    for (let i = 0; i < rows.length; i += chunk) {
      await tx.insert(taxCodes).values(rows.slice(i, i + chunk).map((r) => ({ ...r, versionId: ver.id })));
    }
    await auditLog('00000000-0000-0000-0000-000000000000', 'create', 'tax_code_seed_version', ver.id,
      latest ? { version: latest.version, rowCount: latest.rowCount } : null,
      { taxYear: input.taxYear, version: nextVersion, rowCount: rows.length, hash },
      input.userId, tx);
    return ver.id;
  });
  log.info({ component: 'tb', event: 'seed_imported', taxYear: input.taxYear, version: nextVersion, rows: rows.length });
  return { unchanged: false as const, dryRun: false as const, version: nextVersion, versionId, rowCount: rows.length, diff };
}

export async function listVersions() {
  return db.select().from(taxCodeSeedVersions)
    .orderBy(desc(taxCodeSeedVersions.taxYear), desc(taxCodeSeedVersions.version));
}

export async function latestVersionForYear(taxYear: number) {
  const [v] = await db.select().from(taxCodeSeedVersions)
    .where(eq(taxCodeSeedVersions.taxYear, taxYear))
    .orderBy(desc(taxCodeSeedVersions.version)).limit(1);
  return v ?? null;
}

export interface BrowseFilters {
  versionId?: string;
  returnForm?: string;
  activityType?: string;
  search?: string;
  m1Only?: boolean;
  limit: number;
  offset: number;
}

export async function browseCodes(f: BrowseFilters) {
  const conds = [eq(taxCodes.versionId, f.versionId ?? '')];
  if (!f.versionId) throw AppError.badRequest('versionId is required', 'TB_SEED_INVALID');
  if (f.returnForm) conds.push(eq(taxCodes.returnForm, f.returnForm));
  if (f.activityType) conds.push(eq(taxCodes.activityType, f.activityType));
  if (f.m1Only) conds.push(eq(taxCodes.isM1Adjustment, true));
  if (f.search) {
    const term = `%${f.search}%`;
    conds.push(or(ilike(taxCodes.code, term), ilike(taxCodes.description, term))!);
  }
  const where = and(...conds);
  const [rows, countRows] = await Promise.all([
    db.select().from(taxCodes).where(where)
      .orderBy(taxCodes.returnForm, taxCodes.activityType, taxCodes.sortOrder, taxCodes.code)
      .limit(f.limit).offset(f.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(taxCodes).where(where),
  ]);
  return { codes: rows, total: countRows[0]?.count ?? 0 };
}
