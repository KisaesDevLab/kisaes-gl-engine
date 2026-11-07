// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Bank file import batches (U-06, bank-import-batch-v1).
 *
 * A client parses a bank file and sends one account section as a batch of
 * rows (amounts as decimal strings in the feed sign: positive = money out).
 * The engine computes every row's keys (./keys.ts) and status, the
 * closed-period flag and the file balance check. A dry run (the preview)
 * changes nothing. A commit, under an advisory lock on (tenant, account),
 * inserts the new rows into the bank feed of the account's manual
 * connection, records the batch (always, also when nothing is inserted)
 * and audits it. It never posts and never calls AI: the post-processing
 * after the commit runs cleansing without the LLM and the rule stages
 * without posting (runImportPostProcessing).
 *
 * Row classification (first match wins):
 *   i    a FITID that occurs more than once in the request is ignored on
 *        every occurrence (reason repeated_bank_id);
 *   ii   an existing item of the account with the FITID: same amount and
 *        date within 5 days → duplicate/same_bank_id; another amount, date
 *        within 5 days and a matching description → changed; otherwise the
 *        FITID is ignored (reason bank_id_reused) and the row goes on;
 *   iii  an existing dedupe or row key equal to the row key →
 *        duplicate/same_row;
 *   iv   the fuzzy rule (sameAmountNearby) → possible_duplicate/
 *        similar_existing; items matched in ii–iii are used up, each item
 *        is claimed once;
 *   v    new.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, type Tx, type DbOrTx } from '../../db/index.js';
import { bankConnections, bankFeedItems, bankImportBatches, bankConnectionIdentities } from '../../db/schema/index.js';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../middleware/audit.js';
import { claimAndRecord } from '../idempotency.service.js';
import { runWithoutIdempotency } from '../idempotency-context.js';
import {
  Decimal, DEDUPE_VERSION, NORM_MAX_CODE_POINTS, cleanFitid, fitidKey, keyRows, norm, type KeyedRow,
} from './keys.js';

// ─── Contract ────────────────────────────────────────────────────────

export const MAX_BATCH_ROWS = 20_000;
export const AMOUNT_RE = /^-?\d{1,12}(\.\d{1,2})?$/;
export const BATCH_TOTAL_LIMIT = new Decimal('1e15');
export const MEMO_MAX = 1000;
export const INSERT_CHUNK = 1000;
/** A FITID match counts within this many days. */
export const FITID_DAYS = 5;
/** The fuzzy rule (Q-P25c) matches within this many days. */
export const FUZZY_DAYS = 3;
/** A register line counts as likely in the books within this many days. */
export const LIKELY_DAYS = 5;
const PENDING_STATUSES = ['pending', 'assigned', 'categorizing'] as const;

export type BatchFormat = 'ofx' | 'qfx' | 'qif' | 'csv';
export type RowStatus = 'new' | 'duplicate' | 'possible_duplicate' | 'changed';
export type RowReason = 'same_bank_id' | 'same_row' | 'repeated_bank_id' | 'bank_id_reused' | 'similar_existing';

export interface BatchRowInput {
  line: number;
  date: string;
  amount: string;
  description: string;
  memo?: string | null;
  checkNumber?: number | null;
  fitid?: string | null;
  include?: boolean;
  changedAction?: 'replace' | 'add';
}

export interface BatchInput {
  accountId: string;
  format: BatchFormat;
  fileName: string;
  sourceFileSha256: string;
  sectionIndex: number;
  sectionStart?: string | null;
  sectionEnd?: string | null;
  amountsFlipped: boolean;
  csvMapping?: Record<string, unknown> | null;
  dryRun: boolean;
  relinkIdentity?: boolean;
  bankIdentity?: { mask: string; accountKeyHash: string } | null;
  fileEndingBalance?: string | null;
  fileEndingDate?: string | null;
  rows: BatchRowInput[];
}

export interface RowResult {
  line: number;
  status: RowStatus;
  reason?: RowReason;
  existingItemId?: string;
  existingImportedAt?: string;
  existingPending?: boolean;
  closedPeriod: boolean;
  inserted: boolean;
  /** A `changed` row with changedAction "replace": the existing item was updated. */
  replaced?: boolean;
}

export interface BalanceCheck {
  fileBalance: string;
  fileDate: string;
  booksAtDate: string;
  pendingTotal: string;
  newTotal: string;
  likelyInBooks: { count: number; total: string };
  projected: string;
  difference: string;
}

export interface BatchResult {
  batchId?: string;
  sameFileImportedAt?: string;
  identityLinkedElsewhere?: { accountName: string; mask: string };
  insertedItemIds: string[];
  postProcessing?: 'scheduled' | 'done' | 'failed';
  rows: RowResult[];
  counts: { inFile: number; new: number; duplicate: number; possibleDuplicate: number; changed: number; closedPeriod: number; inserted: number };
  insertedTotal: string;
  balanceCheck?: BalanceCheck;
}

// ─── Validation ──────────────────────────────────────────────────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}

function invalidRow(line: number, field: string, message: string): AppError {
  return AppError.unprocessableEntity(`Line ${line}: ${message}`, 'invalid_row', { line, field });
}

