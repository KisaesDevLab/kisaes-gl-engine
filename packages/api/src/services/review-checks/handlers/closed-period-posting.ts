// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';

// `closed_period_posting` — transactions dated INSIDE a company's
// closed period (txn_date <= companies.lock_date) that were created
// AFTER the close date. The ledger enforces the lock at posting time,
// but the lock can be set after backdated entries landed, moved
// backward, or entries can arrive through restore paths — this check
// surfaces anything sitting in a closed period that post-dates the
// close, so the CPA can verify the closed year still reproduces.
// (Was a stub that claimed no lock-date concept existed; companies.
// lock_date shipped in migration 0020.)
export const handler: CheckHandler = async (tenantId, companyId): Promise<FindingDraft[]> => {
  const companyClause = companyId
    ? sql`AND t.company_id = ${companyId}`
    : sql``;

  const result = await db.execute<{
    id: string; txn_type: string; txn_date: string; created_at: string; lock_date: string; memo: string | null;
  }>(sql`
    SELECT t.id, t.txn_type, t.txn_date, t.created_at, c.lock_date, t.memo
    FROM transactions t
    JOIN companies c ON c.id = t.company_id AND c.tenant_id = t.tenant_id
    WHERE t.tenant_id = ${tenantId}
      ${companyClause}
      AND c.lock_date IS NOT NULL
      AND t.txn_date <= c.lock_date
      AND t.created_at::date > c.lock_date
      AND t.status = 'posted'
    ORDER BY t.txn_date DESC
    LIMIT 200
  `);

  return (result.rows as Array<{
    id: string; txn_type: string; txn_date: string; created_at: string; lock_date: string; memo: string | null;
  }>).map((r) => ({
    checkKey: 'closed_period_posting',
    payload: {
      transactionId: r.id,
      txnType: r.txn_type,
      txnDate: r.txn_date,
      createdAt: r.created_at,
      lockDate: r.lock_date,
      dedupe_key: `txn:${r.id}`,
      reason: `${r.txn_type} dated ${r.txn_date} (inside the closed period ending ${r.lock_date}) was created ${String(r.created_at).slice(0, 10)}, after the close.`,
    },
  }));
};
