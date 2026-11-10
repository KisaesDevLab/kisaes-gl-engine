// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Report line lenses (U-201, U-202; reports-columns-v1, reports-drill-v1).
//
// One definition of "which journal lines count" shared by the report
// columns (columns by client or tag, tag split) and the drill targets
// (General Ledger, Transaction List), so a drill on any cell sums to
// exactly that cell. Every predicate here is per LINE, on both bases:
//
//   client   the line's own contact, else its transaction's contact
//            (COALESCE(line contact, transaction contact)); on cash basis
//            the same pair from the virtual ledger (a payment's recognised
//            invoice line: the invoice line's contact, else the payment's).
//   tag      the line's own tag (journal_lines.tag_id); `untagged` = no tag
//            at all; `untagged_in_group` = no tag from the group (no tag or
//            a tag from another group, Q-P28h).
//   amount   |debit - credit| of the line (on cash basis: of the recognised
//            share), between amount_min and amount_max inclusive.
//   cleared  the reconciliation state of the journal line, as in the
//            register: reconciled = cleared in a completed reconciliation,
//            cleared = cleared but not yet reconciled, uncleared = neither.
//            Cash-basis lines scaled from a paid document have no journal
//            line of their own and count as uncleared.
//   types    the transaction type (cash basis: the type of the transaction
//            the line is recognised on, e.g. the payment).
//
// Everything money here is SQL numeric or Decimal; nothing is parsed into
// a JS number.

import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  adjustingCond, cashBasisLinesWith, executeCashBasis, type AdjustingFilter,
} from './report.service.js';
import { dec, type Dec } from './report-exact.js';

export const REPORTS_COLUMNS_CAPABILITY = 'reports-columns-v1';
export const REPORTS_DRILL_CAPABILITY = 'reports-drill-v1';

export type ContactLens =
  | { kind: 'ids'; ids: string[] }
  | { kind: 'none' }
  // Lines with a client that is not one of `exclude` ("All others").
  | { kind: 'others'; exclude: string[] };

export type TagLens =
  | { kind: 'ids'; ids: string[] }
  | { kind: 'untagged' }
  | { kind: 'untagged_in_group'; groupId: string };

export type ClearedLens = 'cleared' | 'uncleared' | 'reconciled';

export interface LineLens {
  contact?: ContactLens | null;
  tag?: TagLens | null;
  /** Decimal strings, inclusive, compared with |debit - credit|. */
  amountMin?: string | null;
  amountMax?: string | null;
  cleared?: ClearedLens | null;
  txnTypes?: string[] | null;
}

export function lensIsEmpty(lens: LineLens | null | undefined): boolean {
  if (!lens) return true;
  return !lens.contact && !lens.tag && !lens.amountMin && !lens.amountMax && !lens.cleared
    && !(lens.txnTypes && lens.txnTypes.length > 0);
}

/** Column expressions of a line source. Code-controlled constants, never user input. */
export interface LensColumns {
  tag: string;
  contact: string;
  txnType: string;
  debit: string;
  credit: string;
  /** The journal line id, or null when the source has none. */
  lineId: string;
}

/** The posted journal: journal_lines jl JOIN transactions t. */
export const ACCRUAL_COLS: LensColumns = {
  tag: 'jl.tag_id',
  contact: 'COALESCE(jl.contact_id, t.contact_id)',
  txnType: 't.txn_type',
  debit: 'jl.debit',
  credit: 'jl.credit',
  lineId: 'jl.id',
};

/** The cash-basis virtual ledger aliased `cb`. */
export const CASH_COLS: LensColumns = {
  tag: 'cb.tag_id',
  contact: 'COALESCE(cb.line_contact_id, cb.txn_contact_id)',
  txnType: 'cb.txn_type',
  debit: 'cb.debit',
  credit: 'cb.credit',
  lineId: 'cb.line_id',
};

const raw = (s: string) => sql.raw(s);
const idList = (ids: string[]) => sql`(${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`;

/** The ids of a tag group's tags, as a SQL subquery. */
export function groupTagsSql(tenantId: string, groupId: string): SQL {
  return sql`(SELECT gt.id FROM tags gt WHERE gt.tenant_id = ${tenantId} AND gt.group_id = ${groupId}::uuid)`;
}

