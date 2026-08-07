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
import { companyTaxProfiles,
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
import { resolveOwner } from './firm-tax-codes.service.js';
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
  // Stable dataset key ('seed|activity|code' or 'firm|id') — the
  // consolidation prefs map keys on it.
  key: string;
  code: string;
  description: string;
  vendorCode: string | null;
  sortOrder: number;
  amount: number;
  bookAmount: number;
  // Set when the entity consolidates this code: the file emits ONE
  // line under the custom export code instead of per-account rows.
  consolidated: { exportCode: string; description: string } | null;
  accounts: Array<{ accountId: string; accountNumber: string | null; name: string; unitId: string; amount: number; bookAmount: number }>;
}

export interface ConsolidationPref { exportCode: string; description: string }
export type ConsolidationPrefs = Record<string, ConsolidationPref>;

const readConsolidationPrefs = (raw: unknown): ConsolidationPrefs => {
  if (!raw || typeof raw !== 'object') return {};
  const out: ConsolidationPrefs = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v && typeof v === 'object' && typeof (v as ConsolidationPref).exportCode === 'string' && (v as ConsolidationPref).exportCode.trim()) {
      out[k] = {
        exportCode: (v as ConsolidationPref).exportCode,
        description: typeof (v as ConsolidationPref).description === 'string' ? (v as ConsolidationPref).description : '',
      };
    }
  }
  return out;
};

export interface TaxDataset {
  taxYear: number;
  periodEnd: string;
  basis: TbBasis;
  glVersionStamp: number;
  consolidationPrefs: ConsolidationPrefs;
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
  const owner = await resolveOwner(tenantId);
  const firmRows = await db.select().from(firmTaxCodes)
    .where(and(
      eq(firmTaxCodes.isActive, true),
      owner.firmId ? eq(firmTaxCodes.firmId, owner.firmId) : eq(firmTaxCodes.tenantId, tenantId),
    ));
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
  const [profile] = await db.select({ prefs: companyTaxProfiles.consolidationPrefs }).from(companyTaxProfiles)
    .where(and(eq(companyTaxProfiles.tenantId, tenantId), eq(companyTaxProfiles.companyId, companyId))).limit(1);
  const consolidationPrefs = readConsolidationPrefs(profile?.prefs);

  const byCode = new Map<string, TaxDatasetLine>();
  const unassigned: TaxDataset['unassigned'] = [];
  for (const row of wp.rows) {
    if (row.isVirtualRe) {
      // Prior-years RE has no real account to assign — surface it so
      // the preparer designates a Retained Earnings account instead of
      // the balance silently missing from the file.
      if (Math.abs(row.tax) >= 0.005) {
        unassigned.push({ accountId: row.accountId, name: `${row.name} (designate a Retained Earnings account)` });
      }
      continue;
    }
    const units = row.units.length ? row.units : [{ unitId: ZERO_UUID, unadjusted: row.unadjusted, aje: row.aje, adjusted: row.adjusted, taxRje: row.taxRje, tax: row.tax }];
    let dropped = false;
    for (const u of units) {
      if (Math.abs(u.tax) < 0.005) continue;
      const assignment = resolveCodeFor(assignments, row.accountId, u.unitId);
      if (!assignment) {
        // A unit split with balance and no resolvable code would drop
        // one side of a balanced entry from the file — hard finding.
        dropped = true;
        continue;
      }
      const key = assignment.firmCodeId ? `firm|${assignment.firmCodeId}` : `seed|${(assignment as { seedActivityType?: string }).seedActivityType}|${assignment.seedCode}`;
      const m = meta.get(key);
      if (!m) continue;
      let line = byCode.get(key);
      if (!line) {
        const pref = consolidationPrefs[key] ?? null;
        line = {
          key,
          code: m.code,
          description: m.description,
          // Consolidation does NOT change the software code (Vibe TB
          // reference: the custom "Export as" values replace the
          // ACCOUNT identity on the consolidated row; the tax-line
          // mapping stays).
          vendorCode: vendorField ? m[vendorField] : m.code,
          sortOrder: m.sortOrder,
          amount: 0,
          bookAmount: 0,
          consolidated: pref,
          accounts: [],
        };
        byCode.set(key, line);
      }
      // Accumulate raw and round once at the end — per-addition rounding
      // drifts on cash-basis allocation dust.
      line.amount = line.amount + u.tax;
      line.bookAmount = line.bookAmount + u.adjusted;
      line.accounts.push({ accountId: row.accountId, accountNumber: row.accountNumber, name: row.name, unitId: u.unitId, amount: u.tax, bookAmount: u.adjusted });
    }
    if (dropped) {
      unassigned.push({ accountId: row.accountId, name: row.name });
    }
  }
  for (const line of byCode.values()) {
    line.amount = Math.round(line.amount * 100) / 100;
    line.bookAmount = Math.round(line.bookAmount * 100) / 100;
  }

