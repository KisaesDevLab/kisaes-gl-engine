// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, eq } from 'drizzle-orm';
import type { Action, ActionsField, ConditionAST, RuleScope } from '@kis-books/shared';
import { db } from '../db/index.js';
import { bankRules, conditionalRules, userTenantAccess } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

// 3-tier rules plan, Phase 6 — legacy bank_rules → conditional_rules
// migration. Pure conversion + a per-tenant orchestrator.
//
// Mapping table:
//
//   Legacy column          → Conditional rule construct
//   ─────────────────────────────────────────────────────────────
//   description_contains   → leaf descriptor.contains
//   description_exact      → leaf descriptor.equals
//   amount_equals          → leaf amount.eq (sign-aware via applyTo)
//   amount_min/max         → leaf amount.between
//   apply_to=deposits      → leaf amount_sign.eq -1
//   apply_to=expenses      → leaf amount_sign.eq +1
//   bank_account_id        → leaf account_source_id.eq
//   assign_account_id      → action set_account
//   assign_contact_id      → action set_vendor
//   assign_memo            → action set_memo
//   assign_tag_id          → action set_tag
//   auto_confirm=true      → no equivalent today; the conditional
//                            engine fires regardless and the
//                            bookkeeper approves the staged
//                            categorization. Documented as a
//                            behavior change in the migration's
//                            dry-run report.
//
// Global legacy rules (tenant_id IS NULL, is_global=true) are
// out of scope for the per-tenant CLI — they need a target firm
// id to land on, which the operator chooses via a separate
// `--firm <id>` flag at the CLI layer (see migrate-bank-rules.ts).

export interface ConvertedRule {
  // What gets inserted into conditional_rules.
  name: string;
  conditions: ConditionAST;
  actions: ActionsField;
  priority: number;
  active: boolean;
  scope: RuleScope;
  ownerUserId: string | null;
  ownerFirmId: string | null;
  // For the dry-run report — shows the operator what's in flight.
  warnings: string[];
  sourceRuleId: string;
  sourceRuleName: string;
}

// ─── Conversion ──────────────────────────────────────────────

interface LegacyBankRule {
  id: string;
  name: string;
  priority: number | null;
  isActive: boolean | null;
  isGlobal: boolean | null;
  applyTo: string;
  bankAccountId: string | null;
  descriptionContains: string | null;
  descriptionExact: string | null;
  amountEquals: string | null;
  amountMin: string | null;
  amountMax: string | null;
  assignAccountId: string | null;
  assignContactId: string | null;
  assignAccountName: string | null;
  assignContactName: string | null;
  assignMemo: string | null;
  assignTagId: string | null;
  autoConfirm: boolean | null;
}

export interface ConvertOptions {
  scope: RuleScope;
  ownerUserId: string | null;
  ownerFirmId: string | null;
}

