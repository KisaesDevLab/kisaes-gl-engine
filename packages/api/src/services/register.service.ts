// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and, sql } from 'drizzle-orm';
import { isDebitNormal } from '@kis-books/shared';
import { db } from '../db/index.js';
import { accounts, journalLines, transactions, contacts, reconciliationLines, reconciliations } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { escapeLike } from '../utils/sql-like.js';
import DecimalLib from 'decimal.js';

const Decimal = DecimalLib.default || DecimalLib;
type DecimalT = InstanceType<typeof Decimal>;

// The historical JSON-number shape: balances rounded to cents.
function legacyCents(d: DecimalT): number {
  return Number(d.toFixed(2));
}

// Exact shape: the decimal(19,4) value as text, never through a JS number.
export function exactMoney(d: DecimalT): string {
  return d.toFixed(4);
}

function moneyFormatter(exact: boolean | undefined) {
  return {
    balance: (d: DecimalT): RegisterMoney => (exact ? exactMoney(d) : legacyCents(d)),
    amount: (d: DecimalT): RegisterMoney => (exact ? exactMoney(d) : d.toNumber()),
  };
}

interface RegisterFilters {
  startDate?: string;
  endDate?: string;
  txnType?: string;
  payee?: string;
  search?: string;
  // Matches the line's reconciliationStatus exactly ('cleared' = cleared
  // but not yet in a completed reconciliation); 'all' or absent = no filter.
  reconciled?: 'cleared' | 'reconciled' | 'uncleared' | 'all';
  // Transactions carrying this tag on any of their journal lines.
  tagId?: string;
  // Strings, not numbers — money is `decimal(19,4)` per CLAUDE.md.
  // Round-tripping through `parseFloat` introduces IEEE754 drift on
  // edge values; passing the raw string lets PostgreSQL parse with
  // arbitrary precision. The validator below rejects anything that's
  // not a positive decimal so the SQL bind never sees garbage.
  minAmount?: string;
  maxAmount?: string;
  includeVoid?: boolean;
  sortBy?: 'date' | 'ref_no' | 'type' | 'amount';
  sortDir?: 'asc' | 'desc';
  page?: number;
  perPage?: number;
  // `?exact=1` (capability register-exact-v1): every money field is a
  // decimal string with the column's four decimals instead of a rounded
  // JSON number. The number shape stays the default for existing clients.
  exact?: boolean;
}

/** A money value: a JSON number (default) or an exact decimal string (`exact`). */
export type RegisterMoney = number | string;

interface RegisterLine<M extends RegisterMoney = RegisterMoney> {
  lineId: string;
  transactionId: string;
  txnType: string;
  txnNumber: string | null;
  checkNumber: number | null;
  txnDate: string;
  payeeName: string | null;
  contactId: string | null;
  accountName: string | null;
  accountId: string | null;
  categoryName: string | null;
  categoryAccountId: string | null;
  memo: string | null;
  payment: M | null;
  deposit: M | null;
  runningBalance: M;
  reconciliationStatus: 'cleared' | 'reconciled' | 'uncleared';
  hasAttachments: boolean;
  hasSplits: boolean;
  isEditable: boolean;
  status: string;
}

// Determine which inline transaction types are allowed per account detail type
function getAllowedEntryTypes(detailType: string | null, accountType: string): string[] {
  switch (detailType) {
    case 'bank':
      return ['expense', 'deposit', 'transfer', 'journal_entry'];
    case 'credit_card':
      return ['expense', 'transfer', 'journal_entry'];
    case 'accounts_receivable':
    case 'other_current_asset':
      if (detailType === 'accounts_receivable') return []; // read-only
      return ['journal_entry', 'deposit'];
    case 'fixed_asset':
      return ['journal_entry'];
    case 'accounts_payable':
    case 'other_current_liability':
      return ['journal_entry'];
    case 'long_term_liability':
      return ['journal_entry', 'expense'];
    default:
      // Fallback by account type
      if (accountType === 'asset') return ['journal_entry', 'deposit'];
      if (accountType === 'liability') return ['journal_entry'];
      if (accountType === 'equity') return ['journal_entry'];
      return [];
  }
}

