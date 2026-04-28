// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import type {
  Action,
  ActionsField,
  ConditionAST,
  ConditionalRule,
  CreateConditionalRuleInput,
  RuleScope,
  UpdateConditionalRuleInput,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { conditionalRules, conditionalRuleAudit } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

// CRUD service for conditional_rules. The engine evaluator
// (conditional-rules-engine.service.ts) is a pure separate
// module; this service handles persistence + audit.

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

// 3-tier rules plan, Phase 2 — scope-aware list. Optional
// `scope` filter narrows the result to a single tier. Optional
// `firmId` is needed for tenant_firm / global_firm filters
// (a firm authors those; the tenant id alone doesn't identify
// them). When `scope` is omitted we return tenant_user rules
// only (preserves Phase-1 behavior for callers that pre-date
// the tier model).
export async function listForTenant(
  tenantId: string,
  opts: { scope?: RuleScope; firmId?: string | null } = {},
): Promise<ConditionalRule[]> {
  const { scope, firmId } = opts;
  const where = (() => {
    if (scope === 'global_firm') {
      if (!firmId) return sql`FALSE`;
      return and(
        isNull(conditionalRules.tenantId),
        eq(conditionalRules.scope, 'global_firm'),
        eq(conditionalRules.ownerFirmId, firmId),
      );
    }
    if (scope === 'tenant_firm') {
      if (!firmId) return sql`FALSE`;
      return and(
        eq(conditionalRules.tenantId, tenantId),
        eq(conditionalRules.scope, 'tenant_firm'),
        eq(conditionalRules.ownerFirmId, firmId),
      );
    }
    if (scope === 'tenant_user') {
      return and(
        eq(conditionalRules.tenantId, tenantId),
        eq(conditionalRules.scope, 'tenant_user'),
      );
    }
    // No scope filter — return everything visible from this tenant
    // context (every tenant_user + tenant_firm row whose tenantId
    // matches, plus the firm's globals if firmId is supplied).
    if (firmId) {
      return or(
        eq(conditionalRules.tenantId, tenantId),
        and(
          isNull(conditionalRules.tenantId),
          eq(conditionalRules.ownerFirmId, firmId),
          eq(conditionalRules.scope, 'global_firm'),
        ),
      );
    }
    return eq(conditionalRules.tenantId, tenantId);
  })();
  const rows = await db
    .select()
    .from(conditionalRules)
    .where(where)
    .orderBy(asc(conditionalRules.priority), asc(conditionalRules.name));
  return rows.map(mapRow);
}

// Returns active tenant_user rules ordered by priority — what
// the legacy engine pipeline calls when RULES_TIERED_V1 is OFF.
// Behavior preserved verbatim from Phase-1 to keep the flag-OFF
// path semantically identical to today.
export async function listActiveOrderedByPriority(tenantId: string): Promise<ConditionalRule[]> {
  const rows = await db
    .select()
    .from(conditionalRules)
    .where(and(
      eq(conditionalRules.tenantId, tenantId),
      eq(conditionalRules.active, true),
      eq(conditionalRules.scope, 'tenant_user'),
    ))
    .orderBy(asc(conditionalRules.priority), asc(conditionalRules.id));
  return rows.map(mapRow);
}