// Pure converter. Returns a synthetic rule shape ready to insert
// into conditional_rules; never touches the DB. Surfaces warnings
// for any source-row state that doesn't have a clean target
// (e.g., name-based account references on globals when the
// migration target is a tenant_user; auto_confirm; bank_account_id
// references on a global without a system_tag binding).
export function convertBankRule(rule: LegacyBankRule, opts: ConvertOptions): ConvertedRule {
  const warnings: string[] = [];
  const leaves: ConditionAST[] = [];

  // Description matchers. exact wins over contains if both are set
  // — that's what the legacy evaluator does too (exact short-circuits).
  if (rule.descriptionExact) {
    leaves.push({
      type: 'leaf',
      field: 'descriptor',
      operator: 'equals',
      value: rule.descriptionExact,
    });
  } else if (rule.descriptionContains) {
    leaves.push({
      type: 'leaf',
      field: 'descriptor',
      operator: 'contains',
      value: rule.descriptionContains,
    });
  }

  // applyTo → amount_sign condition. The legacy convention:
  // amount < 0 = deposit (money in); amount > 0 = expense.
  if (rule.applyTo === 'deposits') {
    leaves.push({ type: 'leaf', field: 'amount_sign', operator: 'eq', value: -1 });
  } else if (rule.applyTo === 'expenses') {
    leaves.push({ type: 'leaf', field: 'amount_sign', operator: 'eq', value: 1 });
  }

  // Amount conditions. Legacy compares against abs(amount); the
  // conditional engine compares against signed amount. We reuse
  // applyTo to decide the comparison sign:
  //   - expenses (positive amounts) → compare directly
  //   - deposits (negative amounts) → negate the operand
  //   - both → emit a warning; the conversion uses positive operands
  //     which is wrong for deposits. Operators should split such rules
  //     into two single-direction rules before migrating.
  const sign = rule.applyTo === 'deposits' ? -1 : 1;
  if (rule.applyTo === 'both' && (rule.amountEquals || rule.amountMin || rule.amountMax)) {
    warnings.push(
      'Legacy rule applies to BOTH deposits and expenses with an amount filter; ' +
        'amount comparisons in the converted rule will only match positive (expense) amounts. ' +
        'Split the source rule into deposits-only + expenses-only before migrating, ' +
        'or accept the new behavior.',
    );
  }
  if (rule.amountEquals) {
    const v = parseFloat(rule.amountEquals);
    if (Number.isFinite(v)) {
      leaves.push({ type: 'leaf', field: 'amount', operator: 'eq', value: v * sign });
    }
  } else if (rule.amountMin || rule.amountMax) {
    const lo = rule.amountMin ? parseFloat(rule.amountMin) : -Infinity;
    const hi = rule.amountMax ? parseFloat(rule.amountMax) : Infinity;
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      const a = lo * sign;
      const b = hi * sign;
      const [low, high] = a <= b ? [a, b] : [b, a];
      leaves.push({ type: 'leaf', field: 'amount', operator: 'between', value: [low, high] });
    } else if (Number.isFinite(lo)) {
      leaves.push({ type: 'leaf', field: 'amount', operator: sign === 1 ? 'gte' : 'lte', value: lo * sign });
    } else if (Number.isFinite(hi)) {
      leaves.push({ type: 'leaf', field: 'amount', operator: sign === 1 ? 'lte' : 'gte', value: hi * sign });
    }
  }

  // bank_account_id → account_source_id. The legacy column stored
  // either a bank_connection_id OR a GL account uuid depending on
  // the era of the rule; the new condition tests against the GL
  // account id (per the apply-service path). Migrate verbatim
  // and emit a warning when a global rule references a
  // bank_account_id (those won't resolve cross-tenant).
  if (rule.bankAccountId) {
    leaves.push({
      type: 'leaf',
      field: 'account_source_id',
      operator: 'eq',
      value: rule.bankAccountId,
    });
    if (opts.scope === 'global_firm') {
      warnings.push(
        'Source rule filters by bank_account_id, which is tenant-specific. The converted ' +
          'global_firm rule will only match on the originating tenant. Consider removing ' +
          'the bank-account filter or scoping the rule down to tenant_firm.',
      );
    }
  }

  // Compose conditions. The engine accepts a single leaf or a
  // group; emit a group AND when there are multiple leaves so
  // the result mirrors the legacy "all conditions must match"
  // semantics.
  let conditions: ConditionAST;
  if (leaves.length === 0) {
    // Legacy "match everything" rules (rare but possible). Use
    // a degenerate amount.gte 0 OR amount.lte 0 group that always
    // passes; cheaper than introducing a special "TRUE" leaf.
    conditions = {
      type: 'group',
      op: 'OR',
      children: [
        { type: 'leaf', field: 'amount', operator: 'gte', value: 0 },
        { type: 'leaf', field: 'amount', operator: 'lte', value: 0 },
      ],
    };
    warnings.push('Legacy rule had no conditions; converted to a match-all rule.');
  } else if (leaves.length === 1) {
    conditions = leaves[0]!;
  } else {
    conditions = { type: 'group', op: 'AND', children: leaves };
  }

  // Actions. Each non-null assign_* maps to an action; the order
  // here matches the legacy in-row execution order.
  const actions: Action[] = [];
  if (rule.assignAccountId) {
    actions.push({ type: 'set_account', accountId: rule.assignAccountId });
  } else if (opts.scope === 'global_firm' && rule.assignAccountName) {
    // Legacy globals stored a string account name and resolved it
    // via fuzzy match. The new resolver is system_tag-only — emit
    // a warning rather than try to invent a tag. The operator
    // sets system_tags on each tenant's CoA before re-enabling
    // the converted global.
    warnings.push(
      `Source global rule references account name "${rule.assignAccountName}" via fuzzy ` +
        'match. The new resolver uses system_tag handles instead. Tag the matching ' +
        'account on each managed tenant\'s Chart of Accounts and re-bind manually before ' +
        'activating the converted rule.',
    );
  }
  if (rule.assignContactId) {
    actions.push({ type: 'set_vendor', vendorId: rule.assignContactId });
  } else if (rule.assignContactName) {
    // No vendorId in conditional rules' uuid-only action shape; the
    // resolver's findOrCreateContact path handles name-based
    // creation cross-tenant for global rules but tenant rules need
    // a real uuid. Defer creation: emit a warning so the operator
    // creates the contact first.
    warnings.push(
      `Source rule references contact name "${rule.assignContactName}" — convert to a ` +
        'contact uuid in the new rule before saving (or run on a tenant where the ' +
        'contact already exists).',
    );
  }
  if (rule.assignMemo) {
    actions.push({ type: 'set_memo', memo: rule.assignMemo });
  }
  if (rule.assignTagId) {
    if (opts.scope === 'global_firm') {
      warnings.push(
        'Source rule sets a tag id; tag actions on global_firm rules are deferred to ' +
          'Phase 7 (firm tag templates). The tag action will be dropped.',
      );
    } else {
      actions.push({ type: 'set_tag', tagId: rule.assignTagId });
    }
  }

  if (rule.autoConfirm) {
    warnings.push(
      'Source rule has auto_confirm=true. Conditional rules do not auto-post; the ' +
        'staged categorization waits for bookkeeper approval. This is a behavior change.',
    );
  }

  return {
    name: rule.name,
    conditions,
    actions,
    priority: rule.priority ?? 100,
    active: rule.isActive ?? true,
    scope: opts.scope,
    ownerUserId: opts.ownerUserId,
    ownerFirmId: opts.ownerFirmId,
    warnings,
    sourceRuleId: rule.id,
    sourceRuleName: rule.name,
  };
}

