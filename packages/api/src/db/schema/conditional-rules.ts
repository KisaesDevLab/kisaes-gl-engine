// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import {
  pgTable,
  uuid,
  varchar,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 4 — Conditional Rules
// Engine. Two new tables (rules + per-fire audit) plus a stats
// view defined directly in the migration SQL (Drizzle's ORM
// surface doesn't model views, so the view lives in 0067 and is
// queried via raw SQL in conditional-rules-stats.service).
//
// 3-tier rules plan, Phase 2 — extends the table with scope +
// ownership columns. `tenant_id` is now nullable so global_firm
// rows can have NULL (the migration carries the
// non-additive-exception marker). A CHECK constraint added in
// migration 0082 enforces the (scope, tenant_id, owner_user_id,
// owner_firm_id) invariant; not modeled in Drizzle because the
// builder API doesn't support multi-column CHECKs.
export const conditionalRules = pgTable('conditional_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Nullable as of Phase 2 — global_firm rules have no tenant.
  // tenant_user / tenant_firm rules still must set this; the
  // CHECK constraint enforces it. References preserved for the
  // tenant_user / tenant_firm rows.
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  // null = tenant-wide; uuid = scoped to a single company.
  companyId: uuid('company_id'),
  name: varchar('name', { length: 255 }).notNull(),
  // Lower number evaluates first.
  priority: integer('priority').notNull().default(100),
  conditions: jsonb('conditions').notNull(),
  actions: jsonb('actions').notNull(),
  // When true, this rule does NOT short-circuit subsequent rules
  // — it stacks. Default false (first match wins).
  continueAfterMatch: boolean('continue_after_match').notNull().default(false),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by'),
  // 3-tier rules plan, Phase 2 — tier discriminator. Enum-like
  // varchar; CHECK constraint in migration 0082 enforces values.
  scope: varchar('scope', { length: 20 }).notNull().default('tenant_user'),
  // Set when scope = 'tenant_user'. Loose ref (no FK to users)
  // matches the user_tenant_access / firm_users convention.
  ownerUserId: uuid('owner_user_id'),
  // Set when scope IN ('tenant_firm', 'global_firm'). FK to firms
  // so cascade-delete cleans up the firm's rules when the firm
  // itself is hard-deleted (rare; firms are usually deactivated).
  ownerFirmId: uuid('owner_firm_id'),
  // When this row is a per-tenant fork of a global_firm rule,
  // points back at the source. The fork shadows the global for
  // its tenant; the link enables drift-detection / re-sync UI in
  // future phases. NULL on every other row.
  forkedFromGlobalId: uuid('forked_from_global_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantActiveIdx: index('idx_cond_rules_tenant_active').on(table.tenantId, table.active),
  tenantPriorityIdx: index('idx_cond_rules_tenant_priority').on(table.tenantId, table.priority),
  // Phase 2 — drives the global-rule lookup at evaluation time.
  ownerFirmScopeActiveIdx: index('idx_cond_rules_owner_firm_active').on(
    table.ownerFirmId,
    table.scope,
    table.active,
  ),
  // Phase 2 — partial index on forks (created in migration SQL
  // with a WHERE clause Drizzle can't express).
  forkedFromGlobalIdx: index('idx_cond_rules_forked_from').on(table.forkedFromGlobalId),
}));

// One row per RULE FIRE (not per evaluation — see plan §D3).
// `was_overridden` flips true when a bookkeeper later changes
// the categorization the rule produced; the stats view derives
// override-rate from this.
export const conditionalRuleAudit = pgTable('conditional_rule_audit', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  ruleId: uuid('rule_id').notNull().references(() => conditionalRules.id, { onDelete: 'cascade' }),
  bankFeedItemId: uuid('bank_feed_item_id'),
  transactionId: uuid('transaction_id'),
  matchedAt: timestamp('matched_at', { withTimezone: true }).notNull().defaultNow(),
  actionsApplied: jsonb('actions_applied'),
  wasOverridden: boolean('was_overridden').notNull().default(false),
  overriddenAt: timestamp('overridden_at', { withTimezone: true }),
  // 3-tier rules plan, Phase 2 — tier snapshot at fire time. The
  // rule's current `scope` may change later via promote/demote;
  // audit history must remain valid for the tier the fire was AT,
  // so we copy from `rule.scope` when the audit row is written.
  effectiveTier: varchar('effective_tier', { length: 20 }),
  // Same idea for firm attribution — copied from `rule.owner_firm_id`
  // at fire time; null for tenant_user fires.
  effectiveFirmId: uuid('effective_firm_id'),
}, (table) => ({
  tenantRuleIdx: index('idx_cra_tenant_rule').on(table.tenantId, table.ruleId, table.matchedAt),
}));
