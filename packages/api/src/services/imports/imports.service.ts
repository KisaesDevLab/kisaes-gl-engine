// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Bulk-import orchestration. Adapters parse vendor formats into
// canonical rows; this service persists the parse output as a session,
// runs DB-aware validation, and commits via the existing
// postTransaction / accounts insert paths so we don't reinvent
// debits-equal-credits / scope checks / lock-date enforcement.

import * as crypto from 'crypto';
import { and, eq, desc, isNull, or, like, inArray, ne, sql, asc } from 'drizzle-orm';
import { db, type DbOrTx, type Tx } from '../../db/index.js';
import {
  importSessions,
  importRows,
  importBatches,
  accounts,
  contacts,
  transactions,
  companies,
  tags,
  tagGroups,
  items,
  inventoryMovements,
} from '../../db/schema/index.js';
import { normalizeLoose } from '../ai-name-match.js';
import {
  IMPORT_SOURCE_TAGS,
  type CanonicalCoaRow,
  type CanonicalContactRow,
  type CanonicalGlEntry,
  type CanonicalItemRow,
  type CanonicalOpenItemRow,
  type CanonicalTrialBalanceRow,
  type CanonicalValuationRow,
  type ContactKind,
  type ImportAccountMatch,
  type CreateInvoiceInput,
  type CreateCreditMemoInput,
  type ImportCommitResult,
  type ImportKind,
  type ImportPreview,
  type ImportSession,
  type ImportStatus,
  type ImportUploadOptions,
  type ImportValidationError,
  type SourceSystem,
  type TbColumnChoice,
} from '@kis-books/shared';
import { AppError } from '../../utils/errors.js';
// Unmapped TB/GL accounts land here instead of failing the import.
import { findSystemAccountId, getOrCreateSystemAccount, SUSPENSE_TAG } from '../system-accounts.service.js';
import * as ap from './adapters/accounting-power.js';
import * as qbo from './adapters/quickbooks-online.js';
import * as qbd from './adapters/quickbooks-desktop.js';
import * as generic from './adapters/generic.js';
import { parseOpenItems, openItemsTotal } from './adapters/open-items.js';
import { parseItems, parseInventoryValuation, valuationTotal } from './adapters/items.js';
import { INVENTORY_ASSET_TAG } from '../inventory.service.js';
import { postTransaction } from '../ledger.service.js';
import { Decimal } from 'decimal.js';

// ── Helpers ───────────────────────────────────────────────────────

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** JSON with object keys sorted at every depth, so equal content gives equal text. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Drops `rowNumber` at every depth: a re-export with another header or preamble shifts row numbers only. */
function withoutRowNumbers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => withoutRowNumbers(v));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k !== 'rowNumber') out[k] = withoutRowNumbers(v);
  }
  return out;
}

/**
 * U-263 (review S10): the session's content hash, SHA-256 over kind, source,
 * report date and the normalized parsed rows (row numbers dropped, keys
 * sorted). The same data exported twice (other bytes, other preamble) gives
 * the same hash, so a re-import is refused even when the file differs.
 */
export function computeRowHash(
  kind: string,
  sourceSystem: string,
  reportDate: string | null,
  parsed: unknown,
): string {
  const text = canonicalJson({ kind, sourceSystem, reportDate, rows: withoutRowNumbers(jsonSafe(parsed)) });
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The open-item kinds (U-264). */
export function isOpenItemKind(kind: string): kind is 'open_invoices' | 'unpaid_bills' {
  return kind === 'open_invoices' || kind === 'unpaid_bills';
}

/**
 * First and last date a file posts on: a journal file's entry dates, an
 * open-item file's document dates (U-264); null for other kinds or an empty
 * file. Overlap checks read journal files only.
 */
function glDateRange(kind: ImportKind, parsed: unknown): { from: string | null; to: string | null } {
  if (kind !== 'gl_transactions' && !isOpenItemKind(kind)) return { from: null, to: null };
  let from: string | null = null;
  let to: string | null = null;
  for (const e of (parsed as Array<{ date?: string }>) ?? []) {
    if (!e.date) continue;
    if (from === null || e.date < from) from = e.date;
    if (to === null || e.date > to) to = e.date;
  }
  return { from, to };
}

/** Session roles (U-261): 'post' sessions are posted; 'reference' sessions are only compared against. */
export type ImportSessionRole = 'post' | 'reference';

/**
 * U-263: 409 IMPORT_ALREADY_COMMITTED when a committed batch holds a session
 * with the same content hash in this company (an undone batch frees it).
 */
export async function assertNotAlreadyCommitted(
  ex: DbOrTx,
  tenantId: string,
  companyId: string,
  rowHash: string,
  exceptSessionId?: string,
): Promise<void> {
  const [prev] = await ex
    .select({ id: importSessions.id, batchId: importSessions.batchId, committedAt: importSessions.committedAt })
    .from(importSessions)
    .where(and(
      eq(importSessions.tenantId, tenantId),
      eq(importSessions.companyId, companyId),
      eq(importSessions.rowHash, rowHash),
      eq(importSessions.activeCommit, true),
      exceptSessionId ? ne(importSessions.id, exceptSessionId) : undefined,
    ))
    .limit(1);
  if (prev) {
    throw AppError.conflict(
      'This file was already imported into this company. Undo that import first to bring it in again.',
      'IMPORT_ALREADY_COMMITTED',
      { batchId: prev.batchId, sessionId: prev.id, committedAt: prev.committedAt ? prev.committedAt.toISOString() : null },
    );
  }
}

/**
 * U-263: 409 IMPORT_PERIOD_OVERLAP when a journal file's dates overlap a
 * journal file of the same source that a committed batch holds in this
 * company (an undone batch frees it).
 */
export async function assertNoCommittedOverlap(
  ex: DbOrTx,
  tenantId: string,
  companyId: string,
  sourceSystem: string,
  from: string | null,
  to: string | null,
  exceptSessionIds: string[] = [],
): Promise<void> {
  if (!from || !to) return;
  const [prev] = await ex
    .select({ id: importSessions.id, batchId: importSessions.batchId, dateFrom: importSessions.dateFrom, dateTo: importSessions.dateTo })
    .from(importSessions)
    .where(and(
      eq(importSessions.tenantId, tenantId),
      eq(importSessions.companyId, companyId),
      eq(importSessions.sourceSystem, sourceSystem),
      eq(importSessions.kind, 'gl_transactions'),
      eq(importSessions.activeCommit, true),
      sql`${importSessions.dateFrom} <= ${to} AND ${importSessions.dateTo} >= ${from}`,
      exceptSessionIds.length > 0 ? sql`${importSessions.id} NOT IN (${sql.join(exceptSessionIds.map((i) => sql`${i}`), sql`, `)})` : undefined,
    ))
    .limit(1);
  if (prev) {
    throw AppError.conflict(
      'These journal dates overlap a journal file already imported into this company.',
      'IMPORT_PERIOD_OVERLAP',
      {
        batchId: prev.batchId, sessionId: prev.id,
        from: prev.dateFrom! > from ? prev.dateFrom : from,
        to: prev.dateTo! < to ? prev.dateTo : to,
      },
    );
  }
}

/** The parsed canonical rows of a session: import_rows (U-261), or the legacy jsonb column. */
export async function loadParsedRows(
  ex: DbOrTx,
  row: { id: string; parsedRows: unknown },
): Promise<unknown[]> {
  if (Array.isArray(row.parsedRows)) return row.parsedRows as unknown[];
  const rows = await ex
    .select({ data: importRows.data })
    .from(importRows)
    .where(eq(importRows.sessionId, row.id))
    .orderBy(asc(importRows.rowNo));
  return rows.map((r) => r.data);
}

const IMPORT_ROWS_CHUNK = 1000;

async function insertImportRows(tx: Tx, sessionId: string, parsed: unknown[]): Promise<void> {
  for (let i = 0; i < parsed.length; i += IMPORT_ROWS_CHUNK) {
    const chunk = parsed.slice(i, i + IMPORT_ROWS_CHUNK);
    await tx.insert(importRows).values(chunk.map((data, j) => ({ sessionId, rowNo: i + j, data: data as never })));
  }
}

/**
 * Resolve a set of tag names to ids, creating any that don't exist yet.
 * Matching is case-insensitive on the existing tenant tags (tag names are
 * unique per tenant by convention). Returns a lowercased-name → id map plus
 * the count of tags newly created, so the import can report it. Created tags
 * are scoped to the import's company and stamped with the batch (U-261).
 */
async function ensureTags(
  ex: DbOrTx,
  tenantId: string,
  companyId: string,
  names: string[],
  batchId: string | null,
): Promise<{ map: Map<string, string>; created: number }> {
  const wanted = Array.from(new Set(names.map((n) => n.trim()).filter(Boolean)));
  const map = new Map<string, string>();
  if (wanted.length === 0) return { map, created: 0 };

  const existing = await ex
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(eq(tags.tenantId, tenantId));
  for (const t of existing) map.set(t.name.toLowerCase(), t.id);

  const toCreate = wanted.filter((n) => !map.has(n.toLowerCase()));
  if (toCreate.length > 0) {
    const inserted = await ex
      .insert(tags)
      .values(toCreate.map((name) => ({ tenantId, companyId, name, importBatchId: batchId })))
      .returning({ id: tags.id, name: tags.name });
    for (const t of inserted) map.set(t.name.toLowerCase(), t.id);
  }
  return { map, created: toCreate.length };
}

/**
 * U-265: journal line classes through the batch's classMap: a mapped class
 * becomes its `tag` (found by name tenant-wide, else created) in its `group`
 * (a tag group found by name, else created; both stamped with the batch); an
 * unmapped class becomes the tag of its own name, as ensureTags does. Returns
 * lowercased class name -> tag id, the tags created and the classes mapped.
 */
async function ensureMappedTags(
  ctx: CommitSessionContext,
  classNames: string[],
): Promise<{ map: Map<string, string>; created: number; mapped: number }> {
  const { tx, tenantId, companyId, batchId } = ctx;
  const classMap = ctx.shared!.classMap;
  const wanted = Array.from(new Set(classNames.map((n) => n.trim()).filter(Boolean)));
  const out = new Map<string, string>();
  if (wanted.length === 0) return { map: out, created: 0, mapped: 0 };
  const existing = await tx.select({ id: tags.id, name: tags.name }).from(tags).where(eq(tags.tenantId, tenantId));
  const tagByName = new Map(existing.map((t) => [t.name.toLowerCase(), t.id]));
  const groups = await tx.select({ id: tagGroups.id, name: tagGroups.name }).from(tagGroups)
    .where(and(eq(tagGroups.tenantId, tenantId), or(eq(tagGroups.companyId, companyId), isNull(tagGroups.companyId))));
  const groupByName = new Map(groups.map((g) => [g.name.toLowerCase(), g.id]));
  let created = 0;
  let mapped = 0;
  const groupId = async (name: string | undefined): Promise<string | null> => {
    const n = name?.trim();
    if (!n) return null;
    const known = groupByName.get(n.toLowerCase());
    if (known) return known;
    const [g] = await tx.insert(tagGroups).values({ tenantId, companyId, name: n, importBatchId: batchId }).returning({ id: tagGroups.id });
    groupByName.set(n.toLowerCase(), g!.id);
    return g!.id;
  };
  for (const cls of wanted) {
    const m = classMap.get(cls.toLowerCase());
    if (m) mapped++;
    const tagName = (m?.tag ?? cls).trim();
    let id = tagByName.get(tagName.toLowerCase());
    if (!id) {
      const [t] = await tx.insert(tags).values({
        tenantId, companyId, name: tagName, groupId: m ? await groupId(m.group) : null, importBatchId: batchId,
      }).returning({ id: tags.id });
      id = t!.id;
      tagByName.set(tagName.toLowerCase(), id);
      created++;
    }
    out.set(cls.toLowerCase(), id);
  }
  return { map: out, created, mapped };
}

const TERMINAL_STATUSES: readonly ImportStatus[] =['committed', 'failed', 'cancelled', 'undone'];

function isTerminal(s: string): boolean {
  return TERMINAL_STATUSES.includes(s as ImportStatus);
}

/**
 * Hard upper bound on rows / JE entries an import can carry. We cap on
 * the parsed-canonical size, not the raw file, so a CSV with lots of
 * preamble/garbage doesn't waste memory keeping the rejected rows.
 *
 * 50,000 was chosen because:
 *   - the largest realistic GL export the appliance has been asked to
 *     ingest is ~3,000 entries (one calendar year of one entity);
 *     50× headroom covers 50-year history + multi-entity rolls-up;
 *   - parsedRows JSONB at 50K entries × ~250 bytes/entry ≈ 12 MB,
 *     which is still comfortably below Postgres jsonb's 1 GB limit
 *     and our pg row-size watermark;
 *   - a hostile upload at this ceiling holds ~25 MB peak per request
 *     (file buffer + parsed array), so K concurrent uploads are bounded.
 */
const MAX_ROWS_PER_KIND: Record<ImportKind, number> = {
  coa: 5_000,
  contacts: 10_000,
  trial_balance: 5_000,
  gl_transactions: 50_000,
  open_invoices: 20_000,
  unpaid_bills: 20_000,
  items: 10_000,
  inventory_valuation: 10_000,
};

function enforceRowCap(kind: ImportKind, count: number): void {
  const cap = MAX_ROWS_PER_KIND[kind];
  if (count > cap) {
    throw AppError.unprocessableEntity(
      `Import has ${count} rows, exceeding the per-file cap of ${cap} for ${kind}. Split the file and upload in chunks.`,
      'IMPORT_ROW_LIMIT_EXCEEDED',
      { count, cap, kind },
    );
  }
}

/**
 * Convert any Decimal / Date instance lurking in canonical rows into a
 * JSON-safe scalar BEFORE we hand the structure to drizzle for JSONB
 * storage or to res.json() for the wire. The adapters return strings
 * already; this is a defensive belt-and-braces step that catches future
 * bugs where someone forgets to .toFixed() a Decimal.
 */
function jsonSafe<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return (value as unknown as Date).toISOString() as unknown as T;
  if (value instanceof Decimal) return (value as unknown as Decimal).toFixed(4) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v)) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = jsonSafe(v);
    return out as unknown as T;
  }
  return value;
}

interface SessionRowDb {
  id: string;
  tenantId: string;
  companyId: string;
  kind: string;
  sourceSystem: string;
  status: string;
  originalFilename: string;
  fileHash: string;
  rowCount: number;
  errorCount: number;
  parsedRows: unknown;
  validationErrors: unknown;
  commitResult: unknown;
  options: unknown;
  reportDate: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  committedAt: Date | null;
  batchId?: string | null;
  role?: string;
  dateFrom?: string | null;
  dateTo?: string | null;
}

export function toSessionDto(row: SessionRowDb): ImportSession {
  return {
    id: row.id,
    tenantId: row.tenantId,
    companyId: row.companyId,
    kind: row.kind as ImportKind,
    sourceSystem: row.sourceSystem as SourceSystem,
    status: row.status as ImportStatus,
    originalFilename: row.originalFilename,
    fileHash: row.fileHash,
    rowCount: row.rowCount,
    errorCount: row.errorCount,
    reportDate: row.reportDate,
    options: row.options as ImportUploadOptions | null,
    commitResult: row.commitResult as ImportCommitResult | null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    committedAt: row.committedAt ? row.committedAt.toISOString() : null,
    batchId: row.batchId ?? null,
    role: (row.role ?? 'post') as ImportSessionRole,
    dateFrom: row.dateFrom ?? null,
    dateTo: row.dateTo ?? null,
  };
}

