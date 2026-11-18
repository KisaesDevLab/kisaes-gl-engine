// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Bulk Import batches (U-261, U-263; ClientLedger P31 E1).
 *
 * A batch groups upload sessions and commits them in ONE database
 * transaction, run in the background:
 *
 *   draft | failed --commit--> committing --job--> committed | failed
 *
 * The commit request claims the batch (status committing) in its own
 * committed transaction, so a poll sees it running and a crash leaves a
 * state the engine start settles (recoverInterruptedBatches). The job then
 * runs under a transaction-scoped advisory lock per company
 * (pg_try_advisory_xact_lock): a second import of the company while one runs
 * is 409 IMPORT_BUSY. The job ends committed, or failed with
 * error {code, message, rowNumber?, sessionId?} and nothing posted (its
 * transaction rolled back). A failed batch can be committed again.
 *
 * Every row the job creates is stamped with import_batch_id; what it changes
 * on existing rows is kept in prior_values.
 *
 * The job runs in this process (setImmediate), as the bank import
 * post-processing does: it needs no queue, so it works the same on the
 * desktop and on the server appliance, and a closing-date password never
 * enters a queue payload. Progress lives in memory while the job runs (its
 * writes are invisible to pollers until the commit).
 */

import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db, type DbOrTx, type Tx } from '../../db/index.js';
import { importBatches, importSessions, importRows, transactions, companies } from '../../db/schema/index.js';
import type { ImportCommitResult } from '@kis-books/shared';
import { AppError } from '../../utils/errors.js';
import { claimAndRecord } from '../idempotency.service.js';
import { runWithoutIdempotency } from '../idempotency-context.js';
import { runWithLockContext, clearLockContextSecrets } from '../lock-context.js';
import { checkLockDate, type LockDateContext, type LockOverride } from '../ledger.service.js';
import { auditLog, auditLogMany } from '../../middleware/audit.js';
import {
  loadCreatedSets, findUndoBlockers, deleteBatchRows, beforeImages, takeCommitStamps, type CommitStamps, type UndoBlocker,
} from './import-undo.service.js';
import {
  sortSessionsForCommit, commitSessionInBatch, assertNotAlreadyCommitted, assertNoCommittedOverlap,
  toSessionDto, newBatchShared, batchSharedResult, type BatchPriorValues,
} from './imports.service.js';

export type BatchKind = 'conversion' | 'single' | 'transactions';
export type BatchStatus = 'draft' | 'committing' | 'committed' | 'failed' | 'undoing' | 'undone';

export interface BatchOptions {
  /** 1-12; only in a company with no transactions (else 409 IMPORT_FISCAL_YEAR_LOCKED). Undo restores it. */
  fiscalYearStartMonth?: number;
  /** Rows dated before this are left out (applied by the QBD adapters, E2c). */
  historyFrom?: string;
  /** The conversion date: reference files and open items are as of this date (E2c). */
  conversionDate?: string;
  /** Refuse the commit unless the company has no transactions (409 IMPORT_COMPANY_NOT_EMPTY). */
  requireEmptyCompany?: boolean;
  /** Source account key -> account id (E2b). */
  accountMap?: Record<string, string>;
  /** Source class name -> {group?, tag} (E2b). */
  classMap?: Record<string, { group?: string; tag: string }>;
}

export interface BatchError {
  code: string;
  message: string;
  status?: number;
  rowNumber?: number;
  sessionId?: string;
  details?: Record<string, unknown>;
}

export interface BatchProgress { step: string; done: number; total: number }

type BatchRow = typeof importBatches.$inferSelect;
type SessionRow = typeof importSessions.$inferSelect;

// ── Progress (in memory while a job runs) ─────────────────────────

const progressByBatch = new Map<string, BatchProgress>();

function setProgress(batchId: string, step: string, done: number, total: number): void {
  progressByBatch.set(batchId, { step, done, total });
}

// ── DTOs ──────────────────────────────────────────────────────────

function sessionSummary(s: SessionRow) {
  const dto = toSessionDto(s as never);
  return {
    id: dto.id, kind: dto.kind, sourceSystem: dto.sourceSystem, role: dto.role, status: dto.status,
    originalFilename: dto.originalFilename, rowCount: dto.rowCount, errorCount: dto.errorCount,
    reportDate: dto.reportDate, dateFrom: dto.dateFrom, dateTo: dto.dateTo,
    commitResult: dto.commitResult, committedAt: dto.committedAt,
  };
}

export function toBatchDto(b: BatchRow, sessions: SessionRow[]) {
  return {
    id: b.id,
    companyId: b.companyId,
    sourceSystem: b.sourceSystem,
    kind: b.kind as BatchKind,
    status: b.status as BatchStatus,
    options: (b.options as BatchOptions | null) ?? {},
    result: (b.result as Record<string, unknown> | null) ?? null,
    error: (b.error as BatchError | null) ?? null,
    backupRef: b.backupRef,
    companyWasEmpty: b.companyWasEmpty,
    conversionDate: b.conversionDate,
    historyFrom: b.historyFrom,
    tieout: b.tieout ?? null,
    spotCheck: b.spotCheck ?? null,
    verifiedAt: b.verifiedAt ? b.verifiedAt.toISOString() : null,
    verifiedBy: b.verifiedBy,
    createdBy: b.createdBy,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
    committedBy: b.committedBy,
    committedAt: b.committedAt ? b.committedAt.toISOString() : null,
    undoneBy: b.undoneBy,
    undoneAt: b.undoneAt ? b.undoneAt.toISOString() : null,
    sessions: sortSessionsForCommit(sessions).map(sessionSummary),
  };
}

