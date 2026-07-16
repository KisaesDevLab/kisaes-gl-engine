// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { db } from '../db/index.js';
import { tenants } from '../db/schema/index.js';
import { getSetting, setSetting } from './admin.service.js';
import { decrypt as decryptField } from '../utils/encryption.js';
import {
  createBackup,
  createSystemBackup,
  purgeExpiredLocalBackups,
  purgeExpiredRemoteBackups,
  type GfsRetentionConfig,
} from './backup.service.js';
import { recordSchedulerTick } from '../utils/metrics.js';
import { log } from '../utils/logger.js';

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes
const INITIAL_DELAY_MS = 5 * 60 * 1000; // 5 minutes after boot

const SCHEDULE_INTERVALS: Record<string, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

/** True when `schedule` is a real cadence and `elapsed since lastRunKey` ≥ its interval. */
export async function isDue(schedule: string | null, lastRunKey: string): Promise<boolean> {
  if (!schedule || schedule === 'none') return false;
  const intervalMs = SCHEDULE_INTERVALS[schedule];
  if (!intervalMs) return false;
  const lastRun = await getSetting(lastRunKey);
  const parsed = lastRun ? new Date(lastRun).getTime() : 0;
  // Fail SAFE: an unparseable/corrupt last-run timestamp counts as "never
  // run" (due), so a bad value can never silently stop backups forever.
  const lastRunTime = Number.isNaN(parsed) ? 0 : parsed;
  return Date.now() - lastRunTime >= intervalMs;
}

async function runBackupCycle(): Promise<void> {
  const started = Date.now();
  try {
    const fullSchedule = await getSetting('backup_schedule');
    const dbSchedule = await getSetting('backup_db_schedule');

    const fullDue = await isDue(fullSchedule, 'backup_last_run');
    // DB-only cadence (independent of the full-bundle schedule): a DB-only
    // system backup with NO attachments, so a daily cadence doesn't re-fetch
    // every attachment from object storage each run.
    const dbDue = await isDue(dbSchedule, 'backup_db_last_run');

    if (!fullDue && !dbDue) {
      recordSchedulerTick('backup', Date.now() - started, 'skipped');
      return;
    }

    // Retrieve the stored backup passphrase (encrypted in system settings) —
    // required for both cadences.
    const encryptedPassphrase = await getSetting('backup_scheduled_passphrase');
    if (!encryptedPassphrase) {
      console.warn('[Backup Scheduler] No backup passphrase configured. Set one in Admin → System Settings. Skipping.');
      return;
    }
    const passphrase = decryptField(encryptedPassphrase);

    if (fullDue) {
      console.log(`[Backup Scheduler] Full backup is due (schedule: ${fullSchedule})`);
      const allTenants = await db.select({ id: tenants.id }).from(tenants);
      let successCount = 0;
      let errorCount = 0;
      for (const tenant of allTenants) {
        try {
          await createBackup(tenant.id, passphrase);
          successCount++;
        } catch (err: any) {
          errorCount++;
          console.error(`[Backup Scheduler] Failed for tenant ${tenant.id}: ${err.message}`);
        }
      }
      console.log(`[Backup Scheduler] Per-tenant backups: ${successCount} OK, ${errorCount} failed`);

      // Full SYSTEM backup (all tenants/users/config + recovery files +
      // attachment FILES) — the one that makes DR genuinely restorable.
      // Stamp last-run ONLY when it actually succeeds, or a failure is
      // recorded as success and no retry happens for a whole interval.
      let systemOk = false;
      try {
        const sys = await createSystemBackup(passphrase, undefined, { includeAttachments: true });
        console.log(`[Backup Scheduler] System backup created: ${sys.fileName} (${sys.size} bytes)`);
        systemOk = true;
      } catch (err) {
        console.error(`[Backup Scheduler] System backup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (systemOk) {
        await setSetting('backup_last_run', new Date().toISOString());
      } else {
        console.warn('[Backup Scheduler] Full backup did NOT complete — last-run NOT stamped; will retry next cycle.');
      }
    }

    if (dbDue) {
      console.log(`[Backup Scheduler] DB-only backup is due (schedule: ${dbSchedule})`);
      let dbOk = false;
      try {
        const sys = await createSystemBackup(passphrase, undefined, { includeAttachments: false });
        console.log(`[Backup Scheduler] DB-only system backup created: ${sys.fileName} (${sys.size} bytes)`);
        dbOk = true;
      } catch (err) {
        console.error(`[Backup Scheduler] DB-only system backup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (dbOk) {
        await setSetting('backup_db_last_run', new Date().toISOString());
      } else {
        console.warn('[Backup Scheduler] DB-only backup did NOT complete — last-run NOT stamped; will retry next cycle.');
      }
    }

    // Purge expired local backups (covers the mirror dir too — see
    // purgeExpiredLocalBackups).
    const localRetentionStr = await getSetting('backup_local_retention_days');
    const localRetentionDays = parseInt(localRetentionStr || '30') || 30;
    const localPurged = await purgeExpiredLocalBackups(localRetentionDays);
    if (localPurged > 0) {
      console.log(`[Backup Scheduler] Purged ${localPurged} expired local backup(s)`);
    }

    // Purge expired remote backups (GFS)
    const gfsConfig: GfsRetentionConfig = {
      dailyDays: parseInt(await getSetting('backup_remote_retention_daily') || '14') || 0,
      weeklyWeeks: parseInt(await getSetting('backup_remote_retention_weekly') || '8') || 0,
      monthlyMonths: parseInt(await getSetting('backup_remote_retention_monthly') || '12') || 0,
      yearlyYears: parseInt(await getSetting('backup_remote_retention_yearly') || '7') || 0,
    };
    const remotePurged = await purgeExpiredRemoteBackups(gfsConfig);
    if (remotePurged > 0) {
      console.log(`[Backup Scheduler] Purged ${remotePurged} expired remote backup(s)`);
    }

    const durationMs = Date.now() - started;
    log.info({ component: 'backup-scheduler', event: 'cycle_complete', durationMs, fullDue, dbDue });
    recordSchedulerTick('backup', durationMs, 'ok');
  } catch (err: any) {
    log.error({ component: 'backup-scheduler', event: 'cycle_error', message: err.message, durationMs: Date.now() - started });
    recordSchedulerTick('backup', Date.now() - started, 'error');
  }
}

export function startBackupScheduler(): void {
  console.log('[Backup Scheduler] Registered (checks every 60 min, first check in 5 min)');

  // Wrap each cycle in a Postgres advisory lock keyed to the scheduler
  // name, so two instances sharing the DB can't both see "backup is due",
  // both run the cycle, and both produce duplicate archive files. The
  // lock is session-scoped — a crash between acquire and release still
  // frees it at connection close.
  const lockedRun = async () => {
    const { withSchedulerLock } = await import('../utils/scheduler-lock.js');
    await withSchedulerLock('backup-scheduler', runBackupCycle);
  };

  // Initial check after delay
  setTimeout(() => {
    lockedRun().catch((err) => console.error('[Backup Scheduler] Initial check error:', err.message));
  }, INITIAL_DELAY_MS);

  // Recurring check
  setInterval(() => {
    lockedRun().catch((err) => console.error('[Backup Scheduler] Interval check error:', err.message));
  }, CHECK_INTERVAL_MS);
}