// Max rows returned in the preview. The commit path imports every parsed
// row regardless — this only bounds how many the operator can eyeball in
// the review table. Raised from 50 (which surprised operators into
// thinking only 50 rows would import) to a value that shows all rows for
// any realistic CPA import while still capping a pathological 100k-row GL
// file so the preview response/DOM stays sane.
const MAX_PREVIEW_ROWS = 5000;

function buildPreview(
  kind: ImportKind,
  parsed: unknown,
  validationErrors: ImportValidationError[],
  reportDate: string | null,
  options: ImportUploadOptions | null,
): ImportPreview {
  const errorCount = validationErrors.length;
  if (kind === 'gl_transactions') {
    const entries = (parsed as CanonicalGlEntry[]) ?? [];
    return {
      totalRows: entries.length,
      errorCount,
      sampleRows: entries.slice(0, MAX_PREVIEW_ROWS),
      jeGroupCount: entries.length,
      voidEntryCount: entries.filter((e) => e.isVoidReversal).length,
    };
  }
  if (kind === 'trial_balance') {
    const rows = (parsed as CanonicalTrialBalanceRow[]) ?? [];
    let totalDebit = new Decimal(0);
    let totalCredit = new Decimal(0);
    for (const r of rows) {
      if (r.debit) totalDebit = totalDebit.plus(r.debit);
      if (r.credit) totalCredit = totalCredit.plus(r.credit);
    }
    return {
      totalRows: rows.length,
      errorCount,
      sampleRows: rows.slice(0, MAX_PREVIEW_ROWS),
      reportDate: reportDate ?? options?.tbReportDate ?? undefined,
      tbColumn: options?.tbColumn,
      totalDebit: totalDebit.toFixed(4),
      totalCredit: totalCredit.toFixed(4),
    };
  }
  if (isOpenItemKind(kind)) {
    const rows = (parsed as CanonicalOpenItemRow[]) ?? [];
    return {
      totalRows: rows.length,
      errorCount,
      sampleRows: rows.slice(0, MAX_PREVIEW_ROWS),
      ...(reportDate ? { reportDate } : {}),
      openTotal: openItemsTotal(rows),
    };
  }
  if (kind === 'inventory_valuation') {
    const rows = (parsed as CanonicalValuationRow[]) ?? [];
    return {
      totalRows: rows.length,
      errorCount,
      sampleRows: rows.slice(0, MAX_PREVIEW_ROWS),
      ...(reportDate ? { reportDate } : {}),
      valuationTotal: valuationTotal(rows),
    };
  }
  const rows = (parsed as { rowNumber: number }[]) ?? [];
  return {
    totalRows: rows.length,
    errorCount,
    sampleRows: rows.slice(0, MAX_PREVIEW_ROWS),
  };
}

/**
 * U-265: the source account key of a chart row, trial balance row, journal
 * line or item account: the account number, else the name. The key of the
 * batch's accountMap, of preview.accountMatches and of unmappedAccountKeys.
 */
export function sourceAccountKey(accountNumber?: string | null, accountName?: string | null): string | null {
  return accountNumber || accountName || null;
}

type AccountRef = { accountNumber?: string; accountName?: string };

/** Every account reference of a file's rows (chart rows as their own account). */
function accountRefsOf(kind: ImportKind, parsed: unknown): Array<AccountRef & { systemRole?: ImportAccountMatch['systemRole'] }> {
  const out: Array<AccountRef & { systemRole?: ImportAccountMatch['systemRole'] }> = [];
  if (kind === 'coa') {
    for (const r of (parsed as CanonicalCoaRow[]) ?? []) {
      out.push({ accountNumber: r.accountNumber, accountName: r.name, ...(r.systemRole ? { systemRole: r.systemRole } : {}) });
    }
  } else if (kind === 'trial_balance') {
    for (const r of (parsed as CanonicalTrialBalanceRow[]) ?? []) out.push({ accountNumber: r.accountNumber, accountName: r.accountName });
  } else if (kind === 'gl_transactions') {
    for (const e of (parsed as CanonicalGlEntry[]) ?? []) {
      for (const l of e.lines) out.push({ accountNumber: l.accountNumber, accountName: l.accountName });
    }
  } else if (kind === 'items') {
    for (const r of (parsed as CanonicalItemRow[]) ?? []) {
      for (const a of [r.incomeAccount, r.expenseAccount, r.assetAccount, r.cogsAccount]) if (a) out.push(a);
    }
  }
  return out;
}

/**
 * preview.accountMatches (U-265): one entry per distinct source account key
 * over EVERY row of the file, not the preview sample (review S8), against the
 * company's chart as it is now. A chart file's row is 'existing' when its
 * number is in the chart (the commit keeps that account), else 'create'.
 * Another file's key is 'existing' (by number, then name) or 'unmatched'; a
 * chart file in the same batch, or the batch's accountMap, settles it.
 * Undefined for kinds that name no accounts.
 */
export async function computeAccountMatches(
  ex: DbOrTx,
  tenantId: string,
  companyId: string,
  kind: ImportKind,
  parsed: unknown,
): Promise<ImportAccountMatch[] | undefined> {
  if (!['coa', 'trial_balance', 'gl_transactions', 'items'].includes(kind)) return undefined;
  const refs = accountRefsOf(kind, parsed);
  const acctRows = await ex.select({ id: accounts.id, accountNumber: accounts.accountNumber, name: accounts.name, accountType: accounts.accountType })
    .from(accounts).where(and(eq(accounts.tenantId, tenantId), or(eq(accounts.companyId, companyId), isNull(accounts.companyId))))
    .orderBy(asc(accounts.createdAt), asc(accounts.id));
  const byNum = new Map<string, string>();
  const byName = new Map<string, string>();
  const byNameType = new Map<string, string>();
  for (const a of acctRows) {
    if (a.accountNumber) byNum.set(a.accountNumber, a.id);
    // As a batch commit resolves names: the oldest account of that name (of that type, for a chart row).
    const k = a.name.toLowerCase();
    if (!byName.has(k)) byName.set(k, a.id);
    if (!byNameType.has(`${a.accountType}:${k}`)) byNameType.set(`${a.accountType}:${k}`, a.id);
  }
  const chartTypes = new Map<string, string>();
  if (kind === 'coa') {
    for (const r of (parsed as CanonicalCoaRow[]) ?? []) {
      const key = sourceAccountKey(r.accountNumber, r.name);
      if (key && !r.accountNumber) chartTypes.set(key, r.accountType);
    }
  }
  const out = new Map<string, ImportAccountMatch>();
  for (const r of refs) {
    const key = sourceAccountKey(r.accountNumber, r.accountName);
    if (!key) continue;
    const seen = out.get(key);
    if (seen) { seen.rows++; continue; }
    const m: ImportAccountMatch = {
      sourceKey: key, rows: 1, match: 'unmatched',
      ...(r.accountNumber ? { number: r.accountNumber } : {}),
      ...(r.accountName ? { name: r.accountName } : {}),
      ...(r.systemRole ? { systemRole: r.systemRole } : {}),
    };
    const numHit = r.accountNumber ? byNum.get(r.accountNumber) : undefined;
    const nameHit = r.accountName ? byName.get(r.accountName.toLowerCase()) : undefined;
    // A chart row with no number is the company's account of that name and type (a batch adopts it, U-265).
    const chartHit = kind === 'coa' && chartTypes.has(key) && r.accountName
      ? byNameType.get(`${chartTypes.get(key)}:${r.accountName.toLowerCase()}`) : undefined;
    if (numHit) Object.assign(m, { match: 'existing', accountId: numHit, matchedBy: 'number' });
    else if (chartHit) Object.assign(m, { match: 'existing', accountId: chartHit, matchedBy: 'name' });
    else if (kind === 'coa') m.match = 'create';
    else if (nameHit) Object.assign(m, { match: 'existing', accountId: nameHit, matchedBy: 'name' });
    out.set(key, m);
  }
  return [...out.values()].sort((a, b) => (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0));
}

// ── Parsing dispatch ──────────────────────────────────────────────

interface ParseResult {
  parsed: unknown;
  errors: ImportValidationError[];
  reportDate: string | null;
  rowCount: number;
}

async function dispatchParse(
  buf: Buffer,
  kind: ImportKind,
  sourceSystem: SourceSystem,
  options: ImportUploadOptions,
): Promise<ParseResult> {
  // Open items (U-264): one parser for QuickBooks Desktop, QuickBooks Online
  // and the Generic template; the report's own date wins over options.reportDate.
  if (isOpenItemKind(kind)) {
    if (sourceSystem === 'accounting_power') {
      throw AppError.badRequest(`Accounting Power does not support kind="${kind}" in this version.`, 'IMPORT_WRONG_KIND');
    }
    const { rows, errors, reportDate } = await parseOpenItems(buf, kind, sourceSystem);
    return { parsed: rows, errors, reportDate: reportDate ?? options.reportDate ?? null, rowCount: rows.length };
  }
  // U-265: item lists and inventory valuations, one parser each for every source but Accounting Power.
  if (kind === 'items' || kind === 'inventory_valuation') {
    if (sourceSystem === 'accounting_power') {
      throw AppError.badRequest(`Accounting Power does not support kind="${kind}" in this version.`, 'IMPORT_WRONG_KIND');
    }
    if (kind === 'items') {
      const { rows, errors } = await parseItems(buf, sourceSystem);
      return { parsed: rows, errors, reportDate: null, rowCount: rows.length };
    }
    const { rows, errors, reportDate } = await parseInventoryValuation(buf, sourceSystem);
    return { parsed: rows, errors, reportDate: reportDate ?? options.reportDate ?? null, rowCount: rows.length };
  }
  // U-265: an Other Names list is a QuickBooks Desktop list.
  if (kind === 'contacts' && options.contactKind === 'other' && sourceSystem !== 'quickbooks_desktop') {
    throw AppError.badRequest('contactKind "other" is a QuickBooks Desktop Other Names list.', 'IMPORT_CONTACT_KIND_UNSUPPORTED');
  }
  if (sourceSystem === 'accounting_power') {
    if (kind === 'coa') {
      const { rows, errors } = ap.parseCoa(buf);
      return { parsed: rows, errors, reportDate: null, rowCount: rows.length };
    }
    if (kind === 'gl_transactions') {
      const { entries, errors } = ap.parseGl(buf);
      return { parsed: entries, errors, reportDate: null, rowCount: entries.length };
    }
    if (kind === 'contacts') {
      if (!options.contactKind) {
        throw AppError.badRequest(
          'Accounting Power contacts upload requires options.contactKind = "customer" | "vendor".',
          'IMPORT_CONTACT_KIND_REQUIRED',
        );
      }
      const { rows, errors } = ap.parseContacts(buf, options.contactKind as ContactKind);
      return { parsed: rows, errors, reportDate: null, rowCount: rows.length };
    }
    if (kind === 'trial_balance') {
      if (!options.tbColumn) {
        throw AppError.badRequest(
          'Accounting Power trial balance requires options.tbColumn = "beginning" | "adjusted".',
          'IMPORT_TB_COLUMN_REQUIRED',
        );
      }
      if (!options.tbReportDate) {
        throw AppError.badRequest(
          'Accounting Power trial balance requires options.tbReportDate (ISO date).',
          'IMPORT_BAD_DATE',
        );
      }
      const { rows, errors } = ap.parseTrialBalance(buf, { column: options.tbColumn });
      return { parsed: rows, errors, reportDate: options.tbReportDate, rowCount: rows.length };
    }
    throw AppError.badRequest(
      `Accounting Power does not support kind="${kind}" in this version.`,
      'IMPORT_WRONG_KIND',
    );
  }

  // QuickBooks Desktop — all exports are CSV (ISO-8859-1). The trial
  // balance carries its own "As of" date, so (unlike Accounting Power) no
  // tbReportDate option is required; contacts still need contactKind.
  if (sourceSystem === 'quickbooks_desktop') {
    if (kind === 'coa') {
      const { rows, errors } = qbd.parseCoa(buf);
      return { parsed: rows, errors, reportDate: null, rowCount: rows.length };
    }
    if (kind === 'gl_transactions') {
      const { entries, errors } = qbd.parseGl(buf);
      return { parsed: entries, errors, reportDate: null, rowCount: entries.length };
    }
    if (kind === 'contacts') {
      if (!options.contactKind) {
        throw AppError.badRequest(
          'QuickBooks Desktop contacts upload requires options.contactKind = "customer" | "vendor".',
          'IMPORT_CONTACT_KIND_REQUIRED',
        );
      }
      const { rows, errors } = qbd.parseContacts(buf, options.contactKind);
      return { parsed: rows, errors, reportDate: null, rowCount: rows.length };
    }
    if (kind === 'trial_balance') {
      const { rows, errors, reportDate } = qbd.parseTrialBalance(buf);
      // Prefer the file's scraped "As of" date; fall back to an explicit
      // option if the operator supplied one.
      return {
        parsed: rows,
        errors,
        reportDate: reportDate ?? options.tbReportDate ?? null,
        rowCount: rows.length,
      };
    }
    throw AppError.badRequest(`Unsupported QuickBooks Desktop kind="${kind}".`, 'IMPORT_WRONG_KIND');
  }

  // Generic Excel/CSV templates (our own documented column layout).
  if (sourceSystem === 'generic') {
    if (kind === 'coa') {
      const { rows, errors } = await generic.parseCoa(buf);
      return { parsed: rows, errors, reportDate: null, rowCount: rows.length };
    }
    if (kind === 'contacts') {
      // contactKind is an optional per-file default; the template also has a
      // per-row Type column, so a mixed customer/vendor file is fine.
      const { rows, errors } = await generic.parseContacts(buf, options.contactKind as ContactKind | undefined);
      return { parsed: rows, errors, reportDate: null, rowCount: rows.length };
    }
    if (kind === 'trial_balance') {
      // The generic TB file carries no date; require the operator's tbReportDate.
      if (!options.tbReportDate) {
        throw AppError.badRequest(
          'Generic trial balance requires a report date (options.tbReportDate).',
          'IMPORT_BAD_DATE',
        );
      }
      const { rows, errors } = await generic.parseTrialBalance(buf);
      return { parsed: rows, errors, reportDate: options.tbReportDate, rowCount: rows.length };
    }
    if (kind === 'gl_transactions') {
      const { entries, errors } = await generic.parseGl(buf);
      return { parsed: entries, errors, reportDate: null, rowCount: entries.length };
    }
    throw AppError.badRequest(`Unsupported Generic import kind="${kind}".`, 'IMPORT_WRONG_KIND');
  }

  // QuickBooks Online
  if (kind === 'coa') {
    const { rows, errors } = await qbo.parseCoa(buf);
    return { parsed: rows, errors, reportDate: null, rowCount: rows.length };
  }
  if (kind === 'contacts') {
    if (!options.contactKind) {
      throw AppError.badRequest(
        'QuickBooks contacts upload requires options.contactKind = "customer" | "vendor".',
        'IMPORT_CONTACT_KIND_REQUIRED',
      );
    }
    const { rows, errors } = await qbo.parseContacts(buf, options.contactKind as ContactKind);
    return { parsed: rows, errors, reportDate: null, rowCount: rows.length };
  }
  if (kind === 'trial_balance') {
    const { rows, errors, reportDate } = await qbo.parseTrialBalance(buf);
    return { parsed: rows, errors, reportDate, rowCount: rows.length };
  }
  if (kind === 'gl_transactions') {
    const { entries, errors } = await qbo.parseGl(buf);
    return { parsed: entries, errors, reportDate: null, rowCount: entries.length };
  }
  throw AppError.badRequest(`Unsupported QBO kind="${kind}".`, 'IMPORT_WRONG_KIND');
}

