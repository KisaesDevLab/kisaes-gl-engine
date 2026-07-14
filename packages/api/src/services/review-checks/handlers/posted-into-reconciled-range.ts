// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';
import { money, summaryLine } from './present.js';

// `posted_into_reconciled_range` — a transaction dated on or before an
// account's last completed-reconciliation statement date, but created
// AFTER that reconciliation was signed off, and not part of its cleared
// set. The ledger write-guards make it impossible to CHANGE reconciled
// activity; this catches the one legal path left — brand-new backdated
// entries landing inside an already-reconciled window. Sometimes
// legitimate (a late-recorded deposit in transit), always worth a look:
// it will surface as a surprise opening item in the next reconciliation.
export const handler: CheckHandler = async (tenantId, companyId): Promise<FindingDraft[]> => {
  const companyClause = companyId
    ? sql`AND r.company_id = ${companyId}`
    : sql``;

  const result = await db.execute<{
    id: string; txn_type: string; txn_date: string; total: string; created_at: string;
    account_id: string; account_name: string; statement_date: string; payee: string | null;
  }>(sql`
    WITH last_rec AS (
      SELECT DISTINCT ON (r.account_id)
        r.account_id, r.statement_date, r.completed_at
      FROM reconciliations r
      WHERE r.tenant_id = ${tenantId}
        ${companyClause}
        AND r.status = 'complete'
      ORDER BY r.account_id, r.statement_date DESC
    )
    SELECT DISTINCT t.id, t.txn_type, t.txn_date, t.total, t.created_at,
      lr.account_id, a.name AS account_name, lr.statement_date,
      c.display_name AS payee
    FROM last_rec lr
    JOIN journal_lines jl ON jl.account_id = lr.account_id AND jl.tenant_id = ${tenantId}
    JOIN transactions t ON t.id = jl.transaction_id AND t.status = 'posted'
    JOIN accounts a ON a.id = lr.account_id
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE t.txn_date <= lr.statement_date
      AND t.created_at > lr.completed_at
      AND NOT EXISTS (
        SELECT 1 FROM reconciliation_lines rl
        JOIN reconciliations r2 ON r2.id = rl.reconciliation_id
        WHERE rl.journal_line_id = jl.id
          AND rl.is_cleared = TRUE
          AND r2.status = 'complete'
      )
    LIMIT 200
  `);

  return (result.rows as Array<{
    id: string; txn_type: string; txn_date: string; total: string; created_at: string;
    account_id: string; account_name: string; statement_date: string; payee: string | null;
  }>).map((r) => ({
    checkKey: 'posted_into_reconciled_range',
    transactionId: r.id,
    payload: {
      summary: summaryLine(r.txn_date, r.payee ?? r.txn_type, money(r.total), r.account_name),
      accountName: r.account_name,
      txnDate: r.txn_date,
      statementDate: r.statement_date,
      total: r.total,
      createdAt: r.created_at,
      reason: `This ${r.txn_type} is dated ${r.txn_date} — on or before "${r.account_name}"'s last reconciled statement date (${r.statement_date}) — but was entered after that reconciliation was signed off.`,
      suggestion: 'Verify the backdated entry is real (a late-recorded deposit in transit or bank fee is fine). Expect it as an uncleared opening item in the next reconciliation; if it duplicates something already reconciled, void it now.',
      dedupe_key: `txn:${r.id}:acct:${r.account_id}`,
    },
  }));
};
