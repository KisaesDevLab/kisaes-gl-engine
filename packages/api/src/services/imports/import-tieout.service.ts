// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Import tie-out, verify, spot-check and the batch's transactions (U-267,
 * U-271; imports-tieout-v1; ClientLedger P31 E3).
 *
 * The tie-out compares a committed batch's source files with the books as of
 * `asOf` (the batch's conversionDate, else its reference trial balance's date):
 *
 * - accounts: the reference trial balance, row by row resolved to accounts the
 *   way the commit resolved them (accountMap, the merged and mapped chart rows,
 *   number, name), against the exact accrual trial balance as of asOf when the
 *   company was empty at commit, else only the batch's own lines (Q-P31h).
 *   Profit and loss accounts are fiscal year to date; earlier years' income is
 *   in the retained earnings account, as the trial balance report shows it.
 *   The before-conversion accounts are left out here (balanceRows).
 * - arItems / apItems: each open-item row against the open balance of the
 *   document it became (engine A/R and A/P open items as of asOf), keyed by
 *   source row. With an empty company, an open item no row made is a row too
 *   (sourceRow null).
 * - inventoryItems: each valuation row against the engine valuation of its item.
 * - balanceRows: history_ar / history_ap / history_inventory (the
 *   before-conversion accounts must be 0.00 at asOf) and valuation_vs_asset
 *   (inventory asset accounts in the books against the valuation file).
 *
 * Every figure is an exact Decimal string, accounts as debit - credit, and
 * diffExact = booksExact - sourceExact. allZero only when every diff is
 * exactly zero. Errors carry codes and ids, never names.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { db } from '../../db/index.js';
import { importBatches, importSessions, importRows, transactions, accounts } from '../../db/schema/index.js';
import type {
  CanonicalOpenItemRow, CanonicalTrialBalanceRow, CanonicalValuationRow,
} from '@kis-books/shared';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../middleware/audit.js';
import { buildTrialBalance, getFiscalYearStart } from '../report.service.js';
import { arOpenItemsAsOf } from '../ar-open-items.js';
import { apOpenItemsAsOf } from '../ap-open-items.js';
import {
  loadParsedRows, sourceAccountKey, valuationItemMatcher, inventoryAssetAccountIds,
  OPEN_ITEM_SOURCE, openItemSourceId, type BatchPriorValues,
} from './imports.service.js';
import {
  loadBatch, loadSessions, tryCompanyImportLock, toBatchDto, type BatchOptions, type BatchDto,
} from './import-batch.service.js';

type BatchRow = typeof importBatches.$inferSelect;
type SessionRow = typeof importSessions.$inferSelect;

export interface TieoutAccountRow {
  accountId: string | null;
  number: string | null;
  name: string;
  /** The first reference trial balance row on this account (null: books only). */
  sourceRow: number | null;
  sourceRows: number[];
  sourceKeys: string[];
  sourceExact: string;
  booksExact: string;
  diffExact: string;
}

export interface TieoutItemRow {
  /** The open-item file row (null: an open item in the books no row made). */
  sourceRow: number | null;
  sessionId: string | null;
  transactionId: string | null;
  contactName: string | null;
  number: string | null;
  docType: string | null;
  date: string | null;
  sourceExact: string;
  booksExact: string;
  diffExact: string;
}

export interface TieoutInventoryRow {
  sourceRow: number | null;
  item: string;
  itemId: string | null;
  sourceQuantity: string;
  booksQuantity: string;
  quantityDiff: string;
  sourceExact: string;
  booksExact: string;
  diffExact: string;
}

export type TieoutBalanceKey = 'history_ar' | 'history_ap' | 'history_inventory' | 'valuation_vs_asset';

export interface TieoutBalanceRow {
  key: TieoutBalanceKey;
  accountId: string | null;
  sourceExact: string;
  booksExact: string;
  diffExact: string;
}

export interface TieoutTotal { sourceExact: string; booksExact: string; diffExact: string }

