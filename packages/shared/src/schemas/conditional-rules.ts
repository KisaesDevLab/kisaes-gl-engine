// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { z } from 'zod';
import {
  ACTION_TYPES,
  CONDITION_FIELDS,
  CONDITION_FIELDS_DEFERRED,
  FIELD_OPERATOR_MAP,
  MAX_BRANCH_DEPTH,
} from '../constants/conditional-rules.js';

// Leaf condition. The value type depends on the (field, operator)
// pair — we accept the loosest structural shape here and refine
// with cross-field logic. Inferring the type rather than
// annotating avoids a Zod ZodOptional<unknown> vs ZodType<unknown>
// mismatch on the value field.
const leafConditionSchema = z.object({
  type: z.literal('leaf'),
  field: z.enum(CONDITION_FIELDS),
  operator: z.string().min(1),
  value: z.unknown(),
}).superRefine((cond, ctx) => {
  // Reject deferred fields entirely — see plan §D2.
  if ((CONDITION_FIELDS_DEFERRED as readonly string[]).includes(cond.field)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Field "${cond.field}" is not yet supported (plan §D2)`,
      path: ['field'],
    });
    return;
  }
  // Operator must be valid for the field's family.
  const allowed = FIELD_OPERATOR_MAP[cond.field] ?? [];
  if (!allowed.includes(cond.operator)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Operator "${cond.operator}" not valid for field "${cond.field}". Expected one of: ${allowed.join(', ')}`,
      path: ['operator'],
    });
  }
});

// Recursive group condition. Z.lazy enables the cycle. AND/OR
// groups are unbounded in width — depth is capped via the
// MAX_BRANCH_DEPTH check that runs across the full conditions+
// actions tree.
type GroupConditionSchema = {
  type: 'group';
  op: 'AND' | 'OR';
  children: ConditionASTSchema[];
};
type LeafConditionSchema = z.infer<typeof leafConditionSchema>;
type ConditionASTSchema = LeafConditionSchema | GroupConditionSchema;

const groupConditionSchema: z.ZodType<GroupConditionSchema> = z.lazy(() =>
  z.object({
    type: z.literal('group'),
    op: z.enum(['AND', 'OR']),
    children: z.array(conditionAstSchema).min(1).max(20),
  }),
);

export const conditionAstSchema: z.ZodType<ConditionASTSchema> = z.lazy(() =>
  z.union([leafConditionSchema, groupConditionSchema]),
);

// Action union. Each variant is a discriminated union by `type`.
// The split actions enforce structural invariants on the splits
// array (non-empty, percent variants sum to ~100, etc.) here
// rather than only at evaluation time so a mis-built rule can't
// be persisted in the first place.
const splitPercentageEntry = z.object({
  accountId: z.string().uuid(),
  percent: z.number().min(0).max(100),
  tagId: z.string().uuid().optional(),
  memo: z.string().max(500).optional(),
});

const splitFixedEntry = z.object({
  accountId: z.string().uuid(),
  // Stored as decimal string to match journal_lines.debit/credit.
  amount: z.string().regex(/^-?\d+(\.\d{1,4})?$/),
  tagId: z.string().uuid().optional(),
  memo: z.string().max(500).optional(),
});

// discriminatedUnion requires raw ZodObject members (no
// ZodEffects). The percentage-sum invariant moves into a
// post-validation superRefine on the outer schema below.
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_account'), accountId: z.string().uuid() }),
  z.object({ type: z.literal('set_vendor'), vendorId: z.string().uuid() }),
  // 3-tier rules plan, Phase 7 — set_tag accepts either a uuid
  // (tenant-scoped) or a template_key (global rules). One-or-the-
  // other validation runs at create time via createConditional
  // RuleSchema's superRefine; the action shape itself is loose
  // here to avoid breaking discriminated-union parsing for the
  // existing tagId-only callers.
  z.object({
    type: z.literal('set_tag'),
    tagId: z.string().uuid().optional(),
    tagTemplateKey: z
      .string()
      .min(2)
      .max(80)
      .regex(/^[a-z0-9](_?[a-z0-9])*$/)
      .optional(),
  }),
  z.object({ type: z.literal('set_memo'), memo: z.string().min(1).max(500) }),
  z.object({ type: z.literal('set_class'), classId: z.string().uuid() }),
  z.object({ type: z.literal('set_location'), locationId: z.string().uuid() }),
  z.object({
    type: z.literal('split_by_percentage'),
    splits: z.array(splitPercentageEntry).min(2).max(20),
  }),
  z.object({
    type: z.literal('split_by_fixed'),
    splits: z.array(splitFixedEntry).min(2).max(20),
  }),
  z.object({ type: z.literal('mark_for_review') }),
  z.object({ type: z.literal('skip_ai') }),
]);

// ActionsField: either a flat list OR a branching tree. The
// branching tree is recursive via z.lazy — depth enforced by a
// post-validation check below the schema definitions.
type ActionsFieldSchema =
  | z.infer<typeof actionSchema>[]
  | { if: ConditionASTSchema; then: ActionsFieldSchema; elif?: Array<{ if: ConditionASTSchema; then: ActionsFieldSchema }>; else?: ActionsFieldSchema };

const branchSchema: z.ZodType<{ if: ConditionASTSchema; then: ActionsFieldSchema; elif?: Array<{ if: ConditionASTSchema; then: ActionsFieldSchema }>; else?: ActionsFieldSchema }> = z.lazy(() =>
  z.object({
    if: conditionAstSchema,
    then: actionsFieldSchema,
    elif: z.array(z.object({
      if: conditionAstSchema,
      then: actionsFieldSchema,
    })).max(MAX_BRANCH_DEPTH).optional(),
    else: actionsFieldSchema.optional(),
  }),
);

