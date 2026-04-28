// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { withSchedulerLock } from '../utils/scheduler-lock.js';
import * as questionSvc from './portal-question.service.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 11.4 — recurring portal
// question scheduler. Runs the existing scheduler-lock pattern so a
// rolling deploy never duplicates work.

const INITIAL_DELAY_MS = 90 * 1000; // 90s — let the API finish startup
const TICK_INTERVAL_MS = 60 * 60 * 1000; // hourly

let timer: NodeJS.Timeout | null = null;

export function startPortalRecurringScheduler(): void {
  console.log('[Portal Recurring Scheduler] Registered (checks hourly, first check in 90s)');

  const runCycle = async () => {
    try {
      const result = await withSchedulerLock('portal-recurring-scheduler', questionSvc.tickRecurring);
      // Piggyback the orphan sweep (12.5) on the same tick. Cheap query
      // (LEFT JOIN with NULL filter) and self-bounded — only operates on
      // questions whose transactionId no longer resolves.
      const orphanCount = await withSchedulerLock(
        'portal-orphan-sweep',
        questionSvc.resolveOrphansAllTenants,
      );
      if (orphanCount && orphanCount > 0) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            component: 'portal-orphan-sweep',
            event: 'resolved',
            count: orphanCount,
          }),
        );
      }
      if (result && result.fired > 0) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            component: 'portal-recurring-scheduler',
            event: 'fired',
            count: result.fired,
          }),
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[Portal Recurring Scheduler] tick error', err);
    }
  };

  setTimeout(() => { runCycle(); }, INITIAL_DELAY_MS);
  timer = setInterval(() => { runCycle(); }, TICK_INTERVAL_MS);
}

export function stopPortalRecurringScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
