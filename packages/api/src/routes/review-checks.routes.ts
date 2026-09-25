// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import {
  runChecksSchema,
  runAiJudgmentSchema,
  findingsListQuerySchema,
  createSuppressionSchema,
  setOverrideSchema,
  transitionFindingSchema,
  bulkTransitionFindingsSchema,
} from '@kis-books/shared';
import * as featureFlags from '../services/feature-flags.service.js';
import { and, eq } from 'drizzle-orm';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/audit.js';
import { requirePracticeAccess } from '../middleware/practice-access.js';
import { AppError } from '../utils/errors.js';
import { db } from '../db/index.js';
import { companies } from '../db/schema/index.js';
import * as orchestrator from '../services/review-checks/orchestrator.service.js';
import * as registry from '../services/review-checks/registry.service.js';
import * as findingsService from '../services/review-checks/findings.service.js';
import * as suppressions from '../services/review-checks/suppressions.service.js';
import * as closeChecklist from '../services/review-checks/close-checklist.service.js';
import * as closeService from '../services/review-checks/close.service.js';
import * as closeReviewAi from '../services/review-checks/close-review-ai.service.js';

export const reviewChecksRouter = Router();

reviewChecksRouter.use(authenticate);
// Phase 6 routes are gated by CLOSE_REVIEW_V1 — Phase 7 ships
// the dashboard inside the Close Review surface. Readonly
// users + client user_type are excluded; run/suppression/override
// mutations additionally require owner role checked at the handler.
reviewChecksRouter.use(requirePracticeAccess('CLOSE_REVIEW_V1'));

// GET /registry — list all available checks (enabled + disabled).
// Read-only; surfaces what the engine knows about so the
// dashboard can render check toggles in Phase 7.
reviewChecksRouter.get('/registry', async (_req, res) => {
  const entries = await registry.listAll();
  res.json({ checks: entries });
});

// POST /run — on-demand orchestrator trigger. Body: optional
// companyId. Returns one RunResult per company executed (or a
// single result when companyId is supplied). AI-driven handlers
// (category='judgment') are NOT run by this route — see
// /run-ai-judgment for that.
reviewChecksRouter.post('/run', validate(runChecksSchema), async (req, res) => {
  const { companyId, periodStart, periodEnd } = req.body as {
    companyId?: string;
    periodStart: string;
    periodEnd: string;
  };
  if (companyId) {
    // Tenant-isolation: confirm the company belongs to the caller's
    // tenant before running checks against it. Without this, a
    // sibling-tenant company id leaks "exists" timing.
    const exists = await db
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.tenantId, req.tenantId), eq(companies.id, companyId)))
      .limit(1);
    if (exists.length === 0) {
      throw AppError.notFound('Company not found');
    }
  }
  const runOptions = { periodStart, periodEnd };
  const results = companyId
    ? [await orchestrator.runForCompany(req.tenantId, companyId, req.userId, runOptions)]
    : await orchestrator.runForTenant(req.tenantId, req.userId, runOptions);

  await auditLog(
    req.tenantId,
    'create',
    'check_run',
    null,
    null,
    { companyId: companyId ?? null, periodStart, periodEnd, runs: results.length },
    req.userId,
  );
  res.json({ runs: results });
});

