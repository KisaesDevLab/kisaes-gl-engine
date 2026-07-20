// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Backup run log — persists one backup_runs row per backup execution so
// operators can see a history of backups and their state (success /
// partial / failed) in Admin → System Settings instead of container logs.
//
// Writers are DELIBERATELY non-throwing: a failure to record the log row
// must never fail the backup itself (the backup is the thing that matters;
// the log is observability). Every writer catches, logs a warning, and
// returns a null/undefined result the caller can ignore.
//
// Status semantics:
//   running  row inserted at start; never finished (crash) shows as running
//   success  artifact written and every CONFIGURED destination succeeded
//   partial  artifact written but a configured destination (remote/B2
//            upload or mirror copy) failed — the local backup exists,
//            replication does not
//   failed   the backup itself failed; `error` carries the reason

import { and, desc, eq, lt, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import { backupRuns, tenants } from '../db/schema/index.js';
import { log } from '../utils/logger.js';

export type BackupRunKind = 'tenant_backup' | 'system_backup' | 'db_backup' | 'dr_bundle' | 'verify';
export type BackupRunTrigger = 'scheduled' | 'manual';
export type BackupRunStatus = 'running' | 'success' | 'partial' | 'failed';

export const BACKUP_RUN_KINDS: BackupRunKind[] = ['tenant_backup', 'system_backup', 'db_backup', 'dr_bundle', 'verify'];
export const BACKUP_RUN_STATUSES: BackupRunStatus[] = ['running', 'success', 'partial', 'failed'];

/** Outcome of one destination (local artifact / remote upload / mirror copy). */
export interface DestinationResult {
  /** Was this destination configured at all? Unconfigured destinations
   *  never downgrade a run to partial. */
  configured: boolean;
  ok?: boolean;
  error?: string;
  /** e.g. 'size_cap' when a too-large artifact was intentionally kept local-only. */
  skipped?: string;
  /** Mirror: files copied / failed. */
  copied?: number;
  failed?: number;
  /** Multi-part sets: parts uploaded / total. */
  uploaded?: number;
  partCount?: number;
}

export interface RunDestinations {
  local?: DestinationResult;
  remote?: DestinationResult;
  mirror?: DestinationResult;
}

export interface VerifyOutcome {
  ok: boolean;
  depth?: string;
  error?: string;
  warning?: string;
  at: string;
}

/** Insert the row for a run that is starting. Returns the row id, or null
 *  when the insert failed (callers pass the null through; every other
 *  writer treats a null id as a no-op). */
export async function startBackupRun(opts: {
  kind: BackupRunKind;
  trigger: BackupRunTrigger;
  tenantId?: string | null;
  artifactName?: string;
}): Promise<string | null> {
  try {
    const [row] = await db.insert(backupRuns).values({
      kind: opts.kind,
      trigger: opts.trigger,
      tenantId: opts.tenantId ?? null,
      artifactName: opts.artifactName ?? null,
      status: 'running',
    }).returning({ id: backupRuns.id });
    return row?.id ?? null;
  } catch (err) {
    log.warn({ component: 'backup-run-log', event: 'start_failed', message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// A configured destination whose result arrived as a failure (and wasn't an
// intentional skip recorded as such) drags success down to partial.
function destinationFailed(d: DestinationResult | undefined): boolean {
  return !!d && d.configured && d.ok === false;
}

/** Complete a run. Merges `destinations` over what's already on the row
 *  (a fire-and-forget remote upload may have landed first) and downgrades
 *  success → partial when any configured destination failed. */
export async function finishBackupRun(
  id: string | null,
  outcome: {
    status: BackupRunStatus;
    sizeBytes?: number;
    artifactName?: string;
    destinations?: RunDestinations;
    error?: string;
  },
): Promise<void> {
  if (!id) return;
  try {
    const [row] = await db.select().from(backupRuns).where(eq(backupRuns.id, id)).limit(1);
    if (!row) return;
    const merged: RunDestinations = { ...(row.destinations as RunDestinations), ...(outcome.destinations ?? {}) };
    let status = outcome.status;
    if (status === 'success' && (destinationFailed(merged.remote) || destinationFailed(merged.mirror))) {
      status = 'partial';
    }
    await db.update(backupRuns).set({
      status,
      finishedAt: new Date(),
      sizeBytes: outcome.sizeBytes ?? row.sizeBytes,
      artifactName: outcome.artifactName ?? row.artifactName,
      destinations: merged,
      error: outcome.error ?? row.error,
    }).where(eq(backupRuns.id, id));
  } catch (err) {
    log.warn({ component: 'backup-run-log', event: 'finish_failed', id, message: err instanceof Error ? err.message : String(err) });
  }
}

/** Record the (async, fire-and-forget) remote-upload outcome onto a run.
 *  If the run already finished successfully and the configured upload
 *  failed, the run is downgraded to partial. */
export async function updateRunRemote(id: string | null, result: DestinationResult): Promise<void> {
  if (!id) return;
  try {
    const [row] = await db.select().from(backupRuns).where(eq(backupRuns.id, id)).limit(1);
    if (!row) return;
    const merged: RunDestinations = { ...(row.destinations as RunDestinations), remote: result };
    const downgrade = row.status === 'success' && destinationFailed(result);
    await db.update(backupRuns).set({
      destinations: merged,
      ...(downgrade ? { status: 'partial' as const } : {}),
    }).where(eq(backupRuns.id, id));
  } catch (err) {
    log.warn({ component: 'backup-run-log', event: 'remote_update_failed', id, message: err instanceof Error ? err.message : String(err) });
  }
}

/** Attach a backup-verifier outcome to the newest run that produced the
 *  verified artifact (matched by base artifact name). When no run matches
 *  (backups predating the log table), a standalone `verify` row is
 *  inserted so a verification FAILURE is never dropped on the floor. */
export async function recordVerifyOutcome(opts: {
  tenantId: string | null;
  fileName: string;
  ok: boolean;
  depth?: string;
  error?: string;
  warning?: string;
  sizeBytes?: number;
}): Promise<void> {
  try {
    const verify: VerifyOutcome = {
      ok: opts.ok,
      depth: opts.depth,
      error: opts.error,
      warning: opts.warning,
      at: new Date().toISOString(),
    };
    const [match] = await db.select({ id: backupRuns.id })
      .from(backupRuns)
      .where(and(eq(backupRuns.artifactName, opts.fileName), sql`${backupRuns.kind} <> 'verify'`))
      .orderBy(desc(backupRuns.startedAt))
      .limit(1);
    if (match) {
      await db.update(backupRuns).set({ verify }).where(eq(backupRuns.id, match.id));
      return;
    }
    // The verifier derives its tenant id from the backup DIRECTORY name —
    // which can be a synthetic system id or a since-deleted tenant. Only
    // reference rows that exist; everything else records system-wide.
    let tenantId: string | null = null;
    if (opts.tenantId) {
      const [t] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, opts.tenantId)).limit(1);
      tenantId = t?.id ?? null;
    }
    const now = new Date();
    await db.insert(backupRuns).values({
      kind: 'verify',
      trigger: 'scheduled',
      tenantId,
      artifactName: opts.fileName,
      status: opts.ok ? 'success' : 'failed',
      sizeBytes: opts.sizeBytes ?? null,
      startedAt: now,
      finishedAt: now,
      verify,
      error: opts.error ?? null,
    });
  } catch (err) {
    log.warn({ component: 'backup-run-log', event: 'verify_record_failed', fileName: opts.fileName, message: err instanceof Error ? err.message : String(err) });
  }
}

// ─── Stale-run sweep ─────────────────────────────────────────────

// A run whose process crashed (or whose container was killed) never gets a
// finishBackupRun call, so its row would sit at status='running' forever —
// which is exactly the "backups silently stopped" state this log exists to
// surface. Anything still 'running' past this threshold is dead: real
// backups finish in minutes, and the scheduler ticks hourly.
export const STALE_RUN_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours

export const STALE_RUN_ERROR =
  'Backup did not complete (process interrupted or crashed); marked failed by stale-run sweep';

/** Mark long-abandoned 'running' rows as failed. Non-throwing (returns 0 on
 *  error). Called from the backup scheduler's periodic tick (under the
 *  worker advisory lock) and lazily from listBackupRuns so the admin UI
 *  never shows a stale 'running' row even when the worker itself is down.
 *  `finished_at` stays NULL — the run never finished; the sweep only names
 *  the outcome. Swept rows count as failures in backupRunsSummary. */
export async function sweepStaleRuns(thresholdMs: number = STALE_RUN_THRESHOLD_MS): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - thresholdMs);
    const swept = await db.update(backupRuns)
      .set({ status: 'failed', error: STALE_RUN_ERROR })
      .where(and(eq(backupRuns.status, 'running'), lt(backupRuns.startedAt, cutoff)))
      .returning({ id: backupRuns.id, kind: backupRuns.kind, startedAt: backupRuns.startedAt });
    if (swept.length > 0) {
      log.warn({
        component: 'backup-run-log',
        event: 'stale_runs_swept',
        count: swept.length,
        runs: swept.map((r) => ({ id: r.id, kind: r.kind, startedAt: r.startedAt })),
      });
    }
    return swept.length;
  } catch (err) {
    log.warn({ component: 'backup-run-log', event: 'stale_sweep_failed', message: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

// ─── Read side (admin endpoint) ──────────────────────────────────

export interface ListBackupRunsOptions {
  limit: number;
  offset: number;
  status?: BackupRunStatus;
  kind?: BackupRunKind;
}

export async function listBackupRuns(opts: ListBackupRunsOptions) {
  // Lazy sweep: even when the worker (and its scheduler tick) is down —
  // exactly the scenario where backups silently stop — the admin UI never
  // shows a dead run as 'running'. Cheap: one indexed UPDATE, usually 0 rows.
  await sweepStaleRuns();

  const conditions: SQL[] = [];
  if (opts.status) conditions.push(eq(backupRuns.status, opts.status));
  if (opts.kind) conditions.push(eq(backupRuns.kind, opts.kind));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const runs = await db.select().from(backupRuns)
    .where(where)
    .orderBy(desc(backupRuns.startedAt))
    .limit(opts.limit)
    .offset(opts.offset);
  const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(backupRuns).where(where);
  return { runs, total: countRow?.count ?? 0 };
}

export interface BackupRunsKindSummary {
  lastSuccessAt: string | null;
  lastRun: { startedAt: string; status: BackupRunStatus } | null;
  consecutiveFailures: number;
}

/** Per-kind health: last success, most recent run, and how many failed
 *  runs have happened since the last non-failed one. */
export async function backupRunsSummary(): Promise<Record<string, BackupRunsKindSummary>> {
  const rows = await db.execute(sql`
    SELECT
      kind,
      MAX(started_at) FILTER (WHERE status = 'success') AS last_success_at,
      (ARRAY_AGG(started_at ORDER BY started_at DESC))[1] AS last_run_at,
      (ARRAY_AGG(status ORDER BY started_at DESC))[1] AS last_run_status,
      COUNT(*) FILTER (
        WHERE status = 'failed'
          AND started_at > COALESCE(
            (SELECT MAX(b2.started_at) FROM backup_runs b2
              WHERE b2.kind = backup_runs.kind AND b2.status IN ('success', 'partial')),
            '-infinity'::timestamptz)
      )::int AS consecutive_failures
    FROM backup_runs
    GROUP BY kind
  `);
  const summary: Record<string, BackupRunsKindSummary> = {};
  for (const r of rows.rows as Array<Record<string, unknown>>) {
    const toIso = (v: unknown): string | null => {
      if (v == null) return null;
      const d = v instanceof Date ? v : new Date(String(v));
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    };
    summary[String(r['kind'])] = {
      lastSuccessAt: toIso(r['last_success_at']),
      lastRun: r['last_run_at'] != null
        ? { startedAt: toIso(r['last_run_at'])!, status: String(r['last_run_status']) as BackupRunStatus }
        : null,
      consecutiveFailures: Number(r['consecutive_failures'] ?? 0),
    };
  }
  return summary;
}
