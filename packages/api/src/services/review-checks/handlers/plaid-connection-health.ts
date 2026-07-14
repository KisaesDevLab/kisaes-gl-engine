// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';
import { summaryLine } from './present.js';

// `plaid_connection_health` — a bank connection feeding THIS tenant is
// broken or stale. Item status/error badges on the Banking screen are
// passive; nothing told anyone, so a dead login (ITEM_LOGIN_REQUIRED etc.)
// could sit unnoticed for weeks while transactions silently stopped
// arriving. Flags, per tenant-mapped item:
//   - item in a non-active status or carrying a Plaid error code, or
//   - no successful sync in `staleDays` (default 7) despite sync-enabled
//     mappings.
// Period-agnostic (current-state) — ignores the close-period window.
export const handler: CheckHandler = async (tenantId, _companyId, params): Promise<FindingDraft[]> => {
  const staleDays = Number(params['staleDays'] ?? 7);

  const result = await db.execute<{
    id: string; institution_name: string | null; item_status: string | null;
    error_code: string | null; error_message: string | null; last_sync_at: string | null;
  }>(sql`
    SELECT DISTINCT pi.id, pi.institution_name, pi.item_status, pi.error_code, pi.error_message, pi.last_sync_at
    FROM plaid_items pi
    JOIN plaid_accounts pa ON pa.plaid_item_id = pi.id
    JOIN plaid_account_mappings pam ON pam.plaid_account_id = pa.id
      AND pam.tenant_id = ${tenantId} AND pam.is_sync_enabled = true
    WHERE pi.removed_at IS NULL
      AND (
        COALESCE(pi.item_status, 'active') <> 'active'
        OR pi.error_code IS NOT NULL
        OR pi.last_sync_at IS NULL
        OR pi.last_sync_at < now() - (${staleDays}::INT || ' days')::INTERVAL
      )
    LIMIT 200
  `);

  return (result.rows as Array<{
    id: string; institution_name: string | null; item_status: string | null;
    error_code: string | null; error_message: string | null; last_sync_at: string | null;
  }>).map((r) => {
    const broken = (r.item_status && r.item_status !== 'active') || r.error_code;
    const name = r.institution_name || 'Unknown institution';
    const reason = broken
      ? `Bank connection "${name}" needs attention (${r.error_code || r.item_status}) — transactions are not syncing.`
      : `Bank connection "${name}" has not synced in over ${staleDays} days.`;
    const suggestion = broken
      ? 'Reconnect the bank from Banking → Connections (the "Fix" button re-runs the bank login). Until it is fixed, no transactions are importing and the books are falling behind — categorize the backlog once it reconnects.'
      : 'Trigger a manual sync from Banking → Connections. If it stays stale, reconnect the bank; a quiet feed can also just mean no account activity, but verify rather than assume.';
    return {
      checkKey: 'plaid_connection_health',
      payload: {
        summary: summaryLine(name, broken ? (r.error_code || r.item_status) : `no sync in ${staleDays}+ days`),
        institutionName: r.institution_name,
        itemStatus: r.item_status,
        errorCode: r.error_code,
        errorMessage: r.error_message,
        lastSyncAt: r.last_sync_at,
        reason,
        suggestion,
        plaidItemId: r.id,
        // One finding per (item, broken-vs-stale) state so recovery + a new
        // failure re-raises rather than deduping against the old finding.
        dedupe_key: `plaid_item:${r.id}:${broken ? (r.error_code || r.item_status) : 'stale'}`,
      },
    };
  });
};
