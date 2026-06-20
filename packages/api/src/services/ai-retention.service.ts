// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// AI data retention purge.
//
// Two tables accumulate AI history with no natural upper bound:
//   - ai_jobs           — one row per categorize/OCR/classify/chat call
//   - chat_conversations — user/assistant transcripts (chat_messages
//                          cascade-delete with their parent conversation)
//
// This scheduler deletes rows older than a configurable horizon. It
// mirrors backup-scheduler exactly: hourly tick, throttled to one real
// pass per 24h via a `*_last_run` setting, and wrapped in a Postgres
// advisory lock at the call site so the API and worker processes can both
// boot it without double-purging.
//
// Retention is configured through the admin settings KV store:
//   ai_jobs_retention_days   (default 90)   — 0 / negative disables
//   chat_retention_days      (default 365)  — 0 / negative disables
//
// ai_usage_log is intentionally NOT purged here — it's the cost/usage
// ledger (tokens + cost only, no prompt/reply content) and is expected to
// be retained for budgeting/reporting.

import { lt, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { aiJobs, chatConversations } from '../db/schema/index.js';
import { getSetting, setSetting } from './admin.service.js';
import { recordSchedulerTick } from '../utils/metrics.js';
import { log } from '../utils/logger.js';

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes
const INITIAL_DELAY_MS = 5 * 60 * 1000; // 5 minutes after boot
const RUN_EVERY_MS = 24 * 60 * 60 * 1000; // purge at most once per day

const DEFAULT_AI_JOBS_RETENTION_DAYS = 90;
const DEFAULT_CHAT_RETENTION_DAYS = 365;

function cutoffFor(retentionDays: number): Date {
  return new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
}

/**
 * Delete ai_jobs rows created before the retention horizon. A
 * retentionDays of 0 or less disables the purge (matches the
 * backup-purge convention). Returns the number of rows deleted.
 */
export async function purgeOldAiJobs(retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const deleted = await db
    .delete(aiJobs)
    .where(lt(aiJobs.createdAt, cutoffFor(retentionDays)))
    .returning({ id: aiJobs.id });
  return deleted.length;
}

/**
 * Delete chat_conversations whose last activity is older than the
 * retention horizon; chat_messages rows cascade-delete with their parent
 * (FK onDelete: 'cascade'). "Last activity" is last_message_at, falling
 * back to created_at for conversations that never received a message.
 * Returns the number of conversations deleted.
 */
export async function purgeOldChatConversations(retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = cutoffFor(retentionDays);
  const deleted = await db
    .delete(chatConversations)
    .where(lt(sql`coalesce(${chatConversations.lastMessageAt}, ${chatConversations.createdAt})`, cutoff))
    .returning({ id: chatConversations.id });
  return deleted.length;
}

async function runRetentionCycle(): Promise<void> {
  const started = Date.now();
  try {
    const lastRun = await getSetting('ai_retention_last_run');
    const lastRunTime = lastRun ? new Date(lastRun).getTime() : 0;
    if (Date.now() - lastRunTime < RUN_EVERY_MS) {
      recordSchedulerTick('ai-retention', Date.now() - started, 'skipped');
      return; // not due yet
    }

    const aiJobsDays = parseInt(await getSetting('ai_jobs_retention_days') || String(DEFAULT_AI_JOBS_RETENTION_DAYS), 10);
    const chatDays = parseInt(await getSetting('chat_retention_days') || String(DEFAULT_CHAT_RETENTION_DAYS), 10);

    const jobsPurged = await purgeOldAiJobs(Number.isFinite(aiJobsDays) ? aiJobsDays : DEFAULT_AI_JOBS_RETENTION_DAYS);
    const chatPurged = await purgeOldChatConversations(Number.isFinite(chatDays) ? chatDays : DEFAULT_CHAT_RETENTION_DAYS);

    await setSetting('ai_retention_last_run', new Date().toISOString());
    const durationMs = Date.now() - started;
    if (jobsPurged > 0 || chatPurged > 0) {
      console.log(`[AI Retention] Purged ${jobsPurged} ai_job(s) and ${chatPurged} chat conversation(s)`);
    }
    log.info({ component: 'ai-retention', event: 'cycle_complete', jobsPurged, chatPurged, aiJobsDays, chatDays, durationMs });
    recordSchedulerTick('ai-retention', durationMs, 'ok');
  } catch (err: any) {
    log.error({ component: 'ai-retention', event: 'cycle_error', message: err.message, durationMs: Date.now() - started });
    recordSchedulerTick('ai-retention', Date.now() - started, 'error');
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startAiRetentionScheduler(): void {
  console.log('[AI Retention] Registered (checks every 60 min, first check in 5 min; purges at most once/24h)');

  // Advisory-locked so the API and worker can both boot this without two
  // processes purging the same rows on the same tick. Session-scoped lock
  // frees on connection close even if a process crashes mid-cycle.
  const lockedRun = async () => {
    const { withSchedulerLock } = await import('../utils/scheduler-lock.js');
    await withSchedulerLock('ai-retention-scheduler', runRetentionCycle);
  };

  setTimeout(() => {
    lockedRun().catch((err) => console.error('[AI Retention] Initial check error:', err.message));
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    lockedRun().catch((err) => console.error('[AI Retention] Interval check error:', err.message));
  }, CHECK_INTERVAL_MS);
}

export function stopAiRetentionScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