export interface Tieout {
  batchId: string;
  asOf: string;
  computedAt: string;
  /** company: the whole company's books (it was empty at commit); batch: only the batch's own lines (Q-P31h). */
  books: 'company' | 'batch';
  referenceTrialBalance: { sessionId: string; reportDate: string | null } | null;
  accounts: TieoutAccountRow[];
  arItems: TieoutItemRow[];
  apItems: TieoutItemRow[];
  inventoryItems: TieoutInventoryRow[];
  balanceRows: TieoutBalanceRow[];
  totals: {
    accounts: { sourceDebitExact: string; sourceCreditExact: string; booksDebitExact: string; booksCreditExact: string } | null;
    /** A/R aging total of the open-item file and of the books (null: the batch has no open invoices file). */
    ar: TieoutTotal | null;
    ap: TieoutTotal | null;
    /** Valuation file total and the engine valuation of the batch's rows (null: no valuation file). */
    inventory: TieoutTotal | null;
  };
  differenceCount: number;
  allZero: boolean;
  verifiedAt: string | null;
}

export interface TieoutDifference {
  section: 'accounts' | 'arItems' | 'apItems' | 'inventoryItems' | 'balanceRows' | 'totals';
  key: string | null;
  sourceRow: number | null;
  accountId: string | null;
  transactionId: string | null;
  itemId: string | null;
  diffExact: string;
  quantityDiff?: string;
}

const ZERO = new Decimal(0);
const D = (x: unknown): Decimal => new Decimal(x === null || x === undefined || x === '' ? '0' : String(x));
/** Exact, at least 2 places. */
const fmt = (d: Decimal): string => d.toFixed(Math.max(2, d.decimalPlaces()));
const FIRST_DIFFERENCES = 20;

// ── Checks ────────────────────────────────────────────────────────

function assertCommitted(b: BatchRow): void {
  if (b.status === 'committed') return;
  if (b.status === 'undone') throw AppError.conflict('This import was undone.', 'IMPORT_BATCH_UNDONE', { batchId: b.id });
  throw AppError.conflict('Only a committed import can be tied out.', 'IMPORT_BATCH_NOT_COMMITTED', { batchId: b.id, status: b.status });
}

// ── Books side ────────────────────────────────────────────────────

/** Account nets (debit - credit) as of asOf in trial balance presentation: P&L fiscal year to date, earlier P&L in `retained`. */
async function booksTrialBalance(
  tenantId: string, companyId: string, asOf: string, batchId: string | null,
): Promise<{ nets: Map<string, Decimal>; retained: Decimal }> {
  const nets = new Map<string, Decimal>();
  let retained = ZERO;
  if (!batchId) {
    const tb = await buildTrialBalance(tenantId, asOf, asOf, companyId, null, 'accrual', { exactAmounts: true });
    for (const r of tb.data as Array<{ accountId?: string | null; netExact?: string }>) {
      const n = D(r.netExact);
      if (r.accountId) nets.set(r.accountId, (nets.get(r.accountId) ?? ZERO).plus(n));
      else retained = retained.plus(n);
    }
    return { nets, retained };
  }
  // Only the batch's lines (Q-P31h), split at the fiscal year start as buildTrialBalance splits.
  const m = await getFiscalYearStart(tenantId, companyId);
  const end = new Date(`${asOf}T00:00:00Z`);
  let y = end.getUTCFullYear();
  if (end.getUTCMonth() + 1 < m) y--;
  const fyStart = `${y}-${String(m).padStart(2, '0')}-01`;
  const r = await db.execute(sql`
    SELECT jl.account_id::text AS id,
      COALESCE(SUM(CASE WHEN a.account_type IN ('asset', 'liability', 'equity') OR t.txn_date >= ${fyStart}::date
        THEN jl.debit - jl.credit ELSE 0 END), 0)::text AS net,
      COALESCE(SUM(CASE WHEN a.account_type NOT IN ('asset', 'liability', 'equity') AND t.txn_date < ${fyStart}::date
        THEN jl.debit - jl.credit ELSE 0 END), 0)::text AS prior
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE t.tenant_id = ${tenantId} AND t.company_id = ${companyId} AND t.import_batch_id = ${batchId}
      AND t.status = 'posted' AND t.basis <> 'cash' AND t.txn_date <= ${asOf}::date
    GROUP BY jl.account_id`);
  for (const row of r.rows as Array<{ id: string; net: string; prior: string }>) {
    const n = D(row.net);
    if (!n.isZero()) nets.set(row.id, n);
    retained = retained.plus(D(row.prior));
  }
  return { nets, retained };
}