type RegisterResultOf<M extends RegisterMoney> =
  Omit<Awaited<ReturnType<typeof buildRegister>>, 'balanceForward' | 'endingBalance' | 'lines'>
  & { balanceForward: M; endingBalance: M; lines: RegisterLine<M>[] };

// Overloads keep the money type precise for callers: numbers by default,
// strings when `exact: true`.
export function getRegister(tenantId: string, accountId: string, filters: RegisterFilters & { exact: true }): Promise<RegisterResultOf<string>>;
export function getRegister(tenantId: string, accountId: string, filters: RegisterFilters & { exact?: false | undefined }): Promise<RegisterResultOf<number>>;
export function getRegister(tenantId: string, accountId: string, filters: RegisterFilters): Promise<RegisterResultOf<RegisterMoney>>;
export function getRegister(tenantId: string, accountId: string, filters: RegisterFilters) {
  return buildRegister(tenantId, accountId, filters);
}

async function buildRegister(tenantId: string, accountId: string, filters: RegisterFilters) {
  // Validate account
  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId)),
  });
  if (!account) throw AppError.notFound('Account not found');

  const debitNormal = isDebitNormal(account.accountType);
  const money = moneyFormatter(filters.exact);
  const page = filters.page || 1;
  const perPage = Math.min(filters.perPage || 50, 200);
  const offset = (page - 1) * perPage;

  // Default date range: last 90 days
  const today = new Date().toISOString().split('T')[0]!;
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0]!;
  const startDate = filters.startDate || ninetyDaysAgo;
  const endDate = filters.endDate || today;

  // Balances are filter-independent (Q-187): every figure below is the
  // account's true ledger balance, whatever the quick filters hide. Only
  // POSTED transactions move a balance — drafts and voids carry a zero delta,
  // matching accounts.balance (updateAccountBalances runs for posted only).
  const postedDelta = debitNormal
    ? sql`CASE WHEN t.status = 'posted' THEN jl.debit - jl.credit ELSE 0 END`
    : sql`CASE WHEN t.status = 'posted' THEN jl.credit - jl.debit ELSE 0 END`;

  // Balance forward (before startDate) and ending balance (through endDate)
  // in one pass, unfiltered.
  const bfResult = await db.execute(sql`
    SELECT
      COALESCE(SUM(${postedDelta}) FILTER (WHERE t.txn_date < ${startDate}), 0)::text AS balance_forward,
      COALESCE(SUM(${postedDelta}), 0)::text AS ending_balance
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
    WHERE jl.tenant_id = ${tenantId}
      AND jl.account_id = ${accountId}
      AND t.txn_date <= ${endDate}
  `);
  const bfRow = (bfResult.rows as any[])[0] || {};
  const balanceForward = new Decimal(bfRow.balance_forward ?? '0');
  const endingBalanceDec = new Decimal(bfRow.ending_balance ?? '0');

  // Build parameterized WHERE conditions (applied OUTSIDE the running
  // balance window, so filters choose rows but never change a balance).
  const sqlConditions = [
    sql`l.txn_date >= ${startDate}`,
  ];

  if (!filters.includeVoid) {
    sqlConditions.push(sql`l.status != 'void'`);
  }
  if (filters.txnType) {
    sqlConditions.push(sql`l.txn_type = ${filters.txnType}`);
  }
  if (filters.payee) {
    sqlConditions.push(sql`c.display_name ILIKE ${'%' + escapeLike(filters.payee) + '%'}`);
  }
  if (filters.search) {
    const pattern = '%' + escapeLike(filters.search) + '%';
    sqlConditions.push(sql`(c.display_name ILIKE ${pattern} OR l.memo ILIKE ${pattern} OR l.txn_number ILIKE ${pattern})`);
  }
  if (filters.minAmount !== undefined) {
    sqlConditions.push(sql`(l.debit >= ${filters.minAmount} OR l.credit >= ${filters.minAmount})`);
  }
  if (filters.maxAmount !== undefined) {
    sqlConditions.push(sql`(l.debit <= ${filters.maxAmount} AND l.credit <= ${filters.maxAmount})`);
  }
  switch (filters.reconciled) {
    case 'reconciled':
      sqlConditions.push(sql`rec.is_reconciled`);
      break;
    case 'cleared':
      sqlConditions.push(sql`(rec.is_cleared AND NOT rec.is_reconciled)`);
      break;
    case 'uncleared':
      sqlConditions.push(sql`NOT rec.is_cleared`);
      break;
    default:
      break;
  }
  if (filters.tagId) {
    // Same rule as the transaction list's tag filter: any line of the
    // transaction carries the tag (journal_lines.tag_id is the source of
    // truth; transaction_tags is only maintained under TAGS_SPLIT_LEVEL_V2).
    sqlConditions.push(sql`EXISTS (
      SELECT 1 FROM journal_lines tj
      WHERE tj.transaction_id = l.transaction_id
        AND tj.tenant_id = ${tenantId}
        AND tj.tag_id = ${filters.tagId}
    )`);
  }

  const whereClause = sql.join(sqlConditions, sql` AND `);

  // Every line of the account through endDate with its cumulative signed
  // delta in canonical ledger order (date, entry time, line id). The window
  // runs over the WHOLE account history, before any filter, sort or page,
  // so a row's running balance is the true balance after it.
  const ledgerCte = sql`
    WITH l AS (
      SELECT
        jl.id AS line_id,
        jl.transaction_id,
        jl.debit,
        jl.credit,
        jl.description AS line_description,
        t.txn_type,
        t.txn_number,
        t.check_number,
        t.txn_date,
        t.created_at,
        t.status,
        t.memo,
        t.contact_id,
        SUM(${postedDelta}) OVER (
          ORDER BY t.txn_date ASC, t.created_at ASC, jl.id ASC
          ROWS UNBOUNDED PRECEDING
        ) AS running_balance
      FROM journal_lines jl
      JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
      WHERE jl.tenant_id = ${tenantId}
        AND jl.account_id = ${accountId}
        AND t.txn_date <= ${endDate}
    )
  `;

  // Rows plus the joins the filters read: payee name and the line's
  // reconciliation status, collapsed to ONE row per journal line. A line
  // gets a reconciliation_lines row in every reconciliation whose worksheet
  // it appears on, so an item left outstanding for months has one per
  // month; joining those rows directly would duplicate the line.
  const filteredFrom = sql`
    FROM l
    LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = ${tenantId}
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(BOOL_OR(rl.is_cleared), false) AS is_cleared,
        COALESCE(BOOL_OR(rl.is_cleared AND r.status = 'complete'), false) AS is_reconciled
      FROM reconciliation_lines rl
      JOIN reconciliations r ON r.id = rl.reconciliation_id AND r.tenant_id = ${tenantId}
      WHERE rl.journal_line_id = l.line_id
    ) rec ON true
  `;

  // Display sort — independent of the running balance. Sort columns are a
  // fixed switch, never interpolated from user input.
  const dir = filters.sortDir === 'desc' ? sql`DESC` : sql`ASC`;
  let orderClause;
  switch (filters.sortBy) {
    case 'amount':
      orderClause = sql`GREATEST(l.debit, l.credit) ${dir}, l.txn_date ASC, l.line_id ASC`;
      break;
    case 'type':
      orderClause = sql`l.txn_type ${dir}, l.txn_date ASC, l.line_id ASC`;
      break;
    case 'ref_no':
      orderClause = sql`l.txn_number ${dir} NULLS LAST, l.txn_date ASC, l.line_id ASC`;
      break;
    default:
      orderClause = sql`l.txn_date ${dir}, l.created_at ${dir}, l.line_id ${dir}`;
  }

  const countResult = await db.execute(sql`
    ${ledgerCte}
    SELECT COUNT(*) AS total
    ${filteredFrom}
    WHERE ${whereClause}
  `);
  const countRow = (countResult.rows as any[])[0] || {};
  const totalRows = parseInt(countRow.total || '0');

  // Fetch page
  const dataResult = await db.execute(sql`
    ${ledgerCte}
    SELECT
      l.line_id,
      l.transaction_id,
      l.debit::text AS debit,
      l.credit::text AS credit,
      l.line_description,
      l.txn_type,
      l.txn_number,
      l.check_number,
      l.txn_date,
      l.status,
      l.memo,
      l.contact_id,
      c.display_name AS payee_name,
      rec.is_cleared,
      rec.is_reconciled,
      cat.category_name,
      cat.category_account_id,
      l.running_balance::text AS running_balance
    ${filteredFrom}
    -- Resolve the "other side" account(s) for the transaction. If exactly one
    -- distinct account other than the one being viewed, show its name/id.
    -- If more than one, it's a split. Scoped to tenant throughout.
    LEFT JOIN LATERAL (
      SELECT
        CASE
          WHEN COUNT(DISTINCT oa.id) > 1 THEN '— Split —'
          ELSE MIN(oa.name)
        END AS category_name,
        CASE
          WHEN COUNT(DISTINCT oa.id) = 1 THEN MIN(oa.id::text)
          ELSE NULL
        END AS category_account_id
      FROM journal_lines ojl
      JOIN accounts oa ON oa.id = ojl.account_id AND oa.tenant_id = ${tenantId}
      WHERE ojl.transaction_id = l.transaction_id
        AND ojl.tenant_id = ${tenantId}
        AND ojl.account_id <> ${accountId}
    ) cat ON true
    WHERE ${whereClause}
    ORDER BY ${orderClause}
    LIMIT ${perPage} OFFSET ${offset}
  `);

  // Check which transactions have splits (>1 journal line)
  const txnIds = [...new Set((dataResult.rows as any[]).map((r: any) => r.transaction_id))];
  const splitCounts = new Map<string, number>();
  if (txnIds.length > 0) {
    const splitResult = await db.execute(sql`
      SELECT transaction_id, COUNT(*) as cnt
      FROM journal_lines
      WHERE transaction_id IN (${sql.join(txnIds.map(id => sql`${id}`), sql`,`)})
      GROUP BY transaction_id
      HAVING COUNT(*) > 2
    `);
    for (const row of splitResult.rows as any[]) {
      splitCounts.set(row.transaction_id, parseInt(row.cnt));
    }
  }

  const lines: RegisterLine[] = (dataResult.rows as any[]).map((row: any) => {
    const debit = new Decimal(row.debit ?? '0');
    const credit = new Decimal(row.credit ?? '0');
    // Balance after this row: the account's whole-history cumulative
    // posted delta in canonical order (window in the CTE) — correct on any
    // page, under any display sort and under any filter.
    const runningBalance = new Decimal(row.running_balance ?? '0');

    // Payment/deposit relative to account normal balance
    let payment: DecimalT | null = null;
    let deposit: DecimalT | null = null;
    if (debitNormal) {
      // Asset/expense: debit = increase (deposit), credit = decrease (payment)
      if (credit.gt(0)) payment = credit;
      if (debit.gt(0)) deposit = debit;
    } else {
      // Liability/equity/revenue: credit = increase (deposit), debit = decrease (payment)
      if (debit.gt(0)) payment = debit;
      if (credit.gt(0)) deposit = credit;
    }

    // Reconciliation status
    let reconciliationStatus: 'cleared' | 'reconciled' | 'uncleared' = 'uncleared';
    if (row.is_reconciled) {
      reconciliationStatus = 'reconciled';
    } else if (row.is_cleared) {
      reconciliationStatus = 'cleared';
    }

    // The real "other side" account, resolved via the lateral join above.
    // A transaction with >1 distinct other-side account is a split.
    const categoryName: string | null = row.category_name ?? null;
    const categoryAccountId: string | null = row.category_account_id ?? null;

    // Payee fallback: prefer the contact display name, then fall back to a
    // human-readable label for imported rows that have no linked contact
    // (transaction memo, then the journal line description).
    const payeeName: string | null = row.payee_name ?? row.memo ?? row.line_description ?? null;

    return {
      lineId: row.line_id,
      transactionId: row.transaction_id,
      txnType: row.txn_type,
      txnNumber: row.txn_number,
      checkNumber: row.check_number != null ? Number(row.check_number) : null,
      txnDate: row.txn_date,
      payeeName,
      contactId: row.contact_id,
      accountName: categoryName,
      accountId: categoryAccountId,
      categoryName,
      categoryAccountId,
      memo: row.memo,
      payment: payment ? money.amount(payment) : null,
      deposit: deposit ? money.amount(deposit) : null,
      runningBalance: money.balance(runningBalance),
      reconciliationStatus,
      hasAttachments: false, // would need join to attachments
      hasSplits: splitCounts.has(row.transaction_id),
      isEditable: reconciliationStatus !== 'reconciled' && row.status !== 'void',
      status: row.status,
    };
  });

  return {
    account: {
      id: account.id,
      name: account.name,
      accountType: account.accountType,
      detailType: account.detailType,
      accountNumber: account.accountNumber,
    },
    balanceForward: money.balance(balanceForward),
    // The account's balance at endDate, independent of filters and paging.
    endingBalance: money.balance(endingBalanceDec),
    filtersApplied: { startDate, endDate, ...filters },
    pagination: {
      page,
      perPage,
      totalRows,
      totalPages: Math.ceil(totalRows / perPage),
    },
    allowedEntryTypes: getAllowedEntryTypes(account.detailType, account.accountType),
    lines,
  };
}

