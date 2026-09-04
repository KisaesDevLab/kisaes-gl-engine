// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// What is wrong with the Plaid connections right now.
//
// Repairing a broken connection was already well covered — update-mode Fix
// Connection, throttled repair invites to the client, map/unmap/remap, remove
// and force-remove, webhook re-push. Detection is the half that was missing.
// A credential failure raises itself (plaid-sync.service flips item_status,
// emails the owners once, and auto-invites the client), but every quieter
// failure just sits there:
//
//   - webhooks stop arriving, e.g. after a domain move re-points the URL that
//     Plaid pinned per item at link time. The 24h auto-sync sweep hides it, so
//     the feed goes a day late instead of dead and nobody notices at all.
//   - an item's consent lapses on a date Plaid tells us about, which nothing
//     currently reads.
//
// Deliberately NOT here: a bank feed connection whose provider_item_id names
// a removed Plaid item. That looks like an orphan and is not one —
// getOrCreatePlaidConnection writes that id only on insert, so every re-link
// leaves it stale on a perfectly live connection. It flagged nine of ten
// connections here, all of which had imported transactions that same day.
//
// Deliberately NOT here: an account connected but never mapped. A client
// routinely ticks every account in Plaid Link, including personal ones, so it
// is the normal case rather than a fault — and the connection list below this
// panel already shows each unmapped account with a Map button, which is where
// someone would act on it anyway.
//
// None of these throw. Each is a query, which is what this is.

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

/** No webhook in this long is worth surfacing. Most institutions send several a week. */
const WEBHOOK_STALE_DAYS = 7;
/** Consent inside this window needs a re-auth booked before it lapses. */
const CONSENT_WARN_DAYS = 14;

export type PlaidIssueKind =
  | 'item_needs_attention'
  | 'sync_failing'
  | 'feed_stale'
  | 'webhook_stale'
  | 'consent_expiring'
  | 'orphaned_connection';

export interface PlaidHealthIssue {
  kind: PlaidIssueKind;
  /** 'error' = the feed is or will be broken; 'warn' = worth a look. */
  severity: 'error' | 'warn';
  plaidItemId: string | null;
  institutionName: string | null;
  /** Tenants affected, so an admin can act without opening each row. */
  tenants: string[];
  detail: string;
}

export interface PlaidHealth {
  checkedAt: string;
  issues: PlaidHealthIssue[];
  counts: Record<PlaidIssueKind, number>;
}

