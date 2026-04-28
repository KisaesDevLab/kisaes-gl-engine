// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import {
  CONDITION_FIELDS_DEFERRED,
  ACTION_TYPES_DEFERRED,
  MAX_BRANCH_DEPTH,
  type Action,
  type ActionsField,
  type ConditionAST,
  type ConditionalRule,
  type ConditionalRuleContext,
  type LeafCondition,
  type RuleEvaluationResult,
} from '@kis-books/shared';
import { AppError } from '../utils/errors.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 4 — pure evaluator. No
// DB access, no side effects. Inputs are the persisted rule + a
// fully-formed ConditionalRuleContext built by the caller from
// the feed item. Outputs the matched/applied actions; the caller
// decides what to write to the bank-feed item and the audit log.

// ─── Condition evaluator ──────────────────────────────────────

// Hard ceiling on group nesting. The Zod schema (createConditional
// RuleSchema) already enforces 5 levels via depthOfConditions, but
// payloads that bypass that path (raw test sandbox, internal calls,
// future migrations) get the same protection here so a malformed
// rule can't blow the stack.
const MAX_CONDITION_DEPTH = 10;

export function evaluateCondition(
  condition: ConditionAST,
  ctx: ConditionalRuleContext,
  depth = 0,
): boolean {
  if (depth > MAX_CONDITION_DEPTH) {
    throw AppError.badRequest(
      `Condition depth ${depth} exceeds maximum ${MAX_CONDITION_DEPTH}`,
      'CONDITION_TOO_DEEP',
    );
  }
  if (condition.type === 'group') {
    if (condition.children.length === 0) return false;
    if (condition.op === 'AND') {
      return condition.children.every((c) => evaluateCondition(c, ctx, depth + 1));
    }
    return condition.children.some((c) => evaluateCondition(c, ctx, depth + 1));
  }
  return evaluateLeaf(condition, ctx);
}

function evaluateLeaf(leaf: LeafCondition, ctx: ConditionalRuleContext): boolean {
  if ((CONDITION_FIELDS_DEFERRED as readonly string[]).includes(leaf.field)) {
    throw AppError.badRequest(
      `Condition field "${leaf.field}" is not yet implemented`,
      'NOT_IMPLEMENTED',
    );
  }
  const fieldValue = (ctx as unknown as Record<string, unknown>)[leaf.field];

  switch (leaf.field) {
    case 'descriptor':
      return evaluateString(fieldValue as string | undefined, leaf.operator, leaf.value);
    case 'amount':
      return evaluateNumeric(fieldValue as number | undefined, leaf.operator, leaf.value);
    case 'amount_sign':
      return evaluateEqNe(fieldValue as number | undefined, leaf.operator, leaf.value);
    case 'account_source_id':
      return evaluateEqNe(fieldValue as string | undefined, leaf.operator, leaf.value);
    case 'date':
      return evaluateDate(fieldValue as string | undefined, leaf.operator, leaf.value);
    case 'day_of_week':
      return evaluateEqNe(fieldValue as number | undefined, leaf.operator, leaf.value);
    default:
      throw AppError.badRequest(`Unknown condition field "${(leaf as LeafCondition).field}"`);
  }
}

function evaluateString(field: string | undefined, op: string, value: unknown): boolean {
  const haystack = (field ?? '').toLowerCase();
  const needle = String(value ?? '').toLowerCase();
  switch (op) {
    case 'equals':           return haystack === needle;
    case 'not_equals':       return haystack !== needle;
    case 'contains':         return haystack.includes(needle);
    case 'not_contains':     return !haystack.includes(needle);
    case 'starts_with':      return haystack.startsWith(needle);
    case 'not_starts_with':  return !haystack.startsWith(needle);
    case 'ends_with':        return haystack.endsWith(needle);
    case 'not_ends_with':    return !haystack.endsWith(needle);
    case 'matches_regex': {
      try {
        const re = new RegExp(String(value), 'i');
        return re.test(field ?? '');
      } catch {
        return false;
      }
    }
    case 'not_matches_regex': {
      try {
        const re = new RegExp(String(value), 'i');
        return !re.test(field ?? '');
      } catch {
        return true;
      }
    }
    default:
      throw AppError.badRequest(`Unknown string operator "${op}"`);
  }
}