/** Cumulative nets (debit - credit) of balance sheet accounts as of asOf: the company's, or the batch's lines only. */
async function accountNets(
  tenantId: string, companyId: string, asOf: string, batchId: string | null, ids: string[],
): Promise<Map<string, Decimal>> {
  const out = new Map<string, Decimal>();
  if (ids.length === 0) return out;
  const r = await db.execute(sql`
    SELECT jl.account_id::text AS id, COALESCE(SUM(jl.debit - jl.credit), 0)::text AS net
    FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id
    WHERE t.tenant_id = ${tenantId} AND t.company_id = ${companyId} AND t.status = 'posted' AND t.basis <> 'cash'
      AND t.txn_date <= ${asOf}::date ${batchId ? sql`AND t.import_batch_id = ${batchId}` : sql``}
      AND jl.account_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
    GROUP BY jl.account_id`);
  for (const row of r.rows as Array<{ id: string; net: string }>) out.set(row.id, D(row.net));
  return out;
}

// ── Compute ───────────────────────────────────────────────────────

export async function computeTieout(b: BatchRow, sessions: SessionRow[], opts: { requireReference: boolean }): Promise<Tieout> {
  const { tenantId, companyId, id: batchId } = b;
  const options = (b.options as BatchOptions | null) ?? {};
  const refs = sessions.filter((s) => s.kind === 'trial_balance' && s.role === 'reference');
  if (!options.conversionDate && refs.length > 1) {
    throw AppError.unprocessableEntity('This import has several reference trial balances and no conversion date.', 'TIEOUT_REFERENCE_AMBIGUOUS', { batchId });
  }
  const asOf = options.conversionDate ?? refs[0]?.reportDate ?? null;
  if (!asOf) throw AppError.unprocessableEntity('This import has no conversion date to tie out at.', 'TIEOUT_NO_DATE', { batchId });
  const atDate = refs.filter((s) => s.reportDate === asOf);
  if (atDate.length > 1) {
    throw AppError.unprocessableEntity('This import has several reference trial balances for the conversion date.', 'TIEOUT_REFERENCE_AMBIGUOUS', {
      batchId, sessionIds: atDate.map((s) => s.id),
    });
  }
  const ref = atDate[0] ?? null;
  if (!ref && opts.requireReference) {
    throw AppError.unprocessableEntity('Add the trial balance as of the conversion date to tie this import out.', 'TIEOUT_REFERENCE_REQUIRED', { batchId, asOf });
  }
  const companyBooks = b.companyWasEmpty === true;
  const booksBatch = companyBooks ? null : batchId;
  const result = (b.result as Record<string, unknown> | null) ?? {};
  const history = (result['historyAccounts'] as { ar?: string | null; ap?: string | null; inventory?: string | null } | undefined) ?? {};
  const historyIds = new Set([history.ar, history.ap, history.inventory].filter((x): x is string => !!x));
  const prior = (b.priorValues as BatchPriorValues | null) ?? {};

  // ── Accounts ──
  let accountRows: TieoutAccountRow[] = [];
  let accountTotals: Tieout['totals']['accounts'] = null;
  if (ref) {
    const acctList = await db.select({
      id: accounts.id, number: accounts.accountNumber, name: accounts.name, systemTag: accounts.systemTag, companyId: accounts.companyId,
    }).from(accounts).where(and(eq(accounts.tenantId, tenantId), sql`(${accounts.companyId} = ${companyId} OR ${accounts.companyId} IS NULL)`))
      .orderBy(accounts.createdAt, accounts.id);
    const meta = new Map(acctList.map((a) => [a.id, a]));
    const byNum = new Map<string, string>();
    const byName = new Map<string, string>();
    for (const a of acctList) {
      if (a.number) byNum.set(a.number, a.id);
      const k = a.name.toLowerCase();
      if (!byName.has(k)) byName.set(k, a.id);
    }
    for (const [k, id] of Object.entries(prior.accountAliases ?? {})) {
      if (k.startsWith('n:')) byNum.set(k.slice(2), id);
      else if (k.startsWith('name:')) byName.set(k.slice(5), id);
    }
    const map = options.accountMap ?? {};
    const resolve = (num?: string | null, name?: string | null): string | null => {
      const key = sourceAccountKey(num, name);
      const mapped = key ? map[key] : undefined;
      if (mapped && mapped !== 'create' && meta.has(mapped)) return mapped;
      return (num && byNum.get(num)) || (name && byName.get(name.toLowerCase())) || null;
    };

    const { nets, retained } = await booksTrialBalance(tenantId, companyId, asOf, booksBatch);
    // Earlier years' income sits in the retained earnings account, as QuickBooks shows it.
    const re = acctList.find((a) => a.systemTag === 'retained_earnings');
    let retainedOrphan = ZERO;
    if (!retained.isZero()) {
      if (re) nets.set(re.id, (nets.get(re.id) ?? ZERO).plus(retained));
      else retainedOrphan = retained;
    }

    type Acc = { accountId: string | null; number: string | null; name: string; rows: number[]; keys: string[]; source: Decimal };
    const groups = new Map<string, Acc>();
    for (const r of (await loadParsedRows(db, ref)) as CanonicalTrialBalanceRow[]) {
      const id = resolve(r.accountNumber, r.accountName);
      const key = sourceAccountKey(r.accountNumber, r.accountName) ?? `row:${r.rowNumber}`;
      const g = groups.get(id ?? `?${key}`) ?? {
        accountId: id,
        number: id ? (meta.get(id)?.number ?? null) : (r.accountNumber ?? null),
        name: id ? (meta.get(id)?.name ?? '') : (r.accountName ?? r.accountNumber ?? ''),
        rows: [], keys: [], source: ZERO,
      };
      g.rows.push(r.rowNumber);
      if (!g.keys.includes(key)) g.keys.push(key);
      g.source = g.source.plus(D(r.debit)).minus(D(r.credit));
      groups.set(id ?? `?${key}`, g);
    }
    for (const [id, n] of nets) {
      if (groups.has(id) || historyIds.has(id) || n.isZero()) continue;
      const a = meta.get(id);
      groups.set(id, { accountId: id, number: a?.number ?? null, name: a?.name ?? '', rows: [], keys: [], source: ZERO });
    }
    if (!retainedOrphan.isZero()) {
      groups.set('retained', { accountId: null, number: null, name: 'Retained Earnings (Prior Years)', rows: [], keys: [], source: ZERO });
    }
    let sd = ZERO, sc = ZERO, bd = ZERO, bc = ZERO;
    accountRows = [...groups.entries()].map(([gk, g]) => {
      const books = gk === 'retained' ? retainedOrphan : (g.accountId ? (nets.get(g.accountId) ?? ZERO) : ZERO);
      if (g.source.gt(0)) sd = sd.plus(g.source); else sc = sc.minus(g.source);
      if (books.gt(0)) bd = bd.plus(books); else bc = bc.minus(books);
      return {
        accountId: g.accountId, number: g.number, name: g.name,
        sourceRow: g.rows.length > 0 ? Math.min(...g.rows) : null, sourceRows: g.rows.sort((x, y) => x - y), sourceKeys: g.keys.sort(),
        sourceExact: fmt(g.source), booksExact: fmt(books), diffExact: fmt(books.minus(g.source)),
      };
    }).sort((x, y) => (x.number ?? '￿').localeCompare(y.number ?? '￿', undefined, { numeric: true })
      || x.name.localeCompare(y.name) || String(x.accountId).localeCompare(String(y.accountId)));
    accountTotals = { sourceDebitExact: fmt(sd), sourceCreditExact: fmt(sc), booksDebitExact: fmt(bd), booksCreditExact: fmt(bc) };
  }

  // ── Open items ──
  const posting = sessions.filter((s) => s.role === 'post');
  const links = new Map<string, { id: string }>();
  const linked = await db.select({ id: transactions.id, sourceId: transactions.sourceId }).from(transactions).where(and(
    eq(transactions.tenantId, tenantId), eq(transactions.importBatchId, batchId), eq(transactions.source, OPEN_ITEM_SOURCE),
  ));
  for (const l of linked) if (l.sourceId) links.set(l.sourceId, { id: l.id });

  const openItems = async (kind: 'open_invoices' | 'unpaid_bills'): Promise<{ rows: TieoutItemRow[]; total: TieoutTotal } | null> => {
    const files = posting.filter((s) => s.kind === kind);
    if (files.length === 0) return null;
    const open = kind === 'open_invoices'
      ? await arOpenItemsAsOf(db, { tenantId, companyId, asOf })
      : await apOpenItemsAsOf(db, { tenantId, companyId, asOf });
    const openBy = new Map(open.map((o) => [o.txnId, o]));
    const used = new Set<string>();
    const rows: TieoutItemRow[] = [];
    let src = ZERO, books = ZERO;
    for (const s of files) {
      for (const r of (await loadParsedRows(db, s)) as CanonicalOpenItemRow[]) {
        const txnId = links.get(openItemSourceId(s.id, r.rowNumber))?.id ?? null;
        if (txnId) used.add(txnId);
        const o = txnId ? openBy.get(txnId) : undefined;
        const bv = o ? D(o.openExact) : ZERO;
        const sv = D(r.openBalance);
        src = src.plus(sv);
        books = books.plus(bv);
        rows.push({
          sourceRow: r.rowNumber, sessionId: s.id, transactionId: txnId, contactName: r.name, number: r.number ?? null,
          docType: r.docType, date: r.date, sourceExact: fmt(sv), booksExact: fmt(bv), diffExact: fmt(bv.minus(sv)),
        });
      }
    }
    if (companyBooks) {
      // An open item the files did not bring in (entered since, or a ledger line with no document).
      const extra = open.filter((o) => !used.has(o.txnId) && !D(o.openExact).isZero());
      const names = extra.length > 0
        ? new Map((await db.execute(sql`SELECT id::text AS id, display_name FROM contacts WHERE tenant_id = ${tenantId}
            AND id IN (${sql.join([...new Set(extra.map((o) => o.contactId).filter((x): x is string => !!x))].map((x) => sql`${x}::uuid`).concat(sql`NULL::uuid`), sql`, `)})`))
          .rows.map((x) => [String((x as { id: string }).id), String((x as { display_name: string }).display_name)]))
        : new Map<string, string>();
      for (const o of extra) {
        const bv = D(o.openExact);
        books = books.plus(bv);
        rows.push({
          sourceRow: null, sessionId: null, transactionId: o.txnId, contactName: o.contactId ? (names.get(o.contactId) ?? null) : null,
          number: o.number, docType: o.txnType, date: o.date, sourceExact: '0.00', booksExact: fmt(bv), diffExact: fmt(bv),
        });
      }
    }
    return { rows, total: { sourceExact: fmt(src), booksExact: fmt(books), diffExact: fmt(books.minus(src)) } };
  };
  const ar = await openItems('open_invoices');
  const ap = await openItems('unpaid_bills');

  // ── Inventory ──
  const valuations = posting.filter((s) => s.kind === 'inventory_valuation');
  let inventoryRows: TieoutInventoryRow[] = [];
  let inventoryTotal: TieoutTotal | null = null;
  let valuationFileTotal: Decimal | null = null;
  if (valuations.length > 0) {
    const { valuationSummary } = await import('../inventory-report.service.js');
    const summary = await valuationSummary(tenantId, asOf, companyId);
    const byItem = new Map(summary.rows.map((r) => [r.itemId, r]));
    const match = await valuationItemMatcher(db, tenantId, companyId);
    const used = new Set<string>();
    let src = ZERO, books = ZERO;
    for (const s of valuations) {
      for (const r of (await loadParsedRows(db, s)) as CanonicalValuationRow[]) {
        const m = match(r.item);
        const itemId = 'itemId' in m ? m.itemId : null;
        if (itemId) used.add(itemId);
        const row = itemId ? byItem.get(itemId) : undefined;
        const sq = D(r.onHand), sv = D(r.assetValue);
        const bq = row ? D(row.onHand) : ZERO, bv = row ? D(row.value) : ZERO;
        src = src.plus(sv);
        books = books.plus(bv);
        inventoryRows.push({
          sourceRow: r.rowNumber, item: r.item, itemId, sourceQuantity: sq.toFixed(Math.max(0, sq.decimalPlaces())),
          booksQuantity: bq.toFixed(Math.max(0, bq.decimalPlaces())), quantityDiff: bq.minus(sq).toFixed(Math.max(0, bq.minus(sq).decimalPlaces())),
          sourceExact: fmt(sv), booksExact: fmt(bv), diffExact: fmt(bv.minus(sv)),
        });
      }
    }
    valuationFileTotal = src;
    if (companyBooks) {
      for (const r of summary.rows) {
        if (used.has(r.itemId) || (D(r.onHand).isZero() && D(r.value).isZero())) continue;
        const bq = D(r.onHand), bv = D(r.value);
        books = books.plus(bv);
        inventoryRows.push({
          sourceRow: null, item: r.name, itemId: r.itemId, sourceQuantity: '0', booksQuantity: bq.toFixed(Math.max(0, bq.decimalPlaces())),
          quantityDiff: bq.toFixed(Math.max(0, bq.decimalPlaces())), sourceExact: '0.00', booksExact: fmt(bv), diffExact: fmt(bv),
        });
      }
    }
    inventoryTotal = { sourceExact: fmt(src), booksExact: fmt(books), diffExact: fmt(books.minus(src)) };
  }

  // ── Balance rows ──
  const balanceRows: TieoutBalanceRow[] = [];
  const hist: Array<[TieoutBalanceKey, string | null | undefined]> = [
    ['history_ar', history.ar], ['history_ap', history.ap], ['history_inventory', history.inventory],
  ];
  const histNets = await accountNets(tenantId, companyId, asOf, booksBatch, hist.map(([, id]) => id).filter((x): x is string => !!x));
  for (const [key, id] of hist) {
    if (!id) continue;
    const n = histNets.get(id) ?? ZERO;
    balanceRows.push({ key, accountId: id, sourceExact: '0.00', booksExact: fmt(n), diffExact: fmt(n) });
  }
  if (valuationFileTotal) {
    const ids = await inventoryAssetAccountIds(db, tenantId, companyId);
    const assetNets = await accountNets(tenantId, companyId, asOf, booksBatch, ids);
    const gl = [...assetNets.values()].reduce((s, v) => s.plus(v), ZERO);
    balanceRows.push({ key: 'valuation_vs_asset', accountId: null, sourceExact: fmt(valuationFileTotal), booksExact: fmt(gl), diffExact: fmt(gl.minus(valuationFileTotal)) });
  }

  const t: Tieout = {
    batchId, asOf, computedAt: new Date().toISOString(), books: companyBooks ? 'company' : 'batch',
    referenceTrialBalance: ref ? { sessionId: ref.id, reportDate: ref.reportDate } : null,
    accounts: accountRows, arItems: ar?.rows ?? [], apItems: ap?.rows ?? [], inventoryItems: inventoryRows, balanceRows,
    totals: { accounts: accountTotals, ar: ar?.total ?? null, ap: ap?.total ?? null, inventory: inventoryTotal },
    differenceCount: 0, allZero: false, verifiedAt: null,
  };
  const diffs = differences(t);
  t.differenceCount = diffs.length;
  t.allZero = diffs.length === 0;
  return t;
}

