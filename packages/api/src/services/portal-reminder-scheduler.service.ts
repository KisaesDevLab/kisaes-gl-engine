// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { withSchedulerLock } from '../utils/scheduler-lock.js';
import * as svc from './portal-reminders.service.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 13.2 — reminder-scan job.
// Runs every 30 minutes (per the plan). Advisory-locked so a rolling
// deploy never double-sends.

const INITIAL_DELAY_MS = 2 * 60 * 1000; // 2 min — let the API finish startup
const TICK_INTERVAL_MS = 30 * 60 * 1000; // 30 min

let timer: NodeJS.Timeout | null = null;

export function startPortalReminderScheduler(): void {
  console.log('[Portal Reminder Scheduler] Registered (every 30 min, first run in 2 min)');

  const runCycle = async () => {
    try {
      const result = await withSchedulerLock('portal-reminder-scheduler', svc.dispatch);
      if (result && (result.sent > 0 || result.suppressed > 0 || result.capped > 0)) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            component: 'portal-reminder-scheduler',
            event: 'cycle',
            ...result,
          }),
        );
      }
      const purged = await withSchedulerLock(
        'portal-suppression-purge',
        svc.purgeExpiredSuppressions,
      );
      if (purged && purged > 0) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            component: 'portal-suppression-purge',
            event: 'purged',
            count: purged,
          }),
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[Portal Reminder Scheduler] tick error', err);
    }
  };

  setTimeout(() => { runCycle(); }, INITIAL_DELAY_MS);
  timer = setInterval(() => { runCycle(); }, TICK_INTERVAL_MS);
}

export function stopPortalReminderScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