/** The 422s of the contract that need no database: row values, row count, batch total. */
export function validateBatch(input: BatchInput): void {
  if (input.rows.length > MAX_BATCH_ROWS) {
    throw AppError.unprocessableEntity(`A batch is limited to ${MAX_BATCH_ROWS} rows.`, 'too_many_rows', { max: MAX_BATCH_ROWS });
  }
  let total = new Decimal(0);
  for (const r of input.rows) {
    if (!isValidDate(r.date)) throw invalidRow(r.line, 'date', 'the date is not a valid YYYY-MM-DD date.');
    if (typeof r.amount !== 'string' || !AMOUNT_RE.test(r.amount)) {
      throw invalidRow(r.line, 'amount', 'the amount must have at most 12 digits before and 2 after the decimal point.');
    }
    const amt = new Decimal(r.amount);
    if (amt.isZero()) throw invalidRow(r.line, 'amount', 'the amount is zero.');
    if (Array.from(r.description).length > NORM_MAX_CODE_POINTS) {
      throw invalidRow(r.line, 'description', `the description is longer than ${NORM_MAX_CODE_POINTS} characters.`);
    }
    if (r.memo != null && Array.from(r.memo).length > MEMO_MAX) {
      throw invalidRow(r.line, 'memo', `the memo is longer than ${MEMO_MAX} characters.`);
    }
    total = total.plus(amt.abs());
  }
  if (total.gte(BATCH_TOTAL_LIMIT)) {
    throw AppError.unprocessableEntity('The batch total is too large.', 'batch_total_too_large');
  }
  if (input.fileEndingBalance != null && !AMOUNT_RE.test(input.fileEndingBalance)) {
    throw AppError.unprocessableEntity('fileEndingBalance must have at most 12 digits before and 2 after the decimal point.', 'VALIDATION_ERROR');
  }
}

// ─── Classification (pure) ───────────────────────────────────────────

export interface ExistingItem {
  id: string;
  connectionId: string;
  fitid: string | null;
  date: string;
  amount: string;
  description: string;
  checkNumber: number | null;
  status: string;
  createdAt: string;
  dedupeKey: string | null;
  rowKey: string | null;
}

export interface Classified {
  status: RowStatus;
  reason?: RowReason;
  existing?: ExistingItem;
  /** The FITID stored with the row (null when absent or ignored). */
  fitidUsed: string | null;
  dedupeKey: string;
}

function dayNumber(date: string): number {
  const m = DATE_RE.exec(date)!;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) / 86_400_000;
}

export function dayDiff(a: string, b: string): number {
  return Math.abs(dayNumber(a) - dayNumber(b));
}

/** Q-P25c description test: equal, or one a prefix of the other with the shorter at least 8 characters. */
export function descriptionsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [s, l] = Array.from(a).length <= Array.from(b).length ? [a, b] : [b, a];
  return Array.from(s).length >= 8 && l.startsWith(s);
}

function amountEq(a: string, b: string): boolean {
  return new Decimal(a).eq(new Decimal(b));
}

function byAge(a: ExistingItem, b: ExistingItem): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Classifies every row. `byFitid` holds the account's existing items per
 * FITID, `byKey` its items per dedupe and row key, `pool` the existing items
 * dated near the request (fuzzy candidates). The result does not depend on
 * row order except for which of two equal rows claims a fuzzy candidate.
 */
export function classifyRows(
  rows: ReadonlyArray<BatchRowInput>,
  keyed: ReadonlyArray<KeyedRow>,
  byFitid: ReadonlyMap<string, ExistingItem[]>,
  byKey: ReadonlyMap<string, ExistingItem>,
  pool: ReadonlyArray<ExistingItem>,
  section: { start?: string | null; end?: string | null },
): Classified[] {
  const fitids = rows.map((r) => cleanFitid(r.fitid));
  const occurrences = new Map<string, number>();
  for (const f of fitids) if (f) occurrences.set(f, (occurrences.get(f) ?? 0) + 1);

  const usedUp = new Set<string>();
  const out: Array<Classified | null> = rows.map(() => null);
  const fallbackReason: Array<RowReason | undefined> = rows.map(() => undefined);
  const trusted: Array<string | null> = rows.map(() => null);

  // Pass 1: exact matches (ii, iii).
  rows.forEach((row, i) => {
    const k = keyed[i]!;
    const fitid = fitids[i];
    if (fitid && (occurrences.get(fitid) ?? 0) > 1) {
      fallbackReason[i] = 'repeated_bank_id';
    } else if (fitid) {
      const existing = (byFitid.get(fitid) ?? []).slice().sort(byAge)[0];
      if (existing) {
        const near = dayDiff(row.date, existing.date) <= FITID_DAYS;
        if (near && amountEq(existing.amount, k.canonicalAmount)) {
          usedUp.add(existing.id);
          out[i] = { status: 'duplicate', reason: 'same_bank_id', existing, fitidUsed: fitid, dedupeKey: fitidKey(fitid) };
          return;
        }
        if (near && descriptionsMatch(k.normDescription, norm(existing.description))) {
          usedUp.add(existing.id);
          // "Add as new" stores the row without the FITID (it stays with the existing item).
          out[i] = { status: 'changed', existing, fitidUsed: null, dedupeKey: k.rowKey };
          return;
        }
        fallbackReason[i] = 'bank_id_reused';
      } else {
        trusted[i] = fitid;
      }
    }
    const byRow = byKey.get(k.rowKey);
    if (byRow && !usedUp.has(byRow.id)) {
      usedUp.add(byRow.id);
      out[i] = { status: 'duplicate', reason: 'same_row', existing: byRow, fitidUsed: trusted[i] ?? null, dedupeKey: k.rowKey };
    }
  });

  // Pass 2: fuzzy (iv), then new (v).
  rows.forEach((row, i) => {
    if (out[i]) return;
    const k = keyed[i]!;
    const fitidUsed = trusted[i] ?? null;
    const dedupeKey = fitidUsed ? fitidKey(fitidUsed) : k.rowKey;
    let best: ExistingItem | undefined;
    for (const e of pool) {
      if (usedUp.has(e.id)) continue;
      if (!amountEq(e.amount, k.canonicalAmount)) continue;
      const days = dayDiff(row.date, e.date);
      if (days > FUZZY_DAYS) continue;
      if (section.start && e.date < section.start) continue;
      if (section.end && e.date > section.end) continue;
      const eNorm = norm(e.description);
      if (fitidUsed && e.fitid && e.fitid !== fitidUsed && !(days === 0 && eNorm === k.normDescription)) continue;
      if (row.checkNumber != null && e.checkNumber != null && row.checkNumber !== e.checkNumber) continue;
      if (!descriptionsMatch(k.normDescription, eNorm)) continue;
      if (!best || days < dayDiff(row.date, best.date) || (days === dayDiff(row.date, best.date) && byAge(e, best) < 0)) best = e;
    }
    if (best) {
      usedUp.add(best.id);
      out[i] = { status: 'possible_duplicate', reason: 'similar_existing', existing: best, fitidUsed, dedupeKey };
      return;
    }
    out[i] = { status: 'new', ...(fallbackReason[i] ? { reason: fallbackReason[i] } : {}), fitidUsed, dedupeKey };
  });
  return out as Classified[];
}

