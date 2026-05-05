// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Bulk-import orchestration. Adapters parse vendor formats into
// canonical rows; this service persists the parse output as a session,
// runs DB-aware validation, and commits via the existing
// postTransaction / accounts insert paths so we don't reinvent
// debits-equal-credits / scope checks / lock-date enforcement.

import * as crypto from 'crypto';
import { and, eq, desc, isNull, or, like } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  importSessions,
  accounts,
  contacts,
  transactions,
  companies,
} from '../../db/schema/index.js';
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
import * as ap from './adapters/accounting-power.js';
import * as qbo from './adapters/quickbooks-online.js';
import { postTransaction } from '../ledger.service.js';
import { Decimal } from 'decimal.js';

// ── Helpers ───────────────────────────────────────────────────────

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
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
}

function toSessionDto(row: SessionRowDb): ImportSession {
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
  };
}

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
      sampleRows: entries.slice(0, 50),
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
      sampleRows: rows.slice(0, 50),
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
    sampleRows: rows.slice(0, 50),
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
  );
  const allErrors = [...parsed.errors, ...dbErrors];

  const [inserted] = await db
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
      // jsonSafe scrubs any stray Decimal/Date instances so the JSONB
      // round-trip is byte-for-byte equivalent and res.json() never
      // throws on `[object Object]` tokens.
      parsedRows: jsonSafe(parsed.parsed) as never,
      validationErrors: jsonSafe(allErrors) as never,
      options: input.options as never,
      reportDate,
      createdBy: input.userId,
    })
    .returning();
  if (!inserted) throw AppError.internal('Failed to insert import session.');
  const session = toSessionDto(inserted as unknown as SessionRowDb);
  const preview = buildPreview(input.kind, parsed.parsed, allErrors, reportDate, input.options);
  return { session, preview, validationErrors: allErrors };
}

// ── Validation ────────────────────────────────────────────────────