/** Every nonzero difference, in section order (accounts, A/R, A/P, inventory, balance rows, totals); ids and rows, never names. */
export function differences(t: Tieout): TieoutDifference[] {
  const out: TieoutDifference[] = [];
  const base = { key: null, sourceRow: null, accountId: null, transactionId: null, itemId: null };
  for (const a of t.accounts) {
    if (!D(a.diffExact).isZero()) // No key: a source account key may be a name (codes and ids only).
      out.push({ ...base, section: 'accounts', sourceRow: a.sourceRow, accountId: a.accountId, diffExact: a.diffExact });
  }
  for (const [section, list] of [['arItems', t.arItems], ['apItems', t.apItems]] as const) {
    for (const i of list) {
      if (!D(i.diffExact).isZero()) out.push({ ...base, section, sourceRow: i.sourceRow, transactionId: i.transactionId, diffExact: i.diffExact });
    }
  }
  for (const i of t.inventoryItems) {
    if (!D(i.diffExact).isZero() || !D(i.quantityDiff).isZero()) {
      out.push({ ...base, section: 'inventoryItems', sourceRow: i.sourceRow, itemId: i.itemId, diffExact: i.diffExact, quantityDiff: i.quantityDiff });
    }
  }
  for (const r of t.balanceRows) {
    if (!D(r.diffExact).isZero()) out.push({ ...base, section: 'balanceRows', key: r.key, accountId: r.accountId, diffExact: r.diffExact });
  }
  for (const k of ['ar', 'ap', 'inventory'] as const) {
    const x = t.totals[k];
    if (x && !D(x.diffExact).isZero()) out.push({ ...base, section: 'totals', key: k, diffExact: x.diffExact });
  }
  return out;
}