// POST /run-ai-judgment — explicit AI run. Same body shape as
// /run, but the orchestrator passes includeAiHandlers=true so
// category='judgment' handlers fire. Gated by the
// AI_JUDGMENT_CHECKS_V1 feature flag so admins can stage the
// rollout per tenant. Auditable as a separate entity so the
// "AI-credits used" Pareto is easy to surface.
reviewChecksRouter.post(
  '/run-ai-judgment',
  validate(runAiJudgmentSchema),
  async (req, res) => {
    const enabled = await featureFlags.isEnabled(req.tenantId, 'AI_JUDGMENT_CHECKS_V1');
    if (!enabled) {
      throw AppError.notFound('AI judgment checks are not enabled for this tenant');
    }
    const { companyId, periodStart, periodEnd } = req.body as {
      companyId?: string;
      periodStart: string;
      periodEnd: string;
    };
    if (companyId) {
      const exists = await db
        .select({ id: companies.id })
        .from(companies)
        .where(and(eq(companies.tenantId, req.tenantId), eq(companies.id, companyId)))
        .limit(1);
      if (exists.length === 0) {
        throw AppError.notFound('Company not found');
      }
    }
    const results = companyId
      ? [
          await orchestrator.runForCompany(req.tenantId, companyId, req.userId, {
            onlyAiHandlers: true, periodStart, periodEnd,
          }),
        ]
      : await orchestrator.runForTenant(req.tenantId, req.userId, {
          onlyAiHandlers: true, periodStart, periodEnd,
        });

    await auditLog(
      req.tenantId,
      'create',
      'check_run_ai_judgment',
      null,
      null,
      { companyId: companyId ?? null, periodStart, periodEnd, runs: results.length },
      req.userId,
    );
    res.json({ runs: results });
  },
);

// GET /runs — recent runs metadata. Limit is coerced via Zod
// and capped server-side in orchestrator.listRuns; query strings
// like `?limit=abc` or `?limit=99999` resolve to the default 20.
const listRunsQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(200).optional() })
  .strict();
reviewChecksRouter.get('/runs', async (req, res) => {
  const { limit } = listRunsQuerySchema
    .partial()
    .safeParse({ limit: req.query['limit'] }).data ?? { limit: undefined };
  // Optional scope so "Last run" reflects THIS company and close period,
  // not whichever company last ran anything.
  const companyId = typeof req.query['companyId'] === 'string' ? req.query['companyId'] : undefined;
  const periodStart = typeof req.query['periodStart'] === 'string' ? req.query['periodStart'] : undefined;
  const runs = await orchestrator.listRuns(req.tenantId, limit ?? 20, {
    ...(companyId ? { companyId } : {}),
    ...(periodStart ? { periodStart } : {}),
  });
  res.json({ runs });
});

// GET /findings — paginated findings with filters.
reviewChecksRouter.get('/findings', async (req, res) => {
  const parsed = findingsListQuerySchema.parse({
    status: req.query['status'],
    severity: req.query['severity'],
    checkKey: req.query['checkKey'],
    companyId: req.query['companyId'],
    periodStart: req.query['periodStart'],
    periodEnd: req.query['periodEnd'],
    cursor: req.query['cursor'],
    limit: req.query['limit'],
  });
  const result = await findingsService.list(req.tenantId, parsed);
  res.json(result);
});

// GET /findings/:id — single finding.
reviewChecksRouter.get('/findings/:id', async (req, res) => {
  const finding = await findingsService.getById(req.tenantId, req.params['id']!);
  if (!finding) throw AppError.notFound('Finding not found');
  res.json(finding);
});

// GET /findings/:id/payee-history — how this finding's payee was coded
// over the 12 months before its period.
reviewChecksRouter.get('/findings/:id/payee-history', async (req, res) => {
  res.json(await findingsService.payeeCodingHistory(req.tenantId, req.params['id']!));
});

// GET /findings/:id/ai — the stored AI explanation and whether the books
// changed since it was written ("out of date").
reviewChecksRouter.get('/findings/:id/ai', async (req, res) => {
  res.json(await closeReviewAi.getFindingAi(req.tenantId, req.params['id']!));
});

// POST /findings/:id/explain — ask the Close Review AI about one row. Runs
// only when a reviewer clicks; gated like Run AI judgment.
reviewChecksRouter.post('/findings/:id/explain', async (req, res) => {
  if (!(await featureFlags.isEnabled(req.tenantId, 'AI_JUDGMENT_CHECKS_V1'))) {
    throw AppError.notFound('AI review is not enabled for this client');
  }
  const ai = await closeReviewAi.explainFinding(req.tenantId, req.params['id']!);
  await auditLog(req.tenantId, 'create', 'finding_ai_explanation', req.params['id']!, null, { model: ai.model, provider: ai.provider }, req.userId);
  res.json({ ai, stale: false });
});

// ── Close workspace ───────────────────────────────────────────────
const closeQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
});