// ── createSession ─────────────────────────────────────────────────

export interface CreateSessionInput {
  tenantId: string;
  companyId: string;
  userId: string;
  file: { originalname: string; buffer: Buffer };
  kind: ImportKind;
  sourceSystem: SourceSystem;
  options: ImportUploadOptions;
  /** U-261: 'post' (default) or 'reference' (a file only compared against, never posted). */
  role?: ImportSessionRole;
}

export async function createSession(input: CreateSessionInput): Promise<{
  session: ImportSession;
  preview: ImportPreview;
  validationErrors: ImportValidationError[];
}> {
  const fileHash = sha256(input.file.buffer);

  // Refuse a re-upload of the same bytes for the same company while
  // any prior session is still in a non-terminal state. Lets the
  // operator continue or cancel the previous one without two parallel
  // sessions racing to commit.
  const dups = await db
    .select()
    .from(importSessions)
    .where(
      and(
        eq(importSessions.tenantId, input.tenantId),
        eq(importSessions.companyId, input.companyId),
        eq(importSessions.fileHash, fileHash),
        // U-267: per role. A conversion-date trial balance may be uploaded both to post and as the
        // reference the tie-out compares against (a reference file is never posted).
        eq(importSessions.role, input.role ?? 'post'),
      ),
    );
  for (const d of dups) {
    if (!isTerminal(d.status)) {
      throw AppError.conflict(
        'A session for this file is already in progress on this company.',
        'IMPORT_SESSION_ACTIVE',
        { existingSessionId: d.id, status: d.status },
      );
    }
  }

  let parsed: ParseResult;
  try {
    parsed = await dispatchParse(input.file.buffer, input.kind, input.sourceSystem, input.options);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw AppError.badRequest(
      `Could not parse uploaded file: ${e instanceof Error ? e.message : String(e)}`,
      'IMPORT_INVALID_FORMAT',
    );
  }

  // Reject anything that would overflow our memory / JSONB budget BEFORE
  // we run DB validation against it.
  enforceRowCap(input.kind, parsed.rowCount);

  const reportDate = parsed.reportDate ?? input.options.tbReportDate ?? null;

  // DB-aware validation augments the adapter's parse-time errors.
  const dbErrors = await validateAgainstDb(
    input.tenantId,
    input.companyId,
    input.kind,
    parsed.parsed,
    reportDate,
    input.options,
  );
  const allErrors = [...parsed.errors, ...dbErrors];

  // U-263: the same data already imported (by content, not bytes), or a
  // journal file whose dates overlap one already imported, is refused here
  // (and again at commit). Reference files are never posted, so never refused.
  const role: ImportSessionRole = input.role ?? 'post';
  const rowHash = computeRowHash(input.kind, input.sourceSystem, reportDate, parsed.parsed);
  const range = glDateRange(input.kind, parsed.parsed);
  if (role === 'post') {
    await assertNotAlreadyCommitted(db, input.tenantId, input.companyId, rowHash);
    // U-266: journal files only; an open-item file's document dates are not a journal period.
    if (input.kind === 'gl_transactions') {
      await assertNoCommittedOverlap(db, input.tenantId, input.companyId, input.sourceSystem, range.from, range.to);
    }
  }

  // jsonSafe scrubs any stray Decimal/Date instances so the JSONB
  // round-trip is byte-for-byte equivalent and res.json() never
  // throws on `[object Object]` tokens. The rows go to import_rows, one per
  // row (U-261, review S8), in the transaction that inserts the session.
  const safeRows = (jsonSafe(parsed.parsed) as unknown[] | null) ?? [];
  const inserted = await db.transaction(async (tx) => {
    const [s] = await tx
      .insert(importSessions)
      .values({
        tenantId: input.tenantId,
        companyId: input.companyId,
        kind: input.kind,
        sourceSystem: input.sourceSystem,
        status: 'uploaded',
        originalFilename: input.file.originalname,
        fileHash,
        rowCount: parsed.rowCount,
        errorCount: allErrors.length,
        parsedRows: null,
        validationErrors: jsonSafe(allErrors) as never,
        options: input.options as never,
        reportDate,
        createdBy: input.userId,
        role,
        rowHash,
        dateFrom: range.from,
        dateTo: range.to,
      })
      .returning();
    if (!s) throw AppError.internal('Failed to insert import session.');
    await insertImportRows(tx, s.id, safeRows);
    return s;
  });
  const session = toSessionDto(inserted as unknown as SessionRowDb);
  const preview = buildPreview(input.kind, parsed.parsed, allErrors, reportDate, input.options);
  const accountMatches = await computeAccountMatches(db, input.tenantId, input.companyId, input.kind, parsed.parsed);
  if (accountMatches) preview.accountMatches = accountMatches;
  return { session, preview, validationErrors: allErrors };
}

// ── Validation ────────────────────────────────────────────────────

// TB/GL lines naming an account this company's CoA does not have are posted
// to suspense rather than failing the import, unless the operator turned it
// off. Default ON: a balanced entry the reviewer can fix on
// Practice -> Uncategorized beats a dead-end "Import the CoA first."
function suspenseFallbackOn(options: ImportUploadOptions | null | undefined): boolean {
  return options?.unmappedAccountsToSuspense !== false;
}

async function validateAgainstDb(
  tenantId: string,
  companyId: string,
  kind: ImportKind,
  parsedAny: unknown,
  reportDate: string | null,
  options?: ImportUploadOptions | null,
): Promise<ImportValidationError[]> {
  if (kind === 'coa') return validateCoa(tenantId, parsedAny as CanonicalCoaRow[]);
  if (kind === 'contacts') return validateContacts(parsedAny as CanonicalContactRow[]);
  if (kind === 'trial_balance') {
    const errs = await validateTrialBalance(
      tenantId, companyId, parsedAny as CanonicalTrialBalanceRow[], suspenseFallbackOn(options),
    );
    // Pre-flight lock-date against the operator-supplied report date.
    if (reportDate) {
      errs.push(...(await checkLockDate(tenantId, companyId, [reportDate])));
    }
    return errs;
  }
  if (kind === 'gl_transactions') {
    const entries = parsedAny as CanonicalGlEntry[];
    const errs = await validateGl(tenantId, companyId, entries, suspenseFallbackOn(options));
    // Pre-flight lock-date against every distinct entry date — stops
    // the operator burning time on a preview when commit is certain to
    // fail at the ledger layer.
    const dates = Array.from(new Set(entries.map((e) => e.date)));
    errs.push(...(await checkLockDate(tenantId, companyId, dates)));
    return errs;
  }
  if (isOpenItemKind(kind)) {
    // Names are matched at commit (the contacts may come in the same batch).
    const dates = Array.from(new Set(((parsedAny as CanonicalOpenItemRow[]) ?? []).map((r) => r.date)));
    return await checkLockDate(tenantId, companyId, dates);
  }
  if (kind === 'inventory_valuation') {
    // U-265: opening stock is dated the report date; without one it can't post.
    if (!reportDate) {
      return [{ rowNumber: 0, code: 'IMPORT_BAD_DATE', message: 'The inventory valuation has no "As of" date. Give the report date (options.reportDate).' }];
    }
    return ((parsedAny as unknown[]) ?? []).length > 0 ? await checkLockDate(tenantId, companyId, [reportDate]) : [];
  }
  return [];
}

function validateCoa(_tenantId: string, rows: CanonicalCoaRow[]): ImportValidationError[] {
  const errors: ImportValidationError[] = [];
  // Within-file duplicate accountNumber and parent self-loop checks.
  const numbers = new Set<string>();
  const names = new Set<string>();
  for (const r of rows) {
    if (r.accountNumber) {
      if (numbers.has(r.accountNumber)) {
        errors.push({
          rowNumber: r.rowNumber,
          field: 'Account',
          code: 'IMPORT_DUPLICATE_ACCOUNT_NUMBER',
          message: `Account number "${r.accountNumber}" appears more than once in this file.`,
        });
      }
      numbers.add(r.accountNumber);
    }
    const nameKey = r.name.toLowerCase();
    if (names.has(nameKey)) {
      errors.push({
        rowNumber: r.rowNumber,
        field: 'Description',
        code: 'IMPORT_DUPLICATE_ACCOUNT_NAME',
        message: `Account name "${r.name}" appears more than once in this file.`,
      });
    }
    names.add(nameKey);
    if (r.parentNumber && r.parentNumber === r.accountNumber) {
      errors.push({
        rowNumber: r.rowNumber,
        field: 'SubAccount Of',
        code: 'IMPORT_PARENT_SELF_LOOP',
        message: `Account "${r.accountNumber}" cannot be its own parent.`,
      });
    }
  }
  return errors;
}

function validateContacts(rows: CanonicalContactRow[]): ImportValidationError[] {
  const errors: ImportValidationError[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.contactType}:${r.displayName.toLowerCase()}`;
    if (seen.has(key)) {
      errors.push({
        rowNumber: r.rowNumber,
        field: 'displayName',
        code: 'IMPORT_DUPLICATE_CONTACT_NAME',
        message: `Contact "${r.displayName}" appears more than once in this file.`,
      });
    }
    seen.add(key);
  }
  return errors;
}

async function validateTrialBalance(
  tenantId: string,
  companyId: string,
  rows: CanonicalTrialBalanceRow[],
  suspenseFallback = true,
): Promise<ImportValidationError[]> {
  const errors: ImportValidationError[] = [];
  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);
  // Scope to this company's CoA *plus* any tenant-wide accounts
  // (companyId IS NULL — what the legacy template seeder produces).
  // Without the per-company filter, a TB uploaded against company B
  // could resolve to an account that lives only in company A's books.
  const acctRows = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.tenantId, tenantId),
        or(eq(accounts.companyId, companyId), isNull(accounts.companyId)),
      ),
    );
  const byNum = new Map<string, (typeof acctRows)[number]>();
  const byName = new Map<string, (typeof acctRows)[number]>();
  for (const a of acctRows) {
    if (a.accountNumber) byNum.set(a.accountNumber, a);
    byName.set(a.name.toLowerCase(), a);
  }
  for (const r of rows) {
    if (r.debit) totalDebit = totalDebit.plus(r.debit);
    if (r.credit) totalCredit = totalCredit.plus(r.credit);
    const found =
      (r.accountNumber && byNum.get(r.accountNumber)) ||
      (r.accountName && byName.get(r.accountName.toLowerCase())) ||
      null;
    // With the fallback on this is not an error: commitTrialBalance posts the
    // line to suspense and reports it in the commit result instead.
    if (!found && !suspenseFallback) {
      errors.push({
        rowNumber: r.rowNumber,
        code: 'IMPORT_UNKNOWN_ACCOUNT',
        message: `Account "${r.accountNumber ?? r.accountName ?? '?'}" is not in this company's chart of accounts. Import the CoA first.`,
      });
    }
  }
  // U-260: exactly in balance (it tolerated 0.01 before). The totals show
  // every place they carry, so a sub-cent difference is visible.
  if (!totalDebit.equals(totalCredit)) {
    const places = Math.max(2, totalDebit.decimalPlaces(), totalCredit.decimalPlaces());
    errors.push({
      rowNumber: 0,
      code: 'IMPORT_JE_UNBALANCED',
      message: `Trial balance is not in balance: total debits ${totalDebit.toFixed(places)}, total credits ${totalCredit.toFixed(places)}.`,
    });
  }
  return errors;
}

/**
 * Lock-date pre-flight. ledger.postTransaction enforces this at commit
 * time (and that's the security boundary), but surfacing it during
 * validation gives the operator the diagnostic before they spend time
 * walking through the preview. Returns errors keyed to rowNumber 0 so
 * they show as a file-level issue rather than mis-attributed to a row.
 */
async function checkLockDate(
  tenantId: string,
  companyId: string,
  dates: string[],
): Promise<ImportValidationError[]> {
  if (dates.length === 0) return [];
  const [company] = await db
    .select({ lockDate: companies.lockDate })
    .from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));
  const lockDate = company?.lockDate;
  if (!lockDate) return [];
  const offending = dates.filter((d) => d <= lockDate);
  if (offending.length === 0) return [];
  const sample = offending.slice(0, 3).join(', ');
  return [{
    rowNumber: 0,
    code: 'IMPORT_LOCKED_PERIOD',
    message: `One or more entries fall on or before the company's lock date ${lockDate} (${sample}${offending.length > 3 ? `, +${offending.length - 3} more` : ''}). Adjust the lock date in Settings or change the JE date.`,
  }];
}

async function validateGl(
  tenantId: string,
  companyId: string,
  entries: CanonicalGlEntry[],
  suspenseFallback = true,
): Promise<ImportValidationError[]> {
  const errors: ImportValidationError[] = [];
  // See validateTrialBalance — scope to this company's CoA plus any
  // tenant-wide template accounts.
  const acctRows = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.tenantId, tenantId),
        or(eq(accounts.companyId, companyId), isNull(accounts.companyId)),
      ),
    );
  const byNum = new Map<string, (typeof acctRows)[number]>();
  const byName = new Map<string, (typeof acctRows)[number]>();
  for (const a of acctRows) {
    if (a.accountNumber) byNum.set(a.accountNumber, a);
    byName.set(a.name.toLowerCase(), a);
  }

  for (const e of entries) {
    let totalDebit = new Decimal(0);
    let totalCredit = new Decimal(0);
    for (const line of e.lines) {
      const found =
        (line.accountNumber && byNum.get(line.accountNumber)) ||
        (line.accountName && byName.get(line.accountName.toLowerCase())) ||
        null;
      // With the fallback on this is not an error: commitGl posts the line to
      // suspense and reports it in the commit result instead.
      if (!found && !suspenseFallback) {
        errors.push({
          rowNumber: e.rowNumber,
          code: 'IMPORT_UNKNOWN_ACCOUNT',
          message: `Journal entry references account "${line.accountNumber ?? line.accountName ?? '?'}" not in this company's chart of accounts.`,
        });
      }
      totalDebit = totalDebit.plus(line.debit || '0');
      totalCredit = totalCredit.plus(line.credit || '0');
    }
    // U-260: exactly, as the ledger posts it (assertBalanced); a 0.0001
    // difference passed here before and then failed mid-commit.
    if (!totalDebit.equals(totalCredit)) {
      const places = Math.max(2, totalDebit.decimalPlaces(), totalCredit.decimalPlaces());
      errors.push({
        rowNumber: e.rowNumber,
        code: 'IMPORT_JE_UNBALANCED',
        message: `Journal entry on ${e.date} ${e.reference ?? ''} has unbalanced debits ${totalDebit.toFixed(places)} vs credits ${totalCredit.toFixed(places)}.`,
      });
    }
  }
  return errors;
}

