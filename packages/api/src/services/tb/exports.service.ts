// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Vendor exports (Phase 11, D4, rule TB11). The tax dataset pivots the
// engine's TAX column (adjusted + RJE) into tax-code lines via the
// resolved assignments; each vendor file carries that vendor's
// crosswalk code. Validation gates (11.8): unassigned accounts and
// tag-split gaps are HARD blocks; missing vendor codes for the chosen
// software are HARD blocks with resolution options; out-of-balance is
// firm-admin-overridable (11.8b), audit-logged and stamped on the
// export record. File format assumptions are documented per vendor in
// docs/tb/exports/ (11.2) — verify against live import specs before
// first client use.

import ExcelJS from 'exceljs';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  accountTaxAssignments, activityUnits, companies, firmTaxCodes, taxCodes, tbExports,
} from '../../db/schema/index.js';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../middleware/audit.js';
import { incCounter } from '../../utils/metrics.js';
import { getProviderForTenant } from '../storage/storage-provider.factory.js';
import { tenantStorageKey } from '../storage/storage-keys.js';
import { computeWorkpaper, ZERO_UUID, type TbBasis } from './balance-engine.service.js';
import { fiscalYearEnd } from './tax-profile.service.js';
import { resolveSeedVersionId } from './assignments.service.js';
import { resolveCodeFor } from './diagnostics.service.js';
import { runDiagnostics } from './diagnostics.service.js';

export const TB_EXPORT_SOFTWARE = ['ultratax', 'lacerte', 'cch', 'gosystem', 'generic', 'workingtb'] as const;
export type TbExportSoftware = typeof TB_EXPORT_SOFTWARE[number];

const VENDOR_CODE_FIELD: Record<string, 'ultrataxCode' | 'lacerteCode' | 'cchCode' | 'gosystemCode' | 'genericCode' | null> = {
  ultratax: 'ultrataxCode',
  lacerte: 'lacerteCode',
  cch: 'cchCode',
  gosystem: 'gosystemCode',
  generic: 'genericCode',
  workingtb: null, // the working TB carries our own codes, not a vendor's
};

interface CodeMeta {
  code: string;
  description: string;
  activityType: string;
  sortOrder: number;
  ultrataxCode: string | null;
  lacerteCode: string | null;
  cchCode: string | null;
  gosystemCode: string | null;
  genericCode: string | null;
}

export interface TaxDatasetLine {
  code: string;
  description: string;
  vendorCode: string | null;
  sortOrder: number;
  amount: number;
  accounts: Array<{ accountId: string; accountNumber: string | null; name: string; unitId: string; amount: number }>;
}

export interface TaxDataset {
  taxYear: number;
  periodEnd: string;
  basis: TbBasis;
  glVersionStamp: number;
  lines: TaxDatasetLine[];
  unassigned: Array<{ accountId: string; name: string }>;
  missingVendorCode: Array<{ code: string; description: string }>;
}

async function loadCodeMeta(tenantId: string, companyId: string): Promise<Map<string, CodeMeta>> {
  const versionId = await resolveSeedVersionId(tenantId, companyId);
  const meta = new Map<string, CodeMeta>();
  if (versionId) {
    const rows = await db.select().from(taxCodes).where(eq(taxCodes.versionId, versionId));
    for (const r of rows) {
      meta.set(`seed|${r.activityType}|${r.code}`, {
        code: r.code, description: r.description, activityType: r.activityType, sortOrder: r.sortOrder,
        ultrataxCode: r.ultrataxCode, lacerteCode: r.lacerteCode, cchCode: r.cchCode,
        gosystemCode: r.gosystemCode, genericCode: r.genericCode,
      });
    }
  }
  const firmRows = await db.select().from(firmTaxCodes).where(eq(firmTaxCodes.isActive, true));
  for (const r of firmRows) {
    meta.set(`firm|${r.id}`, {
      code: r.code, description: r.description, activityType: r.activityType, sortOrder: r.sortOrder,
      ultrataxCode: r.ultrataxCode, lacerteCode: r.lacerteCode, cchCode: r.cchCode,
      gosystemCode: r.gosystemCode, genericCode: r.genericCode,
    });
  }
  return meta;
}

