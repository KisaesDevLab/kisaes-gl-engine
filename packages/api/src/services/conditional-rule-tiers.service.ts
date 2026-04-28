// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, eq, isNull } from 'drizzle-orm';
import type {
  Action,
  ActionsField,
  ConditionAST,
  ConditionalRule,
  RuleScope,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { conditionalRules } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as crudService from './conditional-rules.service.js';

// 3-tier rules plan, Phase 3 — tier transitions.
//
// Promote moves a rule UP one tier: tenant_user → tenant_firm →
// global_firm. Demote moves DOWN: global_firm → tenant_firm →
// tenant_user. Fork clones a global_firm rule as a tenant_firm
// rule for one tenant, with `forked_from_global_id` pointing
// back. Forks shadow the global at evaluation time for that
// tenant only (the evaluator wiring lands in Phase 4).
//
// Symbol resolution caveat: the action shape today stores
// concrete UUIDs (`accountId`, `vendorId`). When a rule moves
// to global_firm, those UUIDs are still tenant-specific. Phase 4
// introduces the discriminated-union target shape (`{kind: 'uuid'
// | 'system_tag', ...}`) and the resolver service that converts
// UUIDs to system_tag handles. THIS PHASE moves rules
// structurally without rewriting the action targets — global
// rules end up with stale UUIDs that will only work for the
// originating tenant. The promote-to-global path emits a
// warning-shaped 422 unless the caller passes
// `confirmActionShapes: true` so the bookkeeper acknowledges
// that the rule needs Phase-4 resolver support to fire on
// other tenants.

// ─── Types ───────────────────────────────────────────────────

export interface TierActionContext {
  /** Caller's user id (used as ownerUserId on demote-to-user). */
  currentUserId: string;
  /** The firm the caller is acting on. Required for any promote
   *  to firm/global; required for fork. Required for demote
   *  out of firm/global. */
  firmId: string | null;
  /** Caller's role inside that firm. The route layer pre-checks
   *  this against the requested transition. */
  firmRole: 'firm_admin' | 'firm_staff' | 'firm_readonly' | null;
  /** Tenant context for tenant-scoped operations. Always present
   *  on the request because authenticate sets req.tenantId. */
  tenantId: string;
}

export interface PromoteOptions {
  /** Required when promoting tenant_firm → global_firm. The
   *  current action shape stores tenant-specific UUIDs that
   *  won't resolve cross-tenant until Phase 4 ships the symbol
   *  resolver; the flag forces the caller to acknowledge that. */
  confirmActionShapes?: boolean;
}

export interface DemoteOptions {
  /** Required when demoting global_firm → tenant_firm — chooses
   *  which tenant the firm rule lands on. */
  tenantId?: string;
}

export interface ForkToTenantOptions {
  /** Tenant to fork the global rule into. Caller must have
   *  firm-staff access on the firm AND the firm must manage the
   *  target tenant. */
  tenantId: string;
}

// ─── promote ─────────────────────────────────────────────────

const NEXT_TIER_UP: Record<RuleScope, RuleScope | null> = {
  tenant_user: 'tenant_firm',
  tenant_firm: 'global_firm',
  global_firm: null,
};

export async function promote(
  ruleId: string,
  ctx: TierActionContext,
  opts: PromoteOptions = {},
): Promise<ConditionalRule> {
  const before = await loadRuleAcrossScopes(ruleId, ctx);
  const next = NEXT_TIER_UP[before.scope];
  if (!next) {
    throw AppError.badRequest(
      `Rule is already at the highest tier (${before.scope}). Cannot promote further.`,
      'ALREADY_TOP_TIER',
    );
  }
  // Role gate per destination tier.
  if (next === 'tenant_firm') {
    if (!ctx.firmId) {
      throw AppError.notFound('This tenant is not managed by a firm');
    }
    if (ctx.firmRole !== 'firm_admin' && ctx.firmRole !== 'firm_staff') {
      throw AppError.forbidden(
        'Firm staff or admin role required to promote to tenant_firm',
        'NOT_FIRM_STAFF',
      );
    }
  }
  if (next === 'global_firm') {
    if (!ctx.firmId) {
      throw AppError.notFound('This tenant is not managed by a firm');
    }
    if (ctx.firmRole !== 'firm_admin') {
      throw AppError.forbidden(
        'Firm admin role required to promote to global_firm',
        'NOT_FIRM_ADMIN',
      );
    }
    // The action shape stores tenant-specific UUIDs today. Once
    // Phase 4 lands the resolver, this path will rewrite them to
    // system_tag handles automatically. Until then, force the
    // caller to confirm so the rule isn't silently broken on
    // other tenants.
    if (!opts.confirmActionShapes) {
      throw new AppError(
        422,
        'Promoting to global_firm requires confirmActionShapes=true. Action targets reference tenant-specific UUIDs and will not resolve correctly on other tenants until the symbol resolver ships in Phase 4.',
        'CONFIRM_ACTION_SHAPES_REQUIRED',
      );
    }
  }
  // Apply the structural move. Owner fields swap per tier.
  const update = await applyTierUpdate(before, next, ctx);
  return update;
}

// ─── demote ──────────────────────────────────────────────────

const NEXT_TIER_DOWN: Record<RuleScope, RuleScope | null> = {
  global_firm: 'tenant_firm',
  tenant_firm: 'tenant_user',
  tenant_user: null,
};

export async function demote(
  ruleId: string,
  ctx: TierActionContext,
  opts: DemoteOptions = {},
): Promise<ConditionalRule> {
  const before = await loadRuleAcrossScopes(ruleId, ctx);
  const next = NEXT_TIER_DOWN[before.scope];
  if (!next) {
    throw AppError.badRequest(
      `Rule is already at the lowest tier (${before.scope}). Cannot demote further.`,
      'ALREADY_BOTTOM_TIER',
    );
  }
  if (before.scope === 'global_firm') {
    if (ctx.firmRole !== 'firm_admin') {
      throw AppError.forbidden(
        'Firm admin role required to demote a global_firm rule',
        'NOT_FIRM_ADMIN',
      );
    }
    if (!opts.tenantId) {
      throw AppError.badRequest(
        'Demoting global_firm → tenant_firm requires `tenantId` in the body',
        'TENANT_ID_REQUIRED',
      );
    }
  }
  if (before.scope === 'tenant_firm') {
    if (ctx.firmRole !== 'firm_admin' && ctx.firmRole !== 'firm_staff') {
      throw AppError.forbidden(
        'Firm staff or admin role required to demote a tenant_firm rule',
        'NOT_FIRM_STAFF',
      );
    }
  }
  const update = await applyTierUpdate(before, next, ctx, opts);
  return update;
}

// ─── fork ────────────────────────────────────────────────────

export async function forkToTenant(
  ruleId: string,
  ctx: TierActionContext,
  opts: ForkToTenantOptions,
): Promise<ConditionalRule> {
  const source = await loadRuleAcrossScopes(ruleId, ctx);
  if (source.scope !== 'global_firm') {
    throw AppError.badRequest(
      'Only global_firm rules can be forked to a tenant',
      'NOT_GLOBAL_FIRM',
    );
  }
  if (!ctx.firmId) {
    throw AppError.badRequest(
      'Fork requires a firm context',
      'NO_FIRM_CONTEXT',
    );
  }
  if (ctx.firmRole !== 'firm_admin' && ctx.firmRole !== 'firm_staff') {
    throw AppError.forbidden(
      'Firm staff or admin role required to fork a global rule',
      'NOT_FIRM_STAFF',
    );
  }
  // The fork is a NEW row — same conditions/actions JSONB,
  // tenant_firm scope, the source firm as owner, and
  // forked_from_global_id pointing back. Action targets keep
  // the global's UUIDs verbatim; the Phase-4 resolver will
  // re-bind them to the target tenant's UUIDs once it lands.
  const [row] = await db.insert(conditionalRules).values({
    tenantId: opts.tenantId,
    companyId: source.companyId,
    name: source.name,
    priority: source.priority,
    conditions: source.conditions as ConditionAST,
    actions: source.actions as ActionsField,
    continueAfterMatch: source.continueAfterMatch,
    active: source.active,
    createdBy: ctx.currentUserId,
    scope: 'tenant_firm',
    ownerUserId: null,
    ownerFirmId: ctx.firmId,
    forkedFromGlobalId: source.id,
  }).returning();
  return mapRow(row!);
}

// ─── listTenantOverrides ─────────────────────────────────────

// Returns the list of tenants that have a fork pointing back at
// the given global rule. The firm-admin UI uses this to surface
// "X tenants override this rule" with drift hints.
export async function listTenantOverrides(
  globalRuleId: string,
  ctx: TierActionContext,
): Promise<Array<{ ruleId: string; tenantId: string; name: string; updatedAt: string }>> {
  const global = await loadRuleAcrossScopes(globalRuleId, ctx);
  if (global.scope !== 'global_firm') {
    throw AppError.badRequest(
      'tenant-overrides is only valid on global_firm rules',
      'NOT_GLOBAL_FIRM',
    );
  }
  if (!ctx.firmId || global.ownerFirmId !== ctx.firmId) {
    throw AppError.notFound('Global rule not found');
  }
  const rows = await db
    .select({
      id: conditionalRules.id,
      tenantId: conditionalRules.tenantId,
      name: conditionalRules.name,
      updatedAt: conditionalRules.updatedAt,
    })
    .from(conditionalRules)
    .where(eq(conditionalRules.forkedFromGlobalId, globalRuleId));
  return rows
    .filter((r): r is typeof r & { tenantId: string } => r.tenantId !== null)
    .map((r) => ({
      ruleId: r.id,
      tenantId: r.tenantId,
      name: r.name,
      updatedAt: r.updatedAt.toISOString(),
    }));
}

// ─── helpers ─────────────────────────────────────────────────

// Loads a rule by id with scope-aware visibility — tenant-scoped
// rules must match the caller's tenantId; globals must match the
// caller's firmId. Returns the raw shape so the transition
// helpers can read every column (including the ownership
// fields the public ConditionalRule type exposes).
async function loadRuleAcrossScopes(
  ruleId: string,
  ctx: TierActionContext,
): Promise<ConditionalRule> {
  // Reuse crudService.getById which already does scope-aware
  // visibility. firmId is forwarded so global rules visible to
  // this firm are findable.
  return crudService.getById(ctx.tenantId, ruleId, { firmId: ctx.firmId });
}

function mapRow(row: typeof conditionalRules.$inferSelect): ConditionalRule {
  return {
    id: row.id,
    tenantId: row.tenantId,
    companyId: row.companyId,
    name: row.name,
    priority: row.priority,
    conditions: row.conditions as ConditionAST,
    actions: row.actions as ActionsField,
    continueAfterMatch: row.continueAfterMatch,
    active: row.active,
    createdBy: row.createdBy,
    scope: row.scope as RuleScope,
    ownerUserId: row.ownerUserId,
    ownerFirmId: row.ownerFirmId,
    forkedFromGlobalId: row.forkedFromGlobalId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Computes the (scope, tenant_id, owner_user_id, owner_firm_id)
// tuple for the destination tier and applies an UPDATE. The DB
// CHECK constraint enforces the invariant; this function picks
// the right values per transition.
async function applyTierUpdate(
  before: ConditionalRule,
  nextScope: RuleScope,
  ctx: TierActionContext,
  opts: DemoteOptions = {},
): Promise<ConditionalRule> {
  const set: Partial<typeof conditionalRules.$inferInsert> = {
    scope: nextScope,
    updatedAt: new Date(),
  };
  switch (nextScope) {
    case 'tenant_user':
      // From tenant_firm: keep tenant_id, switch ownership to
      // the calling user. Forks lose their global link on
      // demotion all the way down.
      set.tenantId = before.tenantId;
      set.ownerUserId = ctx.currentUserId;
      set.ownerFirmId = null;
      set.forkedFromGlobalId = null;
      break;
    case 'tenant_firm':
      if (before.scope === 'tenant_user') {
        // Promote: keep tenant_id, hand ownership to the firm.
        set.tenantId = before.tenantId;
        set.ownerUserId = null;
        set.ownerFirmId = ctx.firmId!;
      } else if (before.scope === 'global_firm') {
        // Demote: tenantId comes from the demote body. Keep firm
        // ownership but bind to the target tenant. Once Phase 4
        // ships the resolver, action UUIDs would be rewritten to
        // the target tenant's accounts; today they're left as-is.
        if (!opts.tenantId) {
          throw AppError.badRequest(
            'tenantId required when demoting global_firm → tenant_firm',
            'TENANT_ID_REQUIRED',
          );
        }
        set.tenantId = opts.tenantId;
        set.ownerUserId = null;
        set.ownerFirmId = before.ownerFirmId!;
        // Demoting a global directly clears any fork link on the
        // result row (forks are tenant_firm rules; the demoted
        // global itself has no upstream).
        set.forkedFromGlobalId = null;
      }
      break;
    case 'global_firm':
      // Promote tenant_firm → global_firm. Tenant goes null.
      set.tenantId = null;
      set.ownerUserId = null;
      set.ownerFirmId = before.ownerFirmId ?? ctx.firmId!;
      set.forkedFromGlobalId = null;
      break;
  }
  const [row] = await db
    .update(conditionalRules)
    .set(set)
    .where(eq(conditionalRules.id, before.id))
    .returning();
  if (!row) throw AppError.internal('Tier update failed');
  return mapRow(row);
}

// Touch references silenced — these types may be needed later
// when the resolver lands.
export type { Action };
export const _NEXT_TIER_UP = NEXT_TIER_UP;
export const _NEXT_TIER_DOWN = NEXT_TIER_DOWN;
// Used by tests to stub the not-found case without a DB miss.
export async function _exists(ruleId: string): Promise<boolean> {
  const r = await db.query.conditionalRules.findFirst({
    where: and(eq(conditionalRules.id, ruleId), isNull(conditionalRules.tenantId)),
  });
  return !!r;
}
