// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';
import { periodDateClause } from './period.js';
import { money, summaryLine } from './present.js';

// `missing_required_customer` — invoice or customer-payment
// transaction with no contact_id. The build plan asked for
// "missing required class/location/customer"; class+location
// don't yet exist in the schema (deferred from Phase 4), so
// v1 limits to the customer half. Class/location can be added
// to this check's body when those columns ship.
export const handler: CheckHandler = async (tenantId, companyId, params): Promise<FindingDraft[]> => {
  const companyClause = companyId
    ? sql`AND company_id = ${companyId}`
    : sql``;
  const periodClause = periodDateClause(params, 'txn_date');

  const result = await db.execute<{ id: string; txn_type: string; total: string; txn_date: string }>(sql`
    SELECT id, txn_type, total, txn_date
    FROM transactions
    WHERE tenant_id = ${tenantId}
      ${companyClause}
      ${periodClause}
      AND txn_type IN ('invoice', 'customer_payment')
      AND status = 'posted'
      AND contact_id IS NULL
    LIMIT 500
  `);

  return (result.rows as Array<{ id: string; txn_type: string; total: string; txn_date: string }>).map((r) => ({
    checkKey: 'missing_required_customer',
    transactionId: r.id,
    payload: {
      summary: summaryLine(r.txn_date, r.txn_type.replace('_', ' '), money(r.total)),
      txnType: r.txn_type,
      total: r.total,
      txnDate: r.txn_date,
      reason: `This ${r.txn_type.replace('_', ' ')} has no customer on it — invoices and customer payments should always name who owes or paid.`,
      suggestion: 'Open the transaction and select the customer. Without it, A/R aging, customer statements, and income-by-customer reports are all missing this activity.',
    },
  }));
};
