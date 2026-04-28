// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 4 — Conditional Rules
// Engine. Constants surfaced here so the rule builder UI (Phase 5)
// reads them straight from the same source the engine validates
// against.

// Hard ceiling on if/then/else nesting depth — see plan §D5.
// Enforced by both the recursive Zod schema (depth counter) and
// the evaluator (defensive throw).
export const MAX_BRANCH_DEPTH = 5;

// Fields a rule's leaf condition can target. `class_id` and
// `location_id` are listed in the build plan §4.2 but the data
// model has neither column today; they're defined here so the
// catalog stays stable, but the Zod schema rejects them and the
// evaluator throws NOT_IMPLEMENTED if reached. Wire them up when
// class/location tracking lands.
export const CONDITION_FIELDS = [
  'descriptor',
  'amount',
  'amount_sign',
  'account_source_id',
  'date',
  'day_of_week',
  'class_id',     // deferred — see plan §D2
  'location_id',  // deferred — see plan §D2
] as const;
export type ConditionField = typeof CONDITION_FIELDS[number];

export const CONDITION_FIELDS_DEFERRED: readonly ConditionField[] = ['class_id', 'location_id'];

// Operator catalog per field type. The Zod schema cross-checks
// (operator, field) pairs against this catalog so the rule builder
// can't persist (e.g.) `amount.contains` or `descriptor.gt`.
export const STRING_OPERATORS = [
  'equals', 'not_equals',
  'contains', 'not_contains',
  'starts_with', 'not_starts_with',
  'ends_with', 'not_ends_with',
  'matches_regex', 'not_matches_regex',
] as const;

export const NUMERIC_OPERATORS = [
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between',
] as const;

export const DATE_OPERATORS = [
  'before', 'after', 'between', 'on_day_of_week',
] as const;

// Field → allowed operator family.
export const FIELD_OPERATOR_MAP: Record<ConditionField, readonly string[]> = {
  descriptor: STRING_OPERATORS,
  amount: NUMERIC_OPERATORS,
  amount_sign: ['eq', 'ne'],            // -1 | 0 | 1
  account_source_id: ['eq', 'ne'],
  date: DATE_OPERATORS,
  day_of_week: ['eq', 'ne'],            // 0..6
  class_id: ['eq', 'ne'],
  location_id: ['eq', 'ne'],
};

// Action types per build plan §4.3. `skip_ai` and `mark_for_review`
// are flow-control actions (no payload required); the others
// configure the staged categorization on the bank-feed item.
export const ACTION_TYPES = [
  'set_account',
  'set_vendor',
  'set_tag',
  'set_memo',
  'set_class',          // deferred — accepted by schema, no-op by evaluator
  'set_location',       // deferred — same
  'split_by_percentage',
  'split_by_fixed',
  'mark_for_review',
  'skip_ai',
] as const;
export type ActionType = typeof ACTION_TYPES[number];
export const ACTION_TYPES_DEFERRED: readonly ActionType[] = ['set_class', 'set_location'];

// Default priority for new rules. Lower number = earlier
// evaluation. The reorder endpoint redistributes priorities
// across all rules in 100-step increments so a new rule can be
// inserted between two existing ones without re-numbering.
export const DEFAULT_RULE_PRIORITY = 100;