// ── Reading sessions ──────────────────────────────────────────────

export async function getSession(
  tenantId: string,
  companyId: string,
  id: string,
): Promise<{
  session: ImportSession;
  validationErrors: ImportValidationError[];
  preview: ImportPreview;
} | null> {
  const [row] = await db
    .select()
    .from(importSessions)
    .where(
      and(
        eq(importSessions.id, id),
        eq(importSessions.tenantId, tenantId),
        eq(importSessions.companyId, companyId),
      ),
    );
  if (!row) return null;
  const session = toSessionDto(row as unknown as SessionRowDb);
  const validationErrors = (row.validationErrors as ImportValidationError[] | null) ?? [];
  const parsedRows = await loadParsedRows(db, row);
  const preview = buildPreview(session.kind, parsedRows, validationErrors, session.reportDate, session.options);
  const accountMatches = await computeAccountMatches(db, tenantId, companyId, session.kind, parsedRows);
  if (accountMatches) preview.accountMatches = accountMatches;
  return { session, validationErrors, preview };
}

export async function listSessions(
  tenantId: string,
  companyId: string,
  filters: { kind?: ImportKind; sourceSystem?: SourceSystem; status?: ImportStatus; limit: number; offset: number },
): Promise<{ sessions: ImportSession[]; total: number }> {
  const where = and(
    eq(importSessions.tenantId, tenantId),
    eq(importSessions.companyId, companyId),
    filters.kind ? eq(importSessions.kind, filters.kind) : undefined,
    filters.sourceSystem ? eq(importSessions.sourceSystem, filters.sourceSystem) : undefined,
    filters.status ? eq(importSessions.status, filters.status) : undefined,
  );
  const rows = await db
    .select()
    .from(importSessions)
    .where(where)
    .orderBy(desc(importSessions.createdAt))
    .limit(filters.limit)
    .offset(filters.offset);
  const sessions = rows.map((r) => toSessionDto(r as unknown as SessionRowDb));
  return { sessions, total: sessions.length };
}

export async function deleteSession(
  tenantId: string,
  companyId: string,
  id: string,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: importSessions.id, batchId: importSessions.batchId })
      .from(importSessions)
      .where(and(
        eq(importSessions.id, id),
        eq(importSessions.tenantId, tenantId),
        eq(importSessions.companyId, companyId),
      ))
      .for('update');
    if (!row) return false;
    // U-261: a session a batch holds goes with the batch; only a draft or
    // failed batch lets one go (it then leaves the batch).
    if (row.batchId) {
      const [b] = await tx.select({ status: importBatches.status }).from(importBatches)
        .where(eq(importBatches.id, row.batchId)).for('update');
      if (b && !['draft', 'failed'].includes(b.status)) {
        throw AppError.conflict('This file belongs to an import that was committed or is running.', 'IMPORT_SESSION_IN_BATCH',
          { batchId: row.batchId, status: b.status });
      }
    }
    await tx.delete(importRows).where(eq(importRows.sessionId, id));
    await tx.delete(importSessions).where(eq(importSessions.id, id));
    return true;
  });
}

// ── Commit ────────────────────────────────────────────────────────

export async function commitSession(
  tenantId: string,
  companyId: string,
  userId: string,
  id: string,
  options: { dryRun?: boolean } = {},
): Promise<{ session: ImportSession; result: ImportCommitResult }> {
  const [row] = await db
    .select()
    .from(importSessions)
    .where(
      and(
        eq(importSessions.id, id),
        eq(importSessions.tenantId, tenantId),
        eq(importSessions.companyId, companyId),
      ),
    );
  if (!row) throw AppError.notFound('Import session not found.');
  if (isTerminal(row.status)) {
    throw AppError.conflict(
      `Session is already ${row.status}; cannot re-commit.`,
      'IMPORT_TERMINAL',
    );
  }

  // Re-validate against current DB state — accounts may have been
  // added since upload, or a competing TB import may have completed.
  const parsedRows = await loadParsedRows(db, row);
  const dbErrors = await validateAgainstDb(
    tenantId,
    companyId,
    row.kind as ImportKind,
    parsedRows,
    row.reportDate,
    row.options as ImportUploadOptions | null,
  );

  if (dbErrors.length > 0 && !options.dryRun) {
    await db
      .update(importSessions)
      .set({ validationErrors: dbErrors as never, errorCount: dbErrors.length, updatedAt: new Date() })
      .where(eq(importSessions.id, id));
    throw AppError.conflict(
      `Cannot commit — ${dbErrors.length} validation error(s) outstanding.`,
      'IMPORT_HAS_ERRORS',
      { errors: dbErrors.slice(0, 25) },
    );
  }

  if (options.dryRun) {
    return {
      session: toSessionDto(row as unknown as SessionRowDb),
      result: { blockingErrors: dbErrors, created: 0 },
    };
  }

  // U-261: the session commits as a one-session batch, in one database
  // transaction: on failure nothing is posted (the old path kept what it had
  // posted before the failing row). Answers as before, synchronously.
  const { commitSingleSession } = await import('./import-batch.service.js');
  const { result } = await commitSingleSession(tenantId, companyId, userId, id);
  const [updated] = await db.select().from(importSessions).where(eq(importSessions.id, id));
  return {
    session: toSessionDto((updated ?? row) as unknown as SessionRowDb),
    result,
  };
}

// ── Batch commit core (U-261) ─────────────────────────────────────

/** Posting order inside a batch: what later sessions resolve against comes first. */
// U-265: items before the trial balance and journals (their lines on an item's inventory asset
// account are history, redirected), the inventory valuation last (it clears that history).
const KIND_ORDER: Record<string, number> = {
  coa: 0, contacts: 1, items: 2, trial_balance: 3, gl_transactions: 4, open_invoices: 5, unpaid_bills: 6, inventory_valuation: 7,
};

export function sortSessionsForCommit<T extends { kind: string; createdAt: Date }>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) =>
    (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.createdAt.getTime() - b.createdAt.getTime());
}

/** Progress of a running batch: called after each step (rows done of total). */
export type ProgressFn = (step: string, done: number, total: number) => void;

/** What a batch changed on rows it did not create, restored by undo (U-261). */
export interface BatchPriorValues {
  accounts?: Record<string, {
    name: string; accountType: string; detailType: string | null; description: string | null;
    parentId: string | null; updatedAtAfter?: string | null;
  }>;
  fiscalYearStartMonth?: number | null;
  /** Taken at the end of the commit, for undo's changed-since checks (U-261). */
  stamps?: import('./import-undo.service.js').CommitStamps;
  /** An existing untagged account the commit adopted as the suspense account (or as A/R or A/P, U-264). */
  adoptedSystemAccounts?: Record<string, { systemTag: string | null; isSystem: boolean | null }>;
  /**
   * U-264: the invoice and credit memo counters open items with no number
   * advanced, before and after (null: the setting was absent). Undo puts a
   * counter back only while it still reads `after`, so a change made since
   * (a document numbered later, a new prefix) is never lost.
   */
  counters?: {
    invoice?: { before: number | null; after: number | null };
    creditMemo?: { before: number | null; after: number | null };
  };
  /**
   * U-265 (Q-77): existing contacts of the other kind the batch made 'both',
   * with their kind before. Undo puts it back while the contact is still 'both'.
   */
  contacts?: Record<string, { contactType: string }>;
  /**
   * U-267: the batch's source chart keys merged into or mapped to an existing
   * account (`n:<number>` / `name:<lowercased name>` -> account id), kept for
   * the tie-out, which resolves reference trial balance rows the way the
   * commit resolved them. Undo does not read it.
   */
  accountAliases?: Record<string, string>;
}

/**
 * What the sessions of one batch share (U-264, qbd-open-items-v1). With an
 * open_invoices (or unpaid_bills) file in the batch, A/R (or A/P) history goes
 * to "Receivables before conversion" (or "Payables before conversion"): the
 * chart's A/R and A/P accounts merge into the system account, and trial
 * balance and journal lines on them post to the before-conversion account,
 * which the open items then clear (P31 design a).
 */
export interface BatchShared {
  openItems: { ar: boolean; ap: boolean };
  /** U-265: the batch holds an inventory valuation: inventory asset history goes to "Inventory before conversion". */
  inventory: boolean;
  /** Source chart keys merged into a system account: `n:<number>` / `name:<lowercased name>` -> account id. */
  aliases: Map<string, string>;
  /** The before-conversion accounts this batch used (found or created). */
  historyAccounts: { ar?: string; ap?: string; inventory?: string };
  /** Source account keys whose trial balance or journal lines were moved there. */
  redirectedKeys: Set<string>;
  /**
   * U-265: a batch made through POST /imports/batches. Unmapped accounts fail the
   * commit (never suspense) and names merge into 'both' (Q-77). False for the old
   * one-session POST /imports/:id/commit, which keeps its behaviour.
   */
  strict: boolean;
  /** U-265: the batch's accountMap (source account key -> account id | "create"). */
  accountMap: Record<string, string>;
  /** U-265: the batch's classMap (lowercased class name -> {group?, tag}). */
  classMap: Map<string, { group?: string; tag: string }>;
  /** U-266: the batch's historyFrom: journal entries dated before it are not posted (counted). */
  historyFrom?: string;
}

export function newBatchShared(
  kinds: string[],
  opts: {
    strict?: boolean; accountMap?: Record<string, string>; classMap?: Record<string, { group?: string; tag: string }>;
    historyFrom?: string;
  } = {},
): BatchShared {
  return {
    ...(opts.historyFrom ? { historyFrom: opts.historyFrom } : {}),
    openItems: { ar: kinds.includes('open_invoices'), ap: kinds.includes('unpaid_bills') },
    inventory: kinds.includes('inventory_valuation'),
    aliases: new Map(),
    historyAccounts: {},
    redirectedKeys: new Set(),
    strict: opts.strict ?? false,
    accountMap: opts.accountMap ?? {},
    classMap: new Map(Object.entries(opts.classMap ?? {}).map(([k, v]) => [k.trim().toLowerCase(), v])),
  };
}

/** The batch result fields a batch with open items or a valuation adds (U-264, U-265): for the tie-out (E3) and the desktop. */
export function batchSharedResult(shared: BatchShared | undefined): Record<string, unknown> {
  if (!shared || (!shared.historyAccounts.ar && !shared.historyAccounts.ap && !shared.historyAccounts.inventory
    && shared.redirectedKeys.size === 0)) return {};
  return {
    historyAccounts: {
      ar: shared.historyAccounts.ar ?? null,
      ap: shared.historyAccounts.ap ?? null,
      // U-265: only in a batch with an inventory valuation.
      ...(shared.inventory ? { inventory: shared.historyAccounts.inventory ?? null } : {}),
    },
    redirectedAccountKeys: [...shared.redirectedKeys].sort(),
  };
}

export interface CommitSessionContext {
  tx: Tx;
  tenantId: string;
  companyId: string;
  userId: string;
  batchId: string;
  priorValues: BatchPriorValues;
  progress: ProgressFn;
  /** U-264: shared across the batch's sessions (absent: no open-item behaviour). */
  shared?: BatchShared;
}

/**
 * Posts one session inside the batch transaction (U-261). Every read and
 * write uses `ctx.tx`, so a later session sees what an earlier one created
 * and a failure anywhere rolls back all of it. Rows created are stamped with
 * the batch id. Throws an AppError whose details carry rowNumber when a row
 * is to blame.
 */
export async function commitSessionInBatch(
  ctx: CommitSessionContext,
  row: typeof importSessions.$inferSelect,
): Promise<ImportCommitResult> {
  const parsed = await loadParsedRows(ctx.tx, row);
  const options = (row.options as ImportUploadOptions | null) ?? {};
  if (row.kind === 'coa') {
    return await commitCoa(ctx, parsed as CanonicalCoaRow[], options);
  }
  if (row.kind === 'contacts') {
    return await commitContacts(ctx, parsed as CanonicalContactRow[]);
  }
  if (row.kind === 'items') {
    return await commitItems(ctx, parsed as CanonicalItemRow[]);
  }
  if (row.kind === 'inventory_valuation') {
    return await commitValuation(ctx, row.sourceSystem as SourceSystem, row.reportDate, parsed as CanonicalValuationRow[]);
  }
  if (row.kind === 'trial_balance') {
    return await commitTrialBalance(ctx, row.reportDate, options, parsed as CanonicalTrialBalanceRow[], row.originalFilename);
  }
  if (row.kind === 'gl_transactions') {
    return await commitGl(ctx, row.fileHash, row.sourceSystem as SourceSystem, parsed as CanonicalGlEntry[], options);
  }
  if (isOpenItemKind(row.kind)) {
    return await commitOpenItems(ctx, row.kind, row.sourceSystem as SourceSystem, parsed as CanonicalOpenItemRow[], row.id);
  }
  throw AppError.badRequest(`Unknown import kind "${row.kind}".`, 'IMPORT_WRONG_KIND');
}

/**
 * The suspense account for unmapped lines, found or made in the batch
 * transaction (a rollback leaves none behind). One the batch creates is
 * stamped with it (undo removes it); an untagged account it adopts keeps its
 * prior tag in prior_values.
 */
async function batchSuspenseAccount(ctx: CommitSessionContext): Promise<string> {
  const { tx, tenantId, companyId, userId, batchId } = ctx;
  const existing = await findSystemAccountId(tenantId, SUSPENSE_TAG, tx);
  if (existing) return existing;
  const before = new Map((await tx.select({ id: accounts.id, systemTag: accounts.systemTag, isSystem: accounts.isSystem })
    .from(accounts).where(eq(accounts.tenantId, tenantId))).map((a) => [a.id, a]));
  const id = await getOrCreateSystemAccount(tenantId, SUSPENSE_TAG, companyId, userId, tx);
  const prior = before.get(id);
  if (!prior) {
    await tx.update(accounts).set({ importBatchId: batchId }).where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, id)));
  } else {
    (ctx.priorValues.adoptedSystemAccounts ??= {})[id] = { systemTag: prior.systemTag ?? null, isSystem: prior.isSystem ?? null };
  }
  return id;
}

/** Stamps transactions a session posted with the batch id, in chunks (one UPDATE per chunk, not per row). */
async function stampTransactions(tx: Tx, tenantId: string, batchId: string, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += IMPORT_ROWS_CHUNK) {
    const chunk = ids.slice(i, i + IMPORT_ROWS_CHUNK);
    await tx.update(transactions).set({ importBatchId: batchId })
      .where(and(eq(transactions.tenantId, tenantId), inArray(transactions.id, chunk)));
  }
}

// ── Before-conversion accounts (U-264) ────────────────────────────

/**
 * The history accounts of design (a): plain other-current accounts (no
 * system tag, so documents may post to them and journal entries edit them
 * freely), found by name and type or created by the batch.
 */