// ─── Per-tenant orchestrator ─────────────────────────────────

export interface MigrateTenantOptions {
  /** Dry-run: build conversions + warnings, no DB writes. */
  dryRun: boolean;
  /** When true, the source bank_rules row is set is_active=false
   *  AFTER the conditional row inserts. Matches the staged
   *  rollout — operators verify the conditional rules fire
   *  correctly before deactivating the legacy ones. */
  deactivateSource: boolean;
  /** Override owner — when null, the orchestrator picks the
   *  tenant's first owner-role user via user_tenant_access. */
  ownerUserId?: string | null;
}

export interface MigrationReport {
  tenantId: string;
  converted: ConvertedRule[];
  errors: Array<{ sourceRuleId: string; message: string }>;
  insertedIds: string[];
  deactivatedSourceIds: string[];
}

export async function migrateTenantBankRules(
  tenantId: string,
  opts: MigrateTenantOptions,
): Promise<MigrationReport> {
  const ownerUserId = opts.ownerUserId !== undefined
    ? opts.ownerUserId
    : await pickTenantOwner(tenantId);
  if (!ownerUserId) {
    throw AppError.badRequest(
      `Tenant ${tenantId} has no owner-role user_tenant_access row; supply --owner-user-id explicitly.`,
      'NO_TENANT_OWNER',
    );
  }

  const sources = await db
    .select()
    .from(bankRules)
    .where(and(eq(bankRules.tenantId, tenantId), eq(bankRules.isGlobal, false)));

  const converted: ConvertedRule[] = [];
  const errors: MigrationReport['errors'] = [];
  for (const row of sources) {
    try {
      converted.push(convertBankRule(row as LegacyBankRule, {
        scope: 'tenant_user',
        ownerUserId,
        ownerFirmId: null,
      }));
    } catch (err) {
      errors.push({
        sourceRuleId: row.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const insertedIds: string[] = [];
  const deactivatedSourceIds: string[] = [];
  if (!opts.dryRun) {
    await db.transaction(async (tx) => {
      for (const c of converted) {
        const [row] = await tx.insert(conditionalRules).values({
          tenantId,
          name: c.name,
          priority: c.priority,
          conditions: c.conditions,
          actions: c.actions,
          active: c.active,
          scope: c.scope,
          ownerUserId: c.ownerUserId,
          ownerFirmId: c.ownerFirmId,
          createdBy: ownerUserId,
        }).returning({ id: conditionalRules.id });
        insertedIds.push(row!.id);
      }
      if (opts.deactivateSource) {
        for (const c of converted) {
          await tx
            .update(bankRules)
            .set({ isActive: false, updatedAt: new Date() })
            .where(eq(bankRules.id, c.sourceRuleId));
          deactivatedSourceIds.push(c.sourceRuleId);
        }
      }
    });
  }

  return { tenantId, converted, errors, insertedIds, deactivatedSourceIds };
}

async function pickTenantOwner(tenantId: string): Promise<string | null> {
  const row = await db.query.userTenantAccess.findFirst({
    where: and(
      eq(userTenantAccess.tenantId, tenantId),
      eq(userTenantAccess.role, 'owner'),
      eq(userTenantAccess.isActive, true),
    ),
  });
  return row?.userId ?? null;
}