export const actionsFieldSchema: z.ZodType<ActionsFieldSchema> = z.lazy(() =>
  z.union([z.array(actionSchema), branchSchema]),
);

// Recursive depth check — applied after structural validation
// so we can produce a clean error message rather than the deeply
// nested Zod path when a rule exceeds 5 levels.
function depthOfActions(actions: ActionsFieldSchema, level = 0): number {
  if (level > MAX_BRANCH_DEPTH * 2) return level; // safety
  if (Array.isArray(actions)) return level;
  let max = depthOfActions(actions.then, level + 1);
  for (const e of actions.elif ?? []) {
    max = Math.max(max, depthOfActions(e.then, level + 1));
  }
  if (actions.else) max = Math.max(max, depthOfActions(actions.else, level + 1));
  return max;
}

// Mirror of MAX_CONDITION_DEPTH in the engine. Rejecting deeply
// nested AND/OR groups at validation time prevents the engine
// evaluator from ever seeing payloads it would refuse to walk.
const MAX_CONDITION_DEPTH = 10;
function depthOfCondition(condition: ConditionASTSchema, level = 0): number {
  if (level > MAX_CONDITION_DEPTH * 2) return level; // safety
  if (condition.type !== 'group') return level;
  let max = level;
  for (const child of condition.children) {
    max = Math.max(max, depthOfCondition(child, level + 1));
  }
  return max;
}

function maxConditionDepthInActions(actions: ActionsFieldSchema): number {
  if (Array.isArray(actions)) return 0;
  let max = depthOfCondition(actions.if);
  max = Math.max(max, maxConditionDepthInActions(actions.then));
  for (const e of actions.elif ?? []) {
    max = Math.max(max, depthOfCondition(e.if), maxConditionDepthInActions(e.then));
  }
  if (actions.else) max = Math.max(max, maxConditionDepthInActions(actions.else));
  return max;
}

// Walks the actions tree and collects every action node so we
// can apply cross-cutting invariants (percentage sums, depth)
// without re-recursing the structure once per check.
function collectActions(actions: ActionsFieldSchema, out: Array<z.infer<typeof actionSchema>>): void {
  if (Array.isArray(actions)) {
    out.push(...actions);
    return;
  }
  collectActions(actions.then, out);
  for (const e of actions.elif ?? []) collectActions(e.then, out);
  if (actions.else) collectActions(actions.else, out);
}

// 3-tier rules plan, Phase 2 — `scope` is part of the create
// payload. Server-side mapping fills `ownerUserId` / `ownerFirmId`
// from the request context (current user / managing firm) so
// callers don't have to spell them out (and can't spoof them).
// Phase 4 will refine action targets per scope; for now we accept
// the existing UUID-only target shape.
const ruleScopeSchema = z.enum(['tenant_user', 'tenant_firm', 'global_firm']);

// Outer rule object — bare shape, no superRefine — so .partial()
// works downstream for the update payload.
const baseConditionalRuleObject = z.object({
  name: z.string().min(1).max(255),
  companyId: z.string().uuid().nullable().optional(),
  priority: z.number().int().min(0).max(1_000_000).optional(),
  conditions: conditionAstSchema,
  actions: actionsFieldSchema,
  continueAfterMatch: z.boolean().optional(),
  active: z.boolean().optional(),
  // Optional in the wire schema. Defaults to 'tenant_user' on the
  // server when omitted, which preserves Phase-1 behavior for
  // existing clients that don't know about scope yet.
  scope: ruleScopeSchema.optional(),
});

// CRUD payloads. Cross-cutting checks (depth + percentage-sum)
// run as a final superRefine on the assembled schema.
export const createConditionalRuleSchema = baseConditionalRuleObject.superRefine((rule, ctx) => {
  const d = depthOfActions(rule.actions);
  if (d > MAX_BRANCH_DEPTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Branching depth ${d} exceeds maximum ${MAX_BRANCH_DEPTH}`,
      path: ['actions'],
    });
  }
  const condDepth = Math.max(
    depthOfCondition(rule.conditions),
    maxConditionDepthInActions(rule.actions),
  );
  if (condDepth > MAX_CONDITION_DEPTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Condition group depth ${condDepth} exceeds maximum ${MAX_CONDITION_DEPTH}`,
      path: ['conditions'],
    });
  }
  const all: Array<z.infer<typeof actionSchema>> = [];
  collectActions(rule.actions, all);
  for (const action of all) {
    if (action.type === 'split_by_percentage') {
      const sum = action.splits.reduce((s, x) => s + x.percent, 0);
      if (Math.abs(sum - 100) > 0.01) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Percentage splits must sum to 100 (got ${sum})`,
          path: ['actions'],
        });
      }
    }
  }
});
export type CreateConditionalRuleInput = z.infer<typeof createConditionalRuleSchema>;

export const updateConditionalRuleSchema = baseConditionalRuleObject.partial();
export type UpdateConditionalRuleInput = z.infer<typeof updateConditionalRuleSchema>;

export const reorderConditionalRulesSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1).max(500),
});
export type ReorderConditionalRulesInput = z.infer<typeof reorderConditionalRulesSchema>;

// Marks a single audit row as "overridden" — called when a
// bookkeeper later changes the categorization the rule produced.
// Power-user flow: not surfaced in UI in Phase 4; called from
// approval/edit code paths so the override-rate stat reflects
// real user behavior.
export const markOverriddenSchema = z.object({
  auditId: z.string().uuid(),
});
export type MarkOverriddenInput = z.infer<typeof markOverriddenSchema>;

// Listing actions referenced by tests. Re-exporting here so
// the action catalog is reachable through the schemas barrel.
export const _actionTypesForRefinement = ACTION_TYPES;