// GET /reports — per-check open / accepted / excluded counts for the month.
reviewChecksRouter.get('/reports', async (req, res) => {
  const q = closeQuerySchema.parse(req.query);
  await assertCompanyInTenant(req.tenantId, q.companyId ?? null);
  const counts = await findingsService.countsByCheck(req.tenantId, q.companyId ?? null, q);
  res.json({ counts });
});

// GET /close — the month's close record and sign-off chain.
reviewChecksRouter.get('/close', async (req, res) => {
  const q = closeQuerySchema.parse(req.query);
  await assertCompanyInTenant(req.tenantId, q.companyId ?? null);
  res.json({ close: await closeService.getClose(req.tenantId, q.companyId ?? null, q.periodStart, q.periodEnd) });
});

const signSchema = closeQuerySchema.extend({
  role: z.enum(['preparer', 'reviewer']),
  note: z.string().trim().max(1000).optional(),
});
reviewChecksRouter.post('/close/sign', validate(signSchema), async (req, res) => {
  const b = req.body as z.infer<typeof signSchema>;
  await assertCompanyInTenant(req.tenantId, b.companyId ?? null);
  res.json({ close: await closeService.sign(req.tenantId, b.companyId ?? null, b.periodStart, b.periodEnd, b.role, req.userId, b.note || null) });
});

reviewChecksRouter.post('/close/undo', validate(closeQuerySchema), async (req, res) => {
  const b = req.body as z.infer<typeof closeQuerySchema>;
  await assertCompanyInTenant(req.tenantId, b.companyId ?? null);
  res.json({ close: await closeService.unsign(req.tenantId, b.companyId ?? null, b.periodStart, b.periodEnd, req.userId) });
});

// GET /findings/:id/events — state-transition history for the
// drawer's "Activity" pane.
reviewChecksRouter.get('/findings/:id/events', async (req, res) => {
  const events = await findingsService.listEvents(req.tenantId, req.params['id']!);
  res.json({ events });
});

// GET /findings-summary?companyId&periodStart&periodEnd — counts grouped
// by status and severity, scoped exactly like GET /findings.
reviewChecksRouter.get('/findings-summary', async (req, res) => {
  const companyId = typeof req.query['companyId'] === 'string' ? req.query['companyId'] : null;
  const periodStart = typeof req.query['periodStart'] === 'string' ? req.query['periodStart'] : undefined;
  const periodEnd = typeof req.query['periodEnd'] === 'string' ? req.query['periodEnd'] : undefined;
  const summary = await findingsService.summaryByStatusSeverity(req.tenantId, companyId, {
    ...(periodStart ? { periodStart } : {}),
    ...(periodEnd ? { periodEnd } : {}),
  });
  res.json(summary);
});

// POST /findings/:id/transition — change a single finding's
// status. The shared schema already enforces "assignedTo
// required when status=assigned".
reviewChecksRouter.post(
  '/findings/:id/transition',
  validate(transitionFindingSchema),
  async (req, res) => {
    const id = req.params['id']!;
    const { status, note, assignedTo, resolutionNote } = req.body;
    const before = await findingsService.getById(req.tenantId, id);
    if (!before) throw AppError.notFound('Finding not found');
    const updated = await findingsService.transition(req.tenantId, id, status, {
      userId: req.userId,
      note,
      assignedTo: assignedTo ?? undefined,
      resolutionNote,
    });
    res.json(updated);
  },
);

// POST /findings/bulk-transition — same options apply to every
// id in the batch. Returns per-row outcome.
reviewChecksRouter.post(
  '/findings/bulk-transition',
  validate(bulkTransitionFindingsSchema),
  async (req, res) => {
    const { ids, status, note, assignedTo, resolutionNote } = req.body;
    const result = await findingsService.bulkTransition(req.tenantId, ids, status, {
      userId: req.userId,
      note,
      assignedTo: assignedTo ?? undefined,
      resolutionNote,
    });
    await auditLog(
      req.tenantId,
      'update',
      'finding_bulk_transition',
      null,
      { ids, status },
      { updated: result.updated.length, failed: result.failed.length },
      req.userId,
    );
    res.json(result);
  },
);

