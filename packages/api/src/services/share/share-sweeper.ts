// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Sweeps for peer screen share: TTL/idle session expiry (13.6), approval
// lapse (3.11), and daily audit-retention purge (12.8). Interval-based with
// the shared scheduler advisory lock, like the other appliance schedulers —
// API and worker can both boot it without double-firing.

import { env } from '../../config/env.js';
import { log } from '../../utils/logger.js';

const SWEEP_INTERVAL_MS = 15_000;
const RETENTION_INTERVAL_MS = 60 * 60_000; // check hourly, purge is idempotent

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let retentionTimer: ReturnType<typeof setInterval> | null = null;

async function sweepOnce(): Promise<void> {
  const shareService = await import('./share.service.js');
  const ended = await shareService.sweepExpiredSessions();
  const lapsed = await shareService.sweepLapsedParticipants();
  if (ended > 0 || lapsed > 0) {
    log.info({ component: 'share-sweeper', event: 'sweep', endedSessions: ended, lapsedParticipants: lapsed });
  }
}

async function retentionOnce(): Promise<void> {
  const shareService = await import('./share.service.js');
  const purged = await shareService.purgeExpiredAudit();
  if (purged > 0) {
    log.info({ component: 'share-sweeper', event: 'retention_purge', sessionsPurged: purged });
  }
}

export function startShareSweeper(): void {
  if (!env.SHARE_ENABLED) return; // feature off ⇒ nothing to sweep
  console.log('[Share] Sweeper registered (15s lifecycle sweep, hourly retention check)');
  const lockedSweep = async () => {
    const { withSchedulerLock } = await import('../../utils/scheduler-lock.js');
    await withSchedulerLock('share-sweeper', sweepOnce);
  };
  const lockedRetention = async () => {
    const { withSchedulerLock } = await import('../../utils/scheduler-lock.js');
    await withSchedulerLock('share-retention', retentionOnce);
  };
  sweepTimer = setInterval(() => {
    lockedSweep().catch((err) => log.warn({ component: 'share-sweeper', event: 'sweep_error', message: err instanceof Error ? err.message : String(err) }));
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  retentionTimer = setInterval(() => {
    lockedRetention().catch((err) => log.warn({ component: 'share-sweeper', event: 'retention_error', message: err instanceof Error ? err.message : String(err) }));
  }, RETENTION_INTERVAL_MS);
  retentionTimer.unref?.();
}

export function stopShareSweeper(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  if (retentionTimer) clearInterval(retentionTimer);
  sweepTimer = null;
  retentionTimer = null;
}