// ── Routes' services ──────────────────────────────────────────────

/**
 * POST /imports/batches/:id/tieout: computes the tie-out and keeps it on the
 * batch (the latest one). A verified batch's source rows are gone: it answers
 * the tie-out kept at verify.
 */
export async function runTieout(tenantId: string, companyId: string, batchId: string, opts: { requireReference: boolean }): Promise<Tieout> {
  const b = await loadBatch(db, tenantId, companyId, batchId);
  assertCommitted(b);
  if (b.verifiedAt && b.tieout) return b.tieout as Tieout;
  const t = await computeTieout(b, await loadSessions(db, batchId), opts);
  await db.update(importBatches).set({ tieout: t as never, updatedAt: new Date() }).where(and(
    eq(importBatches.id, batchId), eq(importBatches.status, 'committed'), sql`${importBatches.verifiedAt} IS NULL`,
  ));
  return t;
}

/**
 * POST /imports/batches/:id/verify: recomputes; 409 TIEOUT_NOT_ZERO
 * {firstDifferences (up to 20), differenceCount} unless every difference is
 * exactly zero. Else marks the batch verified (verifiedAt, verifiedBy), keeps
 * the tie-out on it, and deletes the stored parsed rows of its sessions
 * (import_rows and any legacy parsed_rows; review S8). A verified batch
 * answers 200 again with what it kept.
 */