// POST /suppressions — create a suppression pattern.
reviewChecksRouter.post(
  '/suppressions',
  validate(createSuppressionSchema),
  async (req, res) => {
    const created = await suppressions.create({
      tenantId: req.tenantId,
      companyId: req.body.companyId ?? null,
      checkKey: req.body.checkKey,
      matchPattern: req.body.matchPattern,
      reason: req.body.reason,
      expiresAt: req.body.expiresAt,
      createdBy: req.userId,
    });
    await auditLog(
      req.tenantId,
      'create',
      'check_suppression',
      created.id,
      null,
      { checkKey: created.checkKey, matchPattern: created.matchPattern },
      req.userId,
    );
    res.status(201).json(created);
  },
);

// GET /suppressions — list. Returns ALL (active + expired)
// so the management UI can show history.
reviewChecksRouter.get('/suppressions', async (req, res) => {
  const items = await suppressions.listAll(req.tenantId);
  res.json({ suppressions: items });
});

// DELETE /suppressions/:id — remove. Owner-only because a bad
// delete could un-mute a known-noisy check tenant-wide.
reviewChecksRouter.delete('/suppressions/:id', async (req, res) => {
  if (req.userRole !== 'owner' && !req.isSuperAdmin) {
    throw AppError.forbidden('Owner role required to delete suppressions');
  }
  await suppressions.remove(req.tenantId, req.params['id']!);
  await auditLog(
    req.tenantId,
    'delete',
    'check_suppression',
    req.params['id']!,
    null,
    null,
    req.userId,
  );
  res.json({ deleted: true });
});

// GET /overrides — list every override row for the tenant. Used
// by the Practice Settings UI to show effective threshold values
// next to registry defaults. Read-open to any practice user
// (the settings page itself is owner-only on the route guard,
// but read of "what is the current materiality?" is benign).
reviewChecksRouter.get('/overrides', async (req, res) => {
  const overrides = await registry.listOverrides(req.tenantId);
  res.json({ overrides });
});

// PUT /overrides/:checkKey — set per-(tenant, company) param
// override. Owner-only.
reviewChecksRouter.put(
  '/overrides/:checkKey',
  validate(setOverrideSchema),
  async (req, res) => {
    if (req.userRole !== 'owner' && !req.isSuperAdmin) {
      throw AppError.forbidden('Owner role required to override check params');
    }
    const checkKey = req.params['checkKey']!;
    await registry.setOverride(req.tenantId, req.body.companyId ?? null, checkKey, req.body.params);
    await auditLog(
      req.tenantId,
      'update',
      'check_params_override',
      null,
      null,
      { checkKey, companyId: req.body.companyId ?? null, params: req.body.params },
      req.userId,
    );
    res.json({ updated: true });
  },
);

// DELETE /overrides/:checkKey?companyId=… — drop an override so
// the resolver falls back to the next layer. Owner-only.
reviewChecksRouter.delete('/overrides/:checkKey', async (req, res) => {
  if (req.userRole !== 'owner' && !req.isSuperAdmin) {
    throw AppError.forbidden('Owner role required to remove check overrides');
  }
  const checkKey = req.params['checkKey']!;
  const companyId = typeof req.query['companyId'] === 'string' ? req.query['companyId'] : null;
  await registry.deleteOverride(req.tenantId, companyId, checkKey);
  await auditLog(
    req.tenantId,
    'delete',
    'check_params_override',
    null,
    null,
    { checkKey, companyId },
    req.userId,
  );
  res.json({ deleted: true });
});

// ── Close checklist ─────────────────────────────────────────────
// The ordered month-end workflow: derived task states (reconciliation
// coverage, bank-feed backlog, open findings) + manual sign-offs.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Task keys are machine-generated: 'reconcile:<accountId>' or one of
// the fixed workflow keys. Rejecting free text keeps the sign-off
// table bounded to rows the checklist can actually display.
const TASK_KEY_RE = /^(reconcile:[0-9a-f-]{36}|bank_feed|findings|final_review)$/i;

