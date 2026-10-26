// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Document drafts (U-92, U-92a, U-92b; document-drafts-v1,
 * idempotency-docs-v1). A draft is a client's reading of one vendor document
 * (a bill, card charge, check or cash expense) that the owner has not
 * accepted yet.
 *
 * - Drafts never touch transactions or journal_lines: balances, the trial
 *   balance and every report ignore them. Only convert() posts, through the
 *   kind's own service, in one database transaction.
 * - Every query is scoped to the request's tenant and company: another
 *   company's draft is 404, the same answer as an id that does not exist.
 * - The file stays an ordinary draft attachment (attachable_type 'draft',
 *   attachable_id the client's draft key). Creating a draft claims the file
 *   by its SHA-256 (computed here from the stored bytes): one live or
 *   converted draft per file and company (uq_document_drafts_claim). The
 *   claim is an INSERT ... ON CONFLICT DO NOTHING, so two computers that
 *   drop the same file at once get one draft and one 409
 *   DOCUMENT_ALREADY_CLAIMED. Discarding frees the claim.
 * - Money: amounts are decimal strings in and out and numeric in SQL; the
 *   duplicate check compares numeric columns in SQL. Nothing here parses an
 *   amount into a JavaScript number.
 * - Audit rows (in the same transaction): create, update, discard, convert;
 *   templates: create, update, delete.
 */

import crypto from 'crypto';
import { and, eq, inArray, desc, sql, count, getTableColumns, type SQL } from 'drizzle-orm';
import {
  DOCUMENT_DRAFT_LIVE_STATUSES, DOCUMENT_DRAFT_LIMITS, convertBodySchemaFor,
  type CreateDocumentDraftInput, type UpdateDocumentDraftInput, type DocumentDraftListQuery,
  type ConvertDocumentDraftInput, type DocumentConvertKind, type DocumentDraftKind,
  type PutVendorLayoutTemplateInput,
} from '@kis-books/shared';
import { db, type Tx } from '../db/index.js';
import { documentDrafts, vendorLayoutTemplates, type DocumentDraftRow, type VendorLayoutTemplateRow } from '../db/schema/index.js';
import { auditLog } from '../middleware/audit.js';
import { AppError } from '../utils/errors.js';
import * as attachmentService from './attachment.service.js';
import * as billService from './bill.service.js';
import * as expenseService from './expense.service.js';
import * as checkService from './check.service.js';
import * as ledger from './ledger.service.js';
import { claimAndRecord } from './idempotency.service.js';

/** Test hooks: only honoured when NODE_ENV is 'test'. */
export const __documentDraftTestHooks: {
  /** Inside the convert transaction, after the posting and the relink, before the draft is marked converted. */
  afterPost?: (info: { draftId: string; transactionId: string }) => void | Promise<void>;
} = {};

const isTest = () => process.env['NODE_ENV'] === 'test';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The window of the vendor + amount duplicate rule, in days either side (U-92b). */
export const DUPLICATE_WINDOW_DAYS = 60;

/**
 * SQL for a normalized document reference: leading zeros of every digit run
 * dropped (an all-zero run keeps one 0), then lower case, ASCII letters and
 * digits only (`INV-00123` -> `inv123`, `RB-2026-0042` -> `rb202642`). Same
 * rule as the shared normalizeDocumentReference() and ClientLedger's
 * cl-docread dupes::normalize_reference (shared case table). ASCII only so
 * the result never depends on the database locale.
 */
export function normalizedRefSql(expr: SQL): SQL {
  return sql`regexp_replace(lower(regexp_replace(coalesce(${expr}, ''), '(^|[^0-9])0+([0-9])', '\\1\\2', 'g')), '[^0-9a-z]', '', 'g')`;
}

/** The reference a posted transaction carries: a bill's vendor invoice number, an expense's own reference (not a check number). */
const TXN_REFERENCE_SQL = sql`CASE WHEN t.txn_type = 'bill' THEN t.vendor_invoice_number
  WHEN t.txn_type = 'expense' AND coalesce(t.payment_method, '') <> 'check' THEN t.txn_number
  ELSE NULL END`;

/** The next updated_at of a row: now, but always at least one millisecond after the stored value (ms tokens). */
const NEXT_UPDATED_AT = (col: SQL) => sql`date_trunc('milliseconds', greatest(clock_timestamp(), ${col} + interval '1 millisecond'))`;
const NOW_MS = sql`date_trunc('milliseconds', clock_timestamp())`;

/** The permission resource of a kind; `unknown` is a bill until the reader says otherwise. */
export function resourceOfKind(kind: DocumentDraftKind): 'bills' | 'checks' | 'transactions' {
  switch (kind) {
    case 'check': return 'checks';
    case 'card_charge':
    case 'cash_expense': return 'transactions';
    default: return 'bills';
  }
}

/** The attachable type a converted kind's files move to (checks post as expenses). */
function attachableTypeOf(kind: DocumentConvertKind): string {
  return kind === 'bill' ? 'bill' : 'expense';
}

export interface DocumentDraftDto {
  id: string;
  companyId: string;
  attachmentId: string | null;
  contentSha256: string;
  kind: string;
  status: string;
  reader: string | null;
  fields: Record<string, unknown>;
  lines: unknown[];
  checks: unknown[];
  failureReason: string | null;
  suggestedContactId: string | null;
  docReference: string | null;
  docTotal: string | null;
  docDate: string | null;
  convertedTransactionId: string | null;
  convertedType: string | null;
  convertedAt: string | null;
  discardedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toDto(r: DocumentDraftRow): DocumentDraftDto {
  return {
    id: r.id,
    companyId: r.companyId,
    attachmentId: r.attachmentId,
    contentSha256: r.contentSha256,
    kind: r.kind,
    status: r.status,
    reader: r.reader,
    fields: r.fields,
    lines: r.lines,
    checks: r.checks,
    failureReason: r.failureReason,
    suggestedContactId: r.suggestedContactId,
    docReference: r.docReference,
    docTotal: r.docTotal,
    docDate: r.docDate,
    convertedTransactionId: r.convertedTransactionId,
    convertedType: r.convertedType,
    convertedAt: iso(r.convertedAt),
    discardedAt: iso(r.discardedAt),
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** What an audit row says about a draft: no reading, no amounts, no names. */
function auditImage(r: DocumentDraftRow): Record<string, unknown> {
  return {
    id: r.id, companyId: r.companyId, attachmentId: r.attachmentId, contentSha256: r.contentSha256,
    kind: r.kind, status: r.status, reader: r.reader, failureReason: r.failureReason,
    suggestedContactId: r.suggestedContactId, convertedTransactionId: r.convertedTransactionId,
    convertedType: r.convertedType,
  };
}

function scopeOf(tenantId: string, companyId: string, id: string): SQL {
  return and(eq(documentDrafts.tenantId, tenantId), eq(documentDrafts.companyId, companyId), eq(documentDrafts.id, id))!;
}

function notFound(): AppError {
  return AppError.notFound('Document draft not found');
}

async function lockDraft(tx: Tx, tenantId: string, companyId: string, id: string): Promise<DocumentDraftRow> {
  if (!UUID_RE.test(id)) throw notFound();
  const [row] = await tx.select().from(documentDrafts).where(scopeOf(tenantId, companyId, id)).for('update');
  if (!row) throw notFound();
  return row;
}

function assertNotStale(row: { updatedAt: Date }, expected: string): void {
  const wanted = Date.parse(expected);
  if (Number.isNaN(wanted) || row.updatedAt.getTime() !== wanted) {
    throw AppError.conflict(
      'This document was changed by someone else since you opened it. Reload it and try again.',
      'STALE',
      { updatedAt: row.updatedAt.toISOString() },
    );
  }
}

function closed(row: DocumentDraftRow): AppError {
  return AppError.conflict(
    row.status === 'converted' ? 'This document was already entered.' : 'This document was discarded.',
    'DOCUMENT_DRAFT_CLOSED',
    { status: row.status, transactionId: row.convertedTransactionId },
  );
}

const isLive = (status: string) => (DOCUMENT_DRAFT_LIVE_STATUSES as readonly string[]).includes(status);

// ── Read ─────────────────────────────────────────────────────────────

export async function get(tenantId: string, companyId: string, id: string): Promise<DocumentDraftDto> {
  if (!UUID_RE.test(id)) throw notFound();
  const [row] = await db.select().from(documentDrafts).where(scopeOf(tenantId, companyId, id)).limit(1);
  if (!row) throw notFound();
  return toDto(row);
}

/** A draft without its reading (`fields`, `lines`, `checks`): GET /document-drafts?view=summary. */
export type DocumentDraftSummaryDto = Omit<DocumentDraftDto, 'fields' | 'lines' | 'checks'>;

export async function list(
  tenantId: string, companyId: string, q: DocumentDraftListQuery,
): Promise<{ drafts: Array<DocumentDraftDto | DocumentDraftSummaryDto>; total: number }> {
  const conds: SQL[] = [eq(documentDrafts.tenantId, tenantId), eq(documentDrafts.companyId, companyId)];
  if (q.status && q.status.length) conds.push(inArray(documentDrafts.status, q.status));
  if (q.kind) conds.push(eq(documentDrafts.kind, q.kind));
  const where = and(...conds);
  const order = [desc(documentDrafts.createdAt), desc(documentDrafts.id)] as const;
  const totalP = db.select({ n: count() }).from(documentDrafts).where(where);
  if (q.view === 'summary') {
    // The reading columns are never read, so the database does not ship them.
    const { fields: _f, lines: _l, checks: _c, ...summaryCols } = getTableColumns(documentDrafts);
    const [rows, total] = await Promise.all([
      db.select(summaryCols).from(documentDrafts).where(where).orderBy(...order).limit(q.limit).offset(q.offset),
      totalP,
    ]);
    const drafts = rows.map((r) => {
      const { fields: _a, lines: _b, checks: _d, ...rest } = toDto({ ...r, fields: {}, lines: [], checks: [] } as DocumentDraftRow);
      return rest;
    });
    return { drafts, total: Number(total[0]?.n ?? 0) };
  }
  const [rows, total] = await Promise.all([
    db.select().from(documentDrafts).where(where).orderBy(...order).limit(q.limit).offset(q.offset),
    totalP,
  ]);
  return { drafts: rows.map(toDto), total: Number(total[0]?.n ?? 0) };
}

// ── Create (claim) ───────────────────────────────────────────────────

/**
 * Claims an uploaded draft attachment. The attachment must be visible to the
 * company (else 404) and still a draft attachment (else 422
 * ATTACHMENT_NOT_DRAFT). The engine hashes the stored bytes; a file already
 * claimed in this company by a draft that is not discarded is 409
 * DOCUMENT_ALREADY_CLAIMED with details.draftId. Keyed (idempotency-docs-v1).
 */
export async function create(
  tenantId: string, companyId: string, userId: string, input: CreateDocumentDraftInput,
): Promise<DocumentDraftDto> {
  const att = await attachmentService.getById(tenantId, input.attachmentId, companyId);
  if (att.attachableType !== 'draft') {
    throw AppError.unprocessableEntity('Only a file that is not filed on a record yet can be read as a document.', 'ATTACHMENT_NOT_DRAFT');
  }
  const bytes = await attachmentService.readAttachmentBytes(tenantId, att);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');

  return db.transaction(async (tx) => {
    // The file must still be a draft attachment of this company (or of no
    // company yet) once locked: a concurrent posting may have relinked it,
    // a delete removed it, or another company's claim stamped it meanwhile.
    const locked = await tx.execute(sql`SELECT attachable_type, company_id FROM attachments
      WHERE tenant_id = ${tenantId} AND id = ${att.id} FOR UPDATE`);
    const lockedRow = locked.rows[0] as { attachable_type: string; company_id: string | null } | undefined;
    if (!lockedRow || (lockedRow.company_id !== null && lockedRow.company_id !== companyId)) {
      throw AppError.notFound('Attachment not found');
    }
    if (lockedRow.attachable_type !== 'draft') {
      throw AppError.unprocessableEntity('Only a file that is not filed on a record yet can be read as a document.', 'ATTACHMENT_NOT_DRAFT');
    }

    const inserted = await tx.execute(sql`INSERT INTO document_drafts
        (tenant_id, company_id, attachment_id, content_sha256, kind, created_by, created_at, updated_at)
      VALUES (${tenantId}, ${companyId}, ${att.id}, ${sha}, ${input.kindHint}, ${userId}, ${NOW_MS}, ${NOW_MS})
      ON CONFLICT (tenant_id, company_id, content_sha256) WHERE status <> 'discarded' DO NOTHING
      RETURNING id`);
    const id = (inserted.rows[0] as { id: string } | undefined)?.id;
    if (!id) {
      // The winner committed before the conflict was decided (READ COMMITTED).
      const ex = await tx.execute(sql`SELECT id FROM document_drafts
        WHERE tenant_id = ${tenantId} AND company_id = ${companyId} AND content_sha256 = ${sha} AND status <> 'discarded'
        LIMIT 1`);
      throw AppError.conflict('This document is already being read or was already entered.', 'DOCUMENT_ALREADY_CLAIMED', {
        draftId: (ex.rows[0] as { id: string } | undefined)?.id ?? null,
      });
    }
    await claimAndRecord(tx, 'document_draft', id);
    // The file now belongs to this company (U-90): fill the company on a
    // tenant-wide row, never replacing one it has. Guarded: exactly the
    // locked row, still this company's or no company's.
    const stamped = await tx.execute(sql`UPDATE attachments SET company_id = ${companyId}::uuid
      WHERE tenant_id = ${tenantId} AND id = ${att.id} AND (company_id IS NULL OR company_id = ${companyId}::uuid)`);
    if ((stamped.rowCount ?? 0) !== 1) throw AppError.notFound('Attachment not found');
    const [row] = await tx.select().from(documentDrafts).where(eq(documentDrafts.id, id));
    await auditLog(tenantId, 'create', 'document_draft', id, null, auditImage(row!), userId, tx);
    return toDto(row!);
  });
}

// ── Update (store a reading) ─────────────────────────────────────────

/**
 * Stores a reading (status ready) or a failure (status failed). The caller
 * needs the permission of the draft's kind and, when it changes the kind, of
 * the new one (`canKind`). Stale token 409 STALE; a converted or discarded
 * draft 409 DOCUMENT_DRAFT_CLOSED.
 */
export async function update(
  tenantId: string, companyId: string, userId: string, id: string, input: UpdateDocumentDraftInput,
  canKind: (kind: DocumentDraftKind) => Promise<boolean>,
): Promise<DocumentDraftDto> {
  return db.transaction(async (tx) => {
    const before = await lockDraft(tx, tenantId, companyId, id);
    if (!(await canKind(before.kind)) || (input.kind && input.kind !== before.kind && !(await canKind(input.kind)))) {
      throw AppError.forbidden('You do not have permission for this feature', 'PERMISSION_DENIED');
    }
    if (!isLive(before.status)) throw closed(before);
    assertNotStale(before, input.expectedUpdatedAt);
    if (input.suggestedContactId) await assertContactInScope(tx, tenantId, companyId, input.suggestedContactId);

    const set: Record<string, unknown> = { status: input.status };
    if (input.kind !== undefined) set['kind'] = input.kind;
    if (input.reader !== undefined) set['reader'] = input.reader;
    if (input.fields !== undefined) set['fields'] = input.fields;
    if (input.lines !== undefined) set['lines'] = input.lines;
    if (input.checks !== undefined) set['checks'] = input.checks;
    if (input.failureReason !== undefined) set['failureReason'] = input.failureReason;
    if (input.suggestedContactId !== undefined) set['suggestedContactId'] = input.suggestedContactId;
    if (input.docReference !== undefined) set['docReference'] = input.docReference;
    if (input.docTotal !== undefined) set['docTotal'] = input.docTotal;
    if (input.docDate !== undefined) set['docDate'] = input.docDate;
    set['updatedAt'] = NEXT_UPDATED_AT(sql`${documentDrafts.updatedAt}`);
    const [after] = await tx.update(documentDrafts).set(set as Partial<typeof documentDrafts.$inferInsert>).where(eq(documentDrafts.id, before.id)).returning();
    await auditLog(tenantId, 'update', 'document_draft', before.id, auditImage(before), auditImage(after!), userId, tx);
    return toDto(after!);
  });
}

/** A vendor the company may use: tenant-wide or this company's (404 otherwise). */
async function assertContactInScope(tx: Tx, tenantId: string, companyId: string, contactId: string): Promise<void> {
  const r = await tx.execute(sql`SELECT 1 FROM contacts WHERE tenant_id = ${tenantId} AND id = ${contactId}
    AND (company_id IS NULL OR company_id = ${companyId}) LIMIT 1`);
  if (r.rows.length === 0) throw AppError.notFound('Contact not found');
}

// ── Discard ──────────────────────────────────────────────────────────

/**
 * Discards a draft and frees its claim (the same file can be read again).
 * Already discarded: 200 with the draft, nothing written. Converted: 409
 * DOCUMENT_DRAFT_CLOSED. The file is left alone; the client deletes it
 * afterwards if it wants to (DELETE /attachments/:id).
 */
export async function discard(
  tenantId: string, companyId: string, userId: string, id: string,
  canKind: (kind: DocumentDraftKind) => Promise<boolean>,
): Promise<DocumentDraftDto> {
  return db.transaction(async (tx) => {
    const before = await lockDraft(tx, tenantId, companyId, id);
    if (!(await canKind(before.kind))) throw AppError.forbidden('You do not have permission for this feature', 'PERMISSION_DENIED');
    if (before.status === 'discarded') return toDto(before);
    if (before.status === 'converted') throw closed(before);
    const [after] = await tx.update(documentDrafts).set({
      status: 'discarded',
      discardedAt: sql`clock_timestamp()`,
      updatedAt: NEXT_UPDATED_AT(sql`${documentDrafts.updatedAt}`),
    }).where(eq(documentDrafts.id, before.id)).returning();
    await auditLog(tenantId, 'update', 'document_draft', before.id, auditImage(before), { ...auditImage(after!), discarded: true }, userId, tx);
    return toDto(after!);
  });
}

// ── Duplicates (U-92b) ───────────────────────────────────────────────

export interface DuplicateMatch {
  /** 'transaction': a posted bill, expense or check; 'draft': another live draft. */
  source: 'transaction' | 'draft';
  id: string;
  /** 'reference': same vendor and normalized reference; 'amount_date': same vendor, same total, dates within 60 days. */
  reason: 'reference' | 'amount_date';
  txnType: string | null;
  kind: string | null;
  date: string | null;
  total: string | null;
  reference: string | null;
}

interface DuplicateProbe {
  contactId: string | null;
  reference: string | null;
  /** Numeric source for the amount rule: a SQL expression (a column or a decimal-string parameter). */
  total: SQL | null;
  date: SQL | null;
  excludeTransactionId?: string;
  excludeDraftId?: string;
}

/**
 * Posted bills, expenses and checks of the vendor in the company (or
 * tenant-wide) that are neither void nor deleted, matching by normalized
 * reference or by exact total (numeric) with the date within
 * DUPLICATE_WINDOW_DAYS.
 */
async function transactionMatches(exec: Tx | typeof db, tenantId: string, companyId: string, p: DuplicateProbe): Promise<DuplicateMatch[]> {
  if (!p.contactId) return [];
  const ref = normalizedRefSql(sql`${p.reference}::text`);
  const amountRule = p.total && p.date
    ? sql`(t.total = (${p.total})::numeric AND t.txn_date BETWEEN (${p.date})::date - ${DUPLICATE_WINDOW_DAYS}::int AND (${p.date})::date + ${DUPLICATE_WINDOW_DAYS}::int)`
    : sql`false`;
  const r = await exec.execute(sql`SELECT t.id, t.txn_type, t.txn_date::text AS date, t.total::text AS total,
      ${TXN_REFERENCE_SQL} AS reference,
      (${ref} <> '' AND ${normalizedRefSql(TXN_REFERENCE_SQL)} = ${ref}) AS ref_match
    FROM transactions t
    WHERE t.tenant_id = ${tenantId}
      AND (t.company_id = ${companyId} OR t.company_id IS NULL)
      AND t.txn_type IN ('bill', 'expense')
      AND t.status NOT IN ('void', 'deleted')
      AND t.contact_id = ${p.contactId}
      ${p.excludeTransactionId ? sql`AND t.id <> ${p.excludeTransactionId}` : sql``}
      AND ((${ref} <> '' AND ${normalizedRefSql(TXN_REFERENCE_SQL)} = ${ref}) OR ${amountRule})
    ORDER BY t.txn_date DESC, t.id
    LIMIT 20`);
  return (r.rows as Array<{ id: string; txn_type: string; date: string | null; total: string | null; reference: string | null; ref_match: boolean }>)
    .map((x) => ({
      source: 'transaction' as const, id: x.id, reason: x.ref_match ? 'reference' as const : 'amount_date' as const,
      txnType: x.txn_type, kind: null, date: x.date, total: x.total, reference: x.reference,
    }));
}

/** Other live drafts of the vendor in the company, by the same two rules. */
async function draftMatches(exec: Tx | typeof db, tenantId: string, companyId: string, p: DuplicateProbe): Promise<DuplicateMatch[]> {
  if (!p.contactId) return [];
  const ref = normalizedRefSql(sql`${p.reference}::text`);
  const amountRule = p.total && p.date
    ? sql`(d.doc_total = (${p.total})::numeric AND d.doc_date BETWEEN (${p.date})::date - ${DUPLICATE_WINDOW_DAYS}::int AND (${p.date})::date + ${DUPLICATE_WINDOW_DAYS}::int)`
    : sql`false`;
  const r = await exec.execute(sql`SELECT d.id, d.kind, d.doc_date::text AS date, d.doc_total::text AS total, d.doc_reference AS reference,
      (${ref} <> '' AND ${normalizedRefSql(sql`d.doc_reference`)} = ${ref}) AS ref_match
    FROM document_drafts d
    WHERE d.tenant_id = ${tenantId} AND d.company_id = ${companyId}
      AND d.status IN ('new', 'ready', 'failed')
      AND d.suggested_contact_id = ${p.contactId}
      ${p.excludeDraftId ? sql`AND d.id <> ${p.excludeDraftId}` : sql``}
      AND ((${ref} <> '' AND ${normalizedRefSql(sql`d.doc_reference`)} = ${ref}) OR ${amountRule})
    ORDER BY d.created_at DESC, d.id
    LIMIT 20`);
  return (r.rows as Array<{ id: string; kind: string; date: string | null; total: string | null; reference: string | null; ref_match: boolean }>)
    .map((x) => ({
      source: 'draft' as const, id: x.id, reason: x.ref_match ? 'reference' as const : 'amount_date' as const,
      txnType: null, kind: x.kind, date: x.date, total: x.total, reference: x.reference,
    }));
}

/**
 * GET /document-drafts/:id/duplicates: posted documents and other live
 * drafts that may be the same document, from the draft's vendor
 * (suggestedContactId), reference, total and date. Empty without a vendor.
 */
export async function duplicates(tenantId: string, companyId: string, id: string): Promise<{ matches: DuplicateMatch[] }> {
  if (!UUID_RE.test(id)) throw notFound();
  const [row] = await db.select().from(documentDrafts).where(scopeOf(tenantId, companyId, id)).limit(1);
  if (!row) throw notFound();
  const probe: DuplicateProbe = {
    contactId: row.suggestedContactId,
    reference: row.docReference,
    total: row.docTotal === null ? null : sql`${row.docTotal}::text`,
    date: row.docDate === null ? null : sql`${row.docDate}::text`,
    excludeDraftId: row.id,
    excludeTransactionId: row.convertedTransactionId ?? undefined,
  };
  const [txns, drafts] = await Promise.all([
    transactionMatches(db, tenantId, companyId, probe),
    draftMatches(db, tenantId, companyId, probe),
  ]);
  return { matches: [...txns, ...drafts] };
}

// ── Convert ──────────────────────────────────────────────────────────

/** Parses `body` with the kind's posting schema: 400 VALIDATION_ERROR with the field path. */
export function parseConvertBody(kind: DocumentConvertKind, body: Record<string, unknown>) {
  const parsed = convertBodySchemaFor(kind).safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = ['body', ...(issue?.path ?? [])].join('.');
    throw AppError.badRequest(`${path}: ${issue?.message ?? 'invalid'}`, 'VALIDATION_ERROR', { path });
  }
  return parsed.data;
}

/**
 * Converts a draft into a bill, card charge, cash expense or check, in one
 * database transaction (U-92 convert, M5):
 *   1. the draft is locked FOR UPDATE; the caller needs the permission of
 *      its current kind (`canKind`, 403); converted or discarded 409
 *      DOCUMENT_DRAFT_CLOSED (details.transactionId), stale 409 STALE;
 *   2. the Idempotency-Key is claimed and the draft recorded as its entity;
 *   3. the vendor must be tenant-wide or the company's (404), then is
 *      serialized with a transaction-scoped advisory lock on
 *      company + vendor, so two computers converting copies of one
 *      invoice run one after the other;
 *   4. the body posts through the kind's service on this transaction
 *      (closed period 423 / 403 at the ledger's closing-date check);
 *   5. the duplicate check runs on the posted row (its vendor, total,
 *      reference and date as the engine stored them): any posted bill,
 *      expense or check of the vendor that matches and is not in
 *      acknowledgeDuplicateOf is 409 POSSIBLE_DUPLICATE {matches,
 *      draftMatches} and the posting rolls back; other live drafts that
 *      match (draftMatches) are listed but never block;
 *   6. the draft's file is relinked to the new record (one audit row each),
 *      except files on its key that another live draft reads;
 *   7. the draft is marked converted, with an audit row.
 * Any failure rolls back all of it: no transaction, journal line, audit row
 * or idempotency record, and the file stays on its draft key.
 */
export async function convert(
  tenantId: string, companyId: string, userId: string, id: string, input: ConvertDocumentDraftInput,
  canKind: (kind: DocumentDraftKind) => Promise<boolean>,
): Promise<{ draft: DocumentDraftDto; transactionId: string }> {
  const body = parseConvertBody(input.kind, input.body);
  return db.transaction(async (tx) => {
    const before = await lockDraft(tx, tenantId, companyId, id);
    // The route checked the requested kind; the draft's current kind is
    // checked here, on the locked row (the update() rule).
    if (!(await canKind(before.kind))) throw AppError.forbidden('You do not have permission for this feature', 'PERMISSION_DENIED');
    if (!isLive(before.status)) throw closed(before);
    assertNotStale(before, input.expectedUpdatedAt);
    await claimAndRecord(tx, 'document_draft', before.id);

    const contactId = (body as { contactId?: string | null }).contactId ?? null;
    if (contactId) {
      // The vendor must be tenant-wide or this company's (404), before it
      // names a lock or a posting.
      await assertContactInScope(tx, tenantId, companyId, contactId);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${companyId}:${contactId}`}, 0))`);
    }

    let txnId: string;
    switch (input.kind) {
      case 'bill': {
        const bill = await billService.createBill(tenantId, body as Parameters<typeof billService.createBill>[1], userId, companyId, tx);
        txnId = bill.id;
        break;
      }
      case 'check': {
        const check = await checkService.createCheck(tenantId, body as Parameters<typeof checkService.createCheck>[1], userId, companyId, tx);
        txnId = check!.id;
        break;
      }
      case 'card_charge':
      case 'cash_expense': {
        const exp = await expenseService.createExpense(tenantId, body as Parameters<typeof expenseService.createExpense>[1], userId, companyId, tx);
        txnId = exp.id;
        break;
      }
    }

    if (contactId) {
      const probe = await postedProbe(tx, tenantId, txnId, before.docReference);
      const matches = await transactionMatches(tx, tenantId, companyId, { ...probe, contactId, excludeTransactionId: txnId });
      const acknowledged = new Set(input.acknowledgeDuplicateOf.map((x) => x.toLowerCase()));
      const open = matches.filter((m) => !acknowledged.has(m.id.toLowerCase()));
      if (open.length > 0) {
        // Other live drafts of the same document are listed too, but never
        // block (each is converted or discarded on its own).
        const drafts = await draftMatches(tx, tenantId, companyId, { ...probe, contactId, excludeDraftId: before.id });
        throw AppError.conflict('This may already be entered. Check the matching documents, then confirm to enter it anyway.', 'POSSIBLE_DUPLICATE', {
          matches: open, draftMatches: drafts,
        });
      }
    }

    // Relink the draft's file (and any other file on the same draft key,
    // except files another live draft reads: they stay on the key).
    if (before.attachmentId) {
      const att = await tx.execute(sql`SELECT attachable_type, attachable_id FROM attachments
        WHERE tenant_id = ${tenantId} AND id = ${before.attachmentId} FOR UPDATE`);
      const a = att.rows[0] as { attachable_type: string; attachable_id: string } | undefined;
      if (a && a.attachable_type === 'draft') {
        const claimed = await tx.execute(sql`SELECT attachment_id FROM document_drafts
          WHERE tenant_id = ${tenantId} AND id <> ${before.id} AND attachment_id IS NOT NULL
            AND status IN ('new', 'ready', 'failed')
            AND attachment_id IN (SELECT id FROM attachments WHERE tenant_id = ${tenantId} AND attachable_type = 'draft' AND attachable_id = ${a.attachable_id})`);
        const excludeIds = (claimed.rows as Array<{ attachment_id: string }>).map((r) => r.attachment_id);
        await attachmentService.relinkDraftAttachments(tx, tenantId, a.attachable_id, attachableTypeOf(input.kind), txnId, userId, companyId, excludeIds);
      }
    }

    const hook = isTest() ? __documentDraftTestHooks.afterPost : undefined;
    if (hook) await hook({ draftId: before.id, transactionId: txnId });

    const [after] = await tx.update(documentDrafts).set({
      status: 'converted',
      kind: input.kind,
      convertedTransactionId: txnId,
      convertedType: input.kind === 'bill' ? 'bill' : 'expense',
      convertedAt: sql`clock_timestamp()`,
      convertedBy: userId,
      updatedAt: NEXT_UPDATED_AT(sql`${documentDrafts.updatedAt}`),
    }).where(eq(documentDrafts.id, before.id)).returning();
    await auditLog(tenantId, 'update', 'document_draft', before.id, auditImage(before), {
      ...auditImage(after!), converted: true, acknowledgedDuplicates: input.acknowledgeDuplicateOf,
    }, userId, tx);
    return { draft: toDto(after!), transactionId: txnId };
  });
}

/** The duplicate probe of a posted row as the engine stored it: total, date and reference. */
async function postedProbe(exec: Tx | typeof db, tenantId: string, txnId: string, fallbackReference: string | null) {
  const posted = await exec.execute(sql`SELECT t.contact_id, t.total::text AS total, t.txn_date::text AS date, ${TXN_REFERENCE_SQL} AS reference
    FROM transactions t WHERE t.tenant_id = ${tenantId} AND t.id = ${txnId}`);
  const p = posted.rows[0] as { contact_id: string | null; total: string | null; date: string | null; reference: string | null } | undefined;
  return {
    contactId: p?.contact_id ?? null,
    // A check carries no vendor reference; the document's own one stands in.
    reference: p?.reference ?? fallbackReference,
    total: p?.total == null ? null : sql`${p.total}::text`,
    date: p?.date == null ? null : sql`${p.date}::text`,
  };
}

/**
 * The convert response: the draft, the posted record as now, and the other
 * live drafts that may be the same document (`draftMatches`, never blocking;
 * by the posted record's vendor, reference, total and date).
 */
export async function convertResponse(tenantId: string, companyId: string, id: string) {
  const draft = await get(tenantId, companyId, id);
  const transaction = draft.convertedTransactionId ? await ledger.getTransaction(tenantId, draft.convertedTransactionId) : null;
  const draftMatchesOut = draft.convertedTransactionId
    ? await draftMatches(db, tenantId, companyId, {
      ...(await postedProbe(db, tenantId, draft.convertedTransactionId, draft.docReference)), excludeDraftId: draft.id,
    })
    : [];
  return { draft, transaction, draftMatches: draftMatchesOut };
}

// ── Vendor layout templates ──────────────────────────────────────────

export interface VendorLayoutTemplateDto {
  id: string;
  companyId: string;
  contactId: string;
  fingerprint: string;
  fieldRegions: Record<string, unknown>;
  lineTable: Record<string, unknown> | null;
  samples: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function templateDto(r: VendorLayoutTemplateRow): VendorLayoutTemplateDto {
  return {
    id: r.id, companyId: r.companyId, contactId: r.contactId, fingerprint: r.fingerprint,
    fieldRegions: r.fieldRegions, lineTable: r.lineTable ?? null, samples: r.samples,
    lastUsedAt: iso(r.lastUsedAt), createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

function templateAudit(r: VendorLayoutTemplateRow): Record<string, unknown> {
  return { id: r.id, companyId: r.companyId, contactId: r.contactId, fingerprint: r.fingerprint, samples: r.samples };
}

export async function listTemplates(tenantId: string, companyId: string, contactId?: string): Promise<{ templates: VendorLayoutTemplateDto[] }> {
  const conds: SQL[] = [eq(vendorLayoutTemplates.tenantId, tenantId), eq(vendorLayoutTemplates.companyId, companyId)];
  if (contactId) conds.push(eq(vendorLayoutTemplates.contactId, contactId));
  const rows = await db.select().from(vendorLayoutTemplates).where(and(...conds))
    .orderBy(desc(vendorLayoutTemplates.updatedAt), desc(vendorLayoutTemplates.id))
    .limit(DOCUMENT_DRAFT_LIMITS.templatesPerCompany);
  return { templates: rows.map(templateDto) };
}

/**
 * Creates or replaces the template of (company, vendor, fingerprint).
 * expectedUpdatedAt null: create only (409 STALE when it exists); otherwise
 * the stored updatedAt (409 STALE on a mismatch or when it does not exist).
 * At most templatesPerCompany per company (409 TEMPLATE_LIMIT).
 */
export async function putTemplate(
  tenantId: string, companyId: string, userId: string, input: PutVendorLayoutTemplateInput,
): Promise<{ template: VendorLayoutTemplateDto; created: boolean }> {
  return db.transaction(async (tx) => {
    await assertContactInScope(tx, tenantId, companyId, input.contactId);
    // Serialize writers of this company's templates (cap and upsert).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`vlt:${companyId}`}, 0))`);
    const [existing] = await tx.select().from(vendorLayoutTemplates).where(and(
      eq(vendorLayoutTemplates.tenantId, tenantId), eq(vendorLayoutTemplates.companyId, companyId),
      eq(vendorLayoutTemplates.contactId, input.contactId), eq(vendorLayoutTemplates.fingerprint, input.fingerprint),
    )).for('update');
    if (!existing) {
      if (input.expectedUpdatedAt !== null) {
        throw AppError.conflict('This layout was removed by someone else. Reload and try again.', 'STALE', { updatedAt: null });
      }
      const [n] = await tx.select({ n: count() }).from(vendorLayoutTemplates)
        .where(and(eq(vendorLayoutTemplates.tenantId, tenantId), eq(vendorLayoutTemplates.companyId, companyId)));
      if (Number(n?.n ?? 0) >= DOCUMENT_DRAFT_LIMITS.templatesPerCompany) {
        throw AppError.conflict(`A company keeps at most ${DOCUMENT_DRAFT_LIMITS.templatesPerCompany} vendor layouts.`, 'TEMPLATE_LIMIT');
      }
      const [row] = await tx.insert(vendorLayoutTemplates).values({
        tenantId, companyId, contactId: input.contactId, fingerprint: input.fingerprint,
        fieldRegions: input.fieldRegions, lineTable: input.lineTable ?? null, samples: input.samples ?? 1,
        lastUsedAt: input.lastUsedAt ? new Date(input.lastUsedAt) : null, createdBy: userId,
        createdAt: NOW_MS as unknown as Date, updatedAt: NOW_MS as unknown as Date,
      }).returning();
      await auditLog(tenantId, 'create', 'vendor_layout_template', row!.id, null, templateAudit(row!), userId, tx);
      return { template: templateDto(row!), created: true };
    }
    if (input.expectedUpdatedAt === null) {
      throw AppError.conflict('This layout was saved by someone else. Reload and try again.', 'STALE', { updatedAt: existing.updatedAt.toISOString() });
    }
    assertNotStale(existing, input.expectedUpdatedAt);
    const [row] = await tx.update(vendorLayoutTemplates).set({
      fieldRegions: input.fieldRegions,
      ...(input.lineTable !== undefined ? { lineTable: input.lineTable } : {}),
      ...(input.samples !== undefined ? { samples: input.samples } : {}),
      ...(input.lastUsedAt !== undefined ? { lastUsedAt: input.lastUsedAt ? new Date(input.lastUsedAt) : null } : {}),
      updatedAt: NEXT_UPDATED_AT(sql`${vendorLayoutTemplates.updatedAt}`) as unknown as Date,
    }).where(eq(vendorLayoutTemplates.id, existing.id)).returning();
    await auditLog(tenantId, 'update', 'vendor_layout_template', row!.id, templateAudit(existing), templateAudit(row!), userId, tx);
    return { template: templateDto(row!), created: false };
  });
}

export async function deleteTemplate(
  tenantId: string, companyId: string, userId: string, id: string, expectedUpdatedAt?: string,
): Promise<void> {
  if (!UUID_RE.test(id)) throw AppError.notFound('Vendor layout not found');
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(vendorLayoutTemplates).where(and(
      eq(vendorLayoutTemplates.tenantId, tenantId), eq(vendorLayoutTemplates.companyId, companyId), eq(vendorLayoutTemplates.id, id),
    )).for('update');
    if (!row) throw AppError.notFound('Vendor layout not found');
    if (expectedUpdatedAt !== undefined) assertNotStale(row, expectedUpdatedAt);
    await tx.delete(vendorLayoutTemplates).where(eq(vendorLayoutTemplates.id, row.id));
    await auditLog(tenantId, 'delete', 'vendor_layout_template', row.id, templateAudit(row), null, userId, tx);
  });
}