export async function getRegisterSummary(tenantId: string, accountId: string, opts: { exact?: boolean } = {}) {
  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId)),
  });
  if (!account) throw AppError.notFound('Account not found');

  // Current balance (the stored accounts.balance, as before)
  const currentBalanceDec = new Decimal(account.balance ?? '0');
  const currentBalance: RegisterMoney = opts.exact ? exactMoney(currentBalanceDec) : currentBalanceDec.toNumber();

  // Uncleared count
  const unclearedResult = await db.execute(sql`
    SELECT COUNT(*) as cnt
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id
    WHERE jl.tenant_id = ${tenantId} AND jl.account_id = ${accountId} AND t.status = 'posted'
      AND jl.id NOT IN (
        SELECT rl.journal_line_id FROM reconciliation_lines rl
        JOIN reconciliations r ON r.id = rl.reconciliation_id
        WHERE r.tenant_id = ${tenantId} AND r.account_id = ${accountId}
          AND rl.is_cleared = true
      )
  `);
  const unclearedCount = parseInt((unclearedResult.rows as any[])[0]?.cnt || '0');

  // Last reconciliation date
  const lastRecon = await db.query.reconciliations.findFirst({
    where: and(
      eq(reconciliations.tenantId, tenantId),
      eq(reconciliations.accountId, accountId),
      eq(reconciliations.status, 'complete'),
    ),
  });

  // Transaction count this period (current month)
  const now = new Date();
  // UTC getters — local getters shifted the month boundary by a day in
  // non-UTC containers (same class of bug as the report FY boundaries).
  const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const txnCountResult = await db.execute(sql`
    SELECT COUNT(*) as cnt FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id
    WHERE jl.tenant_id = ${tenantId} AND jl.account_id = ${accountId}
      AND t.status = 'posted' AND t.txn_date >= ${monthStart}
  `);

  return {
    currentBalance,
    unclearedCount,
    lastReconciliationDate: lastRecon?.statementDate || null,
    transactionsThisPeriod: parseInt((txnCountResult.rows as any[])[0]?.cnt || '0'),
  };
}