function isRealDate(d: string): boolean {
  const parsed = new Date(`${d}T00:00:00Z`);
  return !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d;
}

// Tenant-isolation: a client-supplied companyId must belong to the
// caller's tenant (same standard as POST /run above).
async function assertCompanyInTenant(tenantId: string, companyId: string | null): Promise<void> {
  if (!companyId) return;
  const exists = await db
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
    .limit(1);
  if (exists.length === 0) throw AppError.notFound('Company not found');
}

function readChecklistScope(q: Record<string, unknown>): { companyId: string | null; periodStart: string; periodEnd: string } {
  const companyId = typeof q['companyId'] === 'string' && q['companyId'] ? (q['companyId'] as string) : null;
  if (companyId && !UUID_RE.test(companyId)) {
    throw AppError.badRequest('companyId must be a UUID');
  }
  const periodStart = String(q['periodStart'] ?? '').slice(0, 10);
  const periodEnd = String(q['periodEnd'] ?? '').slice(0, 10);
  if (!ISO_DATE.test(periodStart) || !ISO_DATE.test(periodEnd) || !isRealDate(periodStart) || !isRealDate(periodEnd)) {
    throw AppError.badRequest('periodStart and periodEnd (valid YYYY-MM-DD) are required');
  }
  return { companyId, periodStart, periodEnd };
}

// GET /checklist?companyId=&periodStart=&periodEnd= — derived tasks +
// sign-off state for the period.
reviewChecksRouter.get('/checklist', async (req, res) => {
  const { companyId, periodStart, periodEnd } = readChecklistScope(req.query as Record<string, unknown>);
  await assertCompanyInTenant(req.tenantId, companyId);
  const tasks = await closeChecklist.getCloseChecklist(req.tenantId, companyId, periodStart, periodEnd);
  res.json({ tasks });
});

const checklistTaskSchema = z.object({
  companyId: z.string().uuid().nullish(),
  periodStart: z.string().regex(ISO_DATE),
  taskKey: z.string().regex(TASK_KEY_RE, 'Unknown checklist task'),
  note: z.string().max(2000).nullish(),
});

// POST /checklist/complete — manual sign-off (also usable to accept an
// auto task that can't be satisfied in-app, with a note saying why).
reviewChecksRouter.post('/checklist/complete', validate(checklistTaskSchema), async (req, res) => {
  const { companyId, periodStart, taskKey, note } = req.body as z.infer<typeof checklistTaskSchema>;
  if (!isRealDate(periodStart)) throw AppError.badRequest('periodStart must be a valid date');
  await assertCompanyInTenant(req.tenantId, companyId ?? null);
  // Re-signing replaces an existing sign-off — capture the prior state
  // so the audit trail shows whose acceptance was overwritten.
  const before = await closeChecklist.getSignoff(req.tenantId, companyId ?? null, periodStart, taskKey);
  await closeChecklist.completeChecklistTask(req.tenantId, companyId ?? null, periodStart, taskKey, note ?? null, req.userId);
  await auditLog(req.tenantId, 'update', 'close_checklist_task', null, before, { periodStart, taskKey, companyId: companyId ?? null, done: true, note: note ?? null }, req.userId);
  res.json({ completed: true });
});

// POST /checklist/reopen — withdraw a manual sign-off.
reviewChecksRouter.post('/checklist/reopen', validate(checklistTaskSchema.omit({ note: true })), async (req, res) => {
  const { companyId, periodStart, taskKey } = req.body as z.infer<typeof checklistTaskSchema>;
  if (!isRealDate(periodStart)) throw AppError.badRequest('periodStart must be a valid date');
  await assertCompanyInTenant(req.tenantId, companyId ?? null);
  const before = await closeChecklist.getSignoff(req.tenantId, companyId ?? null, periodStart, taskKey);
  await closeChecklist.reopenChecklistTask(req.tenantId, companyId ?? null, periodStart, taskKey);
  await auditLog(req.tenantId, 'update', 'close_checklist_task', null, before, { periodStart, taskKey, companyId: companyId ?? null, done: false }, req.userId);
  res.json({ reopened: true });
});