export type BatchDto = ReturnType<typeof toBatchDto>;

// ── Helpers ───────────────────────────────────────────────────────

/** True when the company has no transactions at all (any status). */
export async function isCompanyEmpty(ex: DbOrTx, tenantId: string, companyId: string): Promise<boolean> {
  const [row] = await ex.select({ id: transactions.id }).from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.companyId, companyId))).limit(1);
  return !row;
}

/** Transaction-scoped advisory lock for imports of one company; false when another transaction holds it. */
export async function tryCompanyImportLock(tx: Tx, companyId: string): Promise<boolean> {
  const r = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`import-batch:${companyId}`}, 0)) AS ok`);
  return (r.rows as Array<{ ok: boolean }>)[0]?.ok === true;
}

function busy(details?: Record<string, unknown>): AppError {
  return AppError.conflict('Another import or undo is running for this company. Try again when it has finished.', 'IMPORT_BUSY', details);
}

/** Pairwise overlap of journal files inside one batch (409 IMPORT_PERIOD_OVERLAP). */
function assertNoOverlapWithin(sessions: SessionRow[]): void {
  const gl = sessions.filter((s) => s.role === 'post' && s.kind === 'gl_transactions' && s.dateFrom && s.dateTo);
  for (let i = 0; i < gl.length; i++) {
    for (let j = i + 1; j < gl.length; j++) {
      const a = gl[i]!;
      const b = gl[j]!;
      if (a.dateFrom! <= b.dateTo! && b.dateFrom! <= a.dateTo!) {
        throw AppError.conflict('Two journal files in this import cover the same dates.', 'IMPORT_PERIOD_OVERLAP', {
          batchId: null, sessionIds: [a.id, b.id],
          from: a.dateFrom! > b.dateFrom! ? a.dateFrom : b.dateFrom,
          to: a.dateTo! < b.dateTo! ? a.dateTo : b.dateTo,
        });
      }
    }
  }
}

/** Re-import refusals against committed batches (U-263), for every 'post' session. */
async function assertSessionsImportable(ex: DbOrTx, tenantId: string, companyId: string, sessions: SessionRow[]): Promise<void> {
  assertNoOverlapWithin(sessions);
  const ids = sessions.map((s) => s.id);
  for (const s of sessions) {
    if (s.role !== 'post') continue;
    if (s.rowHash) await assertNotAlreadyCommitted(ex, tenantId, companyId, s.rowHash, s.id);
    await assertNoCommittedOverlap(ex, tenantId, companyId, s.sourceSystem, s.dateFrom, s.dateTo, ids);
  }
}

/** Errors that block a commit: those found at upload, except the ones the commit itself settles. */
const RECHECKED_AT_COMMIT = new Set(['IMPORT_UNKNOWN_ACCOUNT', 'IMPORT_LOCKED_PERIOD']);

function assertNoBlockingErrors(sessions: SessionRow[]): void {
  for (const s of sessions) {
    const errs = ((s.validationErrors as Array<{ code: string; rowNumber: number }> | null) ?? [])
      .filter((e) => !RECHECKED_AT_COMMIT.has(e.code));
    if (errs.length > 0) {
      throw AppError.conflict(`Cannot commit — ${errs.length} validation error(s) outstanding.`, 'IMPORT_HAS_ERRORS', {
        sessionId: s.id, errors: errs.slice(0, 25),
      });
    }
  }
}

async function loadBatch(ex: DbOrTx, tenantId: string, companyId: string, id: string, forUpdate = false): Promise<BatchRow> {
  const q = ex.select().from(importBatches).where(and(
    eq(importBatches.id, id), eq(importBatches.tenantId, tenantId), eq(importBatches.companyId, companyId),
  ));
  const [b] = forUpdate ? await q.for('update') : await q;
  if (!b) throw AppError.notFound('Import batch not found.');
  return b;
}

async function loadSessions(ex: DbOrTx, batchId: string, forUpdate = false): Promise<SessionRow[]> {
  const q = ex.select().from(importSessions).where(eq(importSessions.batchId, batchId)).orderBy(asc(importSessions.createdAt));
  return forUpdate ? await q.for('update') : await q;
}

// ── Create ────────────────────────────────────────────────────────

export interface CreateBatchInput {
  sourceSystem: string;
  kind: BatchKind;
  sessionIds: string[];
  options?: BatchOptions;
}

export async function createBatch(tenantId: string, companyId: string, userId: string, input: CreateBatchInput): Promise<BatchDto> {
  const ids = Array.from(new Set(input.sessionIds));
  const options = input.options ?? {};
  return await db.transaction(async (tx) => {
    const sessions = await tx.select().from(importSessions).where(and(
      eq(importSessions.tenantId, tenantId), eq(importSessions.companyId, companyId), inArray(importSessions.id, ids),
    )).orderBy(asc(importSessions.id)).for('update');
    if (sessions.length !== ids.length) throw AppError.notFound('Import session not found.');
    for (const s of sessions) {
      if (s.batchId) {
        throw AppError.conflict('This file already belongs to another import.', 'IMPORT_SESSION_IN_BATCH',
          { sessionId: s.id, batchId: s.batchId });
      }
      if (s.status !== 'uploaded') {
        throw AppError.conflict(`Session is already ${s.status}; it can't join an import.`, 'IMPORT_TERMINAL', { sessionId: s.id, status: s.status });
      }
      if (s.sourceSystem !== input.sourceSystem) {
        throw AppError.badRequest('Every file of an import comes from the same source system.', 'IMPORT_SOURCE_MISMATCH', { sessionId: s.id });
      }
    }
    await assertSessionsImportable(tx, tenantId, companyId, sessions);
    if (options.fiscalYearStartMonth !== undefined && !(await isCompanyEmpty(tx, tenantId, companyId))) {
      throw AppError.conflict('The fiscal year can only be set by an import into a company with no transactions.', 'IMPORT_FISCAL_YEAR_LOCKED');
    }
    const [b] = await tx.insert(importBatches).values({
      tenantId, companyId, sourceSystem: input.sourceSystem, kind: input.kind, status: 'draft',
      options: options as never,
      conversionDate: options.conversionDate ?? null,
      historyFrom: options.historyFrom ?? null,
      createdBy: userId,
    }).returning();
    await tx.update(importSessions).set({ batchId: b!.id, updatedAt: new Date() }).where(inArray(importSessions.id, ids));
    const after = await loadSessions(tx, b!.id);
    return toBatchDto(b!, after);
  });
}