function evaluateNumeric(field: number | undefined, op: string, value: unknown): boolean {
  if (field === undefined || field === null || Number.isNaN(field)) return false;
  if (op === 'between') {
    if (!Array.isArray(value) || value.length !== 2) return false;
    const lo = Number(value[0]);
    const hi = Number(value[1]);
    if (Number.isNaN(lo) || Number.isNaN(hi)) return false;
    return field >= lo && field <= hi;
  }
  const v = Number(value);
  if (Number.isNaN(v)) return false;
  switch (op) {
    case 'eq':  return field === v;
    case 'ne':  return field !== v;
    case 'gt':  return field > v;
    case 'gte': return field >= v;
    case 'lt':  return field < v;
    case 'lte': return field <= v;
    default:    throw AppError.badRequest(`Unknown numeric operator "${op}"`);
  }
}

// `eq`/`ne` for fields that aren't string- or numeric-shaped
// (account_source_id is a uuid string, day_of_week is 0..6, etc.).
// Compares stringified values to avoid number/string mismatch
// when the rule is loaded from JSONB.
function evaluateEqNe(field: string | number | undefined, op: string, value: unknown): boolean {
  const a = field === undefined || field === null ? '' : String(field);
  const b = value === undefined || value === null ? '' : String(value);
  if (op === 'eq') return a === b;
  if (op === 'ne') return a !== b;
  throw AppError.badRequest(`Operator "${op}" only supports eq / ne`);
}

function evaluateDate(field: string | undefined, op: string, value: unknown): boolean {
  if (!field) return false;
  const a = new Date(field + 'T00:00:00Z').getTime();
  if (Number.isNaN(a)) return false;
  if (op === 'on_day_of_week') {
    const dow = new Date(field + 'T00:00:00Z').getUTCDay();
    return dow === Number(value);
  }
  if (op === 'between') {
    if (!Array.isArray(value) || value.length !== 2) return false;
    const lo = new Date(String(value[0]) + 'T00:00:00Z').getTime();
    const hi = new Date(String(value[1]) + 'T00:00:00Z').getTime();
    if (Number.isNaN(lo) || Number.isNaN(hi)) return false;
    return a >= lo && a <= hi;
  }
  const v = new Date(String(value) + 'T00:00:00Z').getTime();
  if (Number.isNaN(v)) return false;
  if (op === 'before') return a < v;
  if (op === 'after')  return a > v;
  throw AppError.badRequest(`Unknown date operator "${op}"`);
}

// ─── Action evaluator ──────────────────────────────────────────

// Walks the actions tree (flat list OR if/elif/else branch) and
// returns the flat sequence of actions that should apply for the
// given context. Bounded by MAX_BRANCH_DEPTH so a malformed rule
// can't cause runaway recursion.
export function evaluateActions(
  actions: ActionsField,
  ctx: ConditionalRuleContext,
  depth = 0,
): Action[] {
  if (depth > MAX_BRANCH_DEPTH) {
    throw AppError.badRequest(
      `Branching depth ${depth} exceeds maximum ${MAX_BRANCH_DEPTH}`,
      'BRANCH_TOO_DEEP',
    );
  }
  if (Array.isArray(actions)) {
    // Filter out deferred actions (set_class / set_location)
    // — see plan §D2. They're persisted and validated for
    // schema correctness but the executor doesn't apply them
    // until the underlying class/location features ship.
    return actions.filter(
      (a) => !(ACTION_TYPES_DEFERRED as readonly string[]).includes(a.type),
    );
  }
  if (evaluateCondition(actions.if, ctx)) {
    return evaluateActions(actions.then, ctx, depth + 1);
  }
  for (const branch of actions.elif ?? []) {
    if (evaluateCondition(branch.if, ctx)) {
      return evaluateActions(branch.then, ctx, depth + 1);
    }
  }
  if (actions.else) {
    return evaluateActions(actions.else, ctx, depth + 1);
  }
  return [];
}