/** Whether a classified row is inserted on commit (or would be, for the balance check). */
export function wouldInsert(row: BatchRowInput, c: Classified): boolean {
  switch (c.status) {
    case 'new': return row.include !== false;
    case 'possible_duplicate': return row.include === true;
    case 'changed': return row.changedAction === 'add';
    default: return false;
  }
}

// ─── Database reads ──────────────────────────────────────────────────

interface AccountRow { id: string; name: string; account_type: string; detail_type: string | null; is_active: boolean | null; company_id: string | null }

type AccountKind = 'bank' | 'card';

async function readAccount(ex: DbOrTx, tenantId: string, companyId: string | undefined, accountId: string): Promise<AccountRow & { kind: AccountKind }> {
  const r = await ex.execute(sql`
    SELECT id, name, account_type, detail_type, is_active, company_id
    FROM accounts WHERE tenant_id = ${tenantId} AND id = ${accountId}
  `);
  const a = (r.rows as unknown as AccountRow[])[0];
  if (!a || (companyId && a.company_id && a.company_id !== companyId)) {
    throw AppError.unprocessableEntity('The account is not in this company.', 'account_not_in_company');
  }
  const kind: AccountKind | null = a.account_type === 'asset' && a.detail_type === 'bank'
    ? 'bank'
    : a.account_type === 'liability' && a.detail_type === 'credit_card' ? 'card' : null;
  if (!kind || a.is_active === false) {
    throw AppError.unprocessableEntity(
      a.is_active === false ? 'The account is inactive.' : 'Bank files can only be imported into a bank or credit card account.',
      'account_not_bank_or_card',
    );
  }
  return { ...a, kind };
}

/** The closing date that applies, from the same company-scoped query as checkLockDate. */
async function readLockDate(ex: DbOrTx, tenantId: string, companyId: string | null | undefined): Promise<string | null> {
  const r = companyId
    ? await ex.execute(sql`SELECT lock_date::text AS lock_date FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId}`)
    : await ex.execute(sql`SELECT MAX(lock_date)::text AS lock_date FROM companies WHERE tenant_id = ${tenantId}`);
  return ((r.rows as Array<{ lock_date: string | null }>)[0]?.lock_date) ?? null;
}

async function accountConnections(ex: DbOrTx, tenantId: string, accountId: string) {
  return ex.select({ id: bankConnections.id, provider: bankConnections.provider })
    .from(bankConnections)
    .where(and(eq(bankConnections.tenantId, tenantId), eq(bankConnections.accountId, accountId)))
    .orderBy(bankConnections.createdAt, bankConnections.id);
}

const jsonList = (values: readonly string[]) => sql`(SELECT jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`;
/** A uuid list as one parameter, so the uuid indexes stay usable. */
const uuidList = (values: readonly string[]) => sql`(SELECT x::uuid FROM jsonb_array_elements_text(${JSON.stringify(values)}::jsonb) AS x)`;

interface ItemRow {
  id: string; bank_connection_id: string; provider_transaction_id: string | null; feed_date: string; amount: string;
  original_description: string | null; description: string | null; check_number: number | null; status: string | null;
  created_at: string; dedupe_key: string | null; row_key: string | null;
}

function toExisting(r: ItemRow): ExistingItem {
  return {
    id: r.id, connectionId: r.bank_connection_id, fitid: r.provider_transaction_id, date: r.feed_date, amount: r.amount,
    description: r.original_description ?? r.description ?? '', checkNumber: r.check_number, status: r.status ?? 'pending',
    createdAt: r.created_at, dedupeKey: r.dedupe_key?.trim() ?? null, rowKey: r.row_key?.trim() ?? null,
  };
}

const ITEM_COLUMNS = sql`id, bank_connection_id, provider_transaction_id, feed_date::text AS feed_date, amount::text AS amount,
  original_description, description, check_number, status, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
  dedupe_key, row_key`;

