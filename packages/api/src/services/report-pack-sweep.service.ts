// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Report Pack transient-artifact TTL sweep.
//
// Rendered pack PDFs are transient: report_pack_runs carries a transient_key
// + expires_at (now + 60 min). This scheduler deletes the storage artifact
// for any run past its expires_at and nulls transient_key so a later download
// returns 410 rather than 500. Mirrors ai-retention.service.ts: an interval
// loop throttled by a `*_last_run` KV and wrapped in a Postgres advisory lock
// so the API and worker can both boot it without double-sweeping.

import { and, isNotNull, lt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { reportPackRuns } from '../db/schema/index.js';
import { getSetting, setSetting } from './admin.service.js';
import { getProviderForTenant } from './storage/storage-provider.factory.js';
import { recordSchedulerTick } from '../utils/metrics.js';
import { log } from '../utils/logger.js';

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const INITIAL_DELAY_MS = 2 * 60 * 1000; // 2 minutes after boot
const RUN_EVERY_MS = 10 * 60 * 1000; // sweep at most every 10 minutes

/**
 * Delete storage artifacts for expired runs and null their transient_key.
 * Returns the number of artifacts swept.
 */
export async function sweepExpiredArtifacts(): Promise<number> {
  const expired = await db
    .select({
      id: reportPackRuns.id,
      tenantId: reportPackRuns.tenantId,
      transientKey: reportPackRuns.transientKey,
    })
    .from(reportPackRuns)
    .where(and(
      isNotNull(reportPackRuns.transientKey),
      lt(reportPackRuns.expiresAt, new Date()),
    ));

  let swept = 0;
  for (const run of expired) {
    if (!run.transientKey) continue;
    try {
      const provider = await getProviderForTenant(run.tenantId);
      await provider.delete(run.transientKey);
    } catch (err) {
      // Best-effort: an already-gone object or a transient provider error
      // shouldn't block nulling the key (the download path re-checks TTL).
      log.warn({ component: 'report-pack-sweep', event: 'delete_failed', runId: run.id, message: err instanceof Error ? err.message : String(err) });
    }
    await db.update(reportPackRuns)
      .set({ transientKey: null })
      .where(and(isNotNull(reportPackRuns.transientKey), lt(reportPackRuns.expiresAt, new Date())));
    swept++;
  }
  return swept;
}

async function runSweepCycle(): Promise<void> {
  const started = Date.now();
  try {
    const lastRun = await getSetting('report_pack_sweep_last_run');
    const lastRunTime = lastRun ? new Date(lastRun).getTime() : 0;
    if (Date.now() - lastRunTime < RUN_EVERY_MS) {
      recordSchedulerTick('report-pack-sweep', Date.now() - started, 'skipped');
      return;
    }
    const swept = await sweepExpiredArtifacts();
    await setSetting('report_pack_sweep_last_run', new Date().toISOString());
    const durationMs = Date.now() - started;
    if (swept > 0) console.log(`[Report Pack Sweep] Swept ${swept} expired artifact(s)`);
    log.info({ component: 'report-pack-sweep', event: 'cycle_complete', swept, durationMs });
    recordSchedulerTick('report-pack-sweep', durationMs, 'ok');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ component: 'report-pack-sweep', event: 'cycle_error', message, durationMs: Date.now() - started });
    recordSchedulerTick('report-pack-sweep', Date.now() - started, 'error');
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startReportPackSweepScheduler(): void {
  console.log('[Report Pack Sweep] Registered (checks every 15 min, first check in 2 min; sweeps at most every 10 min)');

  const lockedRun = async () => {
    const { withSchedulerLock } = await import('../utils/scheduler-lock.js');
    await withSchedulerLock('report-pack-sweep-scheduler', runSweepCycle);
  };

  setTimeout(() => {
    lockedRun().catch((err) => console.error('[Report Pack Sweep] Initial check error:', err.message));
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    lockedRun().catch((err) => console.error('[Report Pack Sweep] Interval check error:', err.message));
  }, CHECK_INTERVAL_MS);
}

export function stopReportPackSweepScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
