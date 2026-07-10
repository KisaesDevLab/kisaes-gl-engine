// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Webhook-independent Plaid sync. Self-hosted appliances are frequently NOT
// reachable from the internet, so Plaid's webhooks never arrive and — before
// this scheduler — transactions only flowed when a user clicked "sync".
// This loop polls every active, sync-enabled connection whose last sync is
// older than PLAID_AUTO_SYNC_HOURS (default 6h; 0 disables). Webhooks remain
// the fast path; this is the safety net (transactionsSync is cursor-based, so
// polling after a webhook-triggered sync is a cheap no-op).
//
// Same single-writer pattern as every other scheduler: setInterval +
// Postgres advisory lock (withSchedulerLock), safe to run in both the worker
// and the API.

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { recordSchedulerTick } from '../utils/metrics.js';

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // check every 30 minutes
const INITIAL_DELAY_MS = 3 * 60 * 1000;   // 3 minutes after boot

// Effective interval: Admin UI (plaid_config.auto_sync_hours) wins; the
// PLAID_AUTO_SYNC_HOURS env var is only a deployment-level default; built-in
// fallback 6h. 0 disables.
async function autoSyncHours(): Promise<number> {
  try {
    const row = await db.execute<{ auto_sync_hours: number | null }>(
      sql`SELECT auto_sync_hours FROM plaid_config LIMIT 1`,
    );
    const fromDb = (row.rows[0] as { auto_sync_hours: number | null } | undefined)?.auto_sync_hours;
    if (fromDb !== null && fromDb !== undefined && Number.isFinite(Number(fromDb)) && Number(fromDb) >= 0) {
      return Number(fromDb);
    }
  } catch { /* table may not exist yet on first boot — fall through */ }
  const raw = Number(process.env['PLAID_AUTO_SYNC_HOURS']);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 6;
}

export async function runPlaidSyncCycle(): Promise<void> {
  const started = Date.now();
  const hours = await autoSyncHours();
  if (hours === 0) {
    recordSchedulerTick('plaid-sync', Date.now() - started, 'skipped');
    return;
  }

  // Items due for a sync: live, at least one sync-enabled mapping (someone
  // actually consumes the feed), and stale past the threshold. Items in a
  // login-required/error state are still attempted at a slower cadence
  // (4x the interval) so a recovered login resumes without manual action,
  // without hammering a broken one every cycle.
  const due = await db.execute<{ id: string; institution_name: string | null; item_status: string | null }>(sql`
    SELECT pi.id, pi.institution_name, pi.item_status
    FROM plaid_items pi
    WHERE pi.removed_at IS NULL
      AND EXISTS (
        SELECT 1 FROM plaid_account_mappings pam
        JOIN plaid_accounts pa ON pa.id = pam.plaid_account_id
        WHERE pa.plaid_item_id = pi.id AND pam.is_sync_enabled = true
      )
      AND (
        pi.last_sync_at IS NULL
        OR (COALESCE(pi.item_status, 'active') = 'active'
            AND pi.last_sync_at < now() - (${hours}::INT || ' hours')::INTERVAL)
        OR (COALESCE(pi.item_status, 'active') <> 'active'
            AND pi.last_sync_at < now() - (${hours * 4}::INT || ' hours')::INTERVAL)
      )
    ORDER BY pi.last_sync_at ASC NULLS FIRST
    LIMIT 25
  `);

  if (due.rows.length === 0) {
    recordSchedulerTick('plaid-sync', Date.now() - started, 'skipped');
    return;
  }

  console.log(`[Plaid Sync Scheduler] ${due.rows.length} connection(s) due for sync`);
  const { syncItem } = await import('./plaid-sync.service.js');
  let ok = 0;
  let failed = 0;
  for (const item of due.rows as Array<{ id: string; institution_name: string | null }>) {
    try {
      await syncItem(item.id);
      ok++;
    } catch (err) {
      failed++;
      // syncItem records last_sync_error on the item; just log here.
      console.error(`[Plaid Sync Scheduler] ${item.institution_name || item.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`[Plaid Sync Scheduler] Cycle complete: ${ok} OK, ${failed} failed`);
  recordSchedulerTick('plaid-sync', Date.now() - started, failed > 0 ? 'error' : 'ok');
}

let intervalHandle: NodeJS.Timeout | null = null;
let timeoutHandle: NodeJS.Timeout | null = null;

export function startPlaidSyncScheduler(): void {
  console.log('[Plaid Sync Scheduler] Registered (checks every 30 min, threshold from Admin → Plaid, first check in 3 min)');
  const lockedRun = async () => {
    const { withSchedulerLock } = await import('../utils/scheduler-lock.js');
    await withSchedulerLock('plaid-sync-scheduler', runPlaidSyncCycle);
  };
  timeoutHandle = setTimeout(() => {
    lockedRun().catch((err) => console.error('[Plaid Sync Scheduler] Initial check error:', err.message));
  }, INITIAL_DELAY_MS);
  intervalHandle = setInterval(() => {
    lockedRun().catch((err) => console.error('[Plaid Sync Scheduler] Interval check error:', err.message));
  }, CHECK_INTERVAL_MS);
}

export function stopPlaidSyncScheduler(): void {
  if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
}