async function validateAgainstDb(
  tenantId: string,
  companyId: string,
  kind: ImportKind,
  parsedAny: unknown,
  reportDate: string | null,
): Promise<ImportValidationError[]> {
  if (kind === 'coa') return validateCoa(tenantId, parsedAny as CanonicalCoaRow[]);
  if (kind === 'contacts') return validateContacts(parsedAny as CanonicalContactRow[]);
  if (kind === 'trial_balance') {
    const errs = await validateTrialBalance(tenantId, companyId, parsedAny as CanonicalTrialBalanceRow[]);
    // Pre-flight lock-date against the operator-supplied report date.
    if (reportDate) {
      errs.push(...(await checkLockDate(tenantId, companyId, [reportDate])));
    }
    return errs;
  }
  if (kind === 'gl_transactions') {
    const entries = parsedAny as CanonicalGlEntry[];
    const errs = await validateGl(tenantId, companyId, entries);
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
    if (!found) {
      errors.push({
        rowNumber: r.rowNumber,
        code: 'IMPORT_UNKNOWN_ACCOUNT',
        message: `Account "${r.accountNumber ?? r.accountName ?? '?'}" is not in this company's chart of accounts. Import the CoA first.`,
      });
    }
  }
  if (totalDebit.minus(totalCredit).abs().greaterThan('0.01')) {
    errors.push({
      rowNumber: 0,
      code: 'IMPORT_JE_UNBALANCED',
      message: `Trial balance is not in balance: total debits ${totalDebit.toFixed(2)}, total credits ${totalCredit.toFixed(2)}.`,
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
      if (!found) {
        errors.push({
          rowNumber: e.rowNumber,
          code: 'IMPORT_UNKNOWN_ACCOUNT',
          message: `Journal entry references account "${line.accountNumber ?? line.accountName ?? '?'}" not in this company's chart of accounts.`,
        });
      }
      totalDebit = totalDebit.plus(line.debit || '0');
      totalCredit = totalCredit.plus(line.credit || '0');
    }
    if (totalDebit.minus(totalCredit).abs().greaterThan('0.0001')) {
      errors.push({
        rowNumber: e.rowNumber,
        code: 'IMPORT_JE_UNBALANCED',
        message: `Journal entry on ${e.date} ${e.reference ?? ''} has unbalanced debits ${totalDebit.toFixed(2)} vs credits ${totalCredit.toFixed(2)}.`,
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
    row.parsedRows,
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
  const result = await db
    .delete(importSessions)
    .where(
      and(
        eq(importSessions.id, id),
        eq(importSessions.tenantId, tenantId),
        eq(importSessions.companyId, companyId),
      ),
    )
    .returning();
  return result.length > 0;
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
  const dbErrors = await validateAgainstDb(
    tenantId,
    companyId,
    row.kind as ImportKind,
    row.parsedRows,
    row.reportDate,
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

  // Atomic status transition: only the request that flips
  // 'uploaded' → 'committing' is allowed to run the commit body. A
  // second concurrent /commit call sees status != 'uploaded' and
  // bails. Without this guard two parallel commits could both pass
  // the in-memory isTerminal check above and double-post every JE.
  const claim = await db
    .update(importSessions)
    .set({ status: 'committing', updatedAt: new Date() })
    .where(and(eq(importSessions.id, id), eq(importSessions.status, 'uploaded')))
    .returning({ id: importSessions.id });
  if (claim.length === 0) {
    throw AppError.conflict(
      'Another commit for this session is already in progress.',
      'IMPORT_COMMIT_IN_PROGRESS',
    );
  }

  let result: ImportCommitResult;
  try {
    if (row.kind === 'coa') {
      result = await commitCoa(
        tenantId,
        companyId,
        row.parsedRows as CanonicalCoaRow[],
        (row.options as ImportUploadOptions | null) ?? {},
      );
    } else if (row.kind === 'contacts') {
      result = await commitContacts(
        tenantId,
        companyId,
        row.parsedRows as CanonicalContactRow[],
      );
    } else if (row.kind === 'trial_balance') {
      result = await commitTrialBalance(
        tenantId,
        companyId,
        userId,
        row.id,
        row.reportDate,
        (row.options as ImportUploadOptions | null) ?? {},
        row.parsedRows as CanonicalTrialBalanceRow[],
        row.originalFilename,
      );
    } else if (row.kind === 'gl_transactions') {
      result = await commitGl(
        tenantId,
        companyId,
        userId,
        row.fileHash,
        row.sourceSystem as SourceSystem,
        row.parsedRows as CanonicalGlEntry[],
      );
    } else {
      throw AppError.badRequest(`Unknown import kind "${row.kind}".`, 'IMPORT_WRONG_KIND');
    }
  } catch (e) {
    const errMessage = e instanceof Error ? e.message : String(e);
    // commitGl mid-loop failures throw AppError with details
    // {createdSoFar, failedAtIndex} so the partial progress can be
    // surfaced. For other failures (e.g. parser-level, DB connection)
    // we just record the message; created stays 0.
    const details = (e instanceof AppError ? e.details : undefined) as
      | { createdSoFar?: number; failedAtIndex?: number }
      | undefined;
    await db
      .update(importSessions)
      .set({
        status: 'failed',
        commitResult: {
          error: errMessage,
          created: details?.createdSoFar ?? 0,
          failedAtIndex: details?.failedAtIndex,
        } as never,
        updatedAt: new Date(),
      })
      .where(eq(importSessions.id, id));
    throw e;
  }

  const [updated] = await db
    .update(importSessions)
    .set({
      status: 'committed',
      commitResult: result as never,
      committedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(importSessions.id, id))
    .returning();
  return {
    session: toSessionDto((updated ?? row) as unknown as SessionRowDb),
    result,
  };
}

// ── Commit kinds ──────────────────────────────────────────────────

async function commitCoa(
  tenantId: string,
  companyId: string,
  rows: CanonicalCoaRow[],
  options: ImportUploadOptions,
): Promise<ImportCommitResult> {
  let created = 0;
  let skipped = 0;
  let updated = 0;

  // Pass 1 — insert with parentId=null. The unique index
  // idx_accounts_tenant_number causes onConflictDoNothing to skip
  // existing accountNumbers cleanly. Accounts without a number (QBO
  // imports) get a fresh row each time — within-tenant uniqueness
  // for those is the operator's responsibility.
  for (const r of rows) {
    const insertResult = await db
      .insert(accounts)
      .values({
        tenantId,
        companyId,
        accountNumber: r.accountNumber ?? null,
        name: r.name,
        accountType: r.accountType,
        detailType: r.detailType ?? null,
        description: r.description ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: accounts.id });
    if (insertResult.length > 0) {
      created++;
    } else if (options.updateExistingCoa && r.accountNumber) {
      // Existing account, operator opted into overwrite — count as updated.
      await db
        .update(accounts)
        .set({
          name: r.name,
          accountType: r.accountType,
          detailType: r.detailType ?? null,
          description: r.description ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(eq(accounts.tenantId, tenantId), eq(accounts.accountNumber, r.accountNumber)),
        );
      updated++;
    } else {
      // Existing account, operator did not opt in — leave alone.
      skipped++;
    }
  }

  // Pass 2 — link parents. Build a number→id and name→id map of every
  // account in this tenant (including ones that pre-existed the file)
  // and resolve parentNumber / parentName for each row.
  const allAccts = await db.select().from(accounts).where(eq(accounts.tenantId, tenantId));
  const byNum = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const a of allAccts) {
    if (a.accountNumber) byNum.set(a.accountNumber, a.id);
    byName.set(a.name.toLowerCase(), a.id);
  }
  for (const r of rows) {
    let parentId: string | null = null;
    if (r.parentNumber) parentId = byNum.get(r.parentNumber) ?? null;
    if (!parentId && r.parentName) parentId = byName.get(r.parentName.toLowerCase()) ?? null;
    if (!parentId) continue;
    const childId = (r.accountNumber && byNum.get(r.accountNumber)) || byName.get(r.name.toLowerCase());
    if (!childId || childId === parentId) continue;
    await db
      .update(accounts)
      .set({ parentId, updatedAt: new Date() })
      .where(and(eq(accounts.id, childId), eq(accounts.tenantId, tenantId)));
  }

  return { created, skipped, updated };
}

async function commitContacts(
  tenantId: string,
  companyId: string,
  rows: CanonicalContactRow[],
): Promise<ImportCommitResult> {
  let created = 0;
  let skipped = 0;
  // No unique index on contacts so dedup programmatically: existing
  // (tenant, contact_type, lower-trimmed(display_name)) → skip.
  // Normalize once, key once, so a CSV with both "Acme Corp" and
  // "ACME CORP" (or with stray surrounding whitespace) collapses to a
  // single insert instead of one-skipped-one-inserted.
  const normalize = (s: string) => s.trim().toLowerCase();
  const existing = await db
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

  for (const r of rows) {
    const key = `${r.contactType}:${normalize(r.displayName)}`;
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    await db.insert(contacts).values({
      tenantId,
      companyId,
      contactType: r.contactType,
      displayName: r.displayName.trim(),
      email: r.email ?? null,
      phone: r.phone ?? null,
      billingLine1: r.billingAddress ? r.billingAddress.split('\n')[0] : null,
      shippingLine1: r.shippingAddress ? r.shippingAddress.split('\n')[0] : null,
    });
    created++;
  }
  return { created, skipped };
}

async function commitTrialBalance(
  tenantId: string,
  companyId: string,
  userId: string,
  sessionId: string,
  reportDate: string | null,
  options: ImportUploadOptions,
  rows: CanonicalTrialBalanceRow[],
  filename: string,
): Promise<ImportCommitResult> {
  if (!reportDate) {
    throw AppError.badRequest('Trial balance has no report date.', 'IMPORT_BAD_DATE');
  }
  const tbColumn: TbColumnChoice | undefined = options.tbColumn;
  const sourceId = `${reportDate}:${tbColumn ?? 'qbo'}`;

  // Refuse if a TB JE for the same (date, column) already exists.
  const existingTb = await db
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
  const acctRows = await db
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
  const lines = [];
  for (const r of rows) {
    const id =
      (r.accountNumber && byNum.get(r.accountNumber)) ||
      (r.accountName && byName.get(r.accountName.toLowerCase()));
    if (!id) {
      throw AppError.unprocessableEntity(
        `Account "${r.accountNumber ?? r.accountName ?? '?'}" not found.`,
        'IMPORT_UNKNOWN_ACCOUNT',
      );
    }
    lines.push({
      accountId: id,
      debit: r.debit ?? '0',
      credit: r.credit ?? '0',
    });
  }

  await postTransaction(
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
  );

  void sessionId; // sessionId reserved for future per-session traceability fields
  return { created: 1, skipped: 0 };
}

async function commitGl(
  tenantId: string,
  companyId: string,
  userId: string,
  fileHash: string,
  sourceSystem: SourceSystem,
  entries: CanonicalGlEntry[],
): Promise<ImportCommitResult> {
  let created = 0;
  let skipped = 0;
  let voidsReversed = 0;

  const sourceTag =
    sourceSystem === 'accounting_power' ? IMPORT_SOURCE_TAGS.AP_GL : IMPORT_SOURCE_TAGS.QBO_GL;

  // sourceId is keyed on fileHash + entry-index + void-variant. This means
  // re-uploading the SAME bytes (even after the prior session was cancelled
  // or the operator just hit Upload twice) yields the SAME sourceIds and
  // the existing dedup catches every entry. Earlier code keyed on
  // sessionId, which broke idempotency on re-upload because each upload
  // created a fresh session id. Switching to fileHash keeps re-upload
  // safe without giving up the upload-time same-bytes guard.
  //
  // Prefix-scope the dedup query to this file's sourceId space (the
  // fileHash prefix). Without this, a tenant with a long import history
  // would pull every previously-imported sourceId on every commit — for
  // a tenant that's done dozens of imports across years that's a slow
  // O(N) scan over the full transactions table for no benefit.
  const existing = await db
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
  const acctRows = await db
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
      const id =
        (line.accountNumber && byNum.get(line.accountNumber)) ||
        (line.accountName && byName.get(line.accountName.toLowerCase()));
      if (!id) {
        // Mid-loop failure. Throw an AppError carrying `created` so far
        // so commitSession's catch block can persist partial progress
        // into commit_result and the operator UI can surface it.
        throw AppError.unprocessableEntity(
          `JE on ${e.date} references unknown account "${line.accountNumber ?? line.accountName ?? '?'}"`,
          'IMPORT_UNKNOWN_ACCOUNT',
          { createdSoFar: created, failedAtIndex: idx, accountKey: line.accountNumber ?? line.accountName },
        );
      }
      lines.push({
        accountId: id,
        debit: line.debit || '0',
        credit: line.credit || '0',
      });
    }

    const memoPrefix = e.isVoidReversal ? `[VOID-${e.sourceCode}]` : `[${e.sourceCode}]`;
    const memo = `${memoPrefix} ${e.memo ?? e.name ?? ''}`.trim();

    try {
      await postTransaction(
        tenantId,
        {
          txnType: 'journal_entry',
          txnDate: e.date,
          txnNumber: e.reference,
          memo,
          source: sourceTag,
          sourceId,
          lines,
        },
        userId,
        companyId,
      );
    } catch (err) {
      // Re-throw with progress context so commitSession persists what landed.
      const msg = err instanceof Error ? err.message : String(err);
      throw AppError.unprocessableEntity(
        `Failed posting JE at row ${e.rowNumber} (${e.date} ${e.reference ?? ''}): ${msg}`,
        err instanceof AppError ? (err.code ?? 'IMPORT_POST_FAILED') : 'IMPORT_POST_FAILED',
        { createdSoFar: created, failedAtIndex: idx, originalError: msg },
      );
    }
    created++;
    if (e.isVoidReversal) voidsReversed++;
  }
  return { created, skipped, voidsReversed };
}