async function lookups(
  ex: DbOrTx, tenantId: string, connIds: string[], rows: ReadonlyArray<BatchRowInput>, keyed: ReadonlyArray<KeyedRow>,
): Promise<{ byFitid: Map<string, ExistingItem[]>; byKey: Map<string, ExistingItem>; pool: ExistingItem[] }> {
  const byFitid = new Map<string, ExistingItem[]>();
  const byKey = new Map<string, ExistingItem>();
  const pool: ExistingItem[] = [];
  if (connIds.length === 0 || rows.length === 0) return { byFitid, byKey, pool };
  const conns = uuidList(connIds);

  const fitids = [...new Set(rows.map((r) => cleanFitid(r.fitid)).filter((f): f is string => f !== null))];
  if (fitids.length > 0) {
    const r = await ex.execute(sql`SELECT ${ITEM_COLUMNS} FROM bank_feed_items
      WHERE tenant_id = ${tenantId} AND bank_connection_id IN ${conns} AND provider_transaction_id IN ${jsonList(fitids)}`);
    for (const row of r.rows as unknown as ItemRow[]) {
      const e = toExisting(row);
      const list = byFitid.get(e.fitid!) ?? [];
      list.push(e);
      byFitid.set(e.fitid!, list);
    }
  }

  const keys = keyed.map((k) => k.rowKey);
  const rk = await ex.execute(sql`SELECT ${ITEM_COLUMNS} FROM bank_feed_items
    WHERE tenant_id = ${tenantId} AND bank_connection_id IN ${conns}
      AND (dedupe_key IN ${jsonList(keys)} OR row_key IN ${jsonList(keys)})`);
  const keySet = new Set(keys);
  for (const row of (rk.rows as unknown as ItemRow[]).map(toExisting).sort(byAge)) {
    for (const k of [row.dedupeKey, row.rowKey]) {
      if (k && keySet.has(k) && !byKey.has(k)) byKey.set(k, row);
    }
  }

  const dates = rows.map((r) => r.date).sort();
  const from = new Date((dayNumber(dates[0]!) - FUZZY_DAYS) * 86_400_000).toISOString().slice(0, 10);
  const to = new Date((dayNumber(dates[dates.length - 1]!) + FUZZY_DAYS) * 86_400_000).toISOString().slice(0, 10);
  const amounts = [...new Set(keyed.map((k) => k.canonicalAmount))];
  const pr = await ex.execute(sql`SELECT ${ITEM_COLUMNS} FROM bank_feed_items
    WHERE tenant_id = ${tenantId} AND bank_connection_id IN ${conns}
      AND feed_date BETWEEN ${from}::date AND ${to}::date
      AND amount IN (SELECT x::numeric FROM jsonb_array_elements_text(${JSON.stringify(amounts)}::jsonb) AS x)`);
  for (const row of pr.rows as unknown as ItemRow[]) pool.push(toExisting(row));
  pool.sort(byAge);
  return { byFitid, byKey, pool };
}

async function sameFileImportedAt(ex: DbOrTx, tenantId: string, input: BatchInput): Promise<string | undefined> {
  const r = await ex.execute(sql`
    SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM bank_import_batches
    WHERE tenant_id = ${tenantId} AND account_id = ${input.accountId} AND source_file_sha256 = ${input.sourceFileSha256}
      AND section_index = ${input.sectionIndex} AND undone_at IS NULL
    ORDER BY created_at DESC LIMIT 1`);
  return (r.rows as Array<{ at: string }>)[0]?.at;
}

interface IdentityRow { id: string; bank_connection_id: string; account_id: string; account_name: string; mask: string }

async function readIdentity(ex: DbOrTx, tenantId: string, hash: string): Promise<IdentityRow | undefined> {
  const r = await ex.execute(sql`
    SELECT i.id, i.bank_connection_id, c.account_id, a.name AS account_name, i.mask
    FROM bank_connection_identities i
    JOIN bank_connections c ON c.id = i.bank_connection_id AND c.tenant_id = i.tenant_id
    JOIN accounts a ON a.id = c.account_id AND a.tenant_id = c.tenant_id
    WHERE i.tenant_id = ${tenantId} AND i.account_key_hash = ${hash}`);
  return (r.rows as unknown as IdentityRow[])[0];
}

// ─── Balance check ───────────────────────────────────────────────────

