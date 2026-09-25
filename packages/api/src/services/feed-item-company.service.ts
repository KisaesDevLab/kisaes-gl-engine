// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bankConnections, companies } from '../db/schema/index.js';

// The company a new bank-feed item belongs to: its bank connection's
// company, else the tenant's only company, else null (a multi-company
// tenant whose connection is not company-scoped).
//
// Feed items used to be inserted with no company at all, so every
// company-scoped view (Close Review buckets, Manual Queue, the
// uncategorized_stale / receipt_amount_mismatch checks) silently saw
// nothing. bank_connections.company_id itself is deliberately left alone:
// portal banking relies on NULL-company connections meaning "the tenant's
// only company".
export async function resolveCompanyForConnection(
  tenantId: string,
  bankConnectionId: string,
): Promise<string | null> {
  const conn = await db.query.bankConnections.findFirst({
    where: and(eq(bankConnections.tenantId, tenantId), eq(bankConnections.id, bankConnectionId)),
    columns: { companyId: true },
  });
  if (conn?.companyId) return conn.companyId;
  const rows = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.tenantId, tenantId))
    .limit(2);
  return rows.length === 1 ? rows[0]!.id : null;
}

/** Per-call memo for loops that insert many items across a few connections. */
export function companyResolverCache() {
  const cache = new Map<string, Promise<string | null>>();
  return (tenantId: string, bankConnectionId: string) => {
    const key = `${tenantId}:${bankConnectionId}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = resolveCompanyForConnection(tenantId, bankConnectionId);
      cache.set(key, hit);
    }
    return hit;
  };
}
