// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { ClientPortalActivity } from '@kis-books/shared';
import { db } from '../db/index.js';

/**
 * Unread client submissions + overdue document requests for every client
 * the caller can reach, for the Clients screen's attention icons.
 *
 * Sibling of client-banking-status.service and under the same contract:
 * this deliberately crosses tenants, so the tenant set comes from
 * `user_tenant_access` for the calling user and NEVER from client input
 * (CLAUDE.md #17 does not apply here by design). The route carries
 * requireSessionAuth for the same reason the banking one does — an API key
 * is minted against one tenant and must not read the others.
 *
 * One statement; the two predicates are exactly the ones the dashboard
 * banner uses (dashboard.routes computePortalActivity) so the icon here
 * and the banner after switching in agree.
 */
export async function getForUser(userId: string): Promise<ClientPortalActivity[]> {
  const rows = await db.execute(sql`
    WITH my_tenants AS (
      SELECT uta.tenant_id
      FROM user_tenant_access uta
      WHERE uta.user_id = ${userId} AND uta.is_active = true
    ),
    reqs AS (
      SELECT dr.tenant_id,
             COUNT(*) FILTER (WHERE dr.status = 'submitted' AND dr.reviewed_at IS NULL) AS unread,
             COUNT(*) FILTER (WHERE dr.status = 'pending' AND dr.due_date IS NOT NULL AND dr.due_date < NOW()) AS overdue
      FROM document_requests dr
      WHERE dr.tenant_id IN (SELECT tenant_id FROM my_tenants)
        AND dr.status IN ('submitted', 'pending')
      GROUP BY dr.tenant_id
    )
    SELECT mt.tenant_id,
           COALESCE(r.unread, 0)::int AS unread,
           COALESCE(r.overdue, 0)::int AS overdue
    FROM my_tenants mt
    LEFT JOIN reqs r ON r.tenant_id = mt.tenant_id
  `);

  return (rows.rows as Array<{ tenant_id: string; unread: number; overdue: number }>).map((r) => ({
    tenantId: r.tenant_id,
    unreadSubmissions: Number(r.unread),
    overdueDocRequests: Number(r.overdue),
  }));
}
