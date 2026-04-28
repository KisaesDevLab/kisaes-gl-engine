// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq } from 'drizzle-orm';
import { RUN_THROTTLE_HOURS } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { tenants, companies } from '../../db/schema/index.js';
import { withSchedulerLock } from '../../utils/scheduler-lock.js';
import * as orchestrator from './orchestrator.service.js';

// Phase 6 §6.5 — scheduler that ticks every 30 min and
// triggers per-(tenant, company) runs that haven't completed
// in the last RUN_THROTTLE_HOURS (24h). Uses the existing
// withSchedulerLock advisory-lock pattern; no BullMQ.

const TICK_MS = 30 * 60 * 1000; // 30 minutes
const LOCK_NAME = 'review-checks-scheduler';

let interval: ReturnType<typeof setInterval> | null = null;
let stopped = false;

export function startCheckScheduler(): void {
  if (interval || stopped) return;
  // Run an initial tick on startup, then every TICK_MS.
  void runTick().catch((err) =>
    console.error('[review-checks] scheduler initial tick failed:', err),
  );
  interval = setInterval(
    () => void runTick().catch((err) =>
      console.error('[review-checks] scheduler tick failed:', err),
    ),
    TICK_MS,
  );
  if (typeof interval.unref === 'function') interval.unref();
}

export function stopCheckScheduler(): void {
  stopped = true;
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

async function runTick(): Promise<void> {
  await withSchedulerLock(LOCK_NAME, async () => {
    // For every active tenant, sweep its companies. The
    // throttle check skips (tenant, company) pairs that ran
    // recently. Lock + throttle together prevent the typical
    // multi-instance hot-spotting hazard.
    const tenantRows = await db.select({ id: tenants.id }).from(tenants);
    for (const t of tenantRows) {
      const companyRows = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.tenantId, t.id));
      for (const c of companyRows) {
        const lastCompleted = await orchestrator.lastRunCompletedAt(t.id, c.id);
        if (lastCompleted && Date.now() - lastCompleted.getTime() < RUN_THROTTLE_HOURS * 60 * 60 * 1000) {
          continue;
        }
        await orchestrator.runForCompany(t.id, c.id);
      }
    }
  });
}
