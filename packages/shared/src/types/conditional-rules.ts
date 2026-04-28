// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { ConditionField, ActionType } from '../constants/conditional-rules.js';

// Condition AST per build plan §4.2. Two node types:
//   - leaf: tests a single field against an operator + value
//   - group: combines child nodes with AND or OR
export interface LeafCondition {
  type: 'leaf';
  field: ConditionField;
  operator: string;
  // Polymorphic per (field, operator). Optional + unknown so
  // z.unknown() inference (which produces optional unknown)
  // round-trips through API boundaries; the evaluator handles
  // narrowing. `between` takes a 2-tuple, regex takes a string,
  // etc.
  value?: unknown;
}

export interface GroupCondition {
  type: 'group';
  op: 'AND' | 'OR';
  children: ConditionAST[];
}

export type ConditionAST = LeafCondition | GroupCondition;

// Action variants. `set_*` actions configure staged
// categorization on the bank-feed item; `split_by_*` actions
// configure splits_config; `mark_for_review` and `skip_ai` are
// flow-control flags.
export type Action =
  | { type: 'set_account'; accountId: string }
  | { type: 'set_vendor'; vendorId: string }
  // 3-tier rules plan, Phase 7 — `set_tag` carries either a
  // tenant-local `tagId` (uuid) for tenant_user / tenant_firm
  // rules OR a `tagTemplateKey` (string) for global_firm rules
  // that the resolver looks up via tenant_firm_tag_bindings at
  // fire time. Validators enforce one-or-the-other per scope.
  | { type: 'set_tag'; tagId?: string; tagTemplateKey?: string }
  | { type: 'set_memo'; memo: string }
  | { type: 'set_class'; classId: string }
  | { type: 'set_location'; locationId: string }
  | {
      type: 'split_by_percentage';
      splits: Array<{ accountId: string; percent: number; tagId?: string; memo?: string }>;
    }
  | {
      type: 'split_by_fixed';
      splits: Array<{ accountId: string; amount: string; tagId?: string; memo?: string }>;
    }
  | { type: 'mark_for_review' }
  | { type: 'skip_ai' };

// Conditional branching per build plan §4.4. Either a flat list
// of actions OR a branching tree. Recursion is bounded by
// MAX_BRANCH_DEPTH (5).
export interface ActionBranch {
  if: ConditionAST;
  then: ActionsField;
  // 0..MAX_BRANCH_DEPTH-1 of these — each elif is just a nested
  // condition+then.
  elif?: Array<{ if: ConditionAST; then: ActionsField }>;
  else?: ActionsField;
}

export type ActionsField = Action[] | ActionBranch;

// 3-tier rules plan, Phase 2 — tier discriminator. Maps to the
// `scope` column added in migration 0085.
export const RULE_SCOPES = ['tenant_user', 'tenant_firm', 'global_firm'] as const;
export type RuleScope = typeof RULE_SCOPES[number];

// Persisted shape of a conditional rule (mirrors the DB row).
// As of Phase 2: `tenantId` is nullable (global_firm rules have
// no tenant); `ownerUserId` / `ownerFirmId` are populated per
// scope; `forkedFromGlobalId` is set on tenant-firm forks of a
// global. The CHECK constraint in migration 0085 enforces the
// (scope, tenant_id, owner_*) invariant.
export interface ConditionalRule {
  id: string;
  tenantId: string | null;
  companyId: string | null;
  name: string;
  priority: number;
  conditions: ConditionAST;
  actions: ActionsField;
  continueAfterMatch: boolean;
  active: boolean;
  createdBy: string | null;
  scope: RuleScope;
  ownerUserId: string | null;
  ownerFirmId: string | null;
  forkedFromGlobalId: string | null;
  createdAt: string;
  updatedAt: string;
}

// Stats view row.
export interface ConditionalRuleStats {
  ruleId: string;
  tenantId: string;
  name: string;
  firesTotal: number;
  fires30d: number;
  fires7d: number;
  overrides: number;
  overrideRate: number | null;
  lastFiredAt: string | null;
}

// Audit row (one per fire). `effectiveTier` + `effectiveFirmId`
// snapshot the rule's tier at fire time (Phase 2) — kept stable
// even if the rule is later promoted/demoted.
export interface ConditionalRuleAuditEntry {
  id: string;
  tenantId: string;
  ruleId: string;
  bankFeedItemId: string | null;
  transactionId: string | null;
  matchedAt: string;
  actionsApplied: Action[];
  wasOverridden: boolean;
  overriddenAt: string | null;
  effectiveTier: RuleScope | null;
  effectiveFirmId: string | null;
}

// Context the evaluator sees when judging a feed item.
// `account_source_id` is the bank-connection's GL account
// (NOT the suggested account — that field is what the rule
// SETS, not what it tests against).
export interface ConditionalRuleContext {
  descriptor: string;
  amount: number;
  amount_sign: -1 | 0 | 1;
  account_source_id: string;
  date: string;        // YYYY-MM-DD
  day_of_week: number; // 0=Sun..6=Sat
}

// Result of evaluating one rule against context.
export interface RuleEvaluationResult {
  ruleId: string;
  matched: boolean;
  appliedActions: Action[];
}