  const lines = [...byCode.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  // 11.8a applies to real vendor imports only — the generic CSV is the
  // full-detail export and tolerates empty crosswalk cells.
  const requiresVendorCode = vendorField !== null && opts.software !== 'generic';
  const missingVendorCode = requiresVendorCode
    ? lines.filter((l) => !l.vendorCode && l.code !== 'DONOTMAP')
      .map((l) => ({ code: l.code, description: l.description }))
    : [];

  return {
    taxYear: opts.taxYear,
    periodEnd,
    basis: opts.basis,
    glVersionStamp: wp.glVersionStamp,
    consolidationPrefs,
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
// Byte-compatible with the Vibe Trial Balance reference implementation
// (server/src/routes/exports.ts there): one row per account (or per
// account×unit slice when a book splits activities — the slice carries
// the unit number as an account-number suffix), BOTH Book Basis and
// Tax Basis amount columns, debits positive with no normal-balance
// flip, ExcelJS .xlsx for every target, exact sheet names / headers /
// widths / styling, and consolidation that replaces the ACCOUNT
// identity (consolidated block first, ordered by tax-code sort order,
// then pass-through rows by account number).

// Leading-character formula guard — identical to the reference
// sanitizeCell (= + - @ tab CR get a leading apostrophe).
function sanitizeCell<T>(value: T): T | string {
  if (typeof value !== 'string' || value.length === 0) return value;
  const first = value.charCodeAt(0);
  if (first === 0x3D || first === 0x2B || first === 0x2D || first === 0x40 || first === 0x09 || first === 0x0D) {
    return `'${value}`;
  }
  return value;
}

async function buildRefExcel(
  sheetName: string,
  columns: Array<{ header: string; key: string; width: number; numFmt?: string }>,
  rowData: Array<Record<string, unknown>>,
  opts: { centerHeader?: boolean } = { centerHeader: true },
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Trial Balance App';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName);
  ws.columns = columns.map(({ header: _h, ...rest }) => rest);
  const headerRow = ws.addRow(columns.map((c) => c.header));
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  // The reference's CCH route skips header centering; every other
  // format centers it.
  if (opts.centerHeader !== false) headerRow.alignment = { horizontal: 'center' };
  for (const row of rowData) {
    const dataRow = ws.addRow(columns.map((c) => sanitizeCell(row[c.key])));
    for (let i = 0; i < columns.length; i++) {
      if (columns[i]!.numFmt) dataRow.getCell(i + 1).numFmt = columns[i]!.numFmt!;
    }
  }
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export interface UnitInfo { name: string; number: number | null }

// Account-grain export row (reference grain). `key` is the resolved
// tax-code dataset key (consolidation groups on it).
interface ExportAccountRow {
  accountNumber: string;
  accountName: string;
  key: string | null;
  code: string;            // canonical tax code ('' when unresolved)
  description: string;     // canonical description
  vendorCode: string;      // software crosswalk code ('' when absent)
  sortOrder: number;
  bookAmt: number;
  taxAmt: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Flatten the code-pivot dataset back to account grain, splitting
// account×unit slices (suffix `-N`) and re-sorting by account number
// ASC like the reference's `coa.account_number ASC`.
function toAccountRows(dataset: TaxDataset, unitInfo: Map<string, UnitInfo>): ExportAccountRow[] {
  const rows: ExportAccountRow[] = [];
  for (const l of dataset.lines) {
    for (const a of l.accounts) {
      const unitNumber = unitInfo.get(a.unitId)?.number ?? null;
      const suffix = unitNumber != null ? `-${unitNumber}` : '';
      rows.push({
        accountNumber: `${a.accountNumber ?? ''}${suffix}`,
        accountName: a.name,
        key: l.key,
        code: l.code,
        description: l.description,
        vendorCode: l.vendorCode ?? '',
        sortOrder: l.sortOrder,
        bookAmt: round2(a.bookAmount),
        taxAmt: round2(a.amount),
      });
    }
  }
  rows.sort((x, y) => x.accountNumber.localeCompare(y.accountNumber));
  return rows;
}

// Reference consolidateRows: selected tax codes collapse to ONE row
// whose account identity is the custom "Export as" number/description;
// the software code stays the tax line's. Consolidated block first
// (tax-code sort order), pass-through rows after (account number ASC).
function consolidateAccountRows(rows: ExportAccountRow[], prefs: ConsolidationPrefs): ExportAccountRow[] {
  const keys = new Set(Object.keys(prefs));
  if (keys.size === 0) return rows;
  const passThrough: ExportAccountRow[] = [];
  const groups = new Map<string, ExportAccountRow[]>();
  for (const r of rows) {
    if (r.key && keys.has(r.key)) {
      const g = groups.get(r.key) ?? [];
      g.push(r);
      groups.set(r.key, g);
    } else {
      passThrough.push(r);
    }
  }
  const consolidated: ExportAccountRow[] = [];
  for (const [key, members] of groups) {
    const first = members[0]!;
    const pref = prefs[key]!;
    consolidated.push({
      ...first,
      accountNumber: pref.exportCode || first.accountNumber,
      accountName: pref.description || first.accountName,
      bookAmt: round2(members.reduce((s, m) => s + m.bookAmt, 0)),
      taxAmt: round2(members.reduce((s, m) => s + m.taxAmt, 0)),
    });
  }
  // Reference hard failure: a consolidated identity colliding with a
  // pass-through account number is a 409 DUPLICATE_ACCOUNT.
  const existing = new Set(passThrough.map((r) => r.accountNumber.toLowerCase()));
  for (const c of consolidated) {
    if (existing.has(c.accountNumber.toLowerCase())) {
      throw AppError.conflict(
        `Consolidated account number "${c.accountNumber}" conflicts with an existing account in the export. Choose a different number.`,
        'DUPLICATE_ACCOUNT',
      );
    }
  }
  consolidated.sort((a, b) => a.sortOrder - b.sortOrder);
  return [...consolidated, ...passThrough];
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function buildVendorFile(
  software: TbExportSoftware,
  dataset: TaxDataset,
  companyName: string,
  unitNames: Map<string, string>,
  unitInfo: Map<string, UnitInfo> = new Map(),
  consolidationPrefs: ConsolidationPrefs = {},
): Promise<{ buffer: Buffer; fileName: string; mimeType: string; rowCount: number }> {
  void companyName; void unitNames;
  const stamp = dataset.periodEnd.replace(/-/g, '');
  if (software === 'workingtb') {
    throw AppError.internal('workingtb is built via buildWorkingTbXlsx');
  }
  const rows = consolidateAccountRows(toAccountRows(dataset, unitInfo), consolidationPrefs);
  const amt = { width: 18, numFmt: '#,##0.00' };

  if (software === 'ultratax') {
    const buffer = await buildRefExcel('UltraTax CS Export', [
      { header: 'AccountNumber', key: 'acct', width: 18 },
      { header: 'AccountName', key: 'name', width: 40 },
      { header: 'TaxCode', key: 'code', width: 18 },
      { header: 'Book Basis Amt', key: 'bookAmt', ...amt },
      { header: 'Tax Basis Amt', key: 'taxAmt', ...amt },
    ], rows.map((r) => ({ acct: r.accountNumber, name: r.accountName, code: r.vendorCode, bookAmt: r.bookAmt, taxAmt: r.taxAmt })));
    return { buffer, fileName: `ultratax-export-${stamp}.xlsx`, mimeType: XLSX_MIME, rowCount: rows.length };
  }
  if (software === 'cch') {
    const buffer = await buildRefExcel('CCH Axcess Export', [
      { header: 'AccountNumber', key: 'acct', width: 18 },
      { header: 'AccountName', key: 'name', width: 40 },
      { header: 'CCHCode', key: 'code', width: 18 },
      { header: 'Description', key: 'desc', width: 40 },
      { header: 'Book Basis Amt', key: 'bookAmt', ...amt },
      { header: 'Tax Basis Amt', key: 'taxAmt', ...amt },
    ], rows.map((r) => ({ acct: r.accountNumber, name: r.accountName, code: r.vendorCode, desc: '', bookAmt: r.bookAmt, taxAmt: r.taxAmt })),
    { centerHeader: false });
    return { buffer, fileName: `cch-export-${stamp}.xlsx`, mimeType: XLSX_MIME, rowCount: rows.length };
  }
  if (software === 'lacerte' || software === 'gosystem') {
    const sheet = software === 'lacerte' ? 'Lacerte Export' : 'GoSystem Tax RS Export';
    const buffer = await buildRefExcel(sheet, [
      { header: 'LineCode', key: 'code', width: 18 },
      { header: 'Description', key: 'name', width: 40 },
      { header: 'Book Basis Amt', key: 'bookAmt', ...amt },
      { header: 'Tax Basis Amt', key: 'taxAmt', ...amt },
    ], rows.map((r) => ({ code: r.vendorCode, name: r.accountName, bookAmt: r.bookAmt, taxAmt: r.taxAmt })));
    return { buffer, fileName: `${software}-export-${stamp}.xlsx`, mimeType: XLSX_MIME, rowCount: rows.length };
  }
  // generic: canonical code + description, no software crosswalk.
  const buffer = await buildRefExcel('Generic Export', [
    { header: 'AccountNumber', key: 'acct', width: 18 },
    { header: 'AccountName', key: 'name', width: 40 },
    { header: 'TaxCode', key: 'code', width: 18 },
    { header: 'TaxDescription', key: 'desc', width: 40 },
    { header: 'Book Basis Amt', key: 'bookAmt', ...amt },
    { header: 'Tax Basis Amt', key: 'taxAmt', ...amt },
  ], rows.map((r) => ({ acct: r.accountNumber, name: r.accountName, code: r.code, desc: r.description, bookAmt: r.bookAmt, taxAmt: r.taxAmt })));
  return { buffer, fileName: `generic-export-${stamp}.xlsx`, mimeType: XLSX_MIME, rowCount: rows.length };
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
    ['Cost of Goods Sold', (t) => t === 'cogs'],
    ['Expenses', (t) => t === 'expense'],
    ['Other Income', (t) => t === 'other_revenue'],
    ['Other Expenses', (t) => t === 'other_expense'],
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
      .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId))).limit(1);
    const units = await db.select().from(activityUnits)
      .where(and(eq(activityUnits.tenantId, tenantId), eq(activityUnits.companyId, companyId)));
    const unitNames = new Map(units.map((u) => [u.id, `${u.displayName}`]));
    const unitInfo = new Map(units.map((u) => [u.id, { name: u.displayName, number: u.instanceNumber }]));
    const file = await buildVendorFile(opts.software, dataset, company?.name ?? '', unitNames, unitInfo, dataset.consolidationPrefs);
    ({ buffer, fileName, mimeType, rowCount } = file);
    glVersionStamp = dataset.glVersionStamp;
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
