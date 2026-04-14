import { eq, and, sql } from 'drizzle-orm';
import { isDebitNormal } from '@kis-books/shared';
import { db } from '../db/index.js';
import { accounts, journalLines, transactions, contacts, reconciliationLines, reconciliations } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

interface RegisterFilters {
  startDate?: string;
  endDate?: string;
  txnType?: string;
  payee?: string;
  search?: string;
  reconciled?: 'cleared' | 'reconciled' | 'uncleared' | 'all';
  minAmount?: number;
  maxAmount?: number;
  includeVoid?: boolean;
  sortBy?: 'date' | 'ref_no' | 'type' | 'amount';
  sortDir?: 'asc' | 'desc';
  page?: number;
  perPage?: number;
}

interface RegisterLine {
  lineId: string;
  transactionId: string;
  txnType: string;
  txnNumber: string | null;
  txnDate: string;
  payeeName: string | null;
  contactId: string | null;
  accountName: string | null;
  accountId: string | null;
  memo: string | null;
  payment: number | null;
  deposit: number | null;
  runningBalance: number;
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

export async function getRegister(tenantId: string, accountId: string, filters: RegisterFilters) {
  // Validate account
  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId)),
  });
  if (!account) throw AppError.notFound('Account not found');

  const debitNormal = isDebitNormal(account.accountType);
  const page = filters.page || 1;
  const perPage = Math.min(filters.perPage || 50, 200);
  const offset = (page - 1) * perPage;

  // Default date range: last 90 days
  const today = new Date().toISOString().split('T')[0]!;
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0]!;
  const startDate = filters.startDate || ninetyDaysAgo;
  const endDate = filters.endDate || today;

  // Compute balance_forward: sum of all lines before startDate
  const bfResult = await db.execute(sql`
    SELECT
      COALESCE(SUM(jl.debit), 0) as total_debit,
      COALESCE(SUM(jl.credit), 0) as total_credit
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id
    WHERE jl.tenant_id = ${tenantId}
      AND jl.account_id = ${accountId}
      AND t.status != 'void'
      AND t.txn_date < ${startDate}
  `);
  const bfRow = (bfResult.rows as any[])[0] || { total_debit: '0', total_credit: '0' };
  const balanceForward = debitNormal
    ? parseFloat(bfRow.total_debit) - parseFloat(bfRow.total_credit)
    : parseFloat(bfRow.total_credit) - parseFloat(bfRow.total_debit);

  // Build parameterized WHERE conditions
  const sqlConditions = [
    sql`jl.tenant_id = ${tenantId}`,
    sql`jl.account_id = ${accountId}`,
    sql`t.txn_date >= ${startDate}`,
    sql`t.txn_date <= ${endDate}`,
  ];

  if (!filters.includeVoid) {
    sqlConditions.push(sql`t.status != 'void'`);
  }
  if (filters.txnType) {
    sqlConditions.push(sql`t.txn_type = ${filters.txnType}`);
  }
  if (filters.payee) {
    sqlConditions.push(sql`c.display_name ILIKE ${'%' + filters.payee + '%'}`);
  }
  if (filters.search) {
    const pattern = '%' + filters.search + '%';
    sqlConditions.push(sql`(c.display_name ILIKE ${pattern} OR t.memo ILIKE ${pattern} OR t.txn_number ILIKE ${pattern})`);
  }
  if (filters.minAmount !== undefined) {
    sqlConditions.push(sql`(jl.debit >= ${filters.minAmount} OR jl.credit >= ${filters.minAmount})`);
  }
  if (filters.maxAmount !== undefined) {
    sqlConditions.push(sql`(jl.debit <= ${filters.maxAmount} AND jl.credit <= ${filters.maxAmount})`);
  }

  const whereClause = sql.join(sqlConditions, sql` AND `);

  // Sort — always compute in ASC for correct running balance, reverse later if DESC
  const requestedDesc = filters.sortDir === 'desc';
  // For running balance correctness, always query in ascending date order
  const orderClause = sql`t.txn_date ASC, t.created_at ASC`;

  // Count total
  const countResult = await db.execute(sql`
    SELECT COUNT(*) as total
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE ${whereClause}
  `);
  const totalRows = parseInt((countResult.rows as any[])[0]?.total || '0');

  // Fetch page
  const dataResult = await db.execute(sql`
    SELECT
      jl.id AS line_id,
      jl.transaction_id,
      jl.debit,
      jl.credit,
      jl.description AS line_description,
      t.txn_type,
      t.txn_number,
      t.txn_date,
      t.status,
      t.memo,
      t.contact_id,
      c.display_name AS payee_name,
      rl.is_cleared,
      r.status AS recon_status
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
    LEFT JOIN reconciliation_lines rl ON rl.journal_line_id = jl.id
    LEFT JOIN reconciliations r ON r.id = rl.reconciliation_id
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

  // Build response lines with running balance
  let runningBalance = balanceForward;

  // If we're on page > 1, we need balance at end of previous pages
  if (offset > 0) {
    const priorResult = await db.execute(sql`
      SELECT COALESCE(SUM(sub.debit), 0) as td, COALESCE(SUM(sub.credit), 0) as tc
      FROM (
        SELECT jl.debit, jl.credit
        FROM journal_lines jl
        JOIN transactions t ON t.id = jl.transaction_id
        LEFT JOIN contacts c ON c.id = t.contact_id
        WHERE ${whereClause}
        ORDER BY ${orderClause}
        LIMIT ${offset}
      ) sub
    `);
    const pr = (priorResult.rows as any[])[0] || { td: '0', tc: '0' };
    if (debitNormal) {
      runningBalance += parseFloat(pr.td) - parseFloat(pr.tc);
    } else {
      runningBalance += parseFloat(pr.tc) - parseFloat(pr.td);
    }
  }

  const lines: RegisterLine[] = (dataResult.rows as any[]).map((row: any) => {
    const debit = parseFloat(row.debit);
    const credit = parseFloat(row.credit);

    // Payment/deposit relative to account normal balance
    let payment: number | null = null;
    let deposit: number | null = null;
    if (debitNormal) {
      // Asset/expense: debit = increase (deposit), credit = decrease (payment)
      if (credit > 0) payment = credit;
      if (debit > 0) deposit = debit;
      runningBalance += debit - credit;
    } else {
      // Liability/equity/revenue: credit = increase (deposit), debit = decrease (payment)
      if (debit > 0) payment = debit;
      if (credit > 0) deposit = credit;
      runningBalance += credit - debit;
    }

    // Reconciliation status
    let reconciliationStatus: 'cleared' | 'reconciled' | 'uncleared' = 'uncleared';
    if (row.recon_status === 'complete' && row.is_cleared) {
      reconciliationStatus = 'reconciled';
    } else if (row.is_cleared) {
      reconciliationStatus = 'cleared';
    }

    // Get the "other side" account name — we'd need another query for this
    // For now, use line_description or memo
    const otherAccountName = row.line_description || null;

    return {
      lineId: row.line_id,
      transactionId: row.transaction_id,
      txnType: row.txn_type,
      txnNumber: row.txn_number,
      txnDate: row.txn_date,
      payeeName: row.payee_name,
      contactId: row.contact_id,
      accountName: otherAccountName,
      accountId: null, // would need join to get the "other side" account
      memo: row.memo,
      payment,
      deposit,
      runningBalance: Math.round(runningBalance * 100) / 100,
      reconciliationStatus,
      hasAttachments: false, // would need join to attachments
      hasSplits: splitCounts.has(row.transaction_id),
      isEditable: reconciliationStatus !== 'reconciled' && row.status !== 'void',
      status: row.status,
    };
  });

  const endingBalance = lines.length > 0 ? lines[lines.length - 1]!.runningBalance : balanceForward;

  // Reverse lines if descending sort was requested
  if (requestedDesc) {
    lines.reverse();
  }

  return {
    account: {
      id: account.id,
      name: account.name,
      accountType: account.accountType,
      detailType: account.detailType,
      accountNumber: account.accountNumber,
    },
    balanceForward: Math.round(balanceForward * 100) / 100,
    endingBalance: Math.round(endingBalance * 100) / 100,
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

export async function getRegisterSummary(tenantId: string, accountId: string) {
  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId)),
  });
  if (!account) throw AppError.notFound('Account not found');

  // Current balance
  const currentBalance = parseFloat(account.balance ?? '0');

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
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
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
