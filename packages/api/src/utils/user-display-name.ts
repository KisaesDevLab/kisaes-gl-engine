// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

/**
 * The name to show for a user id a company's row carries (U-284): the
 * user's display name (or email) when the id is a user of this install,
 * else the name a transfer file brought for it, as "Name (ClientLedger)"
 * (transfer_user_names, migration 0283), else NULL. `userCol` and
 * `tenantCol` are trusted SQL column expressions (never request input).
 */
export function userDisplayNameSql(userCol: string, tenantCol: string): string {
  return `COALESCE(
    (SELECT COALESCE(NULLIF(u.display_name, ''), u.email) FROM users u WHERE u.id = ${userCol}),
    (SELECT n.display_name || ' (ClientLedger)' FROM transfer_user_names n WHERE n.tenant_id = ${tenantCol} AND n.user_id = ${userCol}))`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The same names for a set of user ids a tenant's rows carry, in one query
 * (U-284 E6): id -> name, as `userDisplayNameSql`. Ids with no user and no
 * names-only row are left out, so callers keep their own fallback. Users
 * are looked up by id alone (firm staff live in another tenant); names-only
 * people only in `tenantId`.
 */
export async function userDisplayNames(tenantId: string, ids: Iterable<string>): Promise<Map<string, string>> {
  const list = [...new Set(ids)].filter((id) => typeof id === 'string' && UUID_RE.test(id));
  if (list.length === 0) return new Map();
  const r = await db.execute(sql`
    SELECT x.id::text AS id, ${sql.raw(userDisplayNameSql('x.id', 'x.tenant_id'))} AS name
    FROM (SELECT DISTINCT v.id::uuid AS id, ${tenantId}::uuid AS tenant_id FROM unnest(${`{${list.join(',')}}`}::text[]) AS v(id)) x`);
  const out = new Map<string, string>();
  for (const row of r.rows as Array<{ id: string; name: string | null }>) if (row.name) out.set(row.id, row.name);
  return out;
}
