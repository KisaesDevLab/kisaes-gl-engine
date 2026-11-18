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
} from '../../db/schema/index.js';
import { normalizeLoose } from '../ai-name-match.js';
import {
  IMPORT_SOURCE_TAGS,
  type CanonicalCoaRow,
  type CanonicalContactRow,
  type CanonicalGlEntry,
  type CanonicalTrialBalanceRow,
  type ContactKind,
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
import { getSuspenseAccountId } from '../system-accounts.service.js';
import * as ap from './adapters/accounting-power.js';
import * as qbo from './adapters/quickbooks-online.js';
import * as qbd from './adapters/quickbooks-desktop.js';
import * as generic from './adapters/generic.js';
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

/** First and last entry date of a journal file (null for other kinds or an empty file). */
function glDateRange(kind: ImportKind, parsed: unknown): { from: string | null; to: string | null } {
  if (kind !== 'gl_transactions') return { from: null, to: null };
  let from: string | null = null;
  let to: string | null = null;
  for (const e of (parsed as CanonicalGlEntry[]) ?? []) {
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

const TERMINAL_STATUSES: readonly ImportStatus[] = ['committed', 'failed', 'cancelled'];

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
  const rows = (parsed as { rowNumber: number }[]) ?? [];
  return {
    totalRows: rows.length,
    errorCount,
    sampleRows: rows.slice(0, MAX_PREVIEW_ROWS),
  };
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
      const { rows, errors } = ap.parseContacts(buf, options.contactKind);
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
      const { rows, errors } = await generic.parseContacts(buf, options.contactKind);
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
    const { rows, errors } = await qbo.parseContacts(buf, options.contactKind);
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
    await assertNoCommittedOverlap(db, input.tenantId, input.companyId, input.sourceSystem, range.from, range.to);
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
  const preview = buildPreview(
    session.kind,
    await loadParsedRows(db, row),
    validationErrors,
    session.reportDate,
    session.options,
  );
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
const KIND_ORDER: Record<string, number> = { coa: 0, contacts: 1, trial_balance: 2, gl_transactions: 3 };

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
}

export interface CommitSessionContext {
  tx: Tx;
  tenantId: string;
  companyId: string;
  userId: string;
  batchId: string;
  priorValues: BatchPriorValues;
  progress: ProgressFn;
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
  if (row.kind === 'trial_balance') {
    return await commitTrialBalance(ctx, row.reportDate, options, parsed as CanonicalTrialBalanceRow[], row.originalFilename);
  }
  if (row.kind === 'gl_transactions') {
    return await commitGl(ctx, row.fileHash, row.sourceSystem as SourceSystem, parsed as CanonicalGlEntry[], options);
  }
  throw AppError.badRequest(`Unknown import kind "${row.kind}".`, 'IMPORT_WRONG_KIND');
}

/** Stamps transactions a session posted with the batch id, in chunks (one UPDATE per chunk, not per row). */
async function stampTransactions(tx: Tx, tenantId: string, batchId: string, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += IMPORT_ROWS_CHUNK) {
    const chunk = ids.slice(i, i + IMPORT_ROWS_CHUNK);
    await tx.update(transactions).set({ importBatchId: batchId })
      .where(and(eq(transactions.tenantId, tenantId), inArray(transactions.id, chunk)));
  }
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
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
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

  return { created, skipped, updated };
}

async function commitContacts(
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
  // validateTrialBalance.
  const acctRows = await tx
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.tenantId, tenantId),
        or(eq(accounts.companyId, companyId), isNull(accounts.companyId)),
      ),
    );
  const byNum = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const a of acctRows) {
    if (a.accountNumber) byNum.set(a.accountNumber, a.id);
    byName.set(a.name.toLowerCase(), a.id);
  }
  // Lines naming an account this CoA does not have go to suspense (default)
  // so the opening JE still balances and the work is reviewable, instead of
  // aborting the whole import. Resolved lazily: a file that maps cleanly
  // never mints a suspense account.
  const fallbackOn = suspenseFallbackOn(options);
  let suspenseAccountId: string | null = null;
  const unmappedKeys = new Set<string>();

  const lines = [];
  for (const r of rows) {
    let id =
      (r.accountNumber && byNum.get(r.accountNumber)) ||
      (r.accountName && byName.get(r.accountName.toLowerCase()));
    if (!id) {
      const key = r.accountNumber ?? r.accountName ?? '?';
      if (!fallbackOn) {
        throw AppError.unprocessableEntity(
          `Account "${key}" not found.`,
          'IMPORT_UNKNOWN_ACCOUNT',
          { rowNumber: r.rowNumber },
        );
      }
      suspenseAccountId ??= await getSuspenseAccountId(tenantId, companyId, userId);
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
  // the JE still balances and the fix becomes reviewable work.
  const fallbackOn = suspenseFallbackOn(options);
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
  // tenant-wide template accounts (companyId IS NULL).
  const acctRows = await tx
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.tenantId, tenantId),
        or(eq(accounts.companyId, companyId), isNull(accounts.companyId)),
      ),
    );
  const byNum = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const a of acctRows) {
    if (a.accountNumber) byNum.set(a.accountNumber, a.id);
    byName.set(a.name.toLowerCase(), a.id);
  }

  // Resolve (and auto-create) every tag named across the file up front, so a
  // single tag referenced by many rows is created once. The Generic importer
  // populates line.tagName from its Tag column; the QBO/QBD adapters populate
  // it from the Class column (class tracking); for other sources this is a
  // no-op.
  const { map: tagMap, created: tagsCreated } = await ensureTags(
    tx,
    tenantId,
    companyId,
    entries.flatMap((e) => e.lines.map((l) => l.tagName).filter((n): n is string => !!n)),
    batchId,
  );

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
  const postedIds: string[] = [];

  for (let idx = 0; idx < entries.length; idx++) {
    const e = entries[idx]!;
    const variant = e.isVoidReversal ? 'V' : 'O';
    const sourceId = `${fileHash}:${idx}:${variant}`;
    if (seenSourceIds.has(sourceId)) {
      skipped++;
      continue;
    }

    const lines = [];
    for (const line of e.lines) {
      let id =
        (line.accountNumber && byNum.get(line.accountNumber)) ||
        (line.accountName && byName.get(line.accountName.toLowerCase()));
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
        suspenseAccountId ??= await getSuspenseAccountId(tenantId, companyId, userId);
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
    ...(unmappedKeys.size > 0
      ? { unmappedToSuspense: unmappedKeys.size, unmappedAccountKeys: [...unmappedKeys].sort() }
      : {}),
  };
}
