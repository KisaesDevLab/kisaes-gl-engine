// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import type { Request } from 'express';
import type { FirmRole, RuleScope } from '@kis-books/shared';
import {
  createConditionalRuleSchema,
  updateConditionalRuleSchema,
  reorderConditionalRulesSchema,
  conditionAstSchema,
  actionsFieldSchema,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/audit.js';
import { requirePracticeAccess } from '../middleware/practice-access.js';
import { AppError } from '../utils/errors.js';
import * as crudService from '../services/conditional-rules.service.js';
import * as sandboxService from '../services/rule-test-sandbox.service.js';
import * as suggestionsService from '../services/rule-suggestions.service.js';
import * as importExportService from '../services/rule-import-export.service.js';
import * as featureFlagsService from '../services/feature-flags.service.js';
import * as tenantFirmAssignmentService from '../services/tenant-firm-assignment.service.js';
import * as firmUsersService from '../services/firm-users.service.js';
import * as tiersService from '../services/conditional-rule-tiers.service.js';

export const conditionalRulesRouter = Router();

conditionalRulesRouter.use(authenticate);
conditionalRulesRouter.use(requirePracticeAccess('CONDITIONAL_RULES_V1'));

// 3-tier rules plan, Phase 2 — firm-context resolver. Looks up
// the current tenant's managing firm + the caller's role within
// it. Returns null fields when:
//   - the tenant has no active firm assignment (solo book), or
//   - the caller has no firm_users membership in the managing
//     firm (and isn't super-admin).
// Solo books and non-firm members can still author tenant_user
// rules; only tenant_firm / global_firm operations require a
// non-null firmId.
async function resolveFirmContext(req: Request): Promise<{
  firmId: string | null;
  firmRole: FirmRole | null;
  tieredEnabled: boolean;
}> {
  const tieredEnabled = await featureFlagsService
    .isEnabled(req.tenantId, 'RULES_TIERED_V1')
    .catch(() => false);
  if (!tieredEnabled) {
    return { firmId: null, firmRole: null, tieredEnabled: false };
  }
  const assignment = await tenantFirmAssignmentService.getActiveForTenant(req.tenantId);
  if (!assignment) {
    return { firmId: null, firmRole: null, tieredEnabled: true };
  }
  if (req.isSuperAdmin) {
    return { firmId: assignment.firmId, firmRole: 'firm_admin', tieredEnabled: true };
  }
  const role = await firmUsersService.getRoleForUser(assignment.firmId, req.userId);
  return { firmId: assignment.firmId, firmRole: role ?? null, tieredEnabled: true };
}

// Asserts the caller can author rules at the given scope. The
// service-layer create() ALSO enforces (CHECK constraint + ctx
// validation) but the route raises a clean 403 before the insert
// attempt for a friendlier error.
function assertCanAuthorScope(
  scope: RuleScope,
  ctx: { firmId: string | null; firmRole: FirmRole | null },
): void {
  if (scope === 'tenant_user') return; // any practice-access user
  if (!ctx.firmId) {
    throw AppError.notFound('This tenant is not managed by a firm');
  }
  if (scope === 'tenant_firm') {
    if (ctx.firmRole !== 'firm_admin' && ctx.firmRole !== 'firm_staff') {
      throw AppError.forbidden(
        'Firm staff or admin role required to author tenant_firm rules',
        'NOT_FIRM_STAFF',
      );
    }
    return;
  }
  // global_firm
  if (ctx.firmRole !== 'firm_admin') {
    throw AppError.forbidden(
      'Firm admin role required to author global_firm rules',
      'NOT_FIRM_ADMIN',
    );
  }
}

// GET / — list rules. Stats merged in for one-call rendering.
//
// 3-tier rules plan, Phase 2 — accepts ?scope=tenant_user|
// tenant_firm|global_firm. Default behavior (no scope filter):
//   - When RULES_TIERED_V1 is OFF: returns tenant_user rules
//     only, preserving Phase-1 semantics.
//   - When ON: returns every rule visible from the current
//     tenant + the managing firm's globals.
const scopeFilterSchema = z.enum(['tenant_user', 'tenant_firm', 'global_firm']).optional();
conditionalRulesRouter.get('/', async (req, res) => {
  const ctx = await resolveFirmContext(req);
  const scope = scopeFilterSchema.parse(req.query['scope']);
  // Flag-OFF compatibility: when the tier flag is disabled, force
  // scope to 'tenant_user' so the response shape and contents match
  // Phase 1 even if the caller passed ?scope=...
  const effectiveScope = ctx.tieredEnabled ? scope : 'tenant_user';
  const [rules, stats] = await Promise.all([
    crudService.listForTenant(req.tenantId, {
      scope: effectiveScope,
      firmId: ctx.firmId,
    }),
    crudService.statsForTenant(req.tenantId),
  ]);
  const statsById = new Map(stats.map((s) => [s.ruleId, s]));
  const merged = rules.map((r) => ({ ...r, stats: statsById.get(r.id) ?? null }));
  res.json({ rules: merged, firmId: ctx.firmId, firmRole: ctx.firmRole });
});

// Phase 5b §5.7 — auto-suggest. Computed on-demand; the
// frontend caches with a 5-min staleTime. Registered BEFORE the
// `:id` route so "suggestions" isn't matched as a uuid.
conditionalRulesRouter.get('/suggestions', async (req, res) => {
  const suggestions = await suggestionsService.detectSuggestions(req.tenantId);
  res.json({ suggestions });
});

// Phase 5b §5.5 — recent feed items the sandbox dropdown lists.
conditionalRulesRouter.get('/sandbox/recent-samples', async (req, res) => {
  const samples = await sandboxService.recentFeedItemsForPicker(req.tenantId);
  res.json({ samples });
});

// Bank-source account picker for the rule builder. The Phase-4
// condition field `account_source_id` tests against the GL
// account behind a bank connection (not the connection PK), so
// the UI needs the account uuid + a human label. Returns one
// row per active bank connection in the tenant.
conditionalRulesRouter.get('/bank-source-accounts', async (req, res) => {
  const rows = await sandboxService.bankSourceAccountsForPicker(req.tenantId);
  res.json({ accounts: rows });
});

// Phase 5b §5.8 — bulk export.
conditionalRulesRouter.get('/export.json', async (req, res) => {
  const bundle = await importExportService.exportToJson(req.tenantId);
  res.setHeader('Content-Disposition', `attachment; filename="conditional-rules-${Date.now()}.json"`);
  res.json(bundle);
});

conditionalRulesRouter.get('/export.csv', async (req, res) => {
  const csv = await importExportService.exportToCsv(req.tenantId);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="conditional-rules-${Date.now()}.csv"`);
  // Prepend UTF-8 BOM so Excel detects encoding on open and
  // doesn't mangle non-ASCII characters in rule names / memos.
  res.send('﻿' + csv);
});

conditionalRulesRouter.get('/:id', async (req, res) => {
  const ctx = await resolveFirmContext(req);
  const rule = await crudService.getById(req.tenantId, req.params['id']!, {
    firmId: ctx.firmId,
  });
  res.json(rule);
});

// Phase 5b §5.6 — paginated audit log per rule.
const auditQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
conditionalRulesRouter.get('/:id/audit', async (req, res) => {
  const parsed = auditQuerySchema.safeParse({
    cursor: req.query['cursor'],
    limit: req.query['limit'],
  });
  // Bad query params resolve to defaults rather than 400 — the
  // audit pane re-uses the URL-encoded cursor on refresh, so a
  // stale cursor shouldn't kill the page.
  const cursor = parsed.success ? parsed.data.cursor : undefined;
  const limit = parsed.success ? parsed.data.limit : undefined;
  // Verify the rule is visible to the caller before returning
  // audit rows that reference it. Audit listing is currently
  // tenant-scoped only — Phase 5 adds firm-aggregated audit
  // surfaces alongside the per-rule list.
  const ctxForAudit = await resolveFirmContext(req);
  await crudService.getById(req.tenantId, req.params['id']!, { firmId: ctxForAudit.firmId });
  const result = await crudService.listAudit(req.tenantId, req.params['id']!, { cursor, limit });
  res.json(result);
});

// 3-tier rules plan, Phase 3 — tier transition endpoints.
//
// Promote / demote / fork are gated behind `RULES_TIERED_V1`. When
// the flag is OFF, every transition returns 404 so the surface
// looks unavailable to clients that haven't opted into the tier
// model yet. The service layer per-tier role gates run on top.

const promoteBodySchema = z.object({
  // Required when promoting tenant_firm → global_firm because
  // the action shape stores tenant-specific UUIDs that won't
  // resolve cross-tenant until Phase 4 ships the resolver.
  confirmActionShapes: z.boolean().optional(),
});

conditionalRulesRouter.post('/:id/promote', async (req, res) => {
  const ctx = await resolveFirmContext(req);
  if (!ctx.tieredEnabled) {
    throw AppError.notFound('Feature not available');
  }
  const body = promoteBodySchema.parse(req.body ?? {});
  const before = await crudService.getById(req.tenantId, req.params['id']!, {
    firmId: ctx.firmId,
  });
  const after = await tiersService.promote(
    req.params['id']!,
    {
      currentUserId: req.userId,
      firmId: ctx.firmId,
      firmRole: ctx.firmRole,
      tenantId: req.tenantId,
    },
    body,
  );
  await auditLog(
    req.tenantId,
    'update',
    'conditional_rule_tier',
    after.id,
    { scope: before.scope },
    { scope: after.scope, ownerFirmId: after.ownerFirmId, ownerUserId: after.ownerUserId },
    req.userId,
  );
  res.json(after);
});

const demoteBodySchema = z.object({
  // Required when demoting global_firm → tenant_firm. The
  // service rejects with TENANT_ID_REQUIRED if missing.
  tenantId: z.string().uuid().optional(),
});

conditionalRulesRouter.post('/:id/demote', async (req, res) => {
  const ctx = await resolveFirmContext(req);
  if (!ctx.tieredEnabled) {
    throw AppError.notFound('Feature not available');
  }
  const body = demoteBodySchema.parse(req.body ?? {});
  const before = await crudService.getById(req.tenantId, req.params['id']!, {
    firmId: ctx.firmId,
  });
  const after = await tiersService.demote(
    req.params['id']!,
    {
      currentUserId: req.userId,
      firmId: ctx.firmId,
      firmRole: ctx.firmRole,
      tenantId: req.tenantId,
    },
    body,
  );
  await auditLog(
    req.tenantId,
    'update',
    'conditional_rule_tier',
    after.id,
    { scope: before.scope },
    { scope: after.scope, tenantId: after.tenantId, ownerUserId: after.ownerUserId },
    req.userId,
  );
  res.json(after);
});

const forkBodySchema = z.object({
  tenantId: z.string().uuid(),
});

conditionalRulesRouter.post('/:id/fork-to-tenant', async (req, res) => {
  const ctx = await resolveFirmContext(req);
  if (!ctx.tieredEnabled) {
    throw AppError.notFound('Feature not available');
  }
  const body = forkBodySchema.parse(req.body ?? {});
  // The forked rule lands on `body.tenantId`, not necessarily
  // the caller's current tenant. Verify the caller's firm
  // manages the target tenant before allowing the fork.
  const targetAssignment = await tenantFirmAssignmentService.getActiveForTenant(body.tenantId);
  if (!targetAssignment || targetAssignment.firmId !== ctx.firmId) {
    throw AppError.forbidden(
      'Target tenant is not managed by your firm',
      'TARGET_NOT_MANAGED',
    );
  }
  const fork = await tiersService.forkToTenant(
    req.params['id']!,
    {
      currentUserId: req.userId,
      firmId: ctx.firmId,
      firmRole: ctx.firmRole,
      tenantId: req.tenantId,
    },
    { tenantId: body.tenantId },
  );
  await auditLog(
    body.tenantId,
    'create',
    'conditional_rule',
    fork.id,
    null,
    {
      forkedFromGlobalId: fork.forkedFromGlobalId,
      name: fork.name,
      scope: fork.scope,
    },
    req.userId,
  );
  res.status(201).json(fork);
});

conditionalRulesRouter.get('/:id/tenant-overrides', async (req, res) => {
  const ctx = await resolveFirmContext(req);
  if (!ctx.tieredEnabled) {
    throw AppError.notFound('Feature not available');
  }
  const overrides = await tiersService.listTenantOverrides(req.params['id']!, {
    currentUserId: req.userId,
    firmId: ctx.firmId,
    firmRole: ctx.firmRole,
    tenantId: req.tenantId,
  });
  res.json({ overrides });
});

// Phase 5b §5.5 — sandbox runners. Both endpoints accept an
// UNSAVED rule body so authors can test before saving.
const sandboxRuleBodySchema = z.object({
  conditions: conditionAstSchema,
  actions: actionsFieldSchema,
});

conditionalRulesRouter.post('/sandbox/run', async (req, res) => {
  const rule = sandboxRuleBodySchema.parse(req.body?.rule ?? {});
  const sampleFeedItemId = typeof req.body?.sampleFeedItemId === 'string' ? req.body.sampleFeedItemId : undefined;
  const sampleContext = req.body?.sampleContext;
  const result = await sandboxService.runOnSample(req.tenantId, rule, {
    sampleFeedItemId,
    sampleContext,
  });
  res.json(result);
});

conditionalRulesRouter.post('/sandbox/run-batch', async (req, res) => {
  const rule = sandboxRuleBodySchema.parse(req.body?.rule ?? {});
  const limit = typeof req.body?.limit === 'number' ? req.body.limit : 100;
  const result = await sandboxService.runOnLast100(req.tenantId, rule, limit);
  res.json(result);
});

// Phase 5b §5.8 — JSON import. Atomic; partial validation
// failures roll back. The error handler surfaces the per-rule
// errors via the AppError details payload that the existing
// errorHandler already passes through.
conditionalRulesRouter.post('/import', async (req, res) => {
  const report = await importExportService.importJson(req.tenantId, req.body, req.userId);
  await auditLog(
    req.tenantId,
    'create',
    'conditional_rule_import',
    null,
    null,
    { imported: report.imported },
    req.userId,
  );
  res.status(201).json(report);
});

conditionalRulesRouter.post('/', validate(createConditionalRuleSchema), async (req, res) => {
  const ctx = await resolveFirmContext(req);
  // Default scope is 'tenant_user' — preserves the Phase-1 wire
  // contract for clients that pre-date scope. Server-side gate
  // rejects illegal tier requests before the DB insert.
  const scope: RuleScope =
    ctx.tieredEnabled && req.body.scope ? (req.body.scope as RuleScope) : 'tenant_user';
  assertCanAuthorScope(scope, ctx);
  const rule = await crudService.create(
    req.tenantId,
    req.body,
    {
      scope,
      currentUserId: req.userId,
      firmId: ctx.firmId,
    },
    req.userId,
  );
  await auditLog(
    req.tenantId,
    'create',
    'conditional_rule',
    rule.id,
    null,
    { name: rule.name, priority: rule.priority, scope: rule.scope },
    req.userId,
  );
  res.status(201).json(rule);
});

conditionalRulesRouter.put('/:id', validate(updateConditionalRuleSchema), async (req, res) => {
  const ctx = await resolveFirmContext(req);
  const before = await crudService.getById(req.tenantId, req.params['id']!, {
    firmId: ctx.firmId,
  });
  // Authoring-scope check: editing a tenant_firm or global_firm
  // rule requires the appropriate firm role.
  assertCanAuthorScope(before.scope, ctx);
  const after = await crudService.update(req.tenantId, req.params['id']!, req.body, {
    firmId: ctx.firmId,
  });
  await auditLog(
    req.tenantId,
    'update',
    'conditional_rule',
    after.id,
    { name: before.name, priority: before.priority, active: before.active },
    { name: after.name, priority: after.priority, active: after.active },
    req.userId,
  );
  res.json(after);
});

conditionalRulesRouter.delete('/:id', async (req, res) => {
  // Owner-only for tenant_user; firm_admin for tenant_firm /
  // global_firm. Destructive op cascades per-fire audit history.
  // Bookkeepers should mark inactive instead.
  const ctx = await resolveFirmContext(req);
  const before = await crudService.getById(req.tenantId, req.params['id']!, {
    firmId: ctx.firmId,
  });
  if (before.scope === 'tenant_user') {
    if (req.userRole !== 'owner') {
      throw AppError.forbidden('Owner role required to delete tenant_user rules');
    }
  } else if (ctx.firmRole !== 'firm_admin') {
    throw AppError.forbidden(
      'Firm admin role required to delete tenant_firm / global_firm rules',
      'NOT_FIRM_ADMIN',
    );
  }
  await crudService.remove(req.tenantId, req.params['id']!, { firmId: ctx.firmId });
  await auditLog(
    req.tenantId,
    'delete',
    'conditional_rule',
    before.id,
    { name: before.name, scope: before.scope },
    null,
    req.userId,
  );
  res.json({ deleted: true });
});

conditionalRulesRouter.post(
  '/reorder',
  validate(reorderConditionalRulesSchema),
  async (req, res) => {
    await crudService.reorder(req.tenantId, req.body.orderedIds);
    await auditLog(
      req.tenantId,
      'update',
      'conditional_rule_order',
      null,
      null,
      { orderedIds: req.body.orderedIds },
      req.userId,
    );
    res.json({ reordered: req.body.orderedIds.length });
  },
);
