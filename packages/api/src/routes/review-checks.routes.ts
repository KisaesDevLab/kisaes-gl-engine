// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

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
  const { companyId } = req.body as { companyId?: string };
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
  const results = companyId
    ? [await orchestrator.runForCompany(req.tenantId, companyId, req.userId)]
    : await orchestrator.runForTenant(req.tenantId, req.userId);

  await auditLog(
    req.tenantId,
    'create',
    'check_run',
    null,
    null,
    { companyId: companyId ?? null, runs: results.length },
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
    const { companyId } = req.body as { companyId?: string };
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
            includeAiHandlers: true,
          }),
        ]
      : await orchestrator.runForTenant(req.tenantId, req.userId, {
          includeAiHandlers: true,
        });

    await auditLog(
      req.tenantId,
      'create',
      'check_run_ai_judgment',
      null,
      null,
      { companyId: companyId ?? null, runs: results.length },
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
  const runs = await orchestrator.listRuns(req.tenantId, limit ?? 20);
  res.json({ runs });
});

// GET /findings — paginated findings with filters.
reviewChecksRouter.get('/findings', async (req, res) => {
  const parsed = findingsListQuerySchema.parse({
    status: req.query['status'],
    severity: req.query['severity'],
    checkKey: req.query['checkKey'],
    companyId: req.query['companyId'],
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

// GET /findings/:id/events — state-transition history for the
// drawer's "Activity" pane.
reviewChecksRouter.get('/findings/:id/events', async (req, res) => {
  const events = await findingsService.listEvents(req.tenantId, req.params['id']!);
  res.json({ events });
});

// GET /findings-summary?companyId — counts grouped by status
// and severity for the dashboard summary widget.
reviewChecksRouter.get('/findings-summary', async (req, res) => {
  const companyId = typeof req.query['companyId'] === 'string' ? req.query['companyId'] : null;
  const summary = await findingsService.summaryByStatusSeverity(req.tenantId, companyId);
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
  if (req.userRole !== 'owner') {
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
    if (req.userRole !== 'owner') {
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
  if (req.userRole !== 'owner') {
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