// 3-tier rules plan, Phase 4 — tier-aware listing for the
// pipeline. Returns the active rules visible from the current
// (tenant, firm) context in MOST-SPECIFIC-FIRST order:
//
//   1. tenant_user rules on this tenant (the caller's personal
//      first when currentUserId is provided).
//   2. tenant_firm rules on this tenant authored by the firm.
//   3. global_firm rules of the firm, EXCLUDING any global that
//      has an active tenant_firm fork on this tenant
//      (forks shadow globals per-tenant).
//
// `firmId === null` (solo book) skips tiers 2 + 3 entirely. Each
// tier preserves the existing `priority ASC, id ASC` order
// internally so the engine's first-match-wins semantics within
// a tier carry over from Phase 1.
export async function listEvaluableRulesForTenant(
  tenantId: string,
  opts: { currentUserId: string | null; firmId: string | null },
): Promise<ConditionalRule[]> {
  // Tier 1 — tenant_user rules on this tenant.
  const tenantUserRows = await db
    .select()
    .from(conditionalRules)
    .where(and(
      eq(conditionalRules.tenantId, tenantId),
      eq(conditionalRules.active, true),
      eq(conditionalRules.scope, 'tenant_user'),
    ))
    .orderBy(asc(conditionalRules.priority), asc(conditionalRules.id));

  // The caller's personal rules float to the top within tier 1
  // so a bookkeeper's `set_account` for "AMAZON" wins over a
  // co-worker's, then over the firm's, then over the global.
  // Other-user rules in the same tenant follow.
  const tier1Personal = opts.currentUserId
    ? tenantUserRows.filter((r) => r.ownerUserId === opts.currentUserId)
    : [];
  const tier1Other = opts.currentUserId
    ? tenantUserRows.filter((r) => r.ownerUserId !== opts.currentUserId)
    : tenantUserRows;

  if (!opts.firmId) {
    return [...tier1Personal, ...tier1Other].map(mapRow);
  }

  // Tier 2 — tenant_firm rules on this tenant.
  const tier2 = await db
    .select()
    .from(conditionalRules)
    .where(and(
      eq(conditionalRules.tenantId, tenantId),
      eq(conditionalRules.active, true),
      eq(conditionalRules.scope, 'tenant_firm'),
      eq(conditionalRules.ownerFirmId, opts.firmId),
    ))
    .orderBy(asc(conditionalRules.priority), asc(conditionalRules.id));

  // Forks shadow globals: collect the global ids that ANY active
  // tenant_firm rule on this tenant points at via
  // forked_from_global_id. Those globals are filtered out of
  // tier 3 for this tenant only.
  const shadowedGlobalIds = new Set(
    tier2
      .map((r) => r.forkedFromGlobalId)
      .filter((id): id is string => id !== null),
  );

  // Tier 3 — global_firm rules of the firm.
  const tier3Rows = await db
    .select()
    .from(conditionalRules)
    .where(and(
      isNull(conditionalRules.tenantId),
      eq(conditionalRules.active, true),
      eq(conditionalRules.scope, 'global_firm'),
      eq(conditionalRules.ownerFirmId, opts.firmId),
    ))
    .orderBy(asc(conditionalRules.priority), asc(conditionalRules.id));
  const tier3 = tier3Rows.filter((r) => !shadowedGlobalIds.has(r.id));

  return [...tier1Personal, ...tier1Other, ...tier2, ...tier3].map(mapRow);
}

// Phase 2 — scope-aware getById. Resolves a rule by id while
// enforcing tier-based visibility:
//   - tenant_user / tenant_firm: must match tenantId.
//   - global_firm: must match firmId (if provided); otherwise 404.
// Super-admin context is enforced at the route layer; this
// service is purely about scope correctness.
export async function getById(
  tenantId: string,
  id: string,
  opts: { firmId?: string | null } = {},
): Promise<ConditionalRule> {
  const row = await db.query.conditionalRules.findFirst({
    where: eq(conditionalRules.id, id),
  });
  if (!row) throw AppError.notFound('Conditional rule not found');
  const isTenantScoped = row.scope === 'tenant_user' || row.scope === 'tenant_firm';
  const tenantOk = isTenantScoped && row.tenantId === tenantId;
  const globalOk =
    row.scope === 'global_firm' && opts.firmId !== undefined && opts.firmId !== null && row.ownerFirmId === opts.firmId;
  if (!tenantOk && !globalOk) {
    throw AppError.notFound('Conditional rule not found');
  }
  return mapRow(row);
}

// Phase 2 — scope-aware create. The route layer resolves
// ownership context (current user id for tenant_user, firm id
// for tenant_firm / global_firm) and passes it in. The CHECK
// constraint at the DB enforces the (scope, tenant_id, owner_*)
// invariant; this service raises a 400 BEFORE the insert when
// the combination is illegal so the user gets a friendly error
// instead of a raw constraint-violation.
export interface CreateRuleContext {
  scope: RuleScope;
  /** Current user id — required for tenant_user. */
  currentUserId: string | null;
  /** Managing firm id for the current tenant (or the firm the
   *  caller is acting on for global_firm). Required for
   *  tenant_firm / global_firm. */
  firmId: string | null;
}

export async function create(
  tenantId: string,
  input: CreateConditionalRuleInput,
  ctx: CreateRuleContext,
  createdBy?: string,
): Promise<ConditionalRule> {
  const insertValues = buildInsertForScope(tenantId, input, ctx, createdBy);
  const [row] = await db.insert(conditionalRules).values(insertValues).returning();
  return mapRow(row!);
}