export async function buildTaxDataset(
  tenantId: string,
  companyId: string,
  opts: { taxYear: number; basis: TbBasis; software: TbExportSoftware },
): Promise<TaxDataset> {
  const [company] = await db.select({ m: companies.fiscalYearStartMonth }).from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId))).limit(1);
  if (!company) throw AppError.notFound('Company not found');
  const periodEnd = fiscalYearEnd(opts.taxYear, company.m ?? 1);
  const wp = await computeWorkpaper(tenantId, companyId, { periodEnd, basis: opts.basis, taxYear: opts.taxYear });
  const assignments = await db.select().from(accountTaxAssignments)
    .where(and(eq(accountTaxAssignments.tenantId, tenantId), eq(accountTaxAssignments.companyId, companyId)));
  const meta = await loadCodeMeta(tenantId, companyId);
  const vendorField = VENDOR_CODE_FIELD[opts.software];

  const byCode = new Map<string, TaxDatasetLine>();
  const unassigned: TaxDataset['unassigned'] = [];
  for (const row of wp.rows) {
    if (row.isVirtualRe) {
      // Prior-years RE is a computed row; it flows through the real RE
      // account's assignment when one exists, else stays book-only.
      continue;
    }
    const units = row.units.length ? row.units : [{ unitId: ZERO_UUID, unadjusted: row.unadjusted, aje: row.aje, adjusted: row.adjusted, taxRje: row.taxRje, tax: row.tax }];
    let anyResolved = false;
    for (const u of units) {
      if (Math.abs(u.tax) < 0.005) continue;
      const assignment = resolveCodeFor(assignments, row.accountId, u.unitId);
      if (!assignment) continue;
      anyResolved = true;
      const key = assignment.firmCodeId ? `firm|${assignment.firmCodeId}` : `seed|${(assignment as { seedActivityType?: string }).seedActivityType}|${assignment.seedCode}`;
      const m = meta.get(key);
      if (!m) continue;
      let line = byCode.get(key);
      if (!line) {
        line = {
          code: m.code,
          description: m.description,
          vendorCode: vendorField ? m[vendorField] : m.code,
          sortOrder: m.sortOrder,
          amount: 0,
          accounts: [],
        };
        byCode.set(key, line);
      }
      line.amount = Math.round((line.amount + u.tax) * 100) / 100;
      line.accounts.push({ accountId: row.accountId, accountNumber: row.accountNumber, name: row.name, unitId: u.unitId, amount: u.tax });
    }
    const hasBalance = Math.abs(row.tax) >= 0.005;
    if (!anyResolved && hasBalance) {
      unassigned.push({ accountId: row.accountId, name: row.name });
    }
  }

  const lines = [...byCode.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  const missingVendorCode = vendorField
    ? lines.filter((l) => !l.vendorCode && l.code !== 'DONOTMAP')
      .map((l) => ({ code: l.code, description: l.description }))
    : [];

  return {
    taxYear: opts.taxYear,
    periodEnd,
    basis: opts.basis,
    glVersionStamp: wp.glVersionStamp,
    lines: lines.filter((l) => l.code !== 'DONOTMAP'),
    unassigned,
    missingVendorCode,
  };
}

export interface ExportValidation {
  balanced: boolean;
  unassigned: TaxDataset['unassigned'];
  missingVendorCode: TaxDataset['missingVendorCode'];
  splitGaps: number;
  hardBlocked: boolean;
  overridableBlocked: boolean;
  ready: boolean;
}

export async function validateForExport(
  tenantId: string,
  companyId: string,
  opts: { taxYear: number; basis: TbBasis; software: TbExportSoftware },
): Promise<{ validation: ExportValidation; dataset: TaxDataset }> {
  const dataset = await buildTaxDataset(tenantId, companyId, opts);
  const diag = await runDiagnostics(tenantId, companyId, { periodEnd: dataset.periodEnd, basis: opts.basis, taxYear: opts.taxYear });
  const outOfBalance = diag.diagnostics.some((d) => d.kind === 'out_of_balance');
  const splitGaps = diag.diagnostics.filter((d) => d.kind === 'split_gap').length;
  const hardBlocked = dataset.unassigned.length > 0 || dataset.missingVendorCode.length > 0 || splitGaps > 0;
  const validation: ExportValidation = {
    balanced: !outOfBalance,
    unassigned: dataset.unassigned,
    missingVendorCode: dataset.missingVendorCode,
    splitGaps,
    hardBlocked,
    overridableBlocked: outOfBalance,
    ready: !hardBlocked && !outOfBalance,
  };
  return { validation, dataset };
}

// ── File builders ───────────────────────────────────────────────────

function csv(rows: string[][]): Buffer {
  const esc = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return Buffer.from(rows.map((r) => r.map(esc).join(',')).join('\n') + '\n', 'utf8');
}