/** Test hook (NODE_ENV=test only): runs after the request's first read, before the lock is taken. */
export const __tieoutTestHooks: { beforeVerifyLock?: (info: { batchId: string }) => void | Promise<void> } = {};

export async function verifyBatch(
  tenantId: string, companyId: string, userId: string, batchId: string, opts: { requireReference: boolean },
): Promise<{ batch: BatchDto; tieout: Tieout }> {
  const b = await loadBatch(db, tenantId, companyId, batchId);
  assertCommitted(b);
  if (b.verifiedAt && b.tieout) return { batch: toBatchDto(b, await loadSessions(db, batchId)), tieout: b.tieout as Tieout };
  if (process.env['NODE_ENV'] === 'test' && __tieoutTestHooks.beforeVerifyLock) await __tieoutTestHooks.beforeVerifyLock({ batchId });
  const out = await db.transaction(async (tx): Promise<{ done: { batch: BatchDto; tieout: Tieout } } | { notZero: Tieout }> => {
    if (!(await tryCompanyImportLock(tx, companyId))) {
      throw AppError.conflict('Another import or undo is running for this company. Try again when it has finished.', 'IMPORT_BUSY', { batchId });
    }
    const locked = await loadBatch(tx, tenantId, companyId, batchId, true);
    assertCommitted(locked);
    const sessions = await loadSessions(tx, batchId, true);
    if (locked.verifiedAt && locked.tieout) return { done: { batch: toBatchDto(locked, sessions), tieout: locked.tieout as Tieout } };
    // P31 review S2: the tie-out is computed here, under the company import lock with the batch and its
    // sessions locked, so the figures kept as verified are the ones checked, and the source rows are
    // deleted in the same transaction. A posting committed before this point is in the figures. (The
    // reports read on their own connections: a posting that commits while they run is like one made
    // just after the verify.)
    const t = await computeTieout(locked, sessions, opts);
    if (!t.allZero) {
      await tx.update(importBatches).set({ tieout: t as never, updatedAt: new Date() }).where(eq(importBatches.id, batchId));
      return { notZero: t };
    }
    const now = new Date();
    t.verifiedAt = now.toISOString();
    const ids = sessions.map((s) => s.id);
    let purged = 0;
    if (ids.length > 0) {
      purged = (await tx.delete(importRows).where(inArray(importRows.sessionId, ids)).returning({ s: importRows.sessionId })).length;
      await tx.update(importSessions).set({ parsedRows: null, updatedAt: now })
        .where(and(inArray(importSessions.id, ids), sql`${importSessions.parsedRows} IS NOT NULL`));
    }
    const [after] = await tx.update(importBatches).set({ tieout: t as never, verifiedAt: now, verifiedBy: userId, updatedAt: now })
      .where(eq(importBatches.id, batchId)).returning();
    await auditLog(tenantId, 'update', 'import_batch', batchId, { verifiedAt: null }, {
      verifiedAt: t.verifiedAt, asOf: t.asOf, books: t.books, parsedRowsDeleted: purged,
    }, userId, tx);
    return { done: { batch: toBatchDto(after!, await loadSessions(tx, batchId)), tieout: t } };
  });
  if ('notZero' in out) {
    const diffs = differences(out.notZero);
    throw AppError.conflict('The import does not tie out yet.', 'TIEOUT_NOT_ZERO', {
      batchId, differenceCount: diffs.length, firstDifferences: diffs.slice(0, FIRST_DIFFERENCES),
    });
  }
  return out.done;
}