// ── Read ──────────────────────────────────────────────────────────

export async function getBatch(tenantId: string, companyId: string, id: string): Promise<{
  batch: BatchDto; progress: BatchProgress | null; error?: BatchError;
}> {
  const b = await loadBatch(db, tenantId, companyId, id);
  const sessions = await loadSessions(db, id);
  const batch = toBatchDto(b, sessions);
  const running = b.status === 'committing' || b.status === 'undoing';
  const progress = running
    ? (progressByBatch.get(id) ?? { step: 'waiting', done: 0, total: 0 })
    : null;
  // error: a failed commit (status failed), or a failed undo (back at committed with the error).
  return { batch, progress, ...(batch.error && (b.status === 'failed' || b.status === 'committed') ? { error: batch.error } : {}) };
}

function encodeCursor(b: { createdAt: Date; id: string }): string {
  return Buffer.from(`${b.createdAt.toISOString()}|${b.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const [createdAt, id] = text.split('|');
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt)) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw AppError.badRequest('Invalid cursor.', 'INVALID_CURSOR');
  }
  return { createdAt, id };
}

export async function listBatches(tenantId: string, companyId: string, q: { limit: number; cursor?: string }): Promise<{
  batches: BatchDto[]; nextCursor: string | null;
}> {
  const after = q.cursor ? decodeCursor(q.cursor) : null;
  const rows = await db.select().from(importBatches).where(and(
    eq(importBatches.tenantId, tenantId), eq(importBatches.companyId, companyId),
    after ? sql`(${importBatches.createdAt}, ${importBatches.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)` : undefined,
  )).orderBy(desc(importBatches.createdAt), desc(importBatches.id)).limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const sessions = page.length > 0
    ? await db.select().from(importSessions).where(inArray(importSessions.batchId, page.map((b) => b.id)))
    : [];
  const byBatch = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    const list = byBatch.get(s.batchId!) ?? [];
    list.push(s);
    byBatch.set(s.batchId!, list);
  }
  return {
    batches: page.map((b) => toBatchDto(b, byBatch.get(b.id) ?? [])),
    nextCursor: rows.length > q.limit ? encodeCursor(page[page.length - 1]!) : null,
  };
}

// ── Commit ────────────────────────────────────────────────────────

export interface CommitRequest {
  tenantId: string;
  companyId: string;
  userId: string;
  batchId: string;
  backupRef?: string | null;
  /** The closed-period context the job posts with (copied; the request's own is wiped when it answers). */
  lockContext?: LockDateContext;
  /** Set by the synchronous closed-period check (U-262): audited once, by the job, for the whole batch. */
  override?: LockOverride;
}

// ── Closed periods (U-262) ────────────────────────────────────────

/** The earliest date a commit posts on: trial balance report dates and journal first dates of 'post' sessions. */
function earliestPostingDate(sessions: SessionRow[]): string | null {
  let min: string | null = null;
  for (const s of sessions) {
    if (s.role !== 'post') continue;
    // Open items (U-264) post on their document dates: dateFrom is the earliest.
    const d = s.kind === 'trial_balance' ? s.reportDate
      : s.kind === 'gl_transactions' || s.kind === 'open_invoices' || s.kind === 'unpaid_bills' ? s.dateFrom : null;
    if (d && (min === null || d < min)) min = d;
  }
  return min;
}

/**
 * The synchronous closed-period check before the 202 (review S2): the
 * earliest posting date against the closing date, with the request's
 * closing-date password or staff confirmation. 423 TB_PERIOD_LOCKED, 403
 * CLOSING_PASSWORD_INVALID (audited as a failed attempt; the route's limiter
 * answers 429). A permitted override is returned, not audited: the job writes
 * one closing_date_override row for the whole batch.
 */
async function closedPeriodCheck(req: CommitRequest, earliest: string | null): Promise<LockOverride | undefined> {
  if (!earliest) return undefined;
  return await checkLockDate(db, req.tenantId, earliest, req.companyId, req.lockContext ?? { userType: 'staff', userId: req.userId }, {
    deferAudit: true,
  });
}

/** The job's own closed-period context: the request's, with per-posting override audits turned off. */
function jobLockContext(req: CommitRequest): LockDateContext {
  const base = req.lockContext ?? { userType: 'staff' as const, userId: req.userId, overrideConfirmed: false };
  const ctx: LockDateContext = { ...base, batchOverrideAudit: true };
  if (base.verifiedClosingPasswordHashes) ctx.verifiedClosingPasswordHashes = new Set(base.verifiedClosingPasswordHashes);
  return ctx;
}

/** The one closing_date_override audit row of a batch commit or undo (U-262). Never the password. */
async function auditBatchOverride(tx: Tx, req: CommitRequest, operation: 'commit' | 'undo'): Promise<void> {
  const o = req.override;
  if (!o) return;
  await auditLog(req.tenantId, 'override', 'closing_date_override', req.batchId,
    { lockDate: o.lockDate, lockDateSetBy: o.lockDateSetBy, lockDateSetAt: o.lockDateSetAt },
    {
      txnDate: o.txnDate, method: o.method, overrideConfirmed: o.method === 'confirmed',
      importBatchId: req.batchId, operation, companyId: req.companyId,
    },
    req.userId, tx);
}

/**
 * Everything checked before the claim, outside any transaction: the batch
 * state, the sessions, the re-import refusals and the company options.
 */
async function precheckCommit(tenantId: string, companyId: string, b: BatchRow, sessions: SessionRow[]): Promise<void> {
  if (b.status === 'committed') {
    throw AppError.conflict('This import was already committed.', 'IMPORT_ALREADY_COMMITTED', {
      batchId: b.id, sessionId: null, committedAt: b.committedAt ? b.committedAt.toISOString() : null,
    });
  }
  if (b.status === 'committing' || b.status === 'undoing') throw busy({ batchId: b.id, status: b.status });
  if (b.status === 'undone') {
    throw AppError.conflict('This import was undone. Upload the files again to import them.', 'IMPORT_BATCH_UNDONE', { batchId: b.id });
  }
  if (sessions.length === 0) throw AppError.badRequest('This import has no files.', 'IMPORT_BATCH_EMPTY');
  for (const s of sessions) {
    if (s.status !== 'uploaded') {
      throw AppError.conflict(`Session is already ${s.status}.`, 'IMPORT_TERMINAL', { sessionId: s.id, status: s.status });
    }
  }
  assertNoBlockingErrors(sessions.filter((s) => s.role === 'post'));
  await assertSessionsImportable(db, tenantId, companyId, sessions);
  const options = (b.options as BatchOptions | null) ?? {};
  if (options.requireEmptyCompany || options.fiscalYearStartMonth !== undefined) {
    const empty = await isCompanyEmpty(db, tenantId, companyId);
    if (!empty && options.requireEmptyCompany) {
      throw AppError.conflict('This import needs a company with no transactions.', 'IMPORT_COMPANY_NOT_EMPTY');
    }
    if (!empty && options.fiscalYearStartMonth !== undefined) {
      throw AppError.conflict('The fiscal year can only be set by an import into a company with no transactions.', 'IMPORT_FISCAL_YEAR_LOCKED');
    }
  }
}

/**
 * Claims the batch (draft|failed -> committing) in its own committed
 * transaction, under the company import lock, and claims the request's
 * Idempotency-Key there. 409 IMPORT_BUSY while another import or undo of the
 * company runs.
 */
async function claimForCommit(req: CommitRequest): Promise<void> {
  await db.transaction(async (tx) => {
    if (!(await tryCompanyImportLock(tx, req.companyId))) throw busy();
    const b = await loadBatch(tx, req.tenantId, req.companyId, req.batchId, true);
    const [other] = await tx.select({ id: importBatches.id, status: importBatches.status }).from(importBatches).where(and(
      eq(importBatches.tenantId, req.tenantId), eq(importBatches.companyId, req.companyId), ne(importBatches.id, req.batchId),
      inArray(importBatches.status, ['committing', 'undoing']),
    )).limit(1);
    if (other) throw busy({ batchId: other.id, status: other.status });
    if (b.status !== 'draft' && b.status !== 'failed') {
      if (b.status === 'committed') {
        throw AppError.conflict('This import was already committed.', 'IMPORT_ALREADY_COMMITTED', {
          batchId: b.id, sessionId: null, committedAt: b.committedAt ? b.committedAt.toISOString() : null,
        });
      }
      throw busy({ batchId: b.id, status: b.status });
    }
    await tx.update(importBatches).set({
      status: 'committing', error: null, backupRef: req.backupRef ?? b.backupRef ?? null, updatedAt: new Date(),
    }).where(eq(importBatches.id, req.batchId));
    await claimAndRecord(tx, 'import_batch', req.batchId);
  });
}

/** Starts a commit: checks, claims, schedules the job. The route answers 202 {batchId}. */
export async function startCommit(req: CommitRequest): Promise<{ batchId: string }> {
  const b = await loadBatch(db, req.tenantId, req.companyId, req.batchId);
  const sessions = await loadSessions(db, req.batchId);
  await precheckCommit(req.tenantId, req.companyId, b, sessions);
  req.override = await closedPeriodCheck(req, earliestPostingDate(sessions));
  await claimForCommit(req);
  setProgress(req.batchId, 'queued', 0, sessions.length);
  scheduleCommitJob(req);
  return { batchId: req.batchId };
}

/** Test hook: the promise of the last scheduled job. */
export const __batchJobs: { last?: Promise<unknown> } = {};

/** Test hooks (NODE_ENV=test only): run inside the job transaction after each session. */
export const __batchTestHooks: { afterSession?: (info: { batchId: string; sessionId: string }) => void | Promise<void> } = {};

function scheduleCommitJob(req: CommitRequest): void {
  __batchJobs.last = runWithoutIdempotency(() => new Promise<void>((resolve) => {
    setImmediate(() => {
      void runCommitJob(req).catch(() => undefined).finally(resolve);
    });
  }));
}

function errorOf(e: unknown, sessionId: string | null): BatchError {
  const pgCode = (e as { code?: unknown; cause?: { code?: unknown } } | null)?.cause?.code ?? (e as { code?: unknown })?.code;
  const constraint = String((e as { constraint?: unknown; cause?: { constraint?: unknown } })?.cause?.constraint
    ?? (e as { constraint?: unknown })?.constraint ?? '');
  if (pgCode === '23505' && constraint.includes('row_hash')) {
    return { code: 'IMPORT_ALREADY_COMMITTED', message: 'This file was already imported into this company.', status: 409, ...(sessionId ? { sessionId } : {}) };
  }
  if (e instanceof AppError) {
    const details = e.details ?? {};
    const rowNumber = typeof details['rowNumber'] === 'number' ? details['rowNumber'] as number : undefined;
    const { rowNumber: _r, failedAtIndex: _f, originalError: _o, ...rest } = details as Record<string, unknown>;
    return {
      code: e.code ?? 'IMPORT_POST_FAILED',
      message: e.message,
      status: e.statusCode,
      ...(rowNumber !== undefined ? { rowNumber } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(Object.keys(rest).length > 0 ? { details: rest } : {}),
    };
  }
  return { code: 'IMPORT_POST_FAILED', message: 'The import could not be posted.', status: 500, ...(sessionId ? { sessionId } : {}) };
}

/** The error a failed job leaves, as an AppError (the old one-session commit rethrows it). */
function toAppError(err: BatchError, original: unknown): unknown {
  if (original instanceof AppError) return original;
  if (err.code === 'IMPORT_ALREADY_COMMITTED') return new AppError(409, err.message, err.code, err.details);
  return original;
}

/**
 * The commit job: ONE database transaction under the company import lock.
 * Returns the per-session results; on failure marks the batch failed (in a
 * separate statement, after the rollback) and rethrows.
 */
export async function runCommitJob(req: CommitRequest): Promise<Record<string, ImportCommitResult>> {
  const { tenantId, companyId, userId, batchId } = req;
  let currentSession: string | null = null;
  const run = async () => db.transaction(async (tx) => {
    if (!(await tryCompanyImportLock(tx, companyId))) throw busy();
    const b = await loadBatch(tx, tenantId, companyId, batchId);
    const options = (b.options as BatchOptions | null) ?? {};
    const sessions = sortSessionsForCommit(await loadSessions(tx, batchId, true));
    const posting = sessions.filter((s) => s.role === 'post');
    const companyWasEmpty = await isCompanyEmpty(tx, tenantId, companyId);
    if (options.requireEmptyCompany && !companyWasEmpty) {
      throw AppError.conflict('This import needs a company with no transactions.', 'IMPORT_COMPANY_NOT_EMPTY');
    }
    const priorValues: BatchPriorValues = {};
    if (options.fiscalYearStartMonth !== undefined) {
      if (!companyWasEmpty) {
        throw AppError.conflict('The fiscal year can only be set by an import into a company with no transactions.', 'IMPORT_FISCAL_YEAR_LOCKED');
      }
      const [co] = await tx.select({ m: companies.fiscalYearStartMonth }).from(companies)
        .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId))).for('update');
      priorValues.fiscalYearStartMonth = co?.m ?? null;
      await tx.update(companies).set({ fiscalYearStartMonth: options.fiscalYearStartMonth, updatedAt: new Date() })
        .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));
    }

    const results: Record<string, ImportCommitResult> = {};
    // U-264: open-item files in the batch send A/R and A/P history to the before-conversion accounts.
    const shared = newBatchShared(posting.map((s) => s.kind));
    let done = 0;
    for (const s of posting) {
      currentSession = s.id;
      setProgress(batchId, s.kind, done, posting.length);
      const r = await commitSessionInBatch({
        tx, tenantId, companyId, userId, batchId, priorValues, shared,
        progress: (step, d, t) => setProgress(batchId, `${step} ${d}/${t}`, done, posting.length),
      }, s);
      results[s.id] = r;
      const now = new Date();
      await tx.update(importSessions).set({
        status: 'committed', commitResult: r as never, committedAt: now, updatedAt: now, activeCommit: true,
      }).where(eq(importSessions.id, s.id));
      done++;
      if (process.env['NODE_ENV'] === 'test' && __batchTestHooks.afterSession) {
        await __batchTestHooks.afterSession({ batchId, sessionId: s.id });
      }
    }
    currentSession = null;
    // Reference files are never posted; they become part of the record.
    const refs = sessions.filter((s) => s.role !== 'post').map((s) => s.id);
    if (refs.length > 0) {
      await tx.update(importSessions).set({ status: 'committed', committedAt: new Date(), updatedAt: new Date() })
        .where(inArray(importSessions.id, refs));
    }
    // What undo compares against (database clock, review: one stamp in SQL).
    priorValues.stamps = await takeCommitStamps(tx, tenantId, batchId, Object.keys(priorValues.accounts ?? {}));
    await auditBatchOverride(tx, req, 'commit');
    const now = new Date();
    await tx.update(importBatches).set({
      status: 'committed', result: { sessions: results, ...batchSharedResult(shared) } as never, error: null,
      priorValues: priorValues as never, companyWasEmpty,
      committedAt: now, committedBy: userId, updatedAt: now,
    }).where(eq(importBatches.id, batchId));
    return results;
  });

  const jobCtx = req.lockContext ? jobLockContext(req) : undefined;
  try {
    // The batch routes pass an explicit context; the old one-session commit
    // runs in its request, which carries none (the hard 423, as before).
    return jobCtx ? await runWithLockContext(jobCtx, run) : await run();
  } catch (e) {
    const err = errorOf(e, currentSession);
    await db.update(importBatches).set({ status: 'failed', error: err as never, updatedAt: new Date() })
      .where(and(eq(importBatches.id, batchId), eq(importBatches.status, 'committing')));
    throw toAppError(err, e);
  } finally {
    progressByBatch.delete(batchId);
    if (req.lockContext) clearLockContextSecrets(req.lockContext);
    if (jobCtx) clearLockContextSecrets(jobCtx);
  }
}

/**
 * The old POST /imports/:id/commit (U-261): the session commits as a
 * one-session batch (kind 'single'), synchronously. 409
 * IMPORT_SESSION_IN_BATCH when the session already belongs to a batch.
 * A failure leaves the session 'failed' with its error, as before, and
 * posts nothing.
 */
export async function commitSingleSession(
  tenantId: string, companyId: string, userId: string, sessionId: string,
): Promise<{ batchId: string; result: ImportCommitResult }> {
  const batchId = await db.transaction(async (tx) => {
    const [s] = await tx.select().from(importSessions).where(and(
      eq(importSessions.id, sessionId), eq(importSessions.tenantId, tenantId), eq(importSessions.companyId, companyId),
    )).for('update');
    if (!s) throw AppError.notFound('Import session not found.');
    if (s.batchId) {
      const [held] = await tx.select({ kind: importBatches.kind, status: importBatches.status }).from(importBatches)
        .where(eq(importBatches.id, s.batchId));
      if (held?.kind === 'single' && held.status === 'committing') {
        throw AppError.conflict('Another commit for this session is already in progress.', 'IMPORT_COMMIT_IN_PROGRESS');
      }
      throw AppError.conflict('This file already belongs to an import; commit the import instead.', 'IMPORT_SESSION_IN_BATCH',
        { sessionId, batchId: s.batchId });
    }
    if (s.status !== 'uploaded') {
      throw AppError.conflict('Another commit for this session is already in progress.', 'IMPORT_COMMIT_IN_PROGRESS');
    }
    if (s.role === 'post') {
      if (s.rowHash) await assertNotAlreadyCommitted(tx, tenantId, companyId, s.rowHash, s.id);
      await assertNoCommittedOverlap(tx, tenantId, companyId, s.sourceSystem, s.dateFrom, s.dateTo, [s.id]);
    }
    if (!(await tryCompanyImportLock(tx, companyId))) throw busy();
    const [running] = await tx.select({ id: importBatches.id, status: importBatches.status }).from(importBatches).where(and(
      eq(importBatches.tenantId, tenantId), eq(importBatches.companyId, companyId), inArray(importBatches.status, ['committing', 'undoing']),
    )).limit(1);
    if (running) throw busy({ batchId: running.id, status: running.status });
    const [b] = await tx.insert(importBatches).values({
      tenantId, companyId, sourceSystem: s.sourceSystem, kind: 'single', status: 'committing', options: {} as never, createdBy: userId,
    }).returning();
    await tx.update(importSessions).set({ batchId: b!.id, updatedAt: new Date() }).where(eq(importSessions.id, sessionId));
    return b!.id;
  });
  try {
    const results = await runCommitJob({ tenantId, companyId, userId, batchId });
    return { batchId, result: results[sessionId] ?? { created: 0 } };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.update(importSessions).set({
      status: 'failed', commitResult: { error: message, created: 0 } as never, updatedAt: new Date(),
    }).where(eq(importSessions.id, sessionId));
    throw e;
  }
}

// ── Undo (U-261, review B2) ───────────────────────────────────────

function undoBlocked(blockers: UndoBlocker[]): AppError {
  return AppError.conflict('Something imported has been used since, so this import can\'t be undone. Restore the backup taken before the import instead.',
    'IMPORT_UNDO_BLOCKED', { blockers: blockers.slice(0, 100), blockerCount: blockers.length });
}

/** The earliest date of a transaction the batch posted (the undo changes balances from then on). */
async function earliestBatchTxnDate(ex: DbOrTx, tenantId: string, batchId: string): Promise<string | null> {
  const r = await ex.execute(sql`SELECT MIN(txn_date)::text AS d FROM transactions WHERE tenant_id = ${tenantId} AND import_batch_id = ${batchId}`);
  return (r.rows as Array<{ d: string | null }>)[0]?.d ?? null;
}

/**
 * Starts an undo: the batch must be committed; the closed-period check and
 * the blockers run synchronously (409 IMPORT_UNDO_BLOCKED before any
 * claim); then committed -> undoing in its own transaction and 202. The job
 * re-checks the blockers under the lock and ends undone, or back at
 * committed with error.
 */
export async function startUndo(req: CommitRequest): Promise<{ batchId: string }> {
  const b = await loadBatch(db, req.tenantId, req.companyId, req.batchId);
  if (b.status === 'committing' || b.status === 'undoing') throw busy({ batchId: b.id, status: b.status });
  if (b.status === 'undone') throw AppError.conflict('This import was already undone.', 'IMPORT_BATCH_UNDONE', { batchId: b.id });
  if (b.status !== 'committed') {
    throw AppError.conflict('Only a committed import can be undone.', 'IMPORT_BATCH_NOT_COMMITTED', { batchId: b.id, status: b.status });
  }
  req.override = await closedPeriodCheck(req, await earliestBatchTxnDate(db, req.tenantId, req.batchId));
  const stamps = ((b.priorValues as BatchPriorValues | null) ?? {}).stamps ?? {};
  await db.transaction(async (tx) => {
    const created = await loadCreatedSets(tx, req.tenantId, req.batchId);
    const { blockers } = await findUndoBlockers(tx, req.tenantId, req.batchId, created, stamps);
    if (blockers.length > 0) throw undoBlocked(blockers);
  });
  await db.transaction(async (tx) => {
    if (!(await tryCompanyImportLock(tx, req.companyId))) throw busy();
    const locked = await loadBatch(tx, req.tenantId, req.companyId, req.batchId, true);
    const [other] = await tx.select({ id: importBatches.id, status: importBatches.status }).from(importBatches).where(and(
      eq(importBatches.tenantId, req.tenantId), eq(importBatches.companyId, req.companyId), ne(importBatches.id, req.batchId),
      inArray(importBatches.status, ['committing', 'undoing']),
    )).limit(1);
    if (other) throw busy({ batchId: other.id, status: other.status });
    if (locked.status !== 'committed') throw busy({ batchId: locked.id, status: locked.status });
    await tx.update(importBatches).set({ status: 'undoing', error: null, updatedAt: new Date() }).where(eq(importBatches.id, req.batchId));
    await claimAndRecord(tx, 'import_batch', req.batchId);
  });
  setProgress(req.batchId, 'undo queued', 0, 1);
  __batchJobs.last = runWithoutIdempotency(() => new Promise<void>((resolve) => {
    setImmediate(() => { void runUndoJob(req).catch(() => undefined).finally(resolve); });
  }));
  return { batchId: req.batchId };
}

/** The undo job: ONE transaction under the company import lock. On failure the batch goes back to committed with error. */
export async function runUndoJob(req: CommitRequest): Promise<void> {
  const { tenantId, companyId, userId, batchId } = req;
  const jobCtx = jobLockContext(req);
  const run = () => db.transaction(async (tx) => {
    if (!(await tryCompanyImportLock(tx, companyId))) throw busy();
    const b = await loadBatch(tx, tenantId, companyId, batchId, true);
    const prior = (b.priorValues as BatchPriorValues | null) ?? {};
    setProgress(batchId, 'checking', 0, 3);
    // Lock the batch's transactions first, then look for blockers (review B2).
    const created = await loadCreatedSets(tx, tenantId, batchId, true);
    const { blockers, dead } = await findUndoBlockers(tx, tenantId, batchId, created, prior.stamps ?? {});
    if (blockers.length > 0) throw undoBlocked(blockers);
    // The closed-period rule for every date the undo changes (the request's context; one audit row below).
    const dates = (await tx.execute(sql`SELECT DISTINCT txn_date::text AS d FROM transactions WHERE tenant_id = ${tenantId} AND import_batch_id = ${batchId}`)).rows as Array<{ d: string }>;
    for (const { d } of dates) await checkLockDate(tx, tenantId, d, companyId, undefined, { deferAudit: true });

    setProgress(batchId, 'deleting', 1, 3);
    const images = await beforeImages(tx, tenantId, created);
    await deleteBatchRows(tx, tenantId, created, dead);

    setProgress(batchId, 'restoring', 2, 3);
    for (const [id, a] of Object.entries(prior.accounts ?? {})) {
      await tx.execute(sql`UPDATE accounts SET name = ${a.name}, account_type = ${a.accountType}, detail_type = ${a.detailType},
        description = ${a.description}, parent_id = ${a.parentId}, updated_at = now() WHERE tenant_id = ${tenantId} AND id = ${id}`);
    }
    for (const [id, a] of Object.entries(prior.adoptedSystemAccounts ?? {})) {
      await tx.execute(sql`UPDATE accounts SET system_tag = ${a.systemTag}, is_system = ${a.isSystem ?? false}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${id}`);
    }
    if (prior.fiscalYearStartMonth !== undefined) {
      await tx.update(companies).set({ fiscalYearStartMonth: prior.fiscalYearStartMonth, updatedAt: new Date() })
        .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));
    }
    // U-264: the document counters open items may have advanced (a number
    // taken since is skipped by the counter's own in-use check).
    if (prior.counters) {
      await tx.update(companies).set({
        invoiceNextNumber: prior.counters.invoiceNextNumber,
        documentNumbers: (prior.counters.documentNumbers ?? {}) as never,
        updatedAt: new Date(),
      }).where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));
    }

    // One audit row per deleted record with its before-image, then one for the batch.
    const rows: Parameters<typeof auditLogMany>[1][number][] = [];
    for (const t of images.transactions as Array<Record<string, unknown>>) rows.push({ action: 'delete', entityType: 'transaction', entityId: String(t['id']), before: t, after: { importBatchUndo: batchId } });
    for (const [type, list] of [['account', images.accounts], ['contact', images.contacts], ['item', images.items], ['tag', images.tags], ['tag_group', images.tag_groups]] as const) {
      for (const r of list as Array<Record<string, unknown>>) rows.push({ action: 'delete', entityType: type, entityId: String(r['id']), before: r, after: { importBatchUndo: batchId } });
    }
    if (rows.length > 0) await auditLogMany(tenantId, rows, userId, tx);
    await auditBatchOverride(tx, req, 'undo');
    await auditLog(tenantId, 'update', 'import_batch', batchId, { status: 'committed' }, {
      status: 'undone', deleted: {
        transactions: created.txns.length, accounts: created.accounts.length, contacts: created.contacts.length,
        items: created.items.length, tags: created.tags.length, tagGroups: created.tagGroups.length,
      },
      removedLinks: {
        paymentApplications: dead.paymentApplications.length, billPaymentApplications: dead.billPaymentApplications.length,
        vendorCreditApplications: dead.vendorCreditApplications.length, depositLines: dead.depositLines.length, taxLines: dead.taxLines.length,
        settlementStampsCleared: dead.settlementLines,
      },
      backupRef: req.backupRef ?? null,
    }, userId, tx);

    // Sessions stay as the record, marked undone; their parsed rows go (privacy, S8).
    const sessionIds = (await tx.select({ id: importSessions.id }).from(importSessions).where(eq(importSessions.batchId, batchId))).map((s) => s.id);
    if (sessionIds.length > 0) {
      await tx.update(importSessions).set({ status: 'undone', activeCommit: false, updatedAt: new Date() }).where(inArray(importSessions.id, sessionIds));
      await tx.delete(importRows).where(inArray(importRows.sessionId, sessionIds));
    }
    const now = new Date();
    await tx.update(importBatches).set({
      status: 'undone', undoneAt: now, undoneBy: userId, updatedAt: now, error: null,
      result: { ...((b.result as Record<string, unknown> | null) ?? {}), undo: { backupRef: req.backupRef ?? null } } as never,
    }).where(eq(importBatches.id, batchId));
  });
  try {
    await runWithLockContext(jobCtx, run);
  } catch (e) {
    const err = errorOf(e, null);
    await db.update(importBatches).set({ status: 'committed', error: err as never, updatedAt: new Date() })
      .where(and(eq(importBatches.id, batchId), eq(importBatches.status, 'undoing')));
    throw toAppError(err, e);
  } finally {
    progressByBatch.delete(batchId);
    if (req.lockContext) clearLockContextSecrets(req.lockContext);
    clearLockContextSecrets(jobCtx);
  }
}

// ── Engine start ──────────────────────────────────────────────────

/**
 * On engine start (U-261): a batch left 'committing' by a crash or restart
 * is 'failed' (its transaction rolled back with the process), and one left
 * 'undoing' is 'committed' again. A batch whose company import lock is held
 * by a live transaction (another server process still running it) is left
 * alone. Returns how many batches were settled.
 */
export async function recoverInterruptedBatches(): Promise<number> {
  const stale = await db.select({ id: importBatches.id, companyId: importBatches.companyId, status: importBatches.status })
    .from(importBatches).where(inArray(importBatches.status, ['committing', 'undoing']));
  let settled = 0;
  for (const s of stale) {
    if (progressByBatch.has(s.id)) continue;
    const done = await db.transaction(async (tx) => {
      if (!(await tryCompanyImportLock(tx, s.companyId))) return false;
      const to = s.status === 'committing'
        ? { status: 'failed', error: { code: 'IMPORT_INTERRUPTED', message: 'The engine stopped while this import was running; nothing was posted.' } }
        : { status: 'committed' };
      const r = await tx.update(importBatches).set({ ...to, updatedAt: new Date() } as never)
        .where(and(eq(importBatches.id, s.id), eq(importBatches.status, s.status))).returning({ id: importBatches.id });
      return r.length > 0;
    });
    if (done) settled++;
  }
  return settled;
}
