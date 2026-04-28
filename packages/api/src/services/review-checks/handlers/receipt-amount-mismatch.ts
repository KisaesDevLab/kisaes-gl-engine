// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';

// `receipt_amount_mismatch` — surfaces bank-feed items whose
// attached receipt's OCR-extracted total differs from the bank
// amount by more than the configured tolerance. Tolerance is the
// MAX of `toleranceDollars` (absolute) and `tolerancePercent` ×
// bank amount, so small charges aren't flagged for $0.50 noise
// while large invoices still tolerate proportional rounding.
//
// Dedupe key is `attachment:<attachmentId>` so a single OCR'd
// receipt only ever produces one open finding even if checks
// re-run; the bookkeeper resolves it once and the next OCR pass
// (e.g. they re-uploaded the receipt) creates a new attachment id
// and therefore a new finding.
export const handler: CheckHandler = async (tenantId, companyId, params): Promise<FindingDraft[]> => {
  const toleranceDollars = Math.max(0, Number(params['toleranceDollars'] ?? 1));
  const tolerancePercent = Math.max(0, Number(params['tolerancePercent'] ?? 0.02));
  const companyClause = companyId
    ? sql`AND b.company_id = ${companyId}`
    : sql``;

  const result = await db.execute<{
    bank_feed_item_id: string;
    attachment_id: string;
    bank_amount: string;
    ocr_total: string;
    ocr_vendor: string | null;
    ocr_date: string | null;
    description: string | null;
  }>(sql`
    SELECT
      b.id AS bank_feed_item_id,
      a.id AS attachment_id,
      b.amount AS bank_amount,
      a.ocr_total,
      a.ocr_vendor,
      a.ocr_date,
      b.description
    FROM bank_feed_items b
    JOIN attachments a ON
      a.tenant_id = b.tenant_id
      AND a.attachable_type = 'bank_feed_items'
      AND a.attachable_id = b.id
      AND a.ocr_status = 'complete'
      AND a.ocr_total IS NOT NULL
    WHERE b.tenant_id = ${tenantId}
      ${companyClause}
      AND ABS(ABS(b.amount) - a.ocr_total) > GREATEST(${toleranceDollars}, ABS(b.amount) * ${tolerancePercent})
    ORDER BY a.created_at DESC
    LIMIT 500
  `);

  return (result.rows as Array<{
    bank_feed_item_id: string;
    attachment_id: string;
    bank_amount: string;
    ocr_total: string;
    ocr_vendor: string | null;
    ocr_date: string | null;
    description: string | null;
  }>).map((r) => {
    const bankAmt = Math.abs(parseFloat(r.bank_amount));
    const receiptAmt = parseFloat(r.ocr_total);
    const variance = receiptAmt - bankAmt;
    return {
      checkKey: 'receipt_amount_mismatch',
      // bank_feed_items isn't a transactions row — leave
      // transactionId null and use the attachment id for dedupe.
      transactionId: null,
      vendorId: null,
      payload: {
        bankFeedItemId: r.bank_feed_item_id,
        attachmentId: r.attachment_id,
        bankAmount: bankAmt,
        receiptTotal: receiptAmt,
        variance,
        ocrVendor: r.ocr_vendor,
        ocrDate: r.ocr_date,
        description: r.description,
        toleranceDollars,
        tolerancePercent,
        dedupe_key: `attachment:${r.attachment_id}`,
        reason: `Receipt total ${receiptAmt.toFixed(2)} differs from bank amount ${bankAmt.toFixed(2)} by ${variance.toFixed(2)}.`,
      },
    };
  });
};