export interface SpotCheckItem { key: string; label: string; done: boolean; note?: string | null }

/** PUT /imports/batches/:id/spot-check: stored on the batch as sent (a committed batch, verified or not). */
export async function saveSpotCheck(
  tenantId: string, companyId: string, userId: string, batchId: string, items: SpotCheckItem[],
): Promise<{ items: SpotCheckItem[]; updatedAt: string; updatedBy: string }> {
  const b = await loadBatch(db, tenantId, companyId, batchId);
  assertCommitted(b);
  const value = { items, updatedAt: new Date().toISOString(), updatedBy: userId };
  await db.update(importBatches).set({ spotCheck: value as never, updatedAt: new Date() }).where(eq(importBatches.id, batchId));
  return value;
}

// ── The batch's transactions (U-271) ──────────────────────────────

function encodeCursor(date: string, id: string): string {
  return Buffer.from(`${date}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { date: string; id: string } {
  const [date, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!date || !id || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw AppError.badRequest('Invalid cursor.', 'INVALID_CURSOR');
  }
  return { date, id };
}

export interface BatchTransaction {
  id: string; txnType: string; txnDate: string; txnNumber: string | null; vendorInvoiceNumber: string | null;
  status: string; contactId: string | null; contactName: string | null; total: string;
}

/**
 * GET /imports/batches/:id/transactions: the transactions the batch created,
 * by date then id, paged by cursor; total counts them all (for sampling).
 * total is the document total, else (journal entries) the sum of debits.
 */
export async function listBatchTransactions(
  tenantId: string, companyId: string, batchId: string, q: { limit: number; cursor?: string; txnType?: string },
): Promise<{ transactions: BatchTransaction[]; nextCursor: string | null; total: number }> {
  await loadBatch(db, tenantId, companyId, batchId);
  const after = q.cursor ? decodeCursor(q.cursor) : null;
  const where = sql`t.tenant_id = ${tenantId} AND t.company_id = ${companyId} AND t.import_batch_id = ${batchId}
    ${q.txnType ? sql`AND t.txn_type = ${q.txnType}` : sql``}`;
  const r = await db.execute(sql`
    SELECT t.id::text AS id, t.txn_type, t.txn_date::text AS txn_date, t.txn_number, t.vendor_invoice_number, t.status,
      t.contact_id::text AS contact_id, c.display_name,
      COALESCE(t.total, (SELECT SUM(jl.debit) FROM journal_lines jl WHERE jl.transaction_id = t.id), 0)::text AS total
    FROM transactions t LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE ${where} ${after ? sql`AND (t.txn_date, t.id) > (${after.date}::date, ${after.id}::uuid)` : sql``}
    ORDER BY t.txn_date, t.id LIMIT ${q.limit + 1}`);
  const rows = r.rows as Array<Record<string, string | null>>;
  const page = rows.slice(0, q.limit);
  const [{ n } = { n: 0 }] = (await db.execute(sql`SELECT count(*)::int AS n FROM transactions t WHERE ${where}`)).rows as Array<{ n: number }>;
  const last = page[page.length - 1];
  return {
    transactions: page.map((x) => ({
      id: x['id']!, txnType: x['txn_type']!, txnDate: x['txn_date']!, txnNumber: x['txn_number'] ?? null,
      vendorInvoiceNumber: x['vendor_invoice_number'] ?? null, status: x['status']!,
      contactId: x['contact_id'] ?? null, contactName: x['display_name'] ?? null, total: fmt(D(x['total'])),
    })),
    nextCursor: rows.length > q.limit && last ? encodeCursor(last['txn_date']!, last['id']!) : null,
    total: n,
  };
}
