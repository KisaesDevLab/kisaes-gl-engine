// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

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