async function buildVendorFile(software: TbExportSoftware, dataset: TaxDataset, companyName: string, unitNames: Map<string, string>): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
  const stamp = dataset.periodEnd.replace(/-/g, '');
  if (software === 'workingtb') {
    // Excel working trial balance (11.7a) is built by the caller with
    // full five-column data; not reachable here.
    throw AppError.internal('workingtb is built via buildWorkingTbXlsx');
  }
  if (software === 'generic') {
    const rows: string[][] = [['tax_code', 'description', 'ultratax_code', 'cch_code', 'lacerte_code', 'gosystem_code', 'generic_code', 'activity_unit', 'amount']];
    for (const l of dataset.lines) {
      for (const a of l.accounts) {
        rows.push([
          l.code, l.description, '', '', '', '', l.vendorCode ?? '',
          unitNames.get(a.unitId) ?? '', a.amount.toFixed(2),
        ]);
      }
    }
    return { buffer: csv(rows), fileName: `tb-generic-${stamp}.csv`, mimeType: 'text/csv' };
  }
  if (software === 'ultratax') {
    // UltraTax CS Excel import layout (docs/tb/exports/ultratax.md):
    // one row per (vendor code, activity unit) with the tax-basis amount.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('UltraTax Import');
    ws.addRow(['Tax Code', 'Description', 'Unit', 'Amount']);
    ws.getRow(1).font = { bold: true };
    for (const l of dataset.lines) {
      const byUnit = new Map<string, number>();
      for (const a of l.accounts) byUnit.set(a.unitId, (byUnit.get(a.unitId) ?? 0) + a.amount);
      for (const [unitId, amount] of byUnit) {
        ws.addRow([l.vendorCode ?? l.code, l.description, unitNames.get(unitId) ?? '', Math.round(amount * 100) / 100]);
      }
    }
    ws.getColumn(4).numFmt = '#,##0.00';
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return { buffer, fileName: `tb-ultratax-${stamp}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }
  // Lacerte / CCH / GoSystem: CSV of (vendor code, description, amount).
  const rows: string[][] = [['code', 'description', 'amount']];
  for (const l of dataset.lines) {
    rows.push([l.vendorCode ?? l.code, l.description, l.amount.toFixed(2)]);
  }
  return { buffer: csv(rows), fileName: `tb-${software}-${stamp}.csv`, mimeType: 'text/csv' };
}

// Excel working trial balance (11.7a): five columns + code + unit,
// grouped subtotals, tabular numerals.
export async function buildWorkingTbXlsx(tenantId: string, companyId: string, opts: { taxYear: number; basis: TbBasis }): Promise<{ buffer: Buffer; fileName: string; mimeType: string; glVersionStamp: number; rowCount: number }> {
  const [company] = await db.select({ m: companies.fiscalYearStartMonth, name: companies.businessName }).from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId))).limit(1);
  if (!company) throw AppError.notFound('Company not found');
  const periodEnd = fiscalYearEnd(opts.taxYear, company.m ?? 1);
  const wp = await computeWorkpaper(tenantId, companyId, { periodEnd, basis: opts.basis, taxYear: opts.taxYear });
  const assignments = await db.select().from(accountTaxAssignments)
    .where(and(eq(accountTaxAssignments.tenantId, tenantId), eq(accountTaxAssignments.companyId, companyId)));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Working TB');
  ws.addRow([`${company.name} — Working Trial Balance`, '', '', '', '', '', '', '']);
  ws.addRow([`Tax year ${opts.taxYear} · FY end ${periodEnd} · ${opts.basis} basis`]);
  ws.addRow([]);
  const header = ws.addRow(['Acct #', 'Account', 'Unadjusted', 'AJE', 'Adjusted', 'Tax RJE', 'Tax', 'Tax Code']);
  header.font = { bold: true };
  ws.getRow(1).font = { bold: true, size: 14 };

  const sections: Array<[string, (t: string) => boolean]> = [
    ['Assets', (t) => t === 'asset'],
    ['Liabilities', (t) => t === 'liability'],
    ['Equity', (t) => t === 'equity'],
    ['Revenue', (t) => t === 'revenue'],
    ['Expenses', (t) => t === 'expense'],
  ];
  let rowCount = 0;
  for (const [label, match] of sections) {
    const rows = wp.rows.filter((r) => match(r.accountType));
    if (rows.length === 0) continue;
    const sec = ws.addRow([label]);
    sec.font = { bold: true };
    const totals = { unadjusted: 0, aje: 0, adjusted: 0, taxRje: 0, tax: 0 };
    for (const r of rows) {
      const assignment = resolveCodeFor(assignments, r.accountId, r.units[0]?.unitId ?? ZERO_UUID);
      ws.addRow([
        r.accountNumber ?? '', r.name,
        r.unadjusted, r.aje, r.adjusted, r.taxRje, r.tax,
        assignment?.seedCode ?? (assignment?.firmCodeId ? 'FIRM' : ''),
      ]);
      totals.unadjusted += r.unadjusted;
      totals.aje += r.aje;
      totals.adjusted += r.adjusted;
      totals.taxRje += r.taxRje;
      totals.tax += r.tax;
      rowCount++;
    }
    const st = ws.addRow(['', `Total ${label}`, totals.unadjusted, totals.aje, totals.adjusted, totals.taxRje, totals.tax, '']);
    st.font = { bold: true };
  }
  for (const col of [3, 4, 5, 6, 7]) ws.getColumn(col).numFmt = '#,##0.00;(#,##0.00)';
  ws.getColumn(2).width = 40;
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return {
    buffer,
    fileName: `working-tb-${periodEnd.replace(/-/g, '')}-${opts.basis}.xlsx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    glVersionStamp: wp.glVersionStamp,
    rowCount,
  };
}

