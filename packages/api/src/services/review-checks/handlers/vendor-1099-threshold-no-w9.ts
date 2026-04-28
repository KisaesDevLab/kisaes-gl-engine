// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';

// `vendor_1099_threshold_no_w9` — vendors paid ≥$600 YTD with
// no tax_id on file. Phase 12 (1099 Center) will add the W-9
// request workflow; this check just flags the gap today.
// Default threshold $600 (the IRS 1099-NEC reporting floor).
export const handler: CheckHandler = async (tenantId, companyId, params): Promise<FindingDraft[]> => {
  const threshold = Number(params['thresholdAmount'] ?? 600);
  const companyClause = companyId
    ? sql`AND t.company_id = ${companyId}`
    : sql``;

  // Sum YTD vendor payments per vendor; flag those above the
  // threshold whose contact lacks a tax_id AND has no operator-
  // set exclusion on file. Excluded vendors (e.g. "corporation per
  // W-9") are deliberately omitted — they were already triaged.
  const result = await db.execute<{ contact_id: string; display_name: string; total_paid: string }>(sql`
    SELECT
      c.id AS contact_id,
      c.display_name,
      SUM(t.total)::TEXT AS total_paid
    FROM transactions t
    JOIN contacts c ON c.id = t.contact_id
    LEFT JOIN vendor_1099_profile vp ON vp.contact_id = c.id
    WHERE t.tenant_id = ${tenantId}
      ${companyClause}
      AND t.txn_type IN ('expense', 'bill_payment', 'check')
      AND t.status = 'posted'
      AND EXTRACT(YEAR FROM t.txn_date) = EXTRACT(YEAR FROM now())
      AND c.contact_type = 'vendor'
      AND (c.tax_id IS NULL OR c.tax_id = '')
      AND vp.exclusion_reason IS NULL
    GROUP BY c.id, c.display_name
    HAVING SUM(t.total) >= ${threshold}
    LIMIT 200
  `);

  return (result.rows as Array<{ contact_id: string; display_name: string; total_paid: string }>).map((r) => ({
    checkKey: 'vendor_1099_threshold_no_w9',
    vendorId: r.contact_id,
    payload: {
      vendorName: r.display_name,
      totalPaidYTD: r.total_paid,
      threshold,
      reason: `Vendor "${r.display_name}" paid $${r.total_paid} YTD with no W-9 / tax ID on file.`,
    },
  }));
};