export const HISTORY_ACCOUNT_SPECS = {
  ar: {
    name: 'Receivables before conversion', accountType: 'asset', detailType: 'other_current_asset',
    description: 'Receivables history from before the switch. The open invoices brought in clear it: 0.00 at the conversion date.',
  },
  ap: {
    name: 'Payables before conversion', accountType: 'liability', detailType: 'other_current_liability',
    description: 'Payables history from before the switch. The unpaid bills brought in clear it: 0.00 at the conversion date.',
  },
  // U-265 (Q-P31e, Q-P31s): never an inventory asset account (no item names it), so an inventory adjustment may offset to it.
  inventory: {
    name: 'Inventory before conversion', accountType: 'asset', detailType: 'other_current_asset',
    description: 'Inventory history from before the switch. The opening stock brought in at its exact value clears it: 0.00 at the conversion date.',
  },
} as const;

type HistorySide = keyof typeof HISTORY_ACCOUNT_SPECS;

async function historyAccount(ctx: CommitSessionContext, side: HistorySide): Promise<string> {
  const shared = ctx.shared;
  if (!shared) throw AppError.internal('Open items need the batch context.');
  const known = shared.historyAccounts[side];
  if (known) return known;
  const { tx, tenantId, companyId, batchId } = ctx;
  const spec = HISTORY_ACCOUNT_SPECS[side];
  const [found] = await tx.select({ id: accounts.id }).from(accounts).where(and(
    eq(accounts.tenantId, tenantId),
    or(eq(accounts.companyId, companyId), isNull(accounts.companyId)),
    eq(accounts.accountType, spec.accountType),
    sql`lower(${accounts.name}) = ${spec.name.toLowerCase()}`,
  )).orderBy(asc(accounts.createdAt), asc(accounts.id)).limit(1);
  let id = found?.id;
  if (!id) {
    const [created] = await tx.insert(accounts).values({
      tenantId, companyId, name: spec.name, accountType: spec.accountType, detailType: spec.detailType,
      description: spec.description, importBatchId: batchId,
    }).returning({ id: accounts.id });
    id = created!.id;
  }
  shared.historyAccounts[side] = id;
  return id;
}

/** The tenant's inventory asset accounts: tagged inventory_asset, or the asset account of an inventory part. */
export async function inventoryAssetAccountIds(tx: DbOrTx, tenantId: string): Promise<string[]> {
  const r = await tx.execute(sql`
    SELECT a.id::text AS id FROM accounts a
    WHERE a.tenant_id = ${tenantId} AND (a.system_tag = ${INVENTORY_ASSET_TAG} OR EXISTS (
      SELECT 1 FROM items i WHERE i.tenant_id = a.tenant_id AND i.item_type = 'inventory_part' AND i.asset_account_id = a.id))`);
  return (r.rows as Array<{ id: string }>).map((x) => x.id);
}

/**
 * U-265: resolves source account references the way every batch kind does:
 * the batch's accountMap first (an account id), then the chart rows merged in
 * this batch (aliases), then the company's chart by number, then by name.
 */
async function accountResolver(ctx: CommitSessionContext) {
  const { tx, tenantId, companyId } = ctx;
  const acctRows = await tx.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), or(eq(accounts.companyId, companyId), isNull(accounts.companyId))))
    .orderBy(asc(accounts.createdAt), asc(accounts.id));
  const byNum = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const a of acctRows) {
    if (a.accountNumber) byNum.set(a.accountNumber, a.id);
    // A name several accounts carry resolves to the oldest (preview.accountMatches reports the same one).
    const k = a.name.toLowerCase();
    if (!byName.has(k)) byName.set(k, a.id);
  }
  applyAliases(ctx, byNum, byName);
  const map = ctx.shared?.accountMap ?? {};
  const resolve = (accountNumber?: string | null, accountName?: string | null): string | null => {
    const key = sourceAccountKey(accountNumber, accountName);
    const mapped = key ? map[key] : undefined;
    if (mapped && mapped !== 'create') return mapped;
    return (accountNumber && byNum.get(accountNumber)) || (accountName && byName.get(accountName.toLowerCase())) || null;
  };
  return { acctRows, resolve };
}

/**
 * U-265: a batch commit refuses every account reference it can't resolve, all
 * of them in one error (never suspense): 422 IMPORT_UNMAPPED_ACCOUNT
 * {rowNumber (the first), unmappedAccountKeys (up to 500), unmappedCount}.
 */
function unmappedError(first: number, keys: Set<string>): AppError {
  const list = [...keys].sort();
  return AppError.unprocessableEntity(
    `${list.length} account(s) in this file are not in the chart of accounts and have no mapping. Map them before importing.`,
    'IMPORT_UNMAPPED_ACCOUNT',
    { rowNumber: first, unmappedAccountKeys: list.slice(0, 500), unmappedCount: list.length },
  );
}

function aliasKeys(accountNumber: string | undefined | null, name: string | undefined | null): string[] {
  return [
    ...(accountNumber ? [`n:${accountNumber}`] : []),
    ...(name ? [`name:${name.toLowerCase()}`] : []),
  ];
}

/** Lays the batch's merged chart rows (aliases) over the number and name lookups. */
function applyAliases(ctx: CommitSessionContext, byNum: Map<string, string>, byName: Map<string, string>): void {
  for (const [k, id] of ctx.shared?.aliases ?? []) {
    if (k.startsWith('n:')) byNum.set(k.slice(2), id);
    else if (k.startsWith('name:')) byName.set(k.slice(5), id);
  }
}

/**
 * With open items in the batch, a trial balance or journal line that lands on
 * an A/R (or A/P) account (system tag or detail type) posts to the
 * before-conversion account instead. Null when the batch has no open items.
 */
async function historyRedirect(
  ctx: CommitSessionContext,
  acctRows: Array<{ id: string; systemTag: string | null; detailType: string | null }>,
): Promise<{ to: (id: string, key: string) => Promise<string>; count: () => number } | null> {
  const shared = ctx.shared;
  if (!shared || (!shared.openItems.ar && !shared.openItems.ap && !shared.inventory)) return null;
  const sideOf = new Map<string, HistorySide>();
  for (const a of acctRows) {
    if (shared.openItems.ar && (a.systemTag === 'accounts_receivable' || a.detailType === 'accounts_receivable')) sideOf.set(a.id, 'ar');
    if (shared.openItems.ap && (a.systemTag === 'accounts_payable' || a.detailType === 'accounts_payable')) sideOf.set(a.id, 'ap');
  }
  // U-265: with an inventory valuation in the batch, the inventory asset accounts (tagged, or named by a part,
  // the batch's items included: they commit first) send their history to "Inventory before conversion".
  if (shared.inventory) {
    for (const id of await inventoryAssetAccountIds(ctx.tx, ctx.tenantId)) sideOf.set(id, 'inventory');
  }
  let moved = 0;
  return {
    to: async (id, key) => {
      const side = sideOf.get(id);
      if (!side) return id;
      moved++;
      shared.redirectedKeys.add(key);
      return historyAccount(ctx, side);
    },
    count: () => moved,
  };
}

// ── Commit kinds ──────────────────────────────────────────────────
// Each runs inside the batch transaction (ctx.tx) and stamps what it creates
// with ctx.batchId (U-261).

async function commitCoa(
  ctx: CommitSessionContext,
  rows: CanonicalCoaRow[],
  options: ImportUploadOptions,
): Promise<ImportCommitResult> {
  const { tx, tenantId, companyId, batchId } = ctx;
  let created = 0;
  let skipped = 0;
  let updated = 0;

  // The prior state of an existing account this file changes (name, type,
  // parent), once, before the first change: undo restores it (U-261).
  const priorAccounts = (ctx.priorValues.accounts ??= {});
  const remember = async (where: ReturnType<typeof and>) => {
    const existing = await tx.select().from(accounts).where(where);
    for (const a of existing) {
      if (a.importBatchId === batchId || priorAccounts[a.id]) continue;
      priorAccounts[a.id] = {
        name: a.name, accountType: a.accountType, detailType: a.detailType ?? null,
        description: a.description ?? null, parentId: a.parentId ?? null,
      };
    }
  };

  // Pass 1 — insert with parentId=null. The unique index
  // idx_accounts_tenant_number causes onConflictDoNothing to skip
  // existing accountNumbers cleanly. Accounts without a number (QBO
  // imports) get a fresh row each time — within-tenant uniqueness
  // for those is the operator's responsibility.
  // U-264 (Q-P31k): with open items in the batch, the source's A/R and A/P
  // accounts merge into the company's one system account of that role (its
  // lines then go to the before-conversion account); with none tagged yet,
  // the first such row becomes it. Elsewhere they import as plain accounts.
  let merged = 0;
  const roleAccount = new Map<string, string>();
  const mergeRole = (role: CanonicalCoaRow['systemRole']) => !!role && !!ctx.shared
    && ((role === 'accounts_receivable' && ctx.shared.openItems.ar) || (role === 'accounts_payable' && ctx.shared.openItems.ap));

  // U-265: a chart row the batch's accountMap sends to an existing account is not created:
  // its lines resolve to that account (as a merged system row's do). In a batch, a chart row
  // with no number whose name and type the company already has (QuickBooks files usually carry
  // no numbers; turning inventory on makes "Inventory Asset" and "Cost of Goods Sold") is that
  // account, unless the accountMap says "create".
  const mappedRows = new Set<number>();
  const byNameType = new Map<string, string>();
  if (ctx.shared?.strict) {
    const mine = await tx.select({ id: accounts.id, name: accounts.name, accountType: accounts.accountType }).from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), or(eq(accounts.companyId, companyId), isNull(accounts.companyId))))
      .orderBy(asc(accounts.createdAt), asc(accounts.id));
    for (const a of mine) {
      const k = `${a.accountType}:${a.name.trim().toLowerCase()}`;
      if (!byNameType.has(k)) byNameType.set(k, a.id);
    }
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const mapKey = sourceAccountKey(r.accountNumber, r.name);
    const mappedTo = mapKey && ctx.shared ? ctx.shared.accountMap[mapKey] : undefined;
    if (mappedTo && mappedTo !== 'create') {
      for (const k of aliasKeys(r.accountNumber, r.name)) ctx.shared!.aliases.set(k, mappedTo);
      mappedRows.add(r.rowNumber);
      skipped++;
      continue;
    }
    if (mergeRole(r.systemRole)) {
      const role = r.systemRole!;
      let target = roleAccount.get(role) ?? await findSystemAccountId(tenantId, role, tx);
      if (target) {
        merged++;
      } else {
        const [ins] = await tx.insert(accounts).values({
          tenantId, companyId, accountNumber: r.accountNumber ?? null, name: r.name, accountType: r.accountType,
          detailType: role, description: r.description ?? null, isSystem: true, systemTag: role, importBatchId: batchId,
        }).onConflictDoNothing().returning({ id: accounts.id });
        if (ins) {
          target = ins.id;
          created++;
        } else {
          // Its number is an existing untagged account: that account takes the role (undo gives it back).
          const [same] = await tx.select().from(accounts)
            .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountNumber, r.accountNumber!))).limit(1);
          if (!same || same.systemTag) {
            throw AppError.conflict(`Account number "${r.accountNumber}" is already used by another system account.`,
              'IMPORT_SYSTEM_ACCOUNT_CONFLICT', { rowNumber: r.rowNumber });
          }
          (ctx.priorValues.adoptedSystemAccounts ??= {})[same.id] = { systemTag: same.systemTag ?? null, isSystem: same.isSystem ?? null };
          await tx.update(accounts).set({ systemTag: role, isSystem: true, updatedAt: new Date() })
            .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, same.id)));
          target = same.id;
          merged++;
        }
      }
      roleAccount.set(role, target);
      for (const k of aliasKeys(r.accountNumber, r.name)) ctx.shared!.aliases.set(k, target);
      if ((i + 1) % 200 === 0) ctx.progress('coa', i + 1, rows.length);
      continue;
    }
    const sameName = !r.accountNumber && mappedTo !== 'create' ? byNameType.get(`${r.accountType}:${r.name.trim().toLowerCase()}`) : undefined;
    if (sameName) {
      for (const k of aliasKeys(r.accountNumber, r.name)) ctx.shared!.aliases.set(k, sameName);
      mappedRows.add(r.rowNumber);
      skipped++;
      continue;
    }
    const insertResult = await tx
      .insert(accounts)
      .values({
        tenantId,
        companyId,
        accountNumber: r.accountNumber ?? null,
        name: r.name,
        accountType: r.accountType,
        detailType: r.detailType ?? null,
        description: r.description ?? null,
        importBatchId: batchId,
      })
      .onConflictDoNothing()
      .returning({ id: accounts.id });
    if (insertResult.length > 0) {
      created++;
    } else if (options.updateExistingCoa && r.accountNumber) {
      // Existing account, operator opted into overwrite — count as updated.
      const where = and(eq(accounts.tenantId, tenantId), eq(accounts.accountNumber, r.accountNumber));
      await remember(where);
      await tx
        .update(accounts)
        .set({
          name: r.name,
          accountType: r.accountType,
          detailType: r.detailType ?? null,
          description: r.description ?? null,
          updatedAt: new Date(),
        })
        .where(where);
      updated++;
    } else {
      // Existing account, operator did not opt in — leave alone.
      skipped++;
    }
    if ((i + 1) % 200 === 0) ctx.progress('coa', i + 1, rows.length);
  }

  // Pass 2 — link parents. Build a number→id and name→id map of every
  // account in this tenant (including ones that pre-existed the file)
  // and resolve parentNumber / parentName for each row.
  const allAccts = await tx.select().from(accounts).where(eq(accounts.tenantId, tenantId));
  const byNum = new Map<string, string>();
  const byName = new Map<string, string>();
  const parentOf = new Map<string, string | null>();
  for (const a of allAccts) {
    if (a.accountNumber) byNum.set(a.accountNumber, a.id);
    byName.set(a.name.toLowerCase(), a.id);
    parentOf.set(a.id, a.parentId ?? null);
  }
  for (const r of rows) {
    if (mergeRole(r.systemRole) || mappedRows.has(r.rowNumber)) continue; // merged or mapped: its parent stays as it is
    let parentId: string | null = null;
    if (r.parentNumber) parentId = byNum.get(r.parentNumber) ?? null;
    if (!parentId && r.parentName) parentId = byName.get(r.parentName.toLowerCase()) ?? null;
    if (!parentId) continue;
    const childId = (r.accountNumber && byNum.get(r.accountNumber)) || byName.get(r.name.toLowerCase());
    if (!childId || childId === parentId || parentOf.get(childId) === parentId) continue;
    const where = and(eq(accounts.id, childId), eq(accounts.tenantId, tenantId));
    await remember(where);
    await tx
      .update(accounts)
      .set({ parentId, updatedAt: new Date() })
      .where(where);
    parentOf.set(childId, parentId);
  }

  return { created, skipped, updated, ...(merged > 0 ? { mergedIntoSystemAccounts: merged } : {}) };
}

/**
 * U-265: the company's contacts by display name (case-insensitive), for the
 * names of a batch (Q-77): a name found as the other kind becomes 'both' (its
 * kind before kept in prior_values when the batch did not create it); a name
 * not found is created, stamped with the batch.
 */
