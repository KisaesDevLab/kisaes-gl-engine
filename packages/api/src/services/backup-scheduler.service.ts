import { db } from '../db/index.js';
import { tenants } from '../db/schema/index.js';
import { getSetting, setSetting } from './admin.service.js';
import {
  createBackup,
  purgeExpiredLocalBackups,
  purgeExpiredRemoteBackups,
  type GfsRetentionConfig,
} from './backup.service.js';

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes
const INITIAL_DELAY_MS = 5 * 60 * 1000; // 5 minutes after boot

const SCHEDULE_INTERVALS: Record<string, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

async function runBackupCycle(): Promise<void> {
  try {
    const schedule = await getSetting('backup_schedule');
    if (!schedule || schedule === 'none') return;

    const intervalMs = SCHEDULE_INTERVALS[schedule];
    if (!intervalMs) return;

    const lastRun = await getSetting('backup_last_run');
    const lastRunTime = lastRun ? new Date(lastRun).getTime() : 0;
    const elapsed = Date.now() - lastRunTime;

    if (elapsed < intervalMs) return; // Not due yet

    console.log(`[Backup Scheduler] Backup is due (schedule: ${schedule}, last run: ${lastRun || 'never'})`);

    // Get all tenant IDs
    const allTenants = await db.select({ id: tenants.id }).from(tenants);
    console.log(`[Backup Scheduler] Creating backups for ${allTenants.length} tenant(s)...`);

    let successCount = 0;
    let errorCount = 0;

    for (const tenant of allTenants) {
      try {
        await createBackup(tenant.id);
        successCount++;
      } catch (err: any) {
        errorCount++;
        console.error(`[Backup Scheduler] Failed for tenant ${tenant.id}: ${err.message}`);
      }
    }

    console.log(`[Backup Scheduler] Backups complete: ${successCount} OK, ${errorCount} failed`);

    // Purge expired local backups
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

    // Mark completion
    await setSetting('backup_last_run', new Date().toISOString());
    console.log('[Backup Scheduler] Cycle complete');
  } catch (err: any) {
    console.error('[Backup Scheduler] Unexpected error:', err.message);
  }
}

export function startBackupScheduler(): void {
  console.log('[Backup Scheduler] Registered (checks every 60 min, first check in 5 min)');

  // Initial check after delay
  setTimeout(() => {
    runBackupCycle().catch((err) => console.error('[Backup Scheduler] Initial check error:', err.message));
  }, INITIAL_DELAY_MS);

  // Recurring check
  setInterval(() => {
    runBackupCycle().catch((err) => console.error('[Backup Scheduler] Interval check error:', err.message));
  }, CHECK_INTERVAL_MS);
}
