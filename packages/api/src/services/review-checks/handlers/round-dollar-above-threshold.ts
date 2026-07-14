// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';
import { periodDateClause } from './period.js';
import { money, summaryLine } from './present.js';

// `round_dollar_above_threshold` — transactions with whole-
// dollar totals at or above the threshold. Common indicator of
// estimates, made-up entries, or fraudulent round numbers.
// Default threshold $500.
export const handler: CheckHandler = async (tenantId, companyId, params): Promise<FindingDraft[]> => {
  const threshold = Number(params['thresholdAmount'] ?? 500);
  const companyClause = companyId
    ? sql`AND t.company_id = ${companyId}`
    : sql``;
  const periodClause = periodDateClause(params, 't.txn_date');

  const result = await db.execute<{ id: string; total: string; txn_type: string; txn_date: string; payee: string | null }>(sql`
    SELECT t.id, t.total, t.txn_type, t.txn_date, c.display_name AS payee
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE t.tenant_id = ${tenantId}
      ${companyClause}
      ${periodClause}
      AND t.status = 'posted'
      AND t.total >= ${threshold}
      AND (t.total::TEXT NOT LIKE '%.%' OR t.total::TEXT LIKE '%.0000' OR t.total::TEXT LIKE '%.00')
    LIMIT 500
  `);

  return (result.rows as Array<{ id: string; total: string; txn_type: string; txn_date: string; payee: string | null }>).map((r) => ({
    checkKey: 'round_dollar_above_threshold',
    transactionId: r.id,
    payload: {
      summary: summaryLine(r.txn_date, r.payee ?? r.txn_type, money(r.total)),
      total: r.total,
      txnType: r.txn_type,
      threshold,
      reason: `This ${r.txn_type} is an exactly round ${money(r.total)}. Round amounts are often estimates, placeholders, or typos rather than real invoice figures.`,
      suggestion: 'Check the amount against the actual invoice or receipt. If the true figure has cents, correct it; if the round amount is genuine (rent, a flat-fee service), resolve with a note so it is documented.',
    },
  }));
};