async function balanceCheck(
  ex: DbOrTx, tenantId: string, account: { id: string; kind: AccountKind }, connIds: string[], input: BatchInput,
  rows: ReadonlyArray<BatchRowInput>, keyed: ReadonlyArray<KeyedRow>, classified: ReadonlyArray<Classified>,
): Promise<BalanceCheck | undefined> {
  if (input.fileEndingBalance == null || !input.fileEndingDate) return undefined;
  const fileDate = input.fileEndingDate;
  const conns = uuidList(connIds.length > 0 ? connIds : ['00000000-0000-0000-0000-000000000000']);

  const books = await ex.execute(sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text AS bal
    FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = jl.tenant_id
    WHERE jl.tenant_id = ${tenantId} AND jl.account_id = ${account.id} AND t.status = 'posted' AND t.txn_date <= ${fileDate}::date`);
  const debitBalance = new Decimal((books.rows as Array<{ bal: string }>)[0]?.bal ?? '0');
  // A card's books and projection are amounts owed (credit balance).
  const booksAtDate = account.kind === 'bank' ? debitBalance : debitBalance.neg();

  const pendingRows = await ex.execute(sql`
    SELECT id, feed_date::text AS feed_date, amount::text AS amount, check_number FROM bank_feed_items
    WHERE tenant_id = ${tenantId} AND bank_connection_id IN ${conns}
      AND status IN ('pending', 'assigned', 'categorizing') AND feed_date <= ${fileDate}::date`);
  const pending = pendingRows.rows as Array<{ id: string; feed_date: string; amount: string; check_number: number | null }>;
  const pendingTotal = pending.reduce((s, p) => s.plus(p.amount), new Decimal(0));

  const added = rows
    .map((r, i) => ({ r, k: keyed[i]!, c: classified[i]! }))
    .filter(({ r, c }) => r.date <= fileDate && wouldInsert(r, c));
  const newTotal = added.reduce((s, a) => s.plus(a.k.canonicalAmount), new Decimal(0));

  // likelyInBooks: new and pending rows matching an uncleared register line
  // of the account (money out = credit - debit for a bank and a card alike)
  // by check number, or by amount within LIKELY_DAYS. Each line counts once.
  const candidates = [
    ...added.map(({ r, k }) => ({ date: r.date, amount: k.canonicalAmount, checkNumber: r.checkNumber ?? null })),
    ...pending.map((p) => ({ date: p.feed_date, amount: p.amount, checkNumber: p.check_number })),
  ];
  let likelyCount = 0;
  let likelyTotal = new Decimal(0);
  if (candidates.length > 0) {
    const dates = candidates.map((c) => c.date).sort();
    const from = new Date((dayNumber(dates[0]!) - LIKELY_DAYS) * 86_400_000).toISOString().slice(0, 10);
    const reg = await ex.execute(sql`
      SELECT jl.id, t.txn_date::text AS txn_date, (jl.credit - jl.debit)::text AS out, t.check_number
      FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = jl.tenant_id
      WHERE jl.tenant_id = ${tenantId} AND jl.account_id = ${account.id} AND t.status = 'posted'
        AND t.txn_date BETWEEN ${from}::date AND (${fileDate}::date + ${LIKELY_DAYS}::int)
        AND NOT EXISTS (SELECT 1 FROM bank_feed_items b WHERE b.tenant_id = t.tenant_id AND b.matched_transaction_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM reconciliation_lines rl WHERE rl.journal_line_id = jl.id AND rl.is_cleared = true)
      ORDER BY t.txn_date, jl.id
      LIMIT 50000`);
    const lines = (reg.rows as Array<{ id: string; txn_date: string; out: string; check_number: number | null }>)
      .map((l) => ({ ...l, outDec: new Decimal(l.out) }));
    const claimed = new Set<string>();
    for (const c of candidates) {
      const amt = new Decimal(c.amount);
      const hit = (c.checkNumber != null ? lines.find((l) => !claimed.has(l.id) && l.check_number === c.checkNumber) : undefined)
        ?? lines.find((l) => !claimed.has(l.id) && l.outDec.eq(amt) && dayDiff(l.txn_date, c.date) <= LIKELY_DAYS);
      if (hit) {
        claimed.add(hit.id);
        likelyCount++;
        likelyTotal = likelyTotal.plus(amt);
      }
    }
  }

  const fileBalance = new Decimal(input.fileEndingBalance);
  const expected = account.kind === 'bank' ? fileBalance : fileBalance.neg();
  const projected = account.kind === 'bank'
    ? booksAtDate.minus(pendingTotal).minus(newTotal)
    : booksAtDate.plus(pendingTotal).plus(newTotal);
  return {
    fileBalance: fileBalance.toFixed(2),
    fileDate,
    booksAtDate: booksAtDate.toFixed(2),
    pendingTotal: pendingTotal.toFixed(2),
    newTotal: newTotal.toFixed(2),
    likelyInBooks: { count: likelyCount, total: likelyTotal.toFixed(2) },
    projected: projected.toFixed(2),
    difference: expected.minus(projected).toFixed(2),
  };
}

// ─── The batch ───────────────────────────────────────────────────────

function counts(rows: RowResult[]): BatchResult['counts'] {
  return {
    inFile: rows.length,
    new: rows.filter((r) => r.status === 'new').length,
    duplicate: rows.filter((r) => r.status === 'duplicate').length,
    possibleDuplicate: rows.filter((r) => r.status === 'possible_duplicate').length,
    changed: rows.filter((r) => r.status === 'changed').length,
    closedPeriod: rows.filter((r) => r.closedPeriod).length,
    inserted: rows.filter((r) => r.inserted).length,
  };
}

function rowResult(row: BatchRowInput, c: Classified, lockDate: string | null): RowResult {
  return {
    line: row.line,
    status: c.status,
    ...(c.reason ? { reason: c.reason } : {}),
    ...(c.existing ? {
      existingItemId: c.existing.id,
      existingImportedAt: c.existing.createdAt,
      existingPending: c.existing.status === 'pending' || c.existing.status === 'assigned',
    } : {}),
    closedPeriod: lockDate !== null && row.date <= lockDate,
    inserted: false,
  };
}

export interface BatchActor { tenantId: string; companyId?: string; userId?: string }

/** Dry run: the preview. Reads only; no lock, no key, no rows, no audit. */
export async function previewBatch(actor: BatchActor, input: BatchInput): Promise<BatchResult> {
  validateBatch(input);
  const account = await readAccount(db, actor.tenantId, actor.companyId, input.accountId);
  const conns = (await accountConnections(db, actor.tenantId, input.accountId)).map((c) => c.id);
  const lockDate = await readLockDate(db, actor.tenantId, actor.companyId ?? account.company_id);
  const keyed = keyRows(input.rows);
  const { byFitid, byKey, pool } = await lookups(db, actor.tenantId, conns, input.rows, keyed);
  const classified = classifyRows(input.rows, keyed, byFitid, byKey, pool, { start: input.sectionStart, end: input.sectionEnd });
  const rows = input.rows.map((r, i) => rowResult(r, classified[i]!, lockDate));
  const identity = input.bankIdentity ? await readIdentity(db, actor.tenantId, input.bankIdentity.accountKeyHash) : undefined;
  const sameFile = await sameFileImportedAt(db, actor.tenantId, input);
  const balance = await balanceCheck(db, actor.tenantId, account, conns, input, input.rows, keyed, classified);
  return {
    ...(sameFile ? { sameFileImportedAt: sameFile } : {}),
    ...(identity && identity.account_id !== input.accountId
      ? { identityLinkedElsewhere: { accountName: identity.account_name, mask: identity.mask } } : {}),
    insertedItemIds: [],
    rows,
    counts: counts(rows),
    insertedTotal: '0.00',
    ...(balance ? { balanceCheck: balance } : {}),
  };
}

/**
 * Commit. One database transaction under the (tenant, account) advisory
 * lock; claims the request's Idempotency-Key. Post-processing is scheduled
 * after the commit (schedulePostProcessing).
 */
export async function commitBatch(actor: BatchActor, input: BatchInput): Promise<BatchResult> {
  validateBatch(input);
  const { tenantId } = actor;
  const batchId = randomUUID();
  const keyed = keyRows(input.rows);

  const result = await db.transaction(async (tx) => {
    const account = await readAccount(tx, tenantId, actor.companyId, input.accountId);
    // Serializes imports into one account (also the first one, before a
    // connection exists) without a row lock on the account, so postings
    // that update accounts.balance keep running.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bank-import:${tenantId}:${input.accountId}`}, 0))`);
    await claimAndRecord(tx, 'bank_import_batch', batchId);

    const companyId = account.company_id ?? actor.companyId ?? null;
    let conns = await accountConnections(tx, tenantId, input.accountId);
    let conn = conns.find((c) => c.provider === 'manual');
    if (!conn) {
      const [created] = await tx.insert(bankConnections).values({
        tenantId, companyId, accountId: input.accountId, provider: 'manual', institutionName: 'File Import', syncStatus: 'active',
      }).returning({ id: bankConnections.id, provider: bankConnections.provider });
      conn = created!;
      conns = [...conns, conn];
    }
    const connIds = conns.map((c) => c.id);

    if (input.bankIdentity) await linkIdentity(tx, actor, conn.id, input);

    const lockDate = await readLockDate(tx, tenantId, actor.companyId ?? account.company_id);
    const { byFitid, byKey, pool } = await lookups(tx, tenantId, connIds, input.rows, keyed);
    const classified = classifyRows(input.rows, keyed, byFitid, byKey, pool, { start: input.sectionStart, end: input.sectionEnd });
    const rows = input.rows.map((r, i) => rowResult(r, classified[i]!, lockDate));
    // Before the insert: pending items exclude this batch's rows.
    const balance = await balanceCheck(tx, tenantId, account, connIds, input, input.rows, keyed, classified);
    const sameFile = await sameFileImportedAt(tx, tenantId, input);

    await tx.insert(bankImportBatches).values({
      id: batchId, tenantId, companyId, bankConnectionId: conn.id, accountId: input.accountId, format: input.format,
      fileName: input.fileName.slice(0, 255), sourceFileSha256: input.sourceFileSha256, sectionIndex: input.sectionIndex,
      sectionStart: input.sectionStart ?? null, sectionEnd: input.sectionEnd ?? null, amountsFlipped: input.amountsFlipped,
      csvMapping: input.csvMapping ?? null, rowsInFile: input.rows.length,
      fileEndingBalance: input.fileEndingBalance ?? null, fileEndingDate: input.fileEndingDate ?? null,
      postProcessing: 'scheduled', createdBy: actor.userId ?? null,
    });

    // Insert the new rows (chunks of INSERT_CHUNK).
    const toInsert: Array<{ i: number; values: typeof bankFeedItems.$inferInsert }> = [];
    input.rows.forEach((row, i) => {
      const c = classified[i]!;
      if (!wouldInsert(row, c)) return;
      toInsert.push({
        i,
        values: {
          tenantId, companyId, bankConnectionId: conn!.id,
          providerTransactionId: c.fitidUsed,
          feedDate: row.date,
          description: row.description,
          originalDescription: row.description,
          amount: keyed[i]!.canonicalAmount,
          memo: row.memo ?? null,
          checkNumber: row.checkNumber ?? null,
          status: 'pending',
          importBatchId: batchId,
          dedupeKey: c.dedupeKey,
          rowKey: keyed[i]!.rowKey,
          dedupeVersion: DEDUPE_VERSION,
          sourceLine: row.line,
        },
      });
    });
    const insertedIds: string[] = [];
    let insertedTotal = new Decimal(0);
    for (let s = 0; s < toInsert.length; s += INSERT_CHUNK) {
      const chunk = toInsert.slice(s, s + INSERT_CHUNK);
      // The lock serializes batches; ON CONFLICT covers another path (the
      // legacy /feed/import, a Plaid sync) inserting the same bank id.
      const got = await tx.insert(bankFeedItems).values(chunk.map((c) => c.values)).onConflictDoNothing()
        .returning({ id: bankFeedItems.id, dedupeKey: bankFeedItems.dedupeKey });
      const byDedupe = new Map(got.map((g) => [g.dedupeKey!.trim(), g.id]));
      for (const c of chunk) {
        const id = byDedupe.get(c.values.dedupeKey!);
        if (!id) continue;
        insertedIds.push(id);
        rows[c.i]!.inserted = true;
        insertedTotal = insertedTotal.plus(keyed[c.i]!.canonicalAmount);
      }
    }

    // `changed` rows with "replace": update the existing item while it is
    // pending and untouched (not assigned, not matched), audited.
    for (let i = 0; i < input.rows.length; i++) {
      const row = input.rows[i]!;
      const c = classified[i]!;
      if (c.status !== 'changed' || row.changedAction !== 'replace' || !c.existing) continue;
      const [before] = await tx.select().from(bankFeedItems)
        .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, c.existing.id))).for('update');
      if (!before || before.status !== 'pending' || before.assignedAt || before.matchedTransactionId) {
        rows[i]!.replaced = false;
        continue;
      }
      const [after] = await tx.update(bankFeedItems).set({
        amount: keyed[i]!.canonicalAmount, feedDate: row.date, importBatchId: batchId, sourceLine: row.line, updatedAt: new Date(),
      }).where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, c.existing.id))).returning();
      await auditLog(tenantId, 'update', 'bank_feed', c.existing.id,
        { amount: before.amount, feedDate: before.feedDate }, { amount: after!.amount, feedDate: after!.feedDate, importBatchId: batchId },
        actor.userId, tx);
      rows[i]!.replaced = true;
    }

    const out: BatchResult = {
      batchId,
      ...(sameFile ? { sameFileImportedAt: sameFile } : {}),
      insertedItemIds: insertedIds,
      postProcessing: 'scheduled',
      rows,
      counts: counts(rows),
      insertedTotal: insertedTotal.toFixed(2),
      ...(balance ? { balanceCheck: balance } : {}),
    };
    const c = out.counts;
    await tx.update(bankImportBatches).set({
      newCount: c.new, duplicateCount: c.duplicate, possibleDuplicateCount: c.possibleDuplicate, changedCount: c.changed,
      closedPeriodCount: c.closedPeriod, insertedCount: c.inserted, insertedTotal: out.insertedTotal, result: out,
      ...(insertedIds.length === 0 ? { postProcessing: 'done' } : {}),
    }).where(eq(bankImportBatches.id, batchId));
    if (insertedIds.length === 0) out.postProcessing = 'done';
    // Counts only: no names, amounts or memo text in the audit trail.
    await auditLog(tenantId, 'create', 'bank_import_batch', batchId, null, {
      accountId: input.accountId, format: input.format, counts: c,
    }, actor.userId, tx);
    return out;
  });
  return result;
}

async function linkIdentity(tx: Tx, actor: BatchActor, connectionId: string, input: BatchInput): Promise<void> {
  const ident = input.bankIdentity!;
  const existing = await readIdentity(tx, actor.tenantId, ident.accountKeyHash);
  if (!existing) {
    const [row] = await tx.insert(bankConnectionIdentities).values({
      tenantId: actor.tenantId, bankConnectionId: connectionId, mask: ident.mask, accountKeyHash: ident.accountKeyHash,
      createdBy: actor.userId ?? null,
    }).returning({ id: bankConnectionIdentities.id });
    await auditLog(actor.tenantId, 'create', 'bank_connection_identity', row!.id, null,
      { mask: ident.mask, accountId: input.accountId }, actor.userId, tx);
    return;
  }
  if (existing.account_id !== input.accountId) {
    if (!input.relinkIdentity) {
      throw AppError.conflict('This bank account is already linked to another account in the books.', 'identity_linked_elsewhere', {
        accountName: existing.account_name, mask: existing.mask,
      });
    }
    await tx.update(bankConnectionIdentities).set({ bankConnectionId: connectionId, mask: ident.mask, updatedAt: new Date() })
      .where(eq(bankConnectionIdentities.id, existing.id));
    await auditLog(actor.tenantId, 'update', 'bank_connection_identity', existing.id,
      { mask: existing.mask, accountId: existing.account_id }, { mask: ident.mask, accountId: input.accountId }, actor.userId, tx);
    return;
  }
  if (existing.bank_connection_id !== connectionId || existing.mask !== ident.mask) {
    await tx.update(bankConnectionIdentities).set({ bankConnectionId: connectionId, mask: ident.mask, updatedAt: new Date() })
      .where(eq(bankConnectionIdentities.id, existing.id));
  }
}

/** The stored response of a committed batch (Idempotency-Key replay). */
export async function readBatchResult(tenantId: string, batchId: string): Promise<BatchResult> {
  const [b] = await db.select({ result: bankImportBatches.result }).from(bankImportBatches)
    .where(and(eq(bankImportBatches.tenantId, tenantId), eq(bankImportBatches.id, batchId)));
  if (!b?.result) throw AppError.notFound('Import batch not found');
  return b.result as BatchResult;
}

// ─── Post-processing ─────────────────────────────────────────────────

/**
 * After the commit: deterministic cleansing (no LLM), the rule stages
 * without posting, potential-match detection and the classification state
 * (bank-feed.service pipelines with { llm: false, autoConfirm: false }).
 * Sets the batch's post_processing to done or failed. The A05 hook.
 */
export async function runImportPostProcessing(tenantId: string, batchId: string): Promise<'done' | 'failed'> {
  const bankFeed = await import('../bank-feed.service.js');
  let state: 'done' | 'failed' = 'done';
  try {
    const items = await db.select().from(bankFeedItems)
      .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.importBatchId, batchId)));
    if (items.length > 0) {
      await bankFeed.runCleansingPipeline(tenantId, items, { llm: false });
      await bankFeed.runCategorizationPipeline(tenantId, items, { llm: false, autoConfirm: false });
    }
  } catch (err) {
    state = 'failed';
    console.warn(`[bank-import] post-processing failed for batch ${batchId}:`, err instanceof Error ? err.message : String(err));
  }
  await db.update(bankImportBatches).set({ postProcessing: state })
    .where(and(eq(bankImportBatches.tenantId, tenantId), eq(bankImportBatches.id, batchId)));
  return state;
}

/** Test hook: the promise of the last scheduled post-processing run. */
export const __postProcessing: { last: Promise<unknown> | null } = { last: null };

/** Runs post-processing detached, outside the request's idempotency context. */
export function schedulePostProcessing(tenantId: string, batchId: string): void {
  __postProcessing.last = runWithoutIdempotency(() => new Promise<void>((resolve) => {
    setImmediate(() => {
      void runImportPostProcessing(tenantId, batchId).catch(() => undefined).finally(resolve);
    });
  }));
}

/** On engine start: batches left `scheduled` (a crash or restart) run again. */
export async function resumeScheduledPostProcessing(): Promise<number> {
  const rows = await db.select({ id: bankImportBatches.id, tenantId: bankImportBatches.tenantId })
    .from(bankImportBatches).where(eq(bankImportBatches.postProcessing, 'scheduled'))
    .orderBy(bankImportBatches.createdAt).limit(500);
  for (const r of rows) await runImportPostProcessing(r.tenantId, r.id);
  return rows.length;
}

// ─── Undo, list, lookup ──────────────────────────────────────────────

/**
 * Undo a batch: removes its untouched pending rows (pending, never assigned
 * or matched). Rows already used block it (409 rows_already_used with their
 * lines) unless `pendingOnly`. 409 still_preparing while post-processing
 * runs; 409 already_undone. Audited (counts only).
 */
export async function undoBatch(actor: BatchActor, batchId: string, pendingOnly: boolean) {
  const { tenantId } = actor;
  return db.transaction(async (tx) => {
    const [batch] = await tx.select().from(bankImportBatches)
      .where(and(eq(bankImportBatches.tenantId, tenantId), eq(bankImportBatches.id, batchId))).for('update');
    if (!batch || (actor.companyId && batch.companyId && batch.companyId !== actor.companyId)) {
      throw AppError.notFound('Import batch not found');
    }
    if (batch.undoneAt) throw AppError.conflict('This import was already undone.', 'already_undone');
    if (batch.postProcessing === 'scheduled') {
      throw AppError.conflict('This import is still being prepared. Try again in a moment.', 'still_preparing');
    }
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bank-import:${tenantId}:${batch.accountId}`}, 0))`);
    await claimAndRecord(tx, 'bank_import_batch', batchId);
    const items = await tx.select({
      id: bankFeedItems.id, status: bankFeedItems.status, assignedAt: bankFeedItems.assignedAt,
      matchedTransactionId: bankFeedItems.matchedTransactionId, sourceLine: bankFeedItems.sourceLine,
    }).from(bankFeedItems)
      .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.importBatchId, batchId))).for('update');
    const untouched = items.filter((i) => i.status === 'pending' && !i.assignedAt && !i.matchedTransactionId);
    const used = items.filter((i) => !untouched.includes(i));
    if (used.length > 0 && !pendingOnly) {
      throw AppError.conflict('Some rows of this import were already used.', 'rows_already_used', {
        lines: used.map((i) => i.sourceLine).filter((l): l is number => l !== null).sort((a, b) => a - b),
      });
    }
    if (untouched.length > 0) {
      await tx.delete(bankFeedItems).where(and(
        eq(bankFeedItems.tenantId, tenantId),
        sql`${bankFeedItems.id} IN ${uuidList(untouched.map((i) => i.id))}`,
      ));
    }
    const undoneAt = new Date();
    await tx.update(bankImportBatches).set({ undoneAt, undoneBy: actor.userId ?? null }).where(eq(bankImportBatches.id, batchId));
    await auditLog(tenantId, 'delete', 'bank_import_batch', batchId, null, {
      removed: untouched.length, kept: used.length, pendingOnly,
    }, actor.userId, tx);
    return { batchId, removed: untouched.length, kept: used.length, undoneAt: undoneAt.toISOString() };
  });
}

export async function listBatches(actor: BatchActor, filters: { accountId?: string; format?: BatchFormat; limit?: number }) {
  const conds = [eq(bankImportBatches.tenantId, actor.tenantId)];
  if (actor.companyId) conds.push(sql`(${bankImportBatches.companyId} = ${actor.companyId} OR ${bankImportBatches.companyId} IS NULL)`);
  if (filters.accountId) conds.push(eq(bankImportBatches.accountId, filters.accountId));
  if (filters.format) conds.push(eq(bankImportBatches.format, filters.format));
  const rows = await db.select().from(bankImportBatches).where(and(...conds))
    .orderBy(sql`${bankImportBatches.createdAt} DESC`).limit(Math.min(filters.limit ?? 50, 200));
  return rows.map((b) => ({
    id: b.id,
    accountId: b.accountId,
    bankConnectionId: b.bankConnectionId,
    format: b.format,
    fileName: b.fileName,
    sourceFileSha256: b.sourceFileSha256,
    sectionIndex: b.sectionIndex,
    sectionStart: b.sectionStart,
    sectionEnd: b.sectionEnd,
    amountsFlipped: b.amountsFlipped,
    csvMapping: b.csvMapping,
    fileEndingBalance: b.fileEndingBalance === null ? null : new Decimal(b.fileEndingBalance).toFixed(2),
    fileEndingDate: b.fileEndingDate,
    counts: {
      inFile: b.rowsInFile, new: b.newCount, duplicate: b.duplicateCount, possibleDuplicate: b.possibleDuplicateCount,
      changed: b.changedCount, closedPeriod: b.closedPeriodCount, inserted: b.insertedCount,
    },
    insertedTotal: new Decimal(b.insertedTotal).toFixed(2),
    postProcessing: b.postProcessing,
    undoneAt: b.undoneAt ? b.undoneAt.toISOString() : null,
    createdAt: b.createdAt.toISOString(),
  }));
}

/** Connections whose saved identity has this hash (first), else this mask. */
export async function lookupConnections(actor: BatchActor, q: { accountKeyHash?: string; mask?: string }) {
  const companyClause = actor.companyId ? sql`AND (a.company_id = ${actor.companyId} OR a.company_id IS NULL)` : sql``;
  if (q.accountKeyHash) {
    const r = await db.execute(sql`
      SELECT c.id AS connection_id, c.account_id, a.name AS account_name, i.mask
      FROM bank_connection_identities i
      JOIN bank_connections c ON c.id = i.bank_connection_id AND c.tenant_id = i.tenant_id
      JOIN accounts a ON a.id = c.account_id AND a.tenant_id = c.tenant_id
      WHERE i.tenant_id = ${actor.tenantId} AND i.account_key_hash = ${q.accountKeyHash} ${companyClause}`);
    const rows = r.rows as Array<{ connection_id: string; account_id: string; account_name: string; mask: string }>;
    if (rows.length > 0 || !q.mask) {
      return rows.map((x) => ({ connectionId: x.connection_id, accountId: x.account_id, accountName: x.account_name, mask: x.mask, via: 'hash' as const }));
    }
  }
  if (!q.mask) return [];
  const r = await db.execute(sql`
    SELECT DISTINCT ON (c.id) c.id AS connection_id, c.account_id, a.name AS account_name, COALESCE(i.mask, c.mask) AS mask
    FROM bank_connections c
    JOIN accounts a ON a.id = c.account_id AND a.tenant_id = c.tenant_id
    LEFT JOIN bank_connection_identities i ON i.bank_connection_id = c.id AND i.tenant_id = c.tenant_id AND i.mask = ${q.mask}
    WHERE c.tenant_id = ${actor.tenantId} AND (i.id IS NOT NULL OR c.mask = ${q.mask}) ${companyClause}
    ORDER BY c.id`);
  return (r.rows as Array<{ connection_id: string; account_id: string; account_name: string; mask: string }>)
    .map((x) => ({ connectionId: x.connection_id, accountId: x.account_id, accountName: x.account_name, mask: x.mask, via: 'mask' as const }));
}
