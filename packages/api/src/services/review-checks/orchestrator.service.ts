// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, desc, eq, sql } from 'drizzle-orm';
import {
  MAX_FINDINGS_PER_RUN,
  type FindingDraft,
  type FindingSeverity,
} from '@kis-books/shared';
import { db } from '../../db/index.js';
import { checkRuns, companies } from '../../db/schema/index.js';
import { withSchedulerLock } from '../../utils/scheduler-lock.js';
import { HANDLERS } from './handlers/index.js';
import * as registry from './registry.service.js';
import * as findingsService from './findings.service.js';
import * as suppressions from './suppressions.service.js';

// Phase 6 §6.4 — orchestrator. For a given (tenant, company)
// invocation, iterates active registry entries, invokes each
// handler with merged params, applies dedupe + suppression,
// bulk-inserts findings, and writes the run row.
//
// Hits the per-run cap of MAX_FINDINGS_PER_RUN to defend
// against runaway handlers; aborts the rest of the checks for
// that run with `truncated = true`.

export interface RunResult {
  runId: string;
  checksExecuted: number;
  findingsCreated: number;
  truncated: boolean;
  error: string | null;
}

// Per-run options. `includeAiHandlers` opts in to AI-driven
// `judgment` category handlers — the nightly scheduler omits this
// flag so AI checks never fire automatically; the on-demand
// /run-ai-judgment route sets it to true.
export interface RunOptions {
  includeAiHandlers?: boolean;
}

export async function runForCompany(
  tenantId: string,
  companyId: string | null,
  userId?: string,
  options: RunOptions = {},
): Promise<RunResult> {
  // Per-(tenant, company) advisory lock so a manual /run trigger
  // can't double-execute alongside the scheduler tick or a second
  // operator hammering the button. Returning a synthetic skipped
  // result is cleaner than 409-ing the API caller; the bookkeeper
  // sees "another run already in progress" instead of a stack trace.
  const lockName = `review-checks-run:${tenantId}:${companyId ?? 'tenant-wide'}`;
  const result = await withSchedulerLock(lockName, () =>
    runForCompanyLocked(tenantId, companyId, userId, options),
  );
  if (result === null) {
    return {
      runId: '',
      checksExecuted: 0,
      findingsCreated: 0,
      truncated: false,
      error: 'Another run is already in progress for this company',
    };
  }
  return result;
}

async function runForCompanyLocked(
  tenantId: string,
  companyId: string | null,
  userId?: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const [run] = await db
    .insert(checkRuns)
    .values({ tenantId, companyId })
    .returning({ id: checkRuns.id });
  const runId = run!.id;

  let checksExecuted = 0;
  let findingsCreated = 0;
  let truncated = false;
  let errorMessage: string | null = null;

  try {
    const registryEntries = await registry.listEnabled();
    const activeSuppressions = await suppressions.listActive(tenantId);
    const defaultSeverityByCheck: Record<string, FindingSeverity> = {};
    for (const entry of registryEntries) {
      defaultSeverityByCheck[entry.checkKey] = entry.defaultSeverity;
    }

    for (const entry of registryEntries) {
      if (findingsCreated >= MAX_FINDINGS_PER_RUN) {
        truncated = true;
        break;
      }
      // AI-driven handlers (category='judgment') only fire when
      // the caller explicitly opts in. The 24h scheduler does NOT
      // pass includeAiHandlers, so AI cost stays bounded to
      // explicit "Run AI judgment" clicks from the bookkeeper.
      if (entry.category === 'judgment' && !options.includeAiHandlers) {
        continue;
      }
      const handler = HANDLERS[entry.handlerName];
      if (!handler) {
        // Registry references a handler that's not in the
        // index map — log and skip rather than fail the run.
        console.warn(`[review-checks] No handler registered for ${entry.handlerName}`);
        continue;
      }
      checksExecuted++;
      let drafts: FindingDraft[];
      try {
        const params = await registry.resolveParams(tenantId, companyId, entry);
        drafts = await handler(tenantId, companyId, params);
      } catch (err) {
        // Per-handler failures shouldn't kill the run.
        console.warn(
          `[review-checks] Handler ${entry.handlerName} failed for tenant ${tenantId}:`,
          err instanceof Error ? err.message : String(err),
        );
        continue;
      }

      const filtered = drafts.filter((d) => !suppressions.shouldSuppress(d, activeSuppressions, companyId));
      const remainingCap = MAX_FINDINGS_PER_RUN - findingsCreated;
      const capped = filtered.slice(0, remainingCap);
      if (filtered.length > capped.length) truncated = true;

      const result = await findingsService.bulkInsert(
        tenantId,
        companyId,
        capped,
        defaultSeverityByCheck,
        userId,
      );
      findingsCreated += result.inserted;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  await db
    .update(checkRuns)
    .set({
      completedAt: new Date(),
      checksExecuted,
      findingsCreated,
      truncated,
      error: errorMessage,
    })
    .where(eq(checkRuns.id, runId));

  return { runId, checksExecuted, findingsCreated, truncated, error: errorMessage };
}

// Iterates every company in the tenant + a tenant-wide pass
// for handlers that don't scope by company. Returns one
// RunResult per (tenant, company) pair so the caller can
// surface per-company stats.
export async function runForTenant(
  tenantId: string,
  userId?: string,
  options: RunOptions = {},
): Promise<RunResult[]> {
  const cos = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.tenantId, tenantId));

  const results: RunResult[] = [];
  for (const c of cos) {
    results.push(await runForCompany(tenantId, c.id, userId, options));
  }
  return results;
}

// List recent runs for a tenant — used by the admin UI in
// Phase 7. Returns up to `limit` entries, newest first. Caps
// at 200 server-side so a maliciously large `?limit=` query
// param can't exhaust the DB pool / memory.
const LIST_RUNS_HARD_CAP = 200;
export async function listRuns(tenantId: string, limit = 20): Promise<typeof checkRuns.$inferSelect[]> {
  const safeLimit =
    Number.isFinite(limit) && limit > 0
      ? Math.min(Math.floor(limit), LIST_RUNS_HARD_CAP)
      : 20;
  return db
    .select()
    .from(checkRuns)
    .where(eq(checkRuns.tenantId, tenantId))
    .orderBy(desc(checkRuns.startedAt))
    .limit(safeLimit);
}

// Used by the scheduler to decide whether to (re)run a
// (tenant, company) pair. Returns the timestamp of the last
// COMPLETED run, or null if none.
export async function lastRunCompletedAt(
  tenantId: string,
  companyId: string | null,
): Promise<Date | null> {
  const conditions = [eq(checkRuns.tenantId, tenantId)];
  conditions.push(
    companyId === null
      ? sql`${checkRuns.companyId} IS NULL`
      : eq(checkRuns.companyId, companyId),
  );
  const [row] = await db
    .select({ completedAt: checkRuns.completedAt })
    .from(checkRuns)
    .where(and(...conditions))
    .orderBy(desc(checkRuns.startedAt))
    .limit(1);
  return row?.completedAt ?? null;
}