// ── Generate + history ─────────────────────────────────────────────

export async function generateExport(
  tenantId: string,
  companyId: string,
  opts: { taxYear: number; basis: TbBasis; software: TbExportSoftware; overrideConfirmed?: boolean; isFirmAdmin?: boolean },
  userId?: string,
) {
  let buffer: Buffer;
  let fileName: string;
  let mimeType: string;
  let glVersionStamp: number;
  let rowCount: number;
  let overrideUsed = false;

  if (opts.software === 'workingtb') {
    const file = await buildWorkingTbXlsx(tenantId, companyId, opts);
    ({ buffer, fileName, mimeType, glVersionStamp, rowCount } = file);
  } else {
    const { validation, dataset } = await validateForExport(tenantId, companyId, opts);
    if (validation.hardBlocked) {
      throw AppError.unprocessableEntity('Export blocked — resolve the validation findings first', 'TB_EXPORT_BLOCKED', {
        unassigned: validation.unassigned.slice(0, 20),
        missingVendorCode: validation.missingVendorCode.slice(0, 20),
        splitGaps: validation.splitGaps,
      });
    }
    if (validation.overridableBlocked) {
      // 11.8b: only a firm admin may push through an out-of-balance TB.
      if (!(opts.overrideConfirmed && opts.isFirmAdmin)) {
        throw AppError.unprocessableEntity('Trial balance is out of balance', 'TB_EXPORT_BLOCKED', {
          outOfBalance: true,
          canOverride: !!opts.isFirmAdmin,
        });
      }
      overrideUsed = true;
      await auditLog(tenantId, 'override', 'tb_export_balance_override', companyId,
        null, { software: opts.software, taxYear: opts.taxYear }, userId);
    }
    const [company] = await db.select({ name: companies.businessName }).from(companies)
      .where(eq(companies.id, companyId)).limit(1);
    const units = await db.select().from(activityUnits).where(eq(activityUnits.companyId, companyId));
    const unitNames = new Map(units.map((u) => [u.id, `${u.displayName}`]));
    const file = await buildVendorFile(opts.software, dataset, company?.name ?? '', unitNames);
    ({ buffer, fileName, mimeType } = file);
    glVersionStamp = dataset.glVersionStamp;
    rowCount = dataset.lines.length;
  }

  const provider = await getProviderForTenant(tenantId);
  const key = tenantStorageKey(tenantId, 'reports', 'tb-exports', companyId, `${Date.now()}-${fileName}`);
  const result = await provider.upload(key, buffer, { fileName, mimeType, sizeBytes: buffer.length });

  const [record] = await db.insert(tbExports).values({
    tenantId, companyId,
    taxYear: opts.taxYear,
    software: opts.software,
    basis: opts.basis,
    glVersionStamp,
    overrideUsed,
    fileName,
    storageKey: result.key,
    storageProvider: (result as { provider?: string }).provider ?? null,
    rowCount,
    createdBy: userId ?? null,
  }).returning();
  await auditLog(tenantId, 'create', 'tb_export', record!.id, null,
    { software: opts.software, taxYear: opts.taxYear, basis: opts.basis, glVersionStamp, overrideUsed }, userId);
  incCounter('tb_exports_total', 'TB vendor exports generated', { software: opts.software, override: String(overrideUsed) });
  return record!;
}

export async function listExports(tenantId: string, companyId: string, taxYear?: number) {
  const conds = [eq(tbExports.tenantId, tenantId), eq(tbExports.companyId, companyId)];
  if (taxYear) conds.push(eq(tbExports.taxYear, taxYear));
  return db.select().from(tbExports).where(and(...conds))
    .orderBy(desc(tbExports.createdAt)).limit(100);
}

export async function downloadExport(tenantId: string, companyId: string, id: string) {
  const [record] = await db.select().from(tbExports)
    .where(and(eq(tbExports.id, id), eq(tbExports.tenantId, tenantId), eq(tbExports.companyId, companyId)))
    .limit(1);
  if (!record) throw AppError.notFound('Export not found');
  const provider = await getProviderForTenant(tenantId);
  const buffer = await provider.download(record.storageKey);
  return { record, buffer };
}
