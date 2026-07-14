// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';
import { periodDateClause } from './period.js';
import { money, summaryLine } from './present.js';

// `duplicate_candidate` — two transactions in the same window
// with the same vendor + same total. Both halves of the pair
// are flagged as findings (the bookkeeper resolves whichever).
export const handler: CheckHandler = async (tenantId, companyId, params): Promise<FindingDraft[]> => {
  const windowDays = Math.max(1, Number(params['windowDays'] ?? 7));
  const companyClause = companyId
    ? sql`AND t1.company_id = ${companyId} AND t2.company_id = ${companyId}`
    : sql``;
  // Both halves of a candidate pair must fall inside the period.
  const period1Clause = periodDateClause(params, 't1.txn_date');
  const period2Clause = periodDateClause(params, 't2.txn_date');

  const result = await db.execute<{
    a_id: string; b_id: string; contact_id: string; total: string;
    vendor_name: string | null; a_date: string; b_date: string;
  }>(sql`
    SELECT
      LEAST(t1.id, t2.id) AS a_id,
      GREATEST(t1.id, t2.id) AS b_id,
      t1.contact_id,
      t1.total,
      c.display_name AS vendor_name,
      LEAST(t1.txn_date, t2.txn_date) AS a_date,
      GREATEST(t1.txn_date, t2.txn_date) AS b_date
    FROM transactions t1
    LEFT JOIN contacts c ON c.id = t1.contact_id
    JOIN transactions t2 ON
      t1.tenant_id = t2.tenant_id
      AND t1.id < t2.id
      AND t1.contact_id = t2.contact_id
      AND t1.txn_type = t2.txn_type
      AND t1.total = t2.total
      AND ABS(EXTRACT(EPOCH FROM (t1.txn_date::TIMESTAMP - t2.txn_date::TIMESTAMP))) <= ${windowDays * 24 * 3600}
    WHERE t1.tenant_id = ${tenantId}
      ${companyClause}
      ${period1Clause}
      ${period2Clause}
      AND t1.contact_id IS NOT NULL
      AND t1.status = 'posted'
      AND t2.status = 'posted'
    LIMIT 500
  `);

  // Emit one finding per pair, attached to the EARLIER half;
  // the payload notes the partner so the UI can link both.
  return (result.rows as Array<{
    a_id: string; b_id: string; contact_id: string; total: string;
    vendor_name: string | null; a_date: string; b_date: string;
  }>).map((r) => ({
    checkKey: 'duplicate_candidate',
    transactionId: r.a_id,
    vendorId: r.contact_id,
    payload: {
      summary: summaryLine(r.vendor_name, money(r.total), `${r.a_date} and ${r.b_date}`),
      vendorName: r.vendor_name,
      total: r.total,
      windowDays,
      reason: r.vendor_name
        ? `Two ${money(r.total)} transactions for "${r.vendor_name}" landed within ${windowDays} days of each other (${r.a_date} and ${r.b_date}).`
        : `Two transactions with the same vendor and total (${money(r.total)}) landed within ${windowDays} days.`,
      suggestion: 'Open both transactions and compare references, payment method, and memo. If one is a duplicate, void it (never delete) so the audit trail stays intact; if both are real — e.g. a recurring charge — resolve with a short note.',
      partnerTransactionId: r.b_id,
      // Pair-level dedupe key — the same pair re-fires across
      // runs would otherwise create duplicate findings.
      dedupe_key: `pair:${r.a_id}:${r.b_id}`,
    },
  }));
};