function buildInsertForScope(
  tenantId: string,
  input: CreateConditionalRuleInput,
  ctx: CreateRuleContext,
  createdBy?: string,
): typeof conditionalRules.$inferInsert {
  const base = {
    companyId: input.companyId ?? null,
    name: input.name,
    priority: input.priority ?? 100,
    conditions: input.conditions,
    actions: input.actions,
    continueAfterMatch: input.continueAfterMatch ?? false,
    active: input.active ?? true,
    createdBy: createdBy ?? null,
    scope: ctx.scope,
  };
  if (ctx.scope === 'tenant_user') {
    if (!ctx.currentUserId) {
      throw AppError.badRequest(
        'tenant_user rules require a logged-in user',
        'OWNER_USER_REQUIRED',
      );
    }
    return {
      ...base,
      tenantId,
      ownerUserId: ctx.currentUserId,
      ownerFirmId: null,
    };
  }
  if (ctx.scope === 'tenant_firm') {
    if (!ctx.firmId) {
      throw AppError.badRequest(
        'tenant_firm rules require a managing firm context',
        'OWNER_FIRM_REQUIRED',
      );
    }
    return {
      ...base,
      tenantId,
      ownerUserId: null,
      ownerFirmId: ctx.firmId,
    };
  }
  // global_firm
  if (!ctx.firmId) {
    throw AppError.badRequest(
      'global_firm rules require a firm context',
      'OWNER_FIRM_REQUIRED',
    );
  }
  return {
    ...base,
    tenantId: null,
    ownerUserId: null,
    ownerFirmId: ctx.firmId,
  };
}

// Phase 2 — scope-respecting update. The body never carries
// scope-mutating fields (tier transitions go through dedicated
// promote/demote endpoints in Phase 3); ownership stays put.
// The route layer is responsible for ensuring the caller can
// see/write the rule's tier.
export async function update(
  tenantId: string,
  id: string,
  input: UpdateConditionalRuleInput,
  opts: { firmId?: string | null } = {},
): Promise<ConditionalRule> {
  // Re-fetch the rule with scope-aware visibility so we don't
  // silently update a rule the caller can't see (e.g., a
  // tenant-scoped caller editing a different tenant's rule by id).
  const before = await getById(tenantId, id, { firmId: opts.firmId });
  const set: Partial<typeof conditionalRules.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) set.name = input.name;
  if (input.companyId !== undefined) set.companyId = input.companyId;
  if (input.priority !== undefined) set.priority = input.priority;
  if (input.conditions !== undefined) set.conditions = input.conditions;
  if (input.actions !== undefined) set.actions = input.actions;
  if (input.continueAfterMatch !== undefined) set.continueAfterMatch = input.continueAfterMatch;
  if (input.active !== undefined) set.active = input.active;

  const [row] = await db
    .update(conditionalRules)
    .set(set)
    .where(eq(conditionalRules.id, before.id))
    .returning();
  if (!row) throw AppError.notFound('Conditional rule not found');
  return mapRow(row);
}

export async function remove(
  tenantId: string,
  id: string,
  opts: { firmId?: string | null } = {},
): Promise<void> {
  // Resolve scope-aware visibility first so the caller can't
  // delete rules outside their reach.
  const target = await getById(tenantId, id, { firmId: opts.firmId });
  await db.delete(conditionalRules).where(eq(conditionalRules.id, target.id));
}

// Re-sequence priorities in 100-step increments so a future
// insert can fit between two existing rules without touching
// every row again. Wrapped in a transaction so a partial
// failure leaves the existing priorities intact.
export async function reorder(tenantId: string, orderedIds: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(conditionalRules)
        .set({ priority: (i + 1) * 100, updatedAt: new Date() })
        .where(and(eq(conditionalRules.tenantId, tenantId), eq(conditionalRules.id, orderedIds[i]!)));
    }
  });
}

// Phase 5b §5.6 — paginated audit log for the Stats tab.
// Cursor is an ISO timestamp on `matched_at`; rows are returned
// newest-first. The `nextCursor` in the response is the
// matched_at of the last row in the page (or null when the
// next page would be empty).
export async function listAudit(
  tenantId: string,
  ruleId: string,
  opts: { cursor?: string; limit?: number },
): Promise<{ rows: typeof conditionalRuleAudit.$inferSelect[]; nextCursor: string | null }> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const conditions = [
    eq(conditionalRuleAudit.tenantId, tenantId),
    eq(conditionalRuleAudit.ruleId, ruleId),
  ];
  if (opts.cursor) {
    conditions.push(sql`${conditionalRuleAudit.matchedAt} < ${new Date(opts.cursor)}`);
  }
  const rows = await db
    .select()
    .from(conditionalRuleAudit)
    .where(and(...conditions))
    .orderBy(sql`${conditionalRuleAudit.matchedAt} DESC`)
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    rows: page,
    nextCursor: hasMore ? page[page.length - 1]!.matchedAt.toISOString() : null,
  };
}