// ─── Single rule + ordered list ───────────────────────────────

export function evaluateRule(rule: ConditionalRule, ctx: ConditionalRuleContext): RuleEvaluationResult {
  const matched = evaluateCondition(rule.conditions, ctx);
  if (!matched) {
    return { ruleId: rule.id, matched: false, appliedActions: [] };
  }
  const appliedActions = evaluateActions(rule.actions, ctx);
  return { ruleId: rule.id, matched: true, appliedActions };
}

// Evaluates a priority-ordered list of rules against context.
// First-match-wins by default; rules with continue_after_match
// stack on top of subsequent matches. Returns every match
// (including stacked ones) so the caller can apply all of them.
//
// Inactive rules are not passed in here — the caller filters
// before calling.
export function evaluateRules(
  rulesByPriority: ConditionalRule[],
  ctx: ConditionalRuleContext,
): RuleEvaluationResult[] {
  const matches: RuleEvaluationResult[] = [];
  for (const rule of rulesByPriority) {
    const result = evaluateRule(rule, ctx);
    if (!result.matched) continue;
    matches.push(result);
    if (!rule.continueAfterMatch) {
      // First match without continue_after_match short-circuits.
      // Any subsequent rules are skipped entirely.
      return matches;
    }
  }
  return matches;
}

// ─── Trace (Phase 5b sandbox) ──────────────────────────────────

// Mirrors the AST shape but with a `matched` boolean per node so
// the sandbox UI can highlight which conditions passed/failed.
// Used only by the test sandbox endpoint — production evaluation
// goes through the simpler `evaluateCondition` for speed.
export type ConditionTrace =
  | {
      kind: 'leaf';
      field: string;
      operator: string;
      value: unknown;
      matched: boolean;
      error?: string;
    }
  | {
      kind: 'group';
      op: 'AND' | 'OR';
      matched: boolean;
      children: ConditionTrace[];
    };

export function traceCondition(
  condition: ConditionAST,
  ctx: ConditionalRuleContext,
  depth = 0,
): ConditionTrace {
  if (depth > MAX_CONDITION_DEPTH) {
    return {
      kind: 'leaf',
      field: '<too-deep>',
      operator: '',
      value: null,
      matched: false,
      error: `Condition depth ${depth} exceeds maximum ${MAX_CONDITION_DEPTH}`,
    };
  }
  if (condition.type === 'group') {
    const childTraces = condition.children.map((c) => traceCondition(c, ctx, depth + 1));
    const matched =
      childTraces.length > 0 &&
      (condition.op === 'AND'
        ? childTraces.every((t) => t.matched)
        : childTraces.some((t) => t.matched));
    return { kind: 'group', op: condition.op, matched, children: childTraces };
  }
  let matched = false;
  let error: string | undefined;
  try {
    matched = evaluateCondition(condition, ctx, depth);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return {
    kind: 'leaf',
    field: condition.field,
    operator: condition.operator,
    value: condition.value,
    matched,
    error,
  };
}

// ─── Helper for callers ────────────────────────────────────────

// Builds the ConditionalRuleContext from a bank-feed item.
// Centralized so the pipeline hook + test fixtures + (future)
// test sandbox use the same construction.
export function contextFromFeedItem(item: {
  description: string | null;
  originalDescription: string | null;
  amount: string;
  feedDate: string;
  bankConnectionAccountId: string;
}): ConditionalRuleContext {
  const desc = (item.originalDescription || item.description || '').trim();
  const amt = parseFloat(item.amount);
  const sign: -1 | 0 | 1 = amt > 0 ? 1 : amt < 0 ? -1 : 0;
  const date = item.feedDate;
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  return {
    descriptor: desc,
    amount: amt,
    amount_sign: sign,
    account_source_id: item.bankConnectionAccountId,
    date,
    day_of_week: dow,
  };
}