/** The line's tag when it belongs to the group, else NULL (the tag-split key). */
export function tagInGroupKey(tenantId: string, groupId: string, tagCol: string): SQL {
  return sql`CASE WHEN ${raw(tagCol)} IN ${groupTagsSql(tenantId, groupId)} THEN ${raw(tagCol)} END`;
}

function tagCond(tenantId: string, tag: TagLens, col: string): SQL {
  switch (tag.kind) {
    case 'ids': return sql`${raw(col)} IN ${idList(tag.ids)}`;
    case 'untagged': return sql`${raw(col)} IS NULL`;
    case 'untagged_in_group':
      // The exact complement of tagInGroupKey(...) IS NOT NULL.
      return sql`(${raw(col)} IS NULL OR ${raw(col)} NOT IN ${groupTagsSql(tenantId, tag.groupId)})`;
  }
}

function contactCond(contact: ContactLens, col: string): SQL {
  switch (contact.kind) {
    case 'ids': return sql`${raw(col)} IN ${idList(contact.ids)}`;
    case 'none': return sql`${raw(col)} IS NULL`;
    case 'others':
      return contact.exclude.length > 0
        ? sql`(${raw(col)} IS NOT NULL AND ${raw(col)} NOT IN ${idList(contact.exclude)})`
        : sql`${raw(col)} IS NOT NULL`;
  }
}

function clearedCond(tenantId: string, cleared: ClearedLens, lineCol: string): SQL {
  const any = sql`EXISTS (SELECT 1 FROM reconciliation_lines lrl
    JOIN reconciliations lr ON lr.id = lrl.reconciliation_id AND lr.tenant_id = ${tenantId}
    WHERE lrl.journal_line_id = ${raw(lineCol)} AND lrl.is_cleared)`;
  const done = sql`EXISTS (SELECT 1 FROM reconciliation_lines lrl
    JOIN reconciliations lr ON lr.id = lrl.reconciliation_id AND lr.tenant_id = ${tenantId}
    WHERE lrl.journal_line_id = ${raw(lineCol)} AND lrl.is_cleared AND lr.status = 'complete')`;
  switch (cleared) {
    case 'reconciled': return done;
    case 'cleared': return sql`(${any} AND NOT ${done})`;
    case 'uncleared': return sql`NOT ${any}`;
  }
}

/** The lens as one SQL conjunct over `cols` (TRUE when empty). */
export function lensSql(tenantId: string, lens: LineLens | null | undefined, cols: LensColumns): SQL {
  if (!lens) return sql`TRUE`;
  const parts: SQL[] = [];
  if (lens.contact) parts.push(contactCond(lens.contact, cols.contact));
  if (lens.tag) parts.push(tagCond(tenantId, lens.tag, cols.tag));
  const amt = sql`ABS(${raw(cols.debit)}::numeric - ${raw(cols.credit)}::numeric)`;
  if (lens.amountMin) parts.push(sql`${amt} >= ${lens.amountMin}::numeric`);
  if (lens.amountMax) parts.push(sql`${amt} <= ${lens.amountMax}::numeric`);
  if (lens.cleared) parts.push(clearedCond(tenantId, lens.cleared, cols.lineId));
  if (lens.txnTypes && lens.txnTypes.length > 0) {
    parts.push(sql`${raw(cols.txnType)} IN (${sql.join(lens.txnTypes.map((t) => sql`${t}`), sql`, `)})`);
  }
  return parts.length > 0 ? sql.join(parts, sql` AND `) : sql`TRUE`;
}

// ─── Grouped line sums ───────────────────────────────────────────

export type SumDimension =
  | null
  | { kind: 'contact' }
  | { kind: 'tag_group'; groupId: string };

export interface LineSum {
  accountId: string;
  accountType: string;
  /** Contact id or group tag id; null = no client / no tag from the group. */
  key: string | null;
  /** True when the lines are dated before `splitDate`. */
  pre: boolean;
  debit: Dec;
  credit: Dec;
}

export interface LineSumOptions {
  basis: 'accrual' | 'cash';
  companyId: string | null;
  adjusting: AdjustingFilter | null;
  /** Inclusive; null = from the beginning. */
  from: string | null;
  to: string;
  /** Only these account types (null = every account). */
  accountTypes?: readonly string[] | null;
  dimension?: SumDimension;
  /** Splits each sum into lines before this date (pre) and from it on. */
  splitDate?: string | null;
  lens?: LineLens | null;
}