export async function getPlaidHealth(): Promise<PlaidHealth> {
  const issues: PlaidHealthIssue[] = [];

  // Tenants per item, resolved once and shared by the item-level checks.
  const tenantRows = await db.execute<{ item_id: string; tenant_name: string }>(sql`
    SELECT DISTINCT pi.id AS item_id, t.name AS tenant_name
    FROM plaid_items pi
    JOIN plaid_accounts pa ON pa.plaid_item_id = pi.id
    JOIN plaid_account_mappings pam ON pam.plaid_account_id = pa.id
    JOIN tenants t ON t.id = pam.tenant_id
    WHERE pi.removed_at IS NULL
  `);
  const tenantsByItem = new Map<string, string[]>();
  for (const r of tenantRows.rows as Array<{ item_id: string; tenant_name: string }>) {
    const list = tenantsByItem.get(r.item_id) ?? [];
    list.push(r.tenant_name);
    tenantsByItem.set(r.item_id, list);
  }

  // 1. Items Plaid has already told us are broken. These also email the
  // owners on transition, but a notice can be missed and the item stays bad
  // until someone acts, so it belongs on the list too.
  const broken = await db.execute<{
    id: string; institution_name: string | null; item_status: string | null;
    error_code: string | null; error_message: string | null;
  }>(sql`
    SELECT id, institution_name, item_status, error_code, error_message
    FROM plaid_items
    WHERE removed_at IS NULL
      AND item_status IS NOT NULL
      AND item_status <> 'active'
    ORDER BY institution_name
  `);
  for (const r of broken.rows as Array<Record<string, string | null>>) {
    issues.push({
      kind: 'item_needs_attention',
      severity: 'error',
      plaidItemId: r['id'] ?? null,
      institutionName: r['institution_name'] ?? null,
      tenants: tenantsByItem.get(String(r['id'])) ?? [],
      detail: `Status ${r['item_status']}${r['error_code'] ? ` (${r['error_code']})` : ''}. ` +
        (r['error_message'] ?? 'Use Fix Connection to re-authorise, or send the client a repair invite.'),
    });
  }

  // 2. Syncs that keep failing without tripping a credential code — network,
  // rate limits, a decryption failure after a key rotation. These email
  // nobody, because the notice only fires for the five credential codes.
  const failing = await db.execute<{
    id: string; institution_name: string | null; last_sync_error: string | null;
  }>(sql`
    SELECT id, institution_name, last_sync_error
      FROM plaid_items
     WHERE removed_at IS NULL
       AND last_sync_status = 'error'
       AND COALESCE(item_status, 'active') = 'active'
  `);
  for (const r of failing.rows as Array<Record<string, string | null>>) {
    issues.push({
      kind: 'sync_failing',
      severity: 'error',
      plaidItemId: r['id'] ?? null,
      institutionName: r['institution_name'] ?? null,
      tenants: tenantsByItem.get(String(r['id'])) ?? [],
      detail: `The last sync failed and this is not a login problem, so nobody was emailed. ${r['last_sync_error'] ?? ''}`.trim(),
    });
  }

  // 3. Feeds that have not SUCCEEDED in a long time. Reads last_success_at,
  // never last_sync_at — see migration 0166 for why the latter cannot answer
  // this question.
  const stalefeed = await db.execute<{
    id: string; institution_name: string | null; days: number | null;
  }>(sql`
    SELECT id, institution_name,
           FLOOR(EXTRACT(EPOCH FROM (now() - last_success_at)) / 86400)::int AS days
      FROM plaid_items
     WHERE removed_at IS NULL
       AND last_success_at IS NOT NULL
       AND last_success_at < now() - (${WEBHOOK_STALE_DAYS}::int || ' days')::interval
  `);
  for (const r of stalefeed.rows as Array<{ id: string; institution_name: string | null; days: number | null }>) {
    issues.push({
      kind: 'feed_stale',
      severity: 'error',
      plaidItemId: r.id,
      institutionName: r.institution_name,
      tenants: tenantsByItem.get(r.id) ?? [],
      detail: `No successful sync in ${r.days} days. Try a manual sync, then Fix Connection if it keeps failing.`,
    });
  }

  // 4. Silence. Counted only for items old enough to have had a chance to
  // send one, so a connection made this morning is not reported as stale.
  const stale = await db.execute<{
    id: string; institution_name: string | null; days: number | null;
  }>(sql`
    SELECT pi.id, pi.institution_name,
           FLOOR(EXTRACT(EPOCH FROM (now() - MAX(w.received_at))) / 86400)::int AS days
      FROM plaid_items pi
      LEFT JOIN plaid_webhook_log w ON w.plaid_item_id = pi.plaid_item_id
     WHERE pi.removed_at IS NULL
       AND pi.created_at < now() - (${WEBHOOK_STALE_DAYS}::int || ' days')::interval
     GROUP BY pi.id, pi.institution_name
    HAVING MAX(w.received_at) IS NULL
        OR MAX(w.received_at) < now() - (${WEBHOOK_STALE_DAYS}::int || ' days')::interval
  `);
  for (const r of stale.rows as Array<{ id: string; institution_name: string | null; days: number | null }>) {
    issues.push({
      kind: 'webhook_stale',
      severity: 'warn',
      plaidItemId: r.id,
      institutionName: r.institution_name,
      tenants: tenantsByItem.get(r.id) ?? [],
      detail: r.days == null
        ? 'No webhook has ever arrived for this connection. The scheduled sync still runs, so the feed is late rather than dead. Try Update webhooks.'
        : `No webhook in ${r.days} days. The scheduled sync still runs, so the feed is late rather than dead. Try Update webhooks.`,
    });
  }

  // 5. Consent with an end date in sight. Populated by refreshItemStatus,
  // which the sync scheduler now calls — it had no callers before, so this
  // column was empty on every row and this check could never fire.
  const consent = await db.execute<{
    id: string; institution_name: string | null; expires: string;
  }>(sql`
    SELECT id, institution_name, consent_expiration_at::date::text AS expires
      FROM plaid_items
     WHERE removed_at IS NULL
       AND consent_expiration_at IS NOT NULL
       AND consent_expiration_at < now() + (${CONSENT_WARN_DAYS}::int || ' days')::interval
  `);
  for (const r of consent.rows as Array<{ id: string; institution_name: string | null; expires: string }>) {
    issues.push({
      kind: 'consent_expiring',
      severity: 'error',
      plaidItemId: r.id,
      institutionName: r.institution_name,
      tenants: tenantsByItem.get(r.id) ?? [],
      detail: `Consent lapses ${r.expires}. Re-authorise with Fix Connection before then or the feed stops.`,
    });
  }

  const counts = {
    item_needs_attention: 0, sync_failing: 0, feed_stale: 0, webhook_stale: 0,
    consent_expiring: 0,
  } as Record<PlaidIssueKind, number>;
  for (const i of issues) counts[i.kind]++;

  // Errors first, so the list reads worst-first without the UI sorting it.
  issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));

  return { checkedAt: new Date().toISOString(), issues, counts };
}