async function contactNames(ctx: CommitSessionContext) {
  const { tx, tenantId, companyId, batchId } = ctx;
  type Entry = { id: string; contactType: string; mine: boolean };
  const rows = await tx.select({
    id: contacts.id, displayName: contacts.displayName, contactType: contacts.contactType, importBatchId: contacts.importBatchId,
  }).from(contacts).where(and(eq(contacts.tenantId, tenantId), or(eq(contacts.companyId, companyId), isNull(contacts.companyId))))
    .orderBy(asc(contacts.createdAt), asc(contacts.id));
  const byName = new Map<string, Entry[]>();
  const add = (name: string, e: Entry) => {
    const k = name.trim().toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), e]);
  };
  for (const r of rows) add(r.displayName, { id: r.id, contactType: r.contactType, mine: r.importBatchId === batchId });
  let created = 0;
  let merged = 0;
  return {
    /** The contact of that name usable as `want` (that kind or both); null when there is none. */
    find(name: string, want: ContactKind): string | null {
      return (byName.get(name.trim().toLowerCase()) ?? []).find((e) => e.contactType === want || e.contactType === 'both')?.id ?? null;
    },
    async ensure(name: string, want: ContactKind, values: Partial<typeof contacts.$inferInsert> = {}): Promise<{ id: string; outcome: 'existing' | 'merged' | 'created' }> {
      const list = byName.get(name.trim().toLowerCase()) ?? [];
      const same = list.find((e) => e.contactType === want || e.contactType === 'both');
      if (same) return { id: same.id, outcome: 'existing' };
      const other = list.find((e) => e.contactType === 'customer' || e.contactType === 'vendor');
      if (other) {
        if (!other.mine) (ctx.priorValues.contacts ??= {})[other.id] ??= { contactType: other.contactType };
        await tx.update(contacts).set({ contactType: 'both', updatedAt: new Date() })
          .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, other.id)));
        other.contactType = 'both';
        merged++;
        return { id: other.id, outcome: 'merged' };
      }
      const [c] = await tx.insert(contacts).values({
        ...values, tenantId, companyId, contactType: want, displayName: name.trim(), importBatchId: batchId,
      }).returning({ id: contacts.id });
      add(name, { id: c!.id, contactType: want, mine: true });
      created++;
      return { id: c!.id, outcome: 'created' };
    },
    counts: () => ({ created, merged }),
  };
}

/**
 * Contacts in a batch (U-265): one contact per name (Q-77: a name on the
 * customer and the vendor list becomes 'both'), inactive names inactive, a
 * job row ("Customer:Job") folded into its customer (created when missing)
 * until the engine has a projects list (U-35). The old one-session commit
 * keeps its behaviour (commitContactsLegacy).
 */
async function commitContacts(
  ctx: CommitSessionContext,
  rows: CanonicalContactRow[],
): Promise<ImportCommitResult> {
  // The old path left inactive names out and kept a job as a contact of its full name.
  if (!ctx.shared?.strict) return await commitContactsLegacy(ctx, rows.filter((r) => r.isActive !== false));
  const { tx, tenantId } = ctx;
  const names = await contactNames(ctx);
  const coa = rows.some((r) => r.defaultExpenseAccountRaw)
    ? await tx.select({ id: accounts.id, accountNumber: accounts.accountNumber, name: accounts.name, accountType: accounts.accountType })
      .from(accounts).where(eq(accounts.tenantId, tenantId))
    : [];
  const byNumber = new Map<string, string>();
  const byAcctName = new Map<string, { id: string; isExpense: boolean }>();
  for (const a of coa) {
    if (a.accountNumber) byNumber.set(a.accountNumber.trim(), a.id);
    const key = a.name.trim().toLowerCase();
    const isExpense = ['expense', 'cogs', 'other_expense'].includes(a.accountType);
    const known = byAcctName.get(key);
    if (!known || (isExpense && !known.isExpense)) byAcctName.set(key, { id: a.id, isExpense });
  }
  const resolveAccount = (raw: string | undefined): string | null => {
    const v = raw?.trim();
    return v ? (byNumber.get(v) ?? byAcctName.get(v.toLowerCase())?.id ?? null) : null;
  };
  let skipped = 0;
  let accountsLinked = 0;
  let inactive = 0;
  let jobsFolded = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.jobOf) {
      await names.ensure(r.jobOf, 'customer');
      jobsFolded++;
      continue;
    }
    const defaultExpenseAccountId = r.contactType === 'vendor' ? resolveAccount(r.defaultExpenseAccountRaw) : null;
    const res = await names.ensure(r.displayName, r.contactType, {
      email: r.email ?? null,
      phone: r.phone ?? null,
      billingLine1: r.billingAddress ? r.billingAddress.split('\n')[0] : null,
      shippingLine1: r.shippingAddress ? r.shippingAddress.split('\n')[0] : null,
      is1099Eligible: (r as { is1099Eligible?: boolean }).is1099Eligible ?? false,
      defaultExpenseAccountId,
      isActive: r.isActive !== false,
    });
    if (res.outcome === 'existing') skipped++;
    if (res.outcome === 'created') {
      if (defaultExpenseAccountId) accountsLinked++;
      if (r.isActive === false) inactive++;
    }
    if ((i + 1) % 200 === 0) ctx.progress('contacts', i + 1, rows.length);
  }
  const { created, merged } = names.counts();
  return {
    created, skipped, accountsLinked,
    ...(merged > 0 ? { mergedToBoth: merged } : {}),
    ...(inactive > 0 ? { inactive } : {}),
    ...(jobsFolded > 0 ? { jobsFolded } : {}),
  };
}

async function commitContactsLegacy(
  ctx: CommitSessionContext,
  rows: CanonicalContactRow[],
): Promise<ImportCommitResult> {
  const { tx, tenantId, companyId, batchId } = ctx;
  let created = 0;
  let skipped = 0;
  let accountsLinked = 0;

  // Resolve source default-expense accounts ("Account" column on the
  // Accounting Power vendor export) against the tenant's chart:
  // exact account-number match first, then case-insensitive name.
  // Name collisions prefer expense-type accounts (that's what a
  // vendor default is). COA is imported before vendors in a
  // migration, so numbers usually line up; unmatched values are
  // simply not linked — never a commit failure.
  const needsAccounts = rows.some((r) => r.defaultExpenseAccountRaw);
  const byNumber = new Map<string, string>();
  const byName = new Map<string, { id: string; isExpense: boolean }>();
  if (needsAccounts) {
    const coa = await tx
      .select({ id: accounts.id, accountNumber: accounts.accountNumber, name: accounts.name, accountType: accounts.accountType })
      .from(accounts)
      .where(eq(accounts.tenantId, tenantId));
    for (const a of coa) {
      if (a.accountNumber) byNumber.set(a.accountNumber.trim(), a.id);
      const key = a.name.trim().toLowerCase();
      const isExpense = ['expense', 'cogs', 'other_expense'].includes(a.accountType);
      const existing = byName.get(key);
      if (!existing || (isExpense && !existing.isExpense)) {
        byName.set(key, { id: a.id, isExpense });
      }
    }
  }
  const resolveAccount = (raw: string | undefined): string | null => {
    if (!raw) return null;
    const v = raw.trim();
    if (!v) return null;
    return byNumber.get(v) ?? byName.get(v.toLowerCase())?.id ?? null;
  };

  // No unique index on contacts so dedup programmatically: existing
  // (tenant, contact_type, lower-trimmed(display_name)) → skip.
  // Normalize once, key once, so a CSV with both "Acme Corp" and
  // "ACME CORP" (or with stray surrounding whitespace) collapses to a
  // single insert instead of one-skipped-one-inserted.
  const normalize = (s: string) => s.trim().toLowerCase();
  const existing = await tx
    .select({
      contactType: contacts.contactType,
      displayName: contacts.displayName,
    })
    .from(contacts)
    .where(eq(contacts.tenantId, tenantId));
  const seen = new Set<string>();
  for (const e of existing) {
    seen.add(`${e.contactType}:${normalize(e.displayName)}`);
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const key = `${r.contactType}:${normalize(r.displayName)}`;
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    const defaultExpenseAccountId =
      r.contactType === 'vendor' ? resolveAccount(r.defaultExpenseAccountRaw) : null;
    if (defaultExpenseAccountId) accountsLinked++;
    await tx.insert(contacts).values({
      tenantId,
      companyId,
      contactType: r.contactType,
      displayName: r.displayName.trim(),
      email: r.email ?? null,
      phone: r.phone ?? null,
      billingLine1: r.billingAddress ? r.billingAddress.split('\n')[0] : null,
      shippingLine1: r.shippingAddress ? r.shippingAddress.split('\n')[0] : null,
      // Accounting Power vendor exports carry a 1099 flag — preserve it
      // so eligibility doesn't have to be re-marked by hand post-import.
      is1099Eligible: (r as { is1099Eligible?: boolean }).is1099Eligible ?? false,
      // Source vendor's default expense category, resolved against the
      // COA — keeps expense-form prefill / batch entry / bill OCR warm
      // from day one instead of starting cold.
      defaultExpenseAccountId,
      importBatchId: batchId,
    });
    created++;
    if ((i + 1) % 200 === 0) ctx.progress('contacts', i + 1, rows.length);
  }
  return { created, skipped, accountsLinked };
}

async function commitTrialBalance(
  ctx: CommitSessionContext,
  reportDate: string | null,
  options: ImportUploadOptions,
  rows: CanonicalTrialBalanceRow[],
  filename: string,
): Promise<ImportCommitResult> {
  const { tx, tenantId, companyId, userId, batchId } = ctx;
  if (!reportDate) {
    throw AppError.badRequest('Trial balance has no report date.', 'IMPORT_BAD_DATE');
  }
  const tbColumn: TbColumnChoice | undefined = options.tbColumn;
  const sourceId = `${reportDate}:${tbColumn ?? 'qbo'}`;

  // Refuse if a TB JE for the same (date, column) already exists.
  const existingTb = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.tenantId, tenantId),
        eq(transactions.source, IMPORT_SOURCE_TAGS.TRIAL_BALANCE),
        eq(transactions.sourceId, sourceId),
      ),
    );
  if (existingTb.length > 0) {
    throw AppError.conflict(
      `An opening JE for ${reportDate}${tbColumn ? ` (${tbColumn})` : ''} has already been imported on this company.`,
      'IMPORT_TB_DUPLICATE',
      { existingTransactionId: existingTb[0]!.id },
    );
  }

  // Resolve account names/numbers to ids — scoped to this company's
  // CoA plus tenant-wide template accounts. Same scope rule as
  // validateTrialBalance. U-265: the batch's accountMap first.
  const { acctRows, resolve } = await accountResolver(ctx);
  const redirect = await historyRedirect(ctx, acctRows);
  // Lines naming an account this CoA does not have go to suspense (default)
  // so the opening JE still balances and the work is reviewable, instead of
  // aborting the whole import. Resolved lazily: a file that maps cleanly
  // never mints a suspense account. U-265: a batch import never does that;
  // every unresolved account fails it, in one error.
  const fallbackOn = !ctx.shared?.strict && suspenseFallbackOn(options);
  if (ctx.shared?.strict) {
    const missing = new Set<string>();
    let first = 0;
    for (const r of rows) {
      if (resolve(r.accountNumber, r.accountName)) continue;
      missing.add(r.accountNumber ?? r.accountName ?? '?');
      first ||= r.rowNumber;
    }
    if (missing.size > 0) throw unmappedError(first, missing);
  }
  let suspenseAccountId: string | null = null;
  const unmappedKeys = new Set<string>();

  const lines = [];
  for (const r of rows) {
    let id = resolve(r.accountNumber, r.accountName);
    if (id && redirect) id = await redirect.to(id, r.accountNumber ?? r.accountName ?? '?');
    if (!id) {
      const key = r.accountNumber ?? r.accountName ?? '?';
      if (!fallbackOn) {
        throw AppError.unprocessableEntity(
          `Account "${key}" not found.`,
          'IMPORT_UNKNOWN_ACCOUNT',
          { rowNumber: r.rowNumber },
        );
      }
      suspenseAccountId ??= await batchSuspenseAccount(ctx);
      unmappedKeys.add(key);
      id = suspenseAccountId;
    }
    lines.push({
      accountId: id,
      debit: r.debit ?? '0',
      credit: r.credit ?? '0',
    });
  }

  const txn = await postTransaction(
    tenantId,
    {
      txnType: 'journal_entry',
      txnDate: reportDate,
      memo: `Opening balances imported from ${filename}${tbColumn ? ` (${tbColumn})` : ''}`,
      source: IMPORT_SOURCE_TAGS.TRIAL_BALANCE,
      sourceId,
      lines,
    },
    userId,
    companyId,
    tx,
  );
  await stampTransactions(tx, tenantId, batchId, [txn.id]);
  ctx.progress('trial_balance', 1, 1);

  return {
    created: 1,
    skipped: 0,
    ...(redirect && redirect.count() > 0 ? { redirectedLines: redirect.count() } : {}),
    ...(unmappedKeys.size > 0
      ? { unmappedToSuspense: unmappedKeys.size, unmappedAccountKeys: [...unmappedKeys].sort() }
      : {}),
  };
}

