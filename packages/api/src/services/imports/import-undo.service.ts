// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Undo of a committed Bulk Import batch (U-261; review B2). A HARD delete:
 * no row the batch created survives, and nothing is left pointing at one
 * (outside the audit trail and the trigger-written bookkeeping tables, see
 * TRIGGER_WRITTEN_TABLES: the desktop change feed keeps naming deleted ids).
 *
 * Inside the undo transaction:
 *   1. the batch's transactions are locked FOR UPDATE;
 *   2. blockers are collected (findUndoBlockers). Any blocker refuses the
 *      undo with 409 IMPORT_UNDO_BLOCKED {blockers:[{kind,id,reason}]};
 *   3. rows are deleted in reverse dependency order: dead links (voided
 *      payment applications, links from void or deleted transactions to
 *      the batch's documents), posting artifacts, the journal lines and
 *      transactions (stored balances moved back exactly), then items,
 *      contacts, tags, tag groups and accounts;
 *   4. prior_values are restored (changed accounts, the fiscal year month);
 *   5. one audit row per deleted record with its before-image, plus one row
 *      for the batch.
 *
 * Blockers are found by a sweep, not a hand list: every uuid column named
 * *_id (and the attachments pointer) of every table is searched for the ids
 * the batch created. A hit on a row the batch does not own is a blocker
 * unless OWNED_ARTIFACTS or the dead-link rules below say otherwise. A new
 * table that points at a transaction therefore blocks undo until it is
 * classified here: fail closed.
 *
 * Decision recorded for the owner (P31 E1): a surviving row that points at
 * a batch-created account, contact, item or tag blocks the undo even when
 * that row is a void or deleted transaction (for example a voided payment
 * on an imported invoice whose customer the batch created). Deleting or
 * rewriting records the batch did not create is not done here; see
 * deadTransactionsBlock().
 */

import { sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import type { Tx, DbOrTx } from '../../db/index.js';

const Decimal = DecimalLib.default || DecimalLib;

/** A Postgres array literal for an id list, passed as ONE parameter (drizzle spreads a JS array into several). */
export function pgArray(ids: readonly string[]): string {
  return `{${ids.join(',')}}`;
}
type Dec = InstanceType<typeof Decimal>;

export interface UndoBlocker {
  /** `table.column` of the pointing row, or a named check (edited, changed_since, inventory_used). */
  kind: string;
  /** The pointing row (or the batch row that was changed). */
  id: string;
  /** Plain reason code: reconciled, deposited, payment_applied, bill_paid, credit_applied, bank_match, tax_filed, billed, used_by_other_transaction, used_by_void_transaction, edited, changed_since, inventory_used, payroll, attached, linked. */
  reason: string;
  /** The batch row it points at. */
  target?: string;
}

export interface CreatedSets {
  txns: string[];
  lines: string[];
  accounts: string[];
  contacts: string[];
  items: string[];
  tags: string[];
  tagGroups: string[];
}

/** What the batch posted, as stamped at the end of its commit (prior_values.stamps). */
export interface CommitStamps {
  /** Latest journal_lines.created_at of the batch's transactions (database clock). */
  linesCreatedMax?: string | null;
  /** Latest updated_at per created table. */
  updatedMax?: Record<string, string | null>;
  /** Changed (not created) accounts as the batch left them. */
  accountsAfter?: Record<string, { name: string; accountType: string; detailType: string | null; description: string | null; parentId: string | null }>;
}

export const CREATED_TABLES = ['transactions', 'accounts', 'contacts', 'items', 'tags', 'tag_groups'] as const;

export async function loadCreatedSets(ex: DbOrTx, tenantId: string, batchId: string, lock = false): Promise<CreatedSets> {
  const ids = async (table: string, forUpdate = false) => ((await ex.execute(sql.raw(
    `SELECT id::text AS id FROM ${table} WHERE tenant_id = '${tenantId}' AND import_batch_id = '${batchId}' ORDER BY id${forUpdate ? ' FOR UPDATE' : ''}`,
  ))).rows as Array<{ id: string }>).map((r) => r.id);
  const txns = await ids('transactions', lock);
  const lines = txns.length === 0 ? [] : ((await ex.execute(sql`
    SELECT id::text AS id FROM journal_lines WHERE tenant_id = ${tenantId} AND transaction_id = ANY(${pgArray(txns)}::uuid[])`)).rows as Array<{ id: string }>).map((r) => r.id);
  // P31 review S5: with `lock`, the master records the batch created are locked too, before the
  // blocker sweep. A posting updates its accounts' stored balance (and a tag is a foreign key), so a
  // posting on one of them waits for the undo: it either committed first (the sweep sees it) or
  // finds the account gone (updateAccountBalances refuses). Contacts and items have no foreign keys;
  // the lock does not stop a posting on them.
  return {
    txns, lines,
    accounts: await ids('accounts', lock), contacts: await ids('contacts', lock), items: await ids('items', lock),
    tags: await ids('tags', lock), tagGroups: await ids('tag_groups', lock),
  };
}

/**
 * Rows that only exist because of a posting (artifacts) and go with the
 * batch's transactions: `table` rows whose `column` is a batch transaction.
 */
const OWNED_ARTIFACTS: Record<string, string> = {
  journal_lines: 'transaction_id',
  transaction_tags: 'transaction_id',
  transaction_tax_lines: 'transaction_id',
  inventory_movements: 'transaction_id',
  transaction_classification_state: 'transaction_id',
  findings: 'transaction_id',
  conditional_rule_audit: 'transaction_id',
  rule_exception_dismissals: 'transaction_id',
  tax_est_transaction_flags: 'transaction_id',
};

/**
 * Tables only database triggers write (bookkeeping, not activity): the desktop
 * change feed (U-294, 0289) and the ledger version counters (0144, 0277). A
 * row there records that a record was written, never that someone used it, so
 * it never blocks an undo and is never a pointer left behind: the undo's own
 * deletes add feed rows naming the deleted ids, as they should. Pinned against
 * the live trigger functions by imports-undo-feed.routes.test.ts: a new table a
 * trigger writes fails there until it is listed here (or classified as real
 * activity).
 */
export const TRIGGER_WRITTEN_TABLES: ReadonlySet<string> = new Set(['change_feed', 'change_feed_state', 'gl_version_stamps']);

/** Tables never searched: they record history about ids, are the import's own bookkeeping, or only triggers write them. */
const SWEEP_SKIP_TABLES = new Set(['audit_log', 'idempotency_keys', 'import_batches', 'import_sessions', 'import_rows', ...TRIGGER_WRITTEN_TABLES]);
/** Columns that never hold a batch-created id (tenant, company, user and actor columns). */
const SWEEP_SKIP_COLUMN = /^(tenant_id|company_id|user_id|.*_user_id|created_by|updated_by|.*_by)$/;

const REASONS: Record<string, string> = {
  reconciliation_lines: 'reconciled',
  reconciliations: 'reconciled',
  deposit_lines: 'deposited',
  payment_applications: 'payment_applied',
  bill_payment_applications: 'bill_paid',
  vendor_credit_applications: 'credit_applied',
  bank_feed_items: 'bank_match',
  bank_statement_lines: 'bank_match',
  bank_feed_accept_group_items: 'bank_match',
  sales_tax_payment_lines: 'tax_filed',
  sales_tax_payments: 'tax_filed',
  billable_cost_links: 'billed',
  journal_lines: 'used_by_other_transaction',
  transactions: 'used_by_other_transaction',
  payroll_import_sessions: 'payroll',
  payroll_check_register_rows: 'payroll',
  attachments: 'attached',
};

interface SweepColumn { table: string; column: string; hasTenant: boolean; hasId: boolean; hasBatch: boolean; hasTxn: boolean }

let sweepCache: SweepColumn[] | null = null;

/** Every uuid `*_id` column (plus attachments.attachable_id) the sweep reads. Cached per process. */
export async function sweepColumns(ex: DbOrTx): Promise<SweepColumn[]> {
  if (sweepCache) return sweepCache;
  const r = await ex.execute(sql`
    SELECT c.table_name AS t, c.column_name AS c,
      EXISTS (SELECT 1 FROM information_schema.columns x WHERE x.table_schema = 'public' AND x.table_name = c.table_name AND x.column_name = 'tenant_id') AS has_tenant,
      EXISTS (SELECT 1 FROM information_schema.columns x WHERE x.table_schema = 'public' AND x.table_name = c.table_name AND x.column_name = 'id') AS has_id,
      EXISTS (SELECT 1 FROM information_schema.columns x WHERE x.table_schema = 'public' AND x.table_name = c.table_name AND x.column_name = 'import_batch_id') AS has_batch,
      EXISTS (SELECT 1 FROM information_schema.columns x WHERE x.table_schema = 'public' AND x.table_name = c.table_name AND x.column_name = 'transaction_id') AS has_txn
    FROM information_schema.columns c JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.data_type = 'uuid' AND c.column_name LIKE '%\\_id' ESCAPE '\\'
    ORDER BY 1, 2`);
  sweepCache = (r.rows as Array<{ t: string; c: string; has_tenant: boolean; has_id: boolean; has_batch: boolean; has_txn: boolean }>)
    .filter((x) => !SWEEP_SKIP_TABLES.has(x.t) && !SWEEP_SKIP_COLUMN.test(x.c) && x.c !== 'import_batch_id')
    .map((x) => ({ table: x.t, column: x.c, hasTenant: x.has_tenant, hasId: x.has_id, hasBatch: x.has_batch, hasTxn: x.has_txn }));
  return sweepCache;
}

/** Test hook: forget the cached column list (a test that adds a table). */
export function __resetSweepCache(): void { sweepCache = null; }

/**
 * Whether a void or deleted transaction outside the batch that points at a
 * batch-created master record (account, contact, item, tag) blocks the
 * undo. The owner may later choose to remove such dead transactions with
 * the batch instead; that is a change to this one function.
 */
export function deadTransactionsBlock(): boolean {
  return true;
}

/** Statuses of transactions outside the batch, by id. */
async function statusesOf(ex: DbOrTx, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const r = await ex.execute(sql`SELECT id::text AS id, status FROM transactions WHERE tenant_id = ${tenantId} AND id = ANY(${pgArray(ids)}::uuid[])`);
  return new Map((r.rows as Array<{ id: string; status: string }>).map((x) => [x.id, x.status]));
}

const DEAD = new Set(['void', 'deleted']);

/** Dead links: rows deleted with the batch although the batch did not create them. */
export interface DeadLinks {
  paymentApplications: string[];
  billPaymentApplications: string[];
  vendorCreditApplications: string[];
  depositLines: string[];
  taxLines: string[];
  /** journal_lines of void or deleted transactions whose source_transaction_id names a batch document: set NULL. */
  settlementLines: string[];
}

/**
 * Applications and deposit lines between a batch document and a payment
 * (or deposit) outside the batch. Live ones are blockers; dead ones (the
 * application voided, or the other transaction void or deleted) are
 * deleted with the batch, and the voided payment itself stays (net zero).
 */
async function linkRows(ex: DbOrTx, tenantId: string, T: string[], blockers: UndoBlocker[]): Promise<DeadLinks> {
  const dead: DeadLinks = { paymentApplications: [], billPaymentApplications: [], vendorCreditApplications: [], depositLines: [], taxLines: [], settlementLines: [] };
  if (T.length === 0) return dead;
  const inT = new Set(T);

  const pa = (await ex.execute(sql`
    SELECT id::text, payment_id::text, invoice_id::text, applied_in_txn_id::text, voided_at IS NOT NULL AS voided, reversed_by_txn_id::text AS reversed
    FROM payment_applications WHERE tenant_id = ${tenantId}
      AND (payment_id = ANY(${pgArray(T)}::uuid[]) OR invoice_id = ANY(${pgArray(T)}::uuid[]) OR applied_in_txn_id = ANY(${pgArray(T)}::uuid[]))`)).rows as Array<{
    id: string; payment_id: string; invoice_id: string; applied_in_txn_id: string | null; voided: boolean; reversed: string | null }>;
  for (const a of pa) {
    if (inT.has(a.payment_id) && inT.has(a.invoice_id)) continue; // inside the batch
    if (a.voided && !a.reversed) dead.paymentApplications.push(a.id);
    else blockers.push({ kind: 'payment_applications.payment_id', id: a.id, reason: 'payment_applied', target: inT.has(a.invoice_id) ? a.invoice_id : a.payment_id });
  }

  const bpa = (await ex.execute(sql`
    SELECT id::text, payment_id::text, bill_id::text FROM bill_payment_applications
    WHERE tenant_id = ${tenantId} AND (payment_id = ANY(${pgArray(T)}::uuid[]) OR bill_id = ANY(${pgArray(T)}::uuid[]))`)).rows as Array<{ id: string; payment_id: string; bill_id: string }>;
  const vca = (await ex.execute(sql`
    SELECT id::text, payment_id::text, credit_id::text, bill_id::text FROM vendor_credit_applications
    WHERE tenant_id = ${tenantId} AND (payment_id = ANY(${pgArray(T)}::uuid[]) OR credit_id = ANY(${pgArray(T)}::uuid[]) OR bill_id = ANY(${pgArray(T)}::uuid[]))`)).rows as Array<{ id: string; payment_id: string; credit_id: string; bill_id: string }>;
  const dl = (await ex.execute(sql`
    SELECT id::text, deposit_id::text, source_transaction_id::text FROM deposit_lines
    WHERE deposit_id = ANY(${pgArray(T)}::uuid[]) OR source_transaction_id = ANY(${pgArray(T)}::uuid[])`)).rows as Array<{ id: string; deposit_id: string; source_transaction_id: string }>;
  const ttl = (await ex.execute(sql`
    SELECT id::text, transaction_id::text FROM transaction_tax_lines
    WHERE tenant_id = ${tenantId} AND invoice_id = ANY(${pgArray(T)}::uuid[]) AND NOT (transaction_id = ANY(${pgArray(T)}::uuid[]))`)).rows as Array<{ id: string; transaction_id: string }>;

  const others = new Set<string>();
  for (const a of bpa) others.add(a.payment_id);
  for (const a of vca) others.add(a.payment_id);
  for (const d of dl) others.add(d.deposit_id);
  for (const t of ttl) others.add(t.transaction_id);
  const status = await statusesOf(ex, tenantId, [...others].filter((x) => !inT.has(x)));
  const isDead = (id: string) => inT.has(id) || DEAD.has(status.get(id) ?? '');

  for (const a of bpa) {
    if (inT.has(a.payment_id) && inT.has(a.bill_id)) continue;
    if (isDead(a.payment_id)) dead.billPaymentApplications.push(a.id);
    else blockers.push({ kind: 'bill_payment_applications.payment_id', id: a.id, reason: 'bill_paid', target: a.bill_id });
  }
  for (const a of vca) {
    if (inT.has(a.payment_id) && inT.has(a.credit_id) && inT.has(a.bill_id)) continue;
    if (isDead(a.payment_id)) dead.vendorCreditApplications.push(a.id);
    else blockers.push({ kind: 'vendor_credit_applications.payment_id', id: a.id, reason: 'credit_applied', target: inT.has(a.credit_id) ? a.credit_id : a.bill_id });
  }
  for (const d of dl) {
    if (inT.has(d.deposit_id)) continue; // the batch's own deposit: its lines go with it
    if (isDead(d.deposit_id)) dead.depositLines.push(d.id);
    else blockers.push({ kind: 'deposit_lines.source_transaction_id', id: d.id, reason: 'deposited', target: d.source_transaction_id });
  }
  for (const t of ttl) {
    if (isDead(t.transaction_id)) dead.taxLines.push(t.id);
    else blockers.push({ kind: 'transaction_tax_lines.invoice_id', id: t.id, reason: 'payment_applied', target: t.transaction_id });
  }
  return dead;
}

/** Columns whose links linkRows() classifies; the sweep leaves them out (other columns of those tables are swept). */
const LINK_COLUMNS = new Set([
  'payment_applications.payment_id', 'payment_applications.invoice_id', 'payment_applications.applied_in_txn_id',
  'payment_applications.reversed_by_txn_id', 'bill_payment_applications.payment_id', 'bill_payment_applications.bill_id',
  'vendor_credit_applications.payment_id', 'vendor_credit_applications.credit_id', 'vendor_credit_applications.bill_id',
  'deposit_lines.deposit_id', 'deposit_lines.source_transaction_id', 'transaction_tax_lines.invoice_id',
]);

/**
 * Every blocker of undoing the batch. `dead` returns the rows deleted with
 * it although it did not create them. Read-only.
 */
export async function findUndoBlockers(
  ex: Tx,
  tenantId: string,
  batchId: string,
  created: CreatedSets,
  stamps: CommitStamps,
): Promise<{ blockers: UndoBlocker[]; dead: DeadLinks }> {
  const blockers: UndoBlocker[] = [];
  const T = created.txns;
  const inT = new Set(T);
  const dead = await linkRows(ex, tenantId, T, blockers);

  const all = [...created.txns, ...created.lines, ...created.accounts, ...created.contacts, ...created.items, ...created.tags, ...created.tagGroups];
  const masters = new Set([...created.accounts, ...created.contacts, ...created.items, ...created.tags, ...created.tagGroups]);
  if (all.length > 0) {
    // The ids to look for, in a temporary table of this transaction (a 50k-line batch would make an id list megabytes long).
    await ex.execute(sql.raw('CREATE TEMP TABLE IF NOT EXISTS undo_ids (id uuid PRIMARY KEY) ON COMMIT DROP'));
    await ex.execute(sql.raw('TRUNCATE pg_temp.undo_ids'));
    for (let i = 0; i < all.length; i += CHUNK) {
      const chunk = all.slice(i, i + CHUNK);
      await ex.execute(sql.raw(`INSERT INTO pg_temp.undo_ids (id) VALUES ${chunk.map((x) => `('${x}')`).join(',')} ON CONFLICT DO NOTHING`));
    }
    for (const col of await sweepColumns(ex)) {
      // Link columns linkRows() classified; the other columns of those tables are swept as any.
      if (LINK_COLUMNS.has(`${col.table}.${col.column}`)) continue;
      const pick = [
        `${col.column}::text AS ref`,
        col.hasId ? 'id::text AS rid' : 'NULL::text AS rid',
        col.hasTxn ? 'transaction_id::text AS txn' : 'NULL::text AS txn',
      ].join(', ');
      // Rows a table owns by transaction (artifacts, lines) belong to the batch when that transaction does.
      const ownerCol = OWNED_ARTIFACTS[col.table];
      const byTxn = col.table === 'journal_lines' || !!ownerCol;
      // Ownership is filtered in SQL BEFORE the limit: a batch that brought in the chart of accounts has
      // thousands of its own lines on those accounts, which must not hide one posting from outside.
      const where = [
        `${col.column} IN (SELECT id FROM pg_temp.undo_ids)`,
        col.hasTenant ? `tenant_id = '${tenantId}'` : null,
        col.hasBatch ? `import_batch_id IS DISTINCT FROM '${batchId}'` : null,
        col.table === 'transactions' ? 'id NOT IN (SELECT id FROM pg_temp.undo_ids)' : null,
        byTxn && col.hasTxn ? '(transaction_id IS NULL OR transaction_id NOT IN (SELECT id FROM pg_temp.undo_ids))' : null,
      ].filter(Boolean).join(' AND ');
      const rows = (await ex.execute(sql.raw(`SELECT ${pick} FROM ${col.table} WHERE ${where} LIMIT 200`))).rows as Array<{
        ref: string; rid: string | null; txn: string | null }>;
      if (rows.length === 0) continue;
      const ownerTxn = (r: { rid: string | null; txn: string | null }) => (col.table === 'transactions' ? r.rid : byTxn ? r.txn : null);
      const status = await statusesOf(ex, tenantId, rows.map(ownerTxn).filter((x): x is string => !!x));
      for (const r of rows) {
        const owner = ownerTxn(r);
        const deadOwner = owner ? DEAD.has(status.get(owner) ?? '') : false;
        if (deadOwner && !masters.has(r.ref)) {
          // A void or deleted transaction's settlement stamp naming a batch document: cleared with the
          // batch (audited) so nothing points at a deleted id. Any other pointer of it blocks.
          if (col.table === 'journal_lines' && col.column === 'source_transaction_id' && r.rid) {
            dead.settlementLines.push(r.rid);
            continue;
          }
        }
        blockers.push({
          kind: `${col.table}.${col.column}`, id: r.rid ?? r.ref,
          reason: deadOwner ? 'used_by_void_transaction' : (REASONS[col.table] ?? 'linked'), target: r.ref,
        });
        if (deadOwner && masters.has(r.ref) && !deadTransactionsBlock()) blockers.pop();
      }
    }
  }
  // Ids kept inside jsonb (findDeleteBlockingLinks reads the same).
  if (T.length > 0) {
    const pr = (await ex.execute(sql`
      SELECT id::text FROM payroll_import_sessions WHERE tenant_id = ${tenantId}
        AND jsonb_typeof(journal_entry_ids) = 'array'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(journal_entry_ids) e WHERE e = ANY(${pgArray(T)}::text[]))
      LIMIT 50`)).rows as Array<{ id: string }>;
    for (const p of pr) blockers.push({ kind: 'payroll_import_sessions.journal_entry_ids', id: p.id, reason: 'payroll' });
  }

  // A batch transaction changed since the commit: lines written after it
  // (an edit re-writes them, a void adds reversals), or no longer posted.
  if (T.length > 0) {
    const edited = (await ex.execute(sql`
      SELECT DISTINCT t.id::text FROM transactions t
      LEFT JOIN journal_lines jl ON jl.transaction_id = t.id
        AND ${stamps.linesCreatedMax ?? null}::timestamptz IS NOT NULL AND jl.created_at > ${stamps.linesCreatedMax ?? null}::timestamptz
      WHERE t.tenant_id = ${tenantId} AND t.id = ANY(${pgArray(T)}::uuid[]) AND (t.status <> 'posted' OR jl.id IS NOT NULL)
      LIMIT 200`)).rows as Array<{ id: string }>;
    for (const e of edited) blockers.push({ kind: 'transactions', id: e.id, reason: 'edited' });
  }
  // A created master record changed since the commit.
  for (const [table, ids] of [['accounts', created.accounts], ['contacts', created.contacts], ['items', created.items], ['tags', created.tags], ['tag_groups', created.tagGroups]] as const) {
    const max = stamps.updatedMax?.[table];
    if (ids.length === 0 || !max) continue;
    // accounts.updated_at moves with every balance change; balances are checked by the line sweep instead.
    if (table === 'accounts') continue;
    const r = (await ex.execute(sql.raw(`SELECT id::text AS id FROM ${table} WHERE tenant_id = '${tenantId}' AND import_batch_id = '${batchId}' AND updated_at > '${max}'::timestamptz LIMIT 200`))).rows as Array<{ id: string }>;
    for (const x of r) blockers.push({ kind: table, id: x.id, reason: 'edited' });
  }
  // An account the batch changed (not created) and someone changed again.
  const after = stamps.accountsAfter ?? {};
  const changedIds = Object.keys(after);
  if (changedIds.length > 0) {
    const r = (await ex.execute(sql`
      SELECT id::text, name, account_type, detail_type, description, parent_id::text FROM accounts
      WHERE tenant_id = ${tenantId} AND id = ANY(${pgArray(changedIds)}::uuid[])`)).rows as Array<{
      id: string; name: string; account_type: string; detail_type: string | null; description: string | null; parent_id: string | null }>;
    for (const a of r) {
      const want = after[a.id]!;
      if (a.name !== want.name || a.account_type !== want.accountType || (a.detail_type ?? null) !== want.detailType
        || (a.description ?? null) !== want.description || (a.parent_id ?? null) !== want.parentId) {
        blockers.push({ kind: 'accounts', id: a.id, reason: 'changed_since' });
      }
    }
  }
  // Inventory the batch brought in and something outside it moved since.
  if (T.length > 0) {
    const inv = (await ex.execute(sql`
      SELECT DISTINCT m2.id::text FROM inventory_movements m
      JOIN inventory_movements m2 ON m2.item_id = m.item_id AND m2.tenant_id = m.tenant_id AND NOT (m2.transaction_id = ANY(${pgArray(T)}::uuid[]))
      WHERE m.tenant_id = ${tenantId} AND m.transaction_id = ANY(${pgArray(T)}::uuid[]) LIMIT 50`)).rows as Array<{ id: string }>;
    for (const m of inv) blockers.push({ kind: 'inventory_movements', id: m.id, reason: 'inventory_used' });
  }

  // One entry per (kind, id).
  const seen = new Set<string>();
  const unique = blockers.filter((b) => { const k = `${b.kind}|${b.id}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { blockers: unique, dead };
}

/**
 * Every row (outside the audit, import and trigger-written tables) that points at one of
 * ids, by the same column sweep undo uses. After an undo this must find
 * nothing for the ids it deleted (tests).
 */
export async function findPointers(ex: Tx, tenantId: string, ids: string[]): Promise<Array<{ kind: string; rid: string | null; ref: string }>> {
  if (ids.length === 0) return [];
  await ex.execute(sql.raw('CREATE TEMP TABLE IF NOT EXISTS undo_ids (id uuid PRIMARY KEY) ON COMMIT DROP'));
  await ex.execute(sql.raw('TRUNCATE pg_temp.undo_ids'));
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    await ex.execute(sql.raw(`INSERT INTO pg_temp.undo_ids (id) VALUES ${chunk.map((x) => `('${x}')`).join(',')} ON CONFLICT DO NOTHING`));
  }
  const out: Array<{ kind: string; rid: string | null; ref: string }> = [];
  for (const col of await sweepColumns(ex)) {
    const where = `"${col.column}" IN (SELECT id FROM pg_temp.undo_ids)${col.hasTenant ? ` AND tenant_id = '${tenantId}'` : ''}`;
    const rows = (await ex.execute(sql.raw(`SELECT "${col.column}"::text AS ref, ${col.hasId ? 'id::text' : 'NULL::text'} AS rid FROM ${col.table} WHERE ${where} LIMIT 20`))).rows as Array<{ ref: string; rid: string | null }>;
    for (const r of rows) out.push({ kind: `${col.table}.${col.column}`, rid: r.rid, ref: r.ref });
  }
  return out;
}

/** Stamps taken at the end of a commit, in the commit transaction (database clock). */
export async function takeCommitStamps(tx: Tx, tenantId: string, batchId: string, changedAccountIds: string[]): Promise<CommitStamps> {
  const lines = (await tx.execute(sql`
    SELECT MAX(jl.created_at)::text AS m FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id
    WHERE t.tenant_id = ${tenantId} AND t.import_batch_id = ${batchId}`)).rows as Array<{ m: string | null }>;
  const updatedMax: Record<string, string | null> = {};
  for (const table of ['accounts', 'contacts', 'items', 'tags', 'tag_groups']) {
    const r = (await tx.execute(sql.raw(`SELECT GREATEST(MAX(updated_at), now())::text AS m FROM ${table} WHERE tenant_id = '${tenantId}' AND import_batch_id = '${batchId}'`))).rows as Array<{ m: string | null }>;
    updatedMax[table] = r[0]?.m ?? null;
  }
  const accountsAfter: CommitStamps['accountsAfter'] = {};
  if (changedAccountIds.length > 0) {
    const r = (await tx.execute(sql`
      SELECT id::text, name, account_type, detail_type, description, parent_id::text FROM accounts
      WHERE tenant_id = ${tenantId} AND id = ANY(${pgArray(changedAccountIds)}::uuid[])`)).rows as Array<{
      id: string; name: string; account_type: string; detail_type: string | null; description: string | null; parent_id: string | null }>;
    for (const a of r) {
      accountsAfter[a.id] = { name: a.name, accountType: a.account_type, detailType: a.detail_type ?? null, description: a.description ?? null, parentId: a.parent_id ?? null };
    }
  }
  return { linesCreatedMax: lines[0]?.m ?? null, updatedMax, accountsAfter };
}

/** Before-images for the audit trail: every deleted transaction with its lines, and every deleted master record. */
export async function beforeImages(tx: Tx, tenantId: string, created: CreatedSets) {
  const rows = async (table: string, ids: string[]) => ids.length === 0 ? [] : (await tx.execute(sql.raw(
    `SELECT to_jsonb(x) AS r FROM ${table} x WHERE tenant_id = '${tenantId}' AND id = ANY(ARRAY[${ids.map((i) => `'${i}'`).join(',')}]::uuid[])`,
  ))).rows.map((r) => (r as { r: Record<string, unknown> }).r);
  const txns = await rows('transactions', created.txns);
  const lines = created.lines.length === 0 ? [] : await rows('journal_lines', created.lines);
  const linesByTxn = new Map<string, unknown[]>();
  for (const l of lines as Array<Record<string, unknown>>) {
    const k = String(l['transaction_id']);
    const list = linesByTxn.get(k) ?? [];
    list.push(l);
    linesByTxn.set(k, list);
  }
  return {
    transactions: (txns as Array<Record<string, unknown>>).map((t) => ({ ...t, lines: linesByTxn.get(String(t['id'])) ?? [] })),
    accounts: await rows('accounts', created.accounts),
    contacts: await rows('contacts', created.contacts),
    items: await rows('items', created.items),
    tags: await rows('tags', created.tags),
    tag_groups: await rows('tag_groups', created.tagGroups),
  };
}

const CHUNK = 1000;

async function deleteIds(tx: Tx, table: string, column: string, ids: string[], tenantId?: string): Promise<void> {
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    await tx.execute(sql.raw(
      `DELETE FROM ${table} WHERE ${column} = ANY(ARRAY[${chunk.map((x) => `'${x}'`).join(',')}]::uuid[])${tenantId ? ` AND tenant_id = '${tenantId}'` : ''}`,
    ));
  }
}

/**
 * Deletes everything the batch created plus its dead links, moving stored
 * account balances back exactly. Call only after findUndoBlockers found none,
 * in the same transaction.
 */
export async function deleteBatchRows(tx: Tx, tenantId: string, created: CreatedSets, dead: DeadLinks): Promise<void> {
  const T = created.txns;
  // Dead links first.
  await deleteIds(tx, 'payment_applications', 'id', dead.paymentApplications, tenantId);
  await deleteIds(tx, 'bill_payment_applications', 'id', dead.billPaymentApplications, tenantId);
  await deleteIds(tx, 'vendor_credit_applications', 'id', dead.vendorCreditApplications, tenantId);
  await deleteIds(tx, 'deposit_lines', 'id', dead.depositLines);
  await deleteIds(tx, 'transaction_tax_lines', 'id', dead.taxLines, tenantId);
  for (let i = 0; i < dead.settlementLines.length; i += CHUNK) {
    const chunk = dead.settlementLines.slice(i, i + CHUNK);
    await tx.execute(sql.raw(`UPDATE journal_lines SET source_transaction_id = NULL WHERE tenant_id = '${tenantId}' AND id = ANY(ARRAY[${chunk.map((x) => `'${x}'`).join(',')}]::uuid[])`));
  }
  if (T.length > 0) {
    // Links inside the batch.
    await deleteIds(tx, 'payment_applications', 'payment_id', T, tenantId);
    await deleteIds(tx, 'payment_applications', 'invoice_id', T, tenantId);
    await deleteIds(tx, 'bill_payment_applications', 'payment_id', T, tenantId);
    await deleteIds(tx, 'vendor_credit_applications', 'payment_id', T, tenantId);
    await deleteIds(tx, 'deposit_lines', 'deposit_id', T);
    // Artifacts (journal lines last).
    for (const [table, column] of Object.entries(OWNED_ARTIFACTS)) {
      if (table === 'journal_lines') continue;
      await deleteIds(tx, table, column, T, tenantId);
    }
    // Stored balances back exactly: minus the net of every line of a transaction that moved them.
    const net = (await tx.execute(sql`
      SELECT jl.account_id::text AS a, SUM(jl.debit - jl.credit)::text AS n
      FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id
      WHERE t.tenant_id = ${tenantId} AND t.id = ANY(${pgArray(T)}::uuid[]) AND t.status <> 'draft'
      GROUP BY jl.account_id`)).rows as Array<{ a: string; n: string }>;
    const createdAccounts = new Set(created.accounts);
    const deltas = new Map<string, Dec>();
    for (const r of net) {
      const n = new Decimal(r.n);
      if (!n.isZero() && !createdAccounts.has(r.a)) deltas.set(r.a, n.negated());
    }
    if (deltas.size > 0) {
      const { applyAccountDeltas } = await import('../ledger.service.js');
      await applyAccountDeltas(tx, tenantId, deltas);
    }
    await deleteIds(tx, 'journal_lines', 'transaction_id', T, tenantId);
    await deleteIds(tx, 'transactions', 'id', T, tenantId);
  }
  await deleteIds(tx, 'items', 'id', created.items, tenantId);
  await deleteIds(tx, 'contacts', 'id', created.contacts, tenantId);
  await deleteIds(tx, 'tags', 'id', created.tags, tenantId);
  await deleteIds(tx, 'tag_groups', 'id', created.tagGroups, tenantId);
  await deleteIds(tx, 'accounts', 'id', created.accounts, tenantId);
}