/**
 * Debit and credit sums per account (and per dimension key, and before or
 * after `splitDate`) over exactly the lines the standard reports read: the
 * posted journal (accrual, cash-only entries left out) or the cash-basis
 * virtual ledger, with the company, adjusting and date rules of
 * buildProfitAndLoss / buildBalanceSheet / buildTrialBalance.
 */
export async function lineSums(tenantId: string, o: LineSumOptions): Promise<LineSum[]> {
  const cash = o.basis === 'cash';
  const cols = cash ? CASH_COLS : ACCRUAL_COLS;
  const dim = o.dimension ?? null;
  const keyExpr = dim === null
    ? sql`NULL::uuid`
    : dim.kind === 'contact'
      ? sql`${raw(cols.contact)}`
      : tagInGroupKey(tenantId, dim.groupId, cols.tag);
  const dateCol = cash ? 'cb.txn_date' : 't.txn_date';
  const preExpr = o.splitDate ? sql`(${raw(dateCol)} < ${o.splitDate})` : sql`false`;
  const typeCond = o.accountTypes && o.accountTypes.length > 0
    ? sql`a.account_type IN (${sql.join(o.accountTypes.map((t) => sql`${t}`), sql`, `)})`
    : sql`TRUE`;
  const lens = lensSql(tenantId, o.lens, cols);

  const res = cash
    ? await executeCashBasis(sql`
        WITH ${cashBasisLinesWith(tenantId, o.from, o.to, o.companyId, o.adjusting)}
        SELECT cb.account_id, a.account_type, ${keyExpr} AS k, ${preExpr} AS pre,
          COALESCE(SUM(cb.debit), 0) AS d, COALESCE(SUM(cb.credit), 0) AS c
        FROM cb_lines cb
        JOIN accounts a ON a.id = cb.account_id AND a.tenant_id = ${tenantId}
        WHERE ${typeCond} AND ${lens}
        GROUP BY 1, 2, 3, 4
      `)
    : await db.execute(sql`
        SELECT jl.account_id, a.account_type, ${keyExpr} AS k, ${preExpr} AS pre,
          COALESCE(SUM(jl.debit), 0) AS d, COALESCE(SUM(jl.credit), 0) AS c
        FROM journal_lines jl
        JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
        JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = ${tenantId}
        WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
          AND t.basis <> 'cash'
          ${o.from ? sql`AND t.txn_date >= ${o.from}` : sql``}
          AND t.txn_date <= ${o.to}
          AND ${o.companyId ? sql`t.company_id = ${o.companyId}` : sql`TRUE`}
          AND ${adjustingCond(o.adjusting, 't.is_adjusting')}
          AND ${typeCond} AND ${lens}
        GROUP BY 1, 2, 3, 4
      `);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    accountId: String(r['account_id']),
    accountType: String(r['account_type']),
    key: (r['k'] as string | null) ?? null,
    pre: r['pre'] === true,
    debit: dec(r['d'] as string),
    credit: dec(r['c'] as string),
  }));
}

/** Natural sign of an account type: debit-normal types read debit - credit. */
export function isDebitNormalType(accountType: string): boolean {
  return accountType === 'asset' || accountType === 'cogs' || accountType === 'expense' || accountType === 'other_expense';
}

export function naturalAmount(accountType: string, debit: Dec, credit: Dec): Dec {
  return isDebitNormalType(accountType) ? debit.minus(credit) : credit.minus(debit);
}

export interface GroupTag { id: string; name: string; tagNumber: string | null; sortOrder: number }

/** A tag group's tags in display order, or null when the group is not the tenant's. */
export async function loadGroupTags(tenantId: string, groupId: string): Promise<GroupTag[] | null> {
  const g = await db.execute(sql`SELECT id FROM tag_groups WHERE id = ${groupId}::uuid AND tenant_id = ${tenantId}`);
  if (g.rows.length === 0) return null;
  const res = await db.execute(sql`
    SELECT id, name, tag_number, COALESCE(sort_order, 0) AS sort_order FROM tags
    WHERE tenant_id = ${tenantId} AND group_id = ${groupId}::uuid
    ORDER BY COALESCE(sort_order, 0), tag_number NULLS LAST, name, id
  `);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r['id']), name: String(r['name'] ?? ''), tagNumber: (r['tag_number'] as string | null) ?? null,
    sortOrder: Number(r['sort_order'] ?? 0),
  }));
}