async function commitGl(
  ctx: CommitSessionContext,
  fileHash: string,
  sourceSystem: SourceSystem,
  entries: CanonicalGlEntry[],
  options: ImportUploadOptions | null,
): Promise<ImportCommitResult> {
  const { tx, tenantId, companyId, userId, batchId } = ctx;
  let created = 0;
  let skipped = 0;
  let voidsReversed = 0;
  // See commitTrialBalance — unmapped accounts land in suspense by default so
  // the JE still balances and the fix becomes reviewable work (not in a batch, U-265).
  let suspenseAccountId: string | null = null;
  const unmappedKeys = new Set<string>();

  const sourceTag =
    sourceSystem === 'accounting_power'
      ? IMPORT_SOURCE_TAGS.AP_GL
      : sourceSystem === 'quickbooks_desktop'
        ? IMPORT_SOURCE_TAGS.QBD_GL
        : sourceSystem === 'generic'
          ? IMPORT_SOURCE_TAGS.GENERIC_GL
          : IMPORT_SOURCE_TAGS.QBO_GL;

  // sourceId is keyed on fileHash + entry-index + void-variant. This means
  // re-uploading the SAME bytes (even after the prior session was cancelled
  // or the operator just hit Upload twice) yields the SAME sourceIds and
  // the existing dedup catches every entry. Earlier code keyed on
  // sessionId, which broke idempotency on re-upload because each upload
  // created a fresh session id. Switching to fileHash keeps re-upload
  // safe without giving up the upload-time same-bytes guard. An undone
  // batch deleted its entries (U-261), so a re-commit after undo finds none.
  //
  // Prefix-scope the dedup query to this file's sourceId space (the
  // fileHash prefix). Without this, a tenant with a long import history
  // would pull every previously-imported sourceId on every commit — for
  // a tenant that's done dozens of imports across years that's a slow
  // O(N) scan over the full transactions table for no benefit.
  const existing = await tx
    .select({ sourceId: transactions.sourceId })
    .from(transactions)
    .where(
      and(
        eq(transactions.tenantId, tenantId),
        eq(transactions.source, sourceTag),
        like(transactions.sourceId, `${fileHash}:%`),
      ),
    );
  const seenSourceIds = new Set(existing.map((e) => e.sourceId).filter(Boolean) as string[]);

  // Build accountId lookup once — scoped to this company's CoA plus
  // tenant-wide template accounts (companyId IS NULL). U-265: the batch's
  // accountMap first; a batch import never posts to suspense.
  const { acctRows, resolve } = await accountResolver(ctx);
  const redirect = await historyRedirect(ctx, acctRows);
  const fallbackOn = !ctx.shared?.strict && suspenseFallbackOn(options);
  // U-266: entries before the batch's historyFrom are skipped in place (never filtered out of the
  // array: an entry's sourceId is its index in the file), counted, and need no account or class.
  const historyFrom = ctx.shared?.historyFrom;
  const posts = (e: CanonicalGlEntry) => !historyFrom || e.date >= historyFrom;
  if (ctx.shared?.strict) {
    const missing = new Set<string>();
    let first = 0;
    for (const e of entries) {
      if (!posts(e)) continue;
      for (const line of e.lines) {
        if (resolve(line.accountNumber, line.accountName)) continue;
        missing.add(line.accountNumber ?? line.accountName ?? '?');
        first ||= e.rowNumber;
      }
    }
    if (missing.size > 0) throw unmappedError(first, missing);
  }

  // Resolve (and auto-create) every tag named across the file up front, so a
  // single tag referenced by many rows is created once. The Generic importer
  // populates line.tagName from its Tag column; the QBO/QBD adapters populate
  // it from the Class column (class tracking); for other sources this is a
  // no-op. U-265: the batch's classMap turns a class into a tag in a group.
  const classNames = entries.filter(posts).flatMap((e) => e.lines.map((l) => l.tagName).filter((n): n is string => !!n));
  const { map: tagMap, created: tagsCreated, mapped: classesMapped } = ctx.shared && ctx.shared.classMap.size > 0
    ? await ensureMappedTags(ctx, classNames)
    : { ...(await ensureTags(tx, tenantId, companyId, classNames, batchId)), mapped: 0 };

  // Match each entry's imported "Description" (e.name) to an existing vendor
  // contact so imported GL transactions carry a payee. Deliberately
  // conservative: descriptions are frequently full memos, so we match ONLY
  // when the description equals a vendor name (case/punctuation-insensitive) —
  // never a substring, since a wrong payee is worse than a blank one. Scoped
  // to vendor/both contacts; a name shared by two active vendors is marked
  // ambiguous (null) and skipped. Never creates a contact.
  const vendorRows = await tx
    .select({ id: contacts.id, displayName: contacts.displayName })
    .from(contacts)
    .where(
      and(
        eq(contacts.tenantId, tenantId),
        or(eq(contacts.contactType, 'vendor'), eq(contacts.contactType, 'both')),
        eq(contacts.isActive, true),
      ),
    );
  const vendorByName = new Map<string, string | null>();
  for (const v of vendorRows) {
    const key = normalizeLoose(v.displayName ?? '');
    if (!key) continue;
    vendorByName.set(key, vendorByName.has(key) ? null : v.id);
  }
  let vendorsMatched = 0;
  let skippedBeforeHistory = 0;
  const postedIds: string[] = [];

  for (let idx = 0; idx < entries.length; idx++) {
    const e = entries[idx]!;
    if (!posts(e)) {
      skippedBeforeHistory++;
      continue;
    }
    const variant = e.isVoidReversal ? 'V' : 'O';
    const sourceId = `${fileHash}:${idx}:${variant}`;
    if (seenSourceIds.has(sourceId)) {
      skipped++;
      continue;
    }

    const lines = [];
    for (const line of e.lines) {
      let id = resolve(line.accountNumber, line.accountName);
      if (id && redirect) id = await redirect.to(id, line.accountNumber ?? line.accountName ?? '?');
      if (!id) {
        const key = line.accountNumber ?? line.accountName ?? '?';
        if (!fallbackOn) {
          // The batch transaction rolls back: nothing of the batch is posted.
          throw AppError.unprocessableEntity(
            `JE on ${e.date} references unknown account "${key}"`,
            'IMPORT_UNKNOWN_ACCOUNT',
            { rowNumber: e.rowNumber, failedAtIndex: idx, accountKey: line.accountNumber ?? line.accountName },
          );
        }
        suspenseAccountId ??= await batchSuspenseAccount(ctx);
        unmappedKeys.add(key);
        id = suspenseAccountId;
      }
      lines.push({
        accountId: id,
        debit: line.debit || '0',
        credit: line.credit || '0',
        ...(line.tagName ? { tagId: tagMap.get(line.tagName.trim().toLowerCase()) } : {}),
      });
    }

    const memoPrefix = e.isVoidReversal ? `[VOID-${e.sourceCode}]` : `[${e.sourceCode}]`;
    const memo = `${memoPrefix} ${e.memo ?? e.name ?? ''}`.trim();

    // Resolve a vendor from the description (exact normalized equality only).
    const matchKey = normalizeLoose(e.name ?? '');
    const matchedContactId = matchKey ? (vendorByName.get(matchKey) ?? null) : null;
    if (matchedContactId) vendorsMatched++;

    try {
      const txn = await postTransaction(
        tenantId,
        {
          txnType: 'journal_entry',
          txnDate: e.date,
          txnNumber: e.reference,
          memo,
          contactId: matchedContactId ?? undefined,
          source: sourceTag,
          sourceId,
          lines,
        },
        userId,
        companyId,
        tx,
      );
      postedIds.push(txn.id);
    } catch (err) {
      // The batch transaction rolls back; the error names the row.
      const msg = err instanceof Error ? err.message : String(err);
      const status = err instanceof AppError ? err.statusCode : 422;
      throw new AppError(
        status === 423 || status === 403 ? status : 422,
        `Failed posting JE at row ${e.rowNumber} (${e.date} ${e.reference ?? ''}): ${msg}`,
        err instanceof AppError ? (err.code ?? 'IMPORT_POST_FAILED') : 'IMPORT_POST_FAILED',
        { ...(err instanceof AppError ? (err.details ?? {}) : {}), rowNumber: e.rowNumber, failedAtIndex: idx, originalError: msg },
      );
    }
    created++;
    if (e.isVoidReversal) voidsReversed++;
    if ((idx + 1) % 100 === 0) ctx.progress('gl_transactions', idx + 1, entries.length);
  }
  await stampTransactions(tx, tenantId, batchId, postedIds);
  ctx.progress('gl_transactions', entries.length, entries.length);
  return {
    created, skipped, voidsReversed, vendorsMatched,
    ...(tagsCreated ? { tagsCreated } : {}),
    ...(classesMapped ? { classesMapped } : {}),
    ...(historyFrom ? { skippedBeforeHistory } : {}),
    ...(redirect && redirect.count() > 0 ? { redirectedLines: redirect.count() } : {}),
    ...(unmappedKeys.size > 0
      ? { unmappedToSuspense: unmappedKeys.size, unmappedAccountKeys: [...unmappedKeys].sort() }
      : {}),
  };
}

/**
 * U-266: a conversion whose conversion-date trial balance shows a nonzero
 * balance on an inventory asset account (tagged inventory_asset, or the asset
 * account of an inventory part, the batch's own items included) needs the
 * inventory valuation file: 422 IMPORT_VALUATION_REQUIRED {sessionId,
 * accounts [{sourceKey, balance}]}. An account only QuickBooks knows as
 * inventory (no part names it, no tag) can't be told apart and isn't refused.
 */
export async function assertValuationNotNeeded(
  ctx: CommitSessionContext,
  sessions: Array<typeof importSessions.$inferSelect>,
): Promise<void> {
  const inventoryIds = new Set(await inventoryAssetAccountIds(ctx.tx, ctx.tenantId));
  if (inventoryIds.size === 0) return;
  const { resolve } = await accountResolver(ctx);
  for (const s of sessions) {
    const rows = (await loadParsedRows(ctx.tx, s)) as CanonicalTrialBalanceRow[];
    const byKey = new Map<string, Decimal>();
    for (const r of rows) {
      const id = resolve(r.accountNumber, r.accountName);
      if (!id || !inventoryIds.has(id)) continue;
      const key = sourceAccountKey(r.accountNumber, r.accountName) ?? '?';
      byKey.set(key, (byKey.get(key) ?? new Decimal(0)).plus(r.debit ?? '0').minus(r.credit ?? '0'));
    }
    const nonzero = [...byKey].filter(([, v]) => !v.isZero()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (nonzero.length > 0) {
      throw AppError.unprocessableEntity(
        'The trial balance shows an inventory balance. Add the Inventory Valuation Summary as of the conversion date.',
        'IMPORT_VALUATION_REQUIRED',
        { sessionId: s.id, accounts: nonzero.map(([sourceKey, v]) => ({ sourceKey, balance: v.toFixed(Math.max(2, v.decimalPlaces())) })) },
      );
    }
  }
}

// ── Open items (U-264, qbd-open-items-v1) ─────────────────────────

const SOURCE_LABEL: Record<string, string> = {
  quickbooks_desktop: 'QuickBooks Desktop',
  quickbooks_online: 'QuickBooks Online',
  generic: 'the import file',
  accounting_power: 'Accounting Power',
};

/** The memo of an imported open item: where it came from, its number and, when partly paid, its original amount. */
function openItemMemo(sourceSystem: string, r: CanonicalOpenItemRow): string {
  const open = new Decimal(r.openBalance).abs();
  const original = r.originalAmount !== undefined ? new Decimal(r.originalAmount).abs() : null;
  const parts = [`Open balance brought in from ${SOURCE_LABEL[sourceSystem] ?? sourceSystem}`, `${r.sourceType}${r.number ? ` ${r.number}` : ''}`];
  if (original && !original.equals(open)) parts.push(`original amount ${original.toFixed(2)}, open ${open.toFixed(2)}`);
  return parts.join('; ');
}

/**
 * U-267: transactions.source of an imported open item; source_id is
 * `<sessionId>:<rowNumber>` (openItemSourceId), its source row.
 */
export const OPEN_ITEM_SOURCE = 'import_open_item';

export function openItemSourceId(sessionId: string, rowNumber: number): string {
  return `${sessionId}:${rowNumber}`;
}

/** The invoice and credit memo counters (null: not set). */
async function readCounters(ctx: CommitSessionContext): Promise<{ invoice: number | null; creditMemo: number | null }> {
  const [co] = await ctx.tx.select({ invoiceNextNumber: companies.invoiceNextNumber, documentNumbers: companies.documentNumbers })
    .from(companies).where(and(eq(companies.tenantId, ctx.tenantId), eq(companies.id, ctx.companyId))).limit(1);
  const cm = (co?.documentNumbers as Record<string, { next?: number }> | null | undefined)?.['credit_memo']?.next;
  return { invoice: co?.invoiceNextNumber ?? null, creditMemo: typeof cm === 'number' ? cm : null };
}

/**
 * Each open item becomes a real one-line document whose line goes to the
 * before-conversion account (P31 design a): an invoice or credit memo
 * (open_invoices), a bill or vendor credit (unpaid_bills), for the open
 * balance exactly, with the source number, date and due date. A name not
 * found among the company's customers (or vendors) is created, stamped with
 * the batch. Posts through the invoice, credit memo, bill and vendor credit
 * services in the batch transaction (review S3), without sales tax.
 */
async function commitOpenItems(
  ctx: CommitSessionContext,
  kind: 'open_invoices' | 'unpaid_bills',
  sourceSystem: SourceSystem,
  rows: CanonicalOpenItemRow[],
  sessionId?: string,
): Promise<ImportCommitResult> {
  const { tx, tenantId, companyId, userId, batchId } = ctx;
  if (rows.length === 0) return { created: 0, skipped: 0 };
  // A row with no number takes the next invoice or credit memo number: undo gives it back.
  const claims = kind === 'open_invoices' && rows.some((r) => !r.number);
  const countersBefore = claims ? await readCounters(ctx) : null;
  const historyId = await historyAccount(ctx, kind === 'open_invoices' ? 'ar' : 'ap');
  const { createInvoiceWithWarnings } = await import('../invoice.service.js');
  const { createCreditMemoWithWarnings } = await import('../credit-memo.service.js');
  const { createBill } = await import('../bill.service.js');
  const { createVendorCredit } = await import('../vendor-credit.service.js');

  // Names: the company's customers (or vendors), both-kind contacts too; the exact type first.
  const want = kind === 'open_invoices' ? 'customer' : 'vendor';
  const existing = await tx.select({ id: contacts.id, displayName: contacts.displayName, contactType: contacts.contactType })
    .from(contacts).where(and(
      eq(contacts.tenantId, tenantId),
      or(eq(contacts.companyId, companyId), isNull(contacts.companyId)),
      inArray(contacts.contactType, [want, 'both']),
    )).orderBy(asc(contacts.createdAt), asc(contacts.id));
  const byName = new Map<string, string>();
  for (const c of [...existing.filter((e) => e.contactType === want), ...existing.filter((e) => e.contactType !== want)]) {
    const k = c.displayName.trim().toLowerCase();
    if (!byName.has(k)) byName.set(k, c.id);
  }

  const documents: Partial<Record<CanonicalOpenItemRow['docType'], number>> = {};
  let contactsCreated = 0;
  // U-265: in a batch, a name found as the other kind becomes 'both' (Q-77) rather than a second
  // contact, and "Customer:Job" is the customer (no projects list yet, U-35) with the job in the memo.
  const names = ctx.shared?.strict ? await contactNames(ctx) : null;
  const posted: string[] = [];
  const links: Array<{ id: string; sourceId: string }> = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const key = r.name.trim().toLowerCase();
    let contactId: string | undefined;
    let job: string | null = null;
    if (names) {
      // "Customer:Job" is QuickBooks' notation; elsewhere a colon is part of the name.
      const colon = sourceSystem === 'quickbooks_desktop' || sourceSystem === 'quickbooks_online' ? r.name.indexOf(':') : -1;
      if (!names.find(r.name, want) && colon > 0) {
        job = r.name.slice(colon + 1).trim();
        contactId = (await names.ensure(r.name.slice(0, colon), want)).id;
      } else {
        contactId = (await names.ensure(r.name, want)).id;
      }
    } else {
      contactId = byName.get(key);
      if (!contactId) {
        const [c] = await tx.insert(contacts).values({
          tenantId, companyId, contactType: want, displayName: r.name.trim(), importBatchId: batchId,
        }).returning({ id: contacts.id });
        contactId = c!.id;
        byName.set(key, contactId);
        contactsCreated++;
      }
    }
    const amount = new Decimal(r.openBalance).abs().toFixed(2);
    const memo = `${openItemMemo(sourceSystem, r)}${job ? `; job ${job}` : ''}`;
    const description = r.docType === 'invoice' || r.docType === 'bill' ? 'Open balance brought in' : 'Open credit brought in';
    let id: string;
    let total: string;
    try {
      if (r.docType === 'invoice') {
        const input = {
          contactId, txnDate: r.date, ...(r.dueDate ? { dueDate: r.dueDate } : {}), memo, warnOnly: true,
          ...(r.number ? { txnNumber: r.number } : {}),
          lines: [{ accountId: historyId, description, quantity: '1', unitPrice: amount, isTaxable: false }],
        } as CreateInvoiceInput;
        const { invoice } = await createInvoiceWithWarnings(tenantId, input, userId, companyId, tx);
        id = invoice.id;
        total = String(invoice.total);
      } else if (r.docType === 'credit_memo') {
        const input = {
          contactId, txnDate: r.date, memo, warnOnly: true, ...(r.number ? { txnNumber: r.number } : {}),
          lines: [{ accountId: historyId, description, quantity: '1', unitPrice: amount }],
        } as CreateCreditMemoInput;
        const { transaction } = await createCreditMemoWithWarnings(tenantId, input, userId, companyId, tx);
        id = transaction.id;
        total = String(transaction.total);
      } else if (r.docType === 'bill') {
        const bill = await createBill(tenantId, {
          contactId, txnDate: r.date, ...(r.dueDate ? { dueDate: r.dueDate } : {}), memo,
          ...(r.number ? { vendorInvoiceNumber: r.number } : {}),
          lines: [{ accountId: historyId, amount, description }],
        } as never, userId, companyId, tx);
        id = bill.id;
        total = String(bill.total);
      } else {
        const credit = await createVendorCredit(tenantId, {
          contactId, txnDate: r.date, memo, ...(r.number ? { vendorInvoiceNumber: r.number } : {}),
          lines: [{ accountId: historyId, amount, description }],
        } as never, userId, companyId, tx);
        id = credit.id;
        total = String(credit.total);
      }
    } catch (err) {
      // The batch transaction rolls back; the error names the row.
      const msg = err instanceof Error ? err.message : String(err);
      throw new AppError(
        err instanceof AppError && (err.statusCode === 423 || err.statusCode === 403) ? err.statusCode : 422,
        `Failed posting the open item at row ${r.rowNumber}: ${msg}`,
        err instanceof AppError ? (err.code ?? 'IMPORT_POST_FAILED') : 'IMPORT_POST_FAILED',
        { ...(err instanceof AppError ? (err.details ?? {}) : {}), rowNumber: r.rowNumber, originalError: msg },
      );
    }
    // Exactly the open balance, or nothing posts (a price level, tax or rounding would change it).
    if (!new Decimal(total).equals(amount)) {
      throw AppError.unprocessableEntity(`The open item at row ${r.rowNumber} posted ${total}, not ${amount}.`,
        'IMPORT_OPEN_ITEM_AMOUNT', { rowNumber: r.rowNumber });
    }
    posted.push(id);
    if (sessionId) links.push({ id, sourceId: openItemSourceId(sessionId, r.rowNumber) });
    documents[r.docType] = (documents[r.docType] ?? 0) + 1;
    if ((i + 1) % 100 === 0) ctx.progress(kind, i + 1, rows.length);
  }
  await stampTransactions(tx, tenantId, batchId, posted);
  // U-267: each document names its source row (session and row number), so the tie-out keys items by source row.
  for (let i = 0; i < links.length; i += IMPORT_ROWS_CHUNK) {
    const chunk = links.slice(i, i + IMPORT_ROWS_CHUNK);
    await tx.execute(sql`
      UPDATE transactions t SET source = ${OPEN_ITEM_SOURCE}, source_id = v.sid
      FROM (VALUES ${sql.join(chunk.map((l) => sql`(${l.id}::uuid, ${l.sourceId}::varchar)`), sql`, `)}) AS v(id, sid)
      WHERE t.tenant_id = ${tenantId} AND t.id = v.id`);
  }
  if (countersBefore) {
    const after = await readCounters(ctx);
    const k = (ctx.priorValues.counters ??= {});
    if (after.invoice !== countersBefore.invoice) {
      k.invoice = { before: k.invoice?.before ?? countersBefore.invoice, after: after.invoice };
    }
    if (after.creditMemo !== countersBefore.creditMemo) {
      k.creditMemo = { before: k.creditMemo ? k.creditMemo.before : countersBefore.creditMemo, after: after.creditMemo };
    }
  }
  ctx.progress(kind, rows.length, rows.length);
  if (names) {
    const n = names.counts();
    contactsCreated = n.created;
    if (n.merged > 0) return { created: posted.length, skipped: 0, documents, ...(contactsCreated > 0 ? { contactsCreated } : {}), mergedToBoth: n.merged };
  }
  return { created: posted.length, skipped: 0, documents, ...(contactsCreated > 0 ? { contactsCreated } : {}) };
}