// Audit-row writer. Called by the apply service after a rule's
// actions are staged on the bank-feed item. Returns the audit id
// so the caller can stash it on the feed item if it needs to
// later mark the row as overridden.
//
// Idempotent on (rule_id, bank_feed_item_id): if the pipeline
// re-runs for the same feed item (e.g. the bookkeeper hits
// "rematch" or a new bank-sync polls items already classified),
// the existing fire's `matched_at` + `actions_applied` are
// refreshed in place. This prevents the audit log + stats view
// from inflating on every refresh while keeping `was_overridden`
// stable across reruns.
export async function recordFire(input: {
  tenantId: string;
  ruleId: string;
  bankFeedItemId: string | null;
  transactionId: string | null;
  actionsApplied: Action[];
  // 3-tier rules plan, Phase 2 — tier snapshot at fire time.
  // Optional in the wire shape so callers that pre-date the tier
  // model (legacy code paths under RULES_TIERED_V1=OFF) can keep
  // calling recordFire without changes; null effective_tier on
  // existing audit rows is interpreted as 'tenant_user' by the
  // stats view's COALESCE.
  effectiveTier?: RuleScope | null;
  effectiveFirmId?: string | null;
}): Promise<string> {
  if (input.bankFeedItemId) {
    const existing = await db.query.conditionalRuleAudit.findFirst({
      where: and(
        eq(conditionalRuleAudit.tenantId, input.tenantId),
        eq(conditionalRuleAudit.ruleId, input.ruleId),
        eq(conditionalRuleAudit.bankFeedItemId, input.bankFeedItemId),
      ),
    });
    if (existing) {
      await db
        .update(conditionalRuleAudit)
        .set({
          actionsApplied: input.actionsApplied,
          matchedAt: new Date(),
          transactionId: input.transactionId ?? existing.transactionId,
          // Refresh the tier on update so a promoted/demoted rule's
          // re-fire records its current tier correctly.
          effectiveTier: input.effectiveTier ?? existing.effectiveTier,
          effectiveFirmId: input.effectiveFirmId ?? existing.effectiveFirmId,
        })
        .where(eq(conditionalRuleAudit.id, existing.id));
      return existing.id;
    }
  }
  const [row] = await db
    .insert(conditionalRuleAudit)
    .values({
      tenantId: input.tenantId,
      ruleId: input.ruleId,
      bankFeedItemId: input.bankFeedItemId,
      transactionId: input.transactionId,
      actionsApplied: input.actionsApplied,
      effectiveTier: input.effectiveTier ?? null,
      effectiveFirmId: input.effectiveFirmId ?? null,
    })
    .returning({ id: conditionalRuleAudit.id });
  return row!.id;
}

// Mark a fire as "overridden" — flips the boolean + stamps the
// timestamp. Called from approval/edit code paths in later
// phases when a bookkeeper changes what the rule produced.
export async function markOverridden(tenantId: string, auditId: string): Promise<void> {
  await db
    .update(conditionalRuleAudit)
    .set({ wasOverridden: true, overriddenAt: new Date() })
    .where(and(eq(conditionalRuleAudit.tenantId, tenantId), eq(conditionalRuleAudit.id, auditId)));
}

// Stats view query. Drizzle doesn't model views so we use raw
// SQL. Joining the view to the rules table keeps the row order
// stable when there are zero fires.
export async function statsForTenant(tenantId: string): Promise<Array<{
  ruleId: string;
  name: string;
  firesTotal: number;
  fires30d: number;
  fires7d: number;
  overrides: number;
  overrideRate: number | null;
  lastFiredAt: string | null;
}>> {
  const result = await db.execute<{
    rule_id: string;
    name: string;
    fires_total: number;
    fires_30d: number;
    fires_7d: number;
    overrides: number;
    override_rate: number | null;
    last_fired_at: Date | null;
  }>(sql`
    SELECT v.rule_id, v.name, v.fires_total, v.fires_30d, v.fires_7d,
           v.overrides, v.override_rate, v.last_fired_at
    FROM conditional_rule_stats v
    WHERE v.tenant_id = ${tenantId}
    ORDER BY v.name
  `);
  return (result.rows as Array<{
    rule_id: string;
    name: string;
    fires_total: number;
    fires_30d: number;
    fires_7d: number;
    overrides: number;
    override_rate: number | null;
    last_fired_at: Date | null;
  }>).map((r) => ({
    ruleId: r.rule_id,
    name: r.name,
    firesTotal: Number(r.fires_total ?? 0),
    fires30d: Number(r.fires_30d ?? 0),
    fires7d: Number(r.fires_7d ?? 0),
    overrides: Number(r.overrides ?? 0),
    overrideRate: r.override_rate === null ? null : Number(r.override_rate),
    lastFiredAt: r.last_fired_at ? new Date(r.last_fired_at).toISOString() : null,
  }));
}