// ── Items and inventory valuation (U-265, qbd-mapping-v1) ─────────

/** Rethrows a service refusal with the row it came from (the batch transaction rolls back). */
function rowError(err: unknown, rowNumber: number, what: string): AppError {
  const msg = err instanceof Error ? err.message : String(err);
  return new AppError(
    err instanceof AppError && [403, 409, 423].includes(err.statusCode) ? err.statusCode : 422,
    `Failed importing the ${what} at row ${rowNumber}: ${msg}`,
    err instanceof AppError ? (err.code ?? 'IMPORT_POST_FAILED') : 'IMPORT_POST_FAILED',
    { ...(err instanceof AppError ? (err.details ?? {}) : {}), rowNumber, originalError: msg },
  );
}

/**
 * Items (U-265): each row becomes an item through the item service (its kind
 * and account checks, its audit row) in the batch transaction, stamped with
 * the batch. Accounts resolve like journal lines (accountMap, merged chart
 * rows, number, name); any unresolved one fails the commit, all listed
 * (IMPORT_UNMAPPED_ACCOUNT), in every path. A name the tenant already has is
 * left as it is (itemsSkipped.exists); sales tax items, groups and payment
 * items are listed but not imported; a subtotal with no account is skipped.
 * Inactive items come in inactive. The preferred vendor is matched by name
 * among the company's vendors (never created).
 */
async function commitItems(ctx: CommitSessionContext, rows: CanonicalItemRow[]): Promise<ImportCommitResult> {
  const { tx, tenantId, companyId, userId, batchId } = ctx;
  const { resolve } = await accountResolver(ctx);
  const skippedBy: NonNullable<ImportCommitResult['itemsSkipped']> = {};
  const bump = (k: keyof typeof skippedBy) => { skippedBy[k] = (skippedBy[k] ?? 0) + 1; };
  const existing = await tx.select({ name: items.name }).from(items).where(eq(items.tenantId, tenantId));
  const taken = new Set(existing.map((x) => x.name.toLowerCase()));
  const todo = rows.filter((r) => {
    if (!r.itemType) { bump(r.skipReason ?? 'group'); return false; }
    if (taken.has(r.name.toLowerCase())) { bump('exists'); return false; }
    if (r.itemType === 'subtotal' && !r.incomeAccount) { bump('no_account'); return false; }
    return true;
  });
  const refId = (a: AccountRef | undefined) => (a ? resolve(a.accountNumber, a.accountName) : null);
  const missing = new Set<string>();
  let first = 0;
  for (const r of todo) {
    for (const a of [r.incomeAccount, r.expenseAccount, r.assetAccount, r.cogsAccount]) {
      if (!a || refId(a)) continue;
      missing.add(sourceAccountKey(a.accountNumber, a.accountName) ?? '?');
      first ||= r.rowNumber;
    }
  }
  if (missing.size > 0) throw unmappedError(first, missing);

  const vendors = await tx.select({ id: contacts.id, displayName: contacts.displayName }).from(contacts).where(and(
    eq(contacts.tenantId, tenantId), or(eq(contacts.companyId, companyId), isNull(contacts.companyId)),
    inArray(contacts.contactType, ['vendor', 'both']),
  )).orderBy(asc(contacts.createdAt), asc(contacts.id));
  const vendorByName = new Map<string, string>();
  for (const v of vendors) {
    const k = v.displayName.trim().toLowerCase();
    if (!vendorByName.has(k)) vendorByName.set(k, v.id);
  }
  const { create } = await import('../items.service.js');
  let created = 0;
  let inactive = 0;
  for (let i = 0; i < todo.length; i++) {
    const r = todo[i]!;
    const input = {
      name: r.name,
      description: r.description ?? null,
      itemType: r.itemType!,
      unitPrice: r.unitPrice ?? null,
      discountPercent: r.discountPercent ?? null,
      incomeAccountId: refId(r.incomeAccount)!,
      isTaxable: r.isTaxable ?? true,
      purchaseDescription: r.purchaseDescription ?? null,
      purchaseCost: r.purchaseCost ?? null,
      expenseAccountId: refId(r.expenseAccount),
      assetAccountId: refId(r.assetAccount),
      cogsAccountId: refId(r.cogsAccount),
      preferredVendorId: r.preferredVendor ? (vendorByName.get(r.preferredVendor.trim().toLowerCase()) ?? null) : null,
      reorderPoint: r.reorderPoint ?? null,
    };
    let id: string;
    try {
      const item = await create(tenantId, input as never, userId, companyId, tx);
      id = (item as { id: string }).id;
    } catch (err) {
      throw rowError(err, r.rowNumber, 'item');
    }
    await tx.update(items).set({ importBatchId: batchId, ...(r.isActive ? {} : { isActive: false }) })
      .where(and(eq(items.tenantId, tenantId), eq(items.id, id)));
    taken.add(r.name.toLowerCase());
    created++;
    if (!r.isActive) inactive++;
    if ((i + 1) % 200 === 0) ctx.progress('items', i + 1, todo.length);
  }
  ctx.progress('items', todo.length, todo.length);
  const skipped = rows.length - created;
  return {
    created, skipped,
    ...(Object.keys(skippedBy).length > 0 ? { itemsSkipped: skippedBy } : {}),
    ...(inactive > 0 ? { inactive } : {}),
  };
}

const VALUATION_CHUNK = 500;

/**
 * Inventory valuation (U-265, review S6; Q-P31e, Q-P31s): each row becomes
 * opening stock of its inventory item, dated the report date, for the exact
 * quantity and value of the report (never quantity x average cost), offset
 * to "Inventory before conversion" (an inventory adjustment can't offset to an
 * inventory asset account). With the batch's trial balance and journal lines
 * on inventory asset accounts sent to that account, it ends at 0.00 and the
 * Inventory Asset accounts hold exactly the valuation. Each movement posted is
 * checked against the report (IMPORT_VALUATION_MISMATCH otherwise).
 */
/**
 * U-265: the inventory part a valuation row names: the item of that name, else
 * (a name with no colon) the one item whose last "Parent:Sub" segment it is.
 * Shared by the commit and the tie-out (U-267), so both read a row the same way.
 */
export async function valuationItemMatcher(ex: DbOrTx, tenantId: string, companyId: string) {
  const all = await ex.select({ id: items.id, name: items.name, itemType: items.itemType, companyId: items.companyId })
    .from(items).where(eq(items.tenantId, tenantId));
  const byName = new Map<string, typeof all>();
  const lastSegment = new Map<string, typeof all>();
  for (const it of all) {
    const k = it.name.toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), it]);
    const seg = it.name.split(':').pop()!.trim().toLowerCase();
    lastSegment.set(seg, [...(lastSegment.get(seg) ?? []), it]);
  }
  return (item: string): { itemId: string } | { reason: 'unknown' | 'ambiguous' | 'other_company' | 'not_inventory' } => {
    const k = item.toLowerCase();
    let hit = byName.get(k);
    // A report that prints only a sub-item's own name: the one item whose last segment it is.
    if (!hit && !k.includes(':')) hit = lastSegment.get(k);
    if (!hit || hit.length !== 1) return { reason: hit ? 'ambiguous' : 'unknown' };
    const it = hit[0]!;
    if (it.companyId && it.companyId !== companyId) return { reason: 'other_company' };
    if (it.itemType !== 'inventory_part') return { reason: 'not_inventory' };
    return { itemId: it.id };
  };
}

async function commitValuation(
  ctx: CommitSessionContext,
  sourceSystem: SourceSystem,
  reportDate: string | null,
  rows: CanonicalValuationRow[],
): Promise<ImportCommitResult> {
  const { tx, tenantId, companyId, userId, batchId } = ctx;
  if (rows.length === 0) return { created: 0, skipped: 0, itemsValued: 0, valuationTotal: '0.00' };
  if (!reportDate) throw AppError.badRequest('The inventory valuation has no report date.', 'IMPORT_BAD_DATE');
  const match = await valuationItemMatcher(tx, tenantId, companyId);
  const lines: Array<{ itemId: string; quantityChange: string; valueChange: string; row: CanonicalValuationRow }> = [];
  const problems: Array<{ rowNumber: number; item: string; reason: string }> = [];
  for (const r of rows) {
    const m = match(r.item);
    if ('reason' in m) { problems.push({ rowNumber: r.rowNumber, item: r.item, reason: m.reason }); continue; }
    lines.push({ itemId: m.itemId, quantityChange: r.onHand, valueChange: r.assetValue, row: r });
  }
  if (problems.length > 0) {
    const code = problems.every((p) => p.reason === 'not_inventory') ? 'IMPORT_ITEM_NOT_INVENTORY' : 'IMPORT_UNKNOWN_ITEM';
    throw AppError.unprocessableEntity(
      `${problems.length} item(s) of the inventory valuation are not inventory items of this company. Import the item list first.`,
      code, { rowNumber: problems[0]!.rowNumber, items: problems.slice(0, 200), itemCount: problems.length },
    );
  }
  const offset = await historyAccount(ctx, 'inventory');
  const { postAdjustment } = await import('../inventory-adjustment.service.js');
  const label = SOURCE_LABEL[sourceSystem] ?? sourceSystem;
  const posted: string[] = [];
  let total = new Decimal(0);
  for (let i = 0; i < lines.length; i += VALUATION_CHUNK) {
    const chunk = lines.slice(i, i + VALUATION_CHUNK);
    let txnId: string;
    try {
      const txn = await postAdjustment(tenantId, companyId, {
        txnDate: reportDate, adjustmentAccountId: offset,
        memo: `Opening inventory brought in from ${label} (valuation as of ${reportDate})`,
        lines: chunk.map((l) => ({ itemId: l.itemId, quantityChange: l.quantityChange, valueChange: l.valueChange })),
      }, userId, tx, { openingZero: true });
      txnId = txn.id;
    } catch (err) {
      throw rowError(err, chunk[0]!.row.rowNumber, 'inventory valuation');
    }
    // Exactly the report's figures, or nothing posts.
    const mv = await tx.select({ itemId: inventoryMovements.itemId, quantity: inventoryMovements.quantity, value: inventoryMovements.value })
      .from(inventoryMovements).where(and(eq(inventoryMovements.tenantId, tenantId), eq(inventoryMovements.transactionId, txnId)));
    const byItem = new Map(mv.map((m) => [m.itemId, m]));
    for (const l of chunk) {
      const m = byItem.get(l.itemId);
      if (!m || !new Decimal(m.quantity).equals(l.quantityChange) || !new Decimal(m.value).equals(l.valueChange)) {
        throw AppError.unprocessableEntity(`The opening stock of "${l.row.item}" did not post at the report's quantity and value.`,
          'IMPORT_VALUATION_MISMATCH', { rowNumber: l.row.rowNumber });
      }
      total = total.plus(l.valueChange);
    }
    posted.push(txnId);
    ctx.progress('inventory_valuation', Math.min(i + VALUATION_CHUNK, lines.length), lines.length);
  }
  await stampTransactions(tx, tenantId, batchId, posted);
  return { created: posted.length, skipped: 0, itemsValued: lines.length, valuationTotal: total.toFixed(2) };
}
