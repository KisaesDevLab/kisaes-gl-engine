// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Report Builder definition schema v1 (U-118 / U-119, capability
 * report-defs-builder-v1). Strict: an unknown key anywhere is refused, as
 * the desktop's serde `deny_unknown_fields` does. Any new field or value
 * means schemaVersion 2. Pure: no I/O.
 *
 * `parseBuilderDefinition` checks the shape (zod), then the rules zod can't
 * say (`checkBuilderRules`), and returns the definition with the entity ids
 * it names by path. Errors carry {path, code}; path is dotted from
 * `definition` (e.g. `definition.nodes.0.children.2.terms.0.nodeId`).
 *
 * Entity ids appear only at `nodes.**.filters.N.ids` (typed by the filter's
 * field) and `nodes.**.groupBy.N.tagGroupId`, at any `children` depth. A
 * uuid anywhere else (a caption, text, header) is refused (UUID_IN_TEXT).
 */

import { z } from 'zod';
import {
  RB_SOURCES, RB_MEASURES, RB_GROUP_KEYS, RB_FILTER_FIELDS, RB_FILTER_OPS, RB_DETAIL_FIELDS,
  RB_SOURCE_INFO, RB_MEASURE_UNIT, RB_ID_FILTER_FIELDS, RB_VALUE_FILTER_FIELDS, RB_NULLABLE_FILTER_FIELDS,
  RB_SCALAR_FILTER_FIELDS, RB_FILTER_VALUES, RB_DEBIT_NORMAL_TYPES,
  type RbSource, type RbMeasure, type RbGroupKey, type RbFilterField, type RbFilterOp, type RbDetailField, type RbUnit,
} from './fields.js';

export const RB_SCHEMA_VERSION = 1;
/** Largest builder definition, in bytes of its JSON text (413 DEFINITION_TOO_LARGE). */
export const RB_MAX_DEFINITION_BYTES = 256 * 1024;
/** Most nodes of every kind, at any depth. */
export const RB_MAX_NODES = 200;
/** Deepest `children` nesting (a top-level node is depth 1). */
export const RB_MAX_DEPTH = 8;
export const RB_MAX_IDS = 500;
export const RB_MAX_VALUES = 500;
export const RB_MAX_FILTERS = 20;
export const RB_MAX_GROUP_BY = 3;
export const RB_MAX_DETAIL_FIELDS = 24;
export const RB_MAX_COMPARE = 2;
export const RB_MAX_TERMS = 20;
export const RB_MAX_HEADERS = 64;

export const RB_NODE_ID_RE = /^[a-z0-9_-]{1,32}$/;
export const RB_COLUMN_KEY_RE = /^[a-z0-9_.:-]{1,64}$/;
export const RB_PRESET_RE = /^[a-z0-9_]{1,40}$/;
export const RB_DECIMAL_RE = /^-?\d{1,15}(\.\d{1,4})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_TOKEN_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Every DEFINITION_INVALID code a builder definition can get. */
export const RB_ERROR_CODES = [
  'SCHEMA', 'TOO_MANY_NODES', 'TOO_DEEP', 'DUPLICATE_ID', 'UUID_IN_TEXT', 'NOT_IN_SOURCE', 'FILTER_OP',
  'FORMULA_FORWARD_REF', 'FORMULA_UNITS', 'PERCENT_BASE', 'EARNINGS_FILTER', 'BUCKETS_PERIODS',
  'RUNNING_BALANCE', 'MIXED_POLARITY',
] as const;
export type RbErrorCode = (typeof RB_ERROR_CODES)[number];

// ── Types ──────────────────────────────────────────────────────────

export interface RbFilter {
  field: RbFilterField;
  op: RbFilterOp;
  ids?: string[];
  values?: string[];
  value?: string;
}
export interface RbGroupBy { key: RbGroupKey; tagGroupId?: string }
export type RbPolarity = 'natural' | 'debit' | 'credit';
export type RbDisplay = 'summary' | 'detail' | 'expandable';

export interface RbSectionNode {
  type: 'section';
  id: string;
  caption: string;
  source: RbSource;
  measure: RbMeasure;
  polarity?: RbPolarity;
  filters: RbFilter[];
  groupBy: RbGroupBy[];
  display: RbDisplay;
  defaultExpanded: boolean;
  showTotal: boolean;
  totalCaption?: string;
  hideZero: boolean;
  earnings?: 'balance_sheet' | 'trial_balance';
}
export interface RbGroupNode { type: 'group'; id: string; caption: string; children: RbNode[]; showTotal: boolean; totalCaption?: string }
export interface RbFormulaNode { type: 'formula'; id: string; caption: string; terms: Array<{ nodeId: string; sign: 1 | -1 }> }
export interface RbTextNode { type: 'text'; id: string; text: string }
export interface RbBlankNode { type: 'blank'; id: string }
export interface RbPageBreakNode { type: 'page_break'; id: string }
export type RbNode = RbSectionNode | RbGroupNode | RbFormulaNode | RbTextNode | RbBlankNode | RbPageBreakNode;

export interface RbCompare { base: 'prior_period' | 'prior_year'; amount: boolean; dollarChange: boolean; percentChange: boolean }

export interface BuilderDefinition {
  schemaVersion: 1;
  kind: 'builder';
  title?: string;
  dates: { mode: 'range' | 'asOf'; preset?: string };
  basis?: 'accrual' | 'cash';
  adjusting?: 'include' | 'exclude' | 'only';
  columns: {
    detailFields: RbDetailField[];
    periods?: 'month' | 'quarter' | 'year';
    agingBuckets?: true;
    compare: RbCompare[];
    percentOf?: string;
    headers: Record<string, string>;
  };
  nodes: RbNode[];
}

// ── Zod ────────────────────────────────────────────────────────────

const nodeId = z.string().regex(RB_NODE_ID_RE, 'node ids are 1–32 of a-z, 0-9, _ and -');
const caption = z.string().trim().min(1).max(200);

const filterSchema = z.object({
  field: z.enum(RB_FILTER_FIELDS),
  op: z.enum(RB_FILTER_OPS),
  ids: z.array(z.string().regex(UUID_RE, 'must be an id')).max(RB_MAX_IDS).optional(),
  values: z.array(z.string().min(1).max(40)).max(RB_MAX_VALUES).optional(),
  value: z.string().regex(RB_DECIMAL_RE, 'must be a decimal amount').optional(),
}).strict();

const groupBySchema = z.object({
  key: z.enum(RB_GROUP_KEYS),
  tagGroupId: z.string().regex(UUID_RE, 'must be an id').optional(),
}).strict();

const sectionSchema = z.object({
  type: z.literal('section'),
  id: nodeId,
  caption,
  source: z.enum(RB_SOURCES),
  measure: z.enum(RB_MEASURES),
  polarity: z.enum(['natural', 'debit', 'credit']).optional(),
  filters: z.array(filterSchema).max(RB_MAX_FILTERS),
  groupBy: z.array(groupBySchema).max(RB_MAX_GROUP_BY),
  display: z.enum(['summary', 'detail', 'expandable']),
  defaultExpanded: z.boolean(),
  showTotal: z.boolean(),
  totalCaption: caption.optional(),
  hideZero: z.boolean(),
  earnings: z.enum(['balance_sheet', 'trial_balance']).optional(),
}).strict();

const formulaSchema = z.object({
  type: z.literal('formula'),
  id: nodeId,
  caption,
  terms: z.array(z.object({ nodeId, sign: z.union([z.literal(1), z.literal(-1)]) }).strict()).min(1).max(RB_MAX_TERMS),
}).strict();

const textSchema = z.object({ type: z.literal('text'), id: nodeId, text: z.string().max(500) }).strict();
const blankSchema = z.object({ type: z.literal('blank'), id: nodeId }).strict();
const pageBreakSchema = z.object({ type: z.literal('page_break'), id: nodeId }).strict();

export const rbNodeSchema: z.ZodType<RbNode> = z.lazy(() => z.discriminatedUnion('type', [
  sectionSchema,
  z.object({
    type: z.literal('group'),
    id: nodeId,
    caption,
    children: z.array(rbNodeSchema).max(RB_MAX_NODES),
    showTotal: z.boolean(),
    totalCaption: caption.optional(),
  }).strict(),
  formulaSchema,
  textSchema,
  blankSchema,
  pageBreakSchema,
])) as unknown as z.ZodType<RbNode>;

export const builderDefinitionSchema: z.ZodType<BuilderDefinition> = z.object({
  schemaVersion: z.literal(RB_SCHEMA_VERSION),
  kind: z.literal('builder'),
  title: caption.optional(),
  dates: z.object({ mode: z.enum(['range', 'asOf']), preset: z.string().regex(RB_PRESET_RE).optional() }).strict(),
  basis: z.enum(['accrual', 'cash']).optional(),
  adjusting: z.enum(['include', 'exclude', 'only']).optional(),
  columns: z.object({
    detailFields: z.array(z.enum(RB_DETAIL_FIELDS)).max(RB_MAX_DETAIL_FIELDS)
      .refine((f) => new Set(f).size === f.length, { message: 'each detail field can be used once' }),
    periods: z.enum(['month', 'quarter', 'year']).optional(),
    agingBuckets: z.literal(true).optional(),
    compare: z.array(z.object({
      base: z.enum(['prior_period', 'prior_year']),
      amount: z.boolean(),
      dollarChange: z.boolean(),
      percentChange: z.boolean(),
    }).strict()).max(RB_MAX_COMPARE),
    percentOf: z.union([nodeId, z.literal('section')]).optional(),
    headers: z.record(z.string().regex(RB_COLUMN_KEY_RE), z.string().trim().min(1).max(80))
      .refine((h) => Object.keys(h).length <= RB_MAX_HEADERS, { message: `at most ${RB_MAX_HEADERS} headers` }),
  }).strict(),
  nodes: z.array(rbNodeSchema).max(RB_MAX_NODES),
}).strict() as unknown as z.ZodType<BuilderDefinition>;

// ── Rules ──────────────────────────────────────────────────────────

export interface RbIssue { path: string; code: RbErrorCode; message: string }

/** The entity tables a builder definition can name. */
export type RbRefKind = 'accounts' | 'contacts' | 'items' | 'tags' | 'tagGroups';
export type RbRefs = Array<{ kind: RbRefKind; path: string; ids: string[] }>;

export interface RbWalkEntry { node: RbNode; path: string; depth: number; ancestors: string[] }

/** Every node in pre-order with its dotted path (from `definition`), depth (1 = top level) and ancestor ids. */
export function walkBuilderNodes(def: Pick<BuilderDefinition, 'nodes'>): RbWalkEntry[] {
  const out: RbWalkEntry[] = [];
  const visit = (nodes: RbNode[], base: string, depth: number, ancestors: string[]) => {
    nodes.forEach((node, i) => {
      const path = `${base}.${i}`;
      out.push({ node, path, depth, ancestors });
      if (node.type === 'group') visit(node.children, `${path}.children`, depth + 1, [...ancestors, node.id]);
    });
  };
  visit(def.nodes, 'definition.nodes', 1, []);
  return out;
}

/** A section's sign when its polarity is left out or 'natural' on a non-gl source. */
export function effectivePolarity(s: Pick<RbSectionNode, 'source' | 'polarity'>): RbPolarity | 'owed_positive' {
  const sign = RB_SOURCE_INFO[s.source].sign;
  if (sign === 'owed_positive') return 'owed_positive';
  if (s.polarity && s.polarity !== 'natural') return s.polarity;
  if (sign === 'natural') return 'natural';
  return sign === 'debit_minus_credit' ? 'debit' : 'credit';
}

/** The unit a node's figures are in; 'mixed' for a group over different units; null for text and spacing. */
export function nodeUnits(def: Pick<BuilderDefinition, 'nodes'>): Map<string, RbUnit | 'mixed' | null> {
  const units = new Map<string, RbUnit | 'mixed' | null>();
  const unitOf = (n: RbNode): RbUnit | 'mixed' | null => {
    let u: RbUnit | 'mixed' | null = null;
    if (n.type === 'section') u = RB_MEASURE_UNIT[n.measure];
    else if (n.type === 'group') {
      const kids = n.children.map(unitOf).filter((x): x is RbUnit | 'mixed' => x !== null);
      u = kids.length === 0 ? null : kids.every((k) => k === kids[0]) ? kids[0]! : 'mixed';
    } else if (n.type === 'formula') {
      const ts = n.terms.map((t) => units.get(t.nodeId)).filter((x): x is RbUnit | 'mixed' => x !== null && x !== undefined);
      u = ts.length === 0 ? null : ts.every((k) => k === ts[0]) ? ts[0]! : 'mixed';
    }
    units.set(n.id, u);
    return u;
  };
  def.nodes.forEach(unitOf);
  return units;
}

const ID_FIELDS = RB_ID_FILTER_FIELDS as Record<string, RbRefKind>;
const isValueField = (f: RbFilterField) => (RB_VALUE_FILTER_FIELDS as readonly string[]).includes(f);
const isNullable = (f: RbFilterField) => (RB_NULLABLE_FILTER_FIELDS as readonly string[]).includes(f);
const isScalar = (f: RbFilterField) => (RB_SCALAR_FILTER_FIELDS as readonly string[]).includes(f);

/**
 * The rules zod can't say, on a definition that passed the schema. Returns
 * every issue found (in path order); the engine reports the first.
 */
export function checkBuilderRules(def: BuilderDefinition): RbIssue[] {
  const issues: RbIssue[] = [];
  const add = (path: string, code: RbErrorCode, message: string) => issues.push({ path, code, message });
  const nodes = walkBuilderNodes(def);

  if (nodes.length > RB_MAX_NODES) add('definition.nodes', 'TOO_MANY_NODES', `A report can have at most ${RB_MAX_NODES} parts.`);
  for (const n of nodes) {
    if (n.depth > RB_MAX_DEPTH) { add(n.path, 'TOO_DEEP', `Groups can be nested at most ${RB_MAX_DEPTH} deep.`); break; }
  }

  const seen = new Map<string, number>();
  nodes.forEach((n, i) => {
    if (n.node.id === 'section') add(`${n.path}.id`, 'DUPLICATE_ID', '"section" is reserved.');
    else if (seen.has(n.node.id)) add(`${n.path}.id`, 'DUPLICATE_ID', 'Each part of the report needs its own id.');
    else seen.set(n.node.id, i);
  });

  // Uuids only at the id paths.
  const textAt = (path: string, s: string | undefined) => {
    if (s !== undefined && UUID_TOKEN_RE.test(s)) add(path, 'UUID_IN_TEXT', 'Text in a report cannot contain an id.');
  };
  textAt('definition.title', def.title);
  for (const [k, v] of Object.entries(def.columns.headers)) {
    if (UUID_TOKEN_RE.test(k)) add(`definition.columns.headers.${k}`, 'UUID_IN_TEXT', 'Text in a report cannot contain an id.');
    textAt(`definition.columns.headers.${k}`, v);
  }
  for (const n of nodes) {
    const node = n.node;
    if ('caption' in node) textAt(`${n.path}.caption`, node.caption);
    if ('totalCaption' in node) textAt(`${n.path}.totalCaption`, node.totalCaption);
    if (node.type === 'text') textAt(`${n.path}.text`, node.text);
  }

  const units = nodeUnits(def);
  const index = new Map(nodes.map((n, i) => [n.node.id, { ...n, i }]));
  const sections = nodes.filter((n): n is RbWalkEntry & { node: RbSectionNode } => n.node.type === 'section');
  const detailFields = def.columns.detailFields;

  for (const { node: s, path } of sections) {
    const info = RB_SOURCE_INFO[s.source];
    if (!info.measures.includes(s.measure)) add(`${path}.measure`, 'NOT_IN_SOURCE', `${info.caption} can't show this measure.`);
    if (info.sign === 'owed_positive' && s.polarity !== undefined) add(`${path}.polarity`, 'NOT_IN_SOURCE', 'Open items are always shown as amounts owed.');
    s.groupBy.forEach((g, gi) => {
      if (!info.groupBy.includes(g.key)) add(`${path}.groupBy.${gi}.key`, 'NOT_IN_SOURCE', `${info.caption} can't be grouped this way.`);
      if ((g.tagGroupId !== undefined) !== (g.key === 'tag')) add(`${path}.groupBy.${gi}.tagGroupId`, 'SCHEMA', 'A tag group is given with, and only with, group by tag.');
    });
    if (new Set(s.groupBy.map((g) => g.key)).size !== s.groupBy.length) add(`${path}.groupBy`, 'SCHEMA', 'Each grouping can be used once.');
    s.filters.forEach((f, fi) => {
      const fp = `${path}.filters.${fi}`;
      if (!info.filters.includes(f.field)) add(`${fp}.field`, 'NOT_IN_SOURCE', `${info.caption} can't be filtered this way.`);
      const listOp = f.op === 'in' || f.op === 'not_in';
      let ok: boolean;
      if (f.op === 'is_none') ok = isNullable(f.field) && f.ids === undefined && f.values === undefined && f.value === undefined;
      else if (f.op === 'gte' || f.op === 'lte') ok = isScalar(f.field) && f.value !== undefined && f.ids === undefined && f.values === undefined;
      else if (ID_FIELDS[f.field]) ok = listOp && f.ids !== undefined && f.ids.length > 0 && f.values === undefined && f.value === undefined;
      else if (isValueField(f.field)) {
        const allowed = RB_FILTER_VALUES[f.field as keyof typeof RB_FILTER_VALUES];
        ok = listOp && f.values !== undefined && f.values.length > 0 && f.ids === undefined && f.value === undefined;
        f.values?.forEach((v, vi) => { if (!allowed.includes(v)) add(`${fp}.values.${vi}`, 'FILTER_OP', 'Not a value this filter knows.'); });
      } else ok = false;
      if (!ok) add(`${fp}.op`, 'FILTER_OP', 'This filter needs a different comparison or value.');
    });

    if (s.earnings !== undefined) {
      const need = s.earnings === 'balance_sheet' ? 'balance' : 'tb_net';
      if (s.source !== 'gl' || s.measure !== need) add(`${path}.earnings`, 'EARNINGS_FILTER', `Earnings rows need All accounts with the ${need === 'balance' ? 'Balance' : 'Trial balance'} measure.`);
      s.filters.forEach((f, fi) => {
        if (!['tag', 'account', 'account_type'].includes(f.field)) add(`${path}.filters.${fi}.field`, 'EARNINGS_FILTER', 'A section with earnings rows can be filtered only by account, account type or tag.');
      });
    }

    const showsDetail = s.display !== 'summary';
    if (showsDetail && detailFields.includes('running_balance')) {
      const inner = s.groupBy[s.groupBy.length - 1];
      if (!(s.source === 'gl' || s.source === 'bank') || inner?.key !== 'account') {
        add(`${path}.groupBy`, 'RUNNING_BALANCE', 'A running balance needs the innermost grouping to be the account.');
      }
    }

    if (effectivePolarity(s) === 'natural' && ['amount', 'balance'].includes(s.measure)) {
      const typeFilter = s.filters.find((f) => f.field === 'account_type' && f.op === 'in');
      const accountFilter = s.filters.find((f) => f.field === 'account' && f.op === 'in');
      const sides = new Set((typeFilter?.values ?? []).map((t) => (RB_DEBIT_NORMAL_TYPES as readonly string[]).includes(t)));
      // An account filter is checked by the run (its accounts must share one normal side).
      if (!(typeFilter && sides.size === 1) && !accountFilter) {
        add(`${path}.polarity`, 'MIXED_POLARITY', 'Natural signs need accounts of one kind (all debit or all credit); choose Debit or Credit.');
      }
    }
  }

  // Columns.
  const cols = def.columns;
  if (cols.agingBuckets) {
    if (cols.periods !== undefined || cols.compare.length > 0) add('definition.columns.agingBuckets', 'BUCKETS_PERIODS', 'Aging columns can\'t be combined with periods or comparisons.');
    for (const { node: s, path } of sections) {
      if (!RB_SOURCE_INFO[s.source].openItems) add(`${path}.source`, 'BUCKETS_PERIODS', 'Aging columns need open-item sections only.');
    }
  }
  if (detailFields.includes('running_balance') && (cols.periods !== undefined || cols.compare.length > 0)) {
    add('definition.columns.detailFields', 'RUNNING_BALANCE', 'A running balance can\'t be combined with periods or comparisons.');
  }
  if (cols.percentOf !== undefined && cols.percentOf !== 'section') {
    const base = index.get(cols.percentOf);
    if (!base || units.get(cols.percentOf) !== 'money') add('definition.columns.percentOf', 'PERCENT_BASE', 'Percent of must name an amount in this report.');
  }
  if (cols.percentOf !== undefined) {
    for (const { node: s, path } of sections) {
      if (RB_MEASURE_UNIT[s.measure] !== 'money') add(`${path}.measure`, 'PERCENT_BASE', 'Percent columns need amounts.');
    }
  }

  // Formulas: earlier in pre-order, not an ancestor, figures of one unit.
  nodes.forEach((n, i) => {
    if (n.node.type !== 'formula') return;
    n.node.terms.forEach((t, ti) => {
      const tp = `${n.path}.terms.${ti}.nodeId`;
      const target = index.get(t.nodeId);
      if (!target || target.i >= i || n.ancestors.includes(t.nodeId) || !['section', 'group', 'formula'].includes(target.node.type)) {
        add(tp, 'FORMULA_FORWARD_REF', 'A formula can only use amounts shown above it.');
        return;
      }
      const u = units.get(t.nodeId);
      if (u === 'mixed' || u === 'debit_credit' || u === null) add(tp, 'FORMULA_UNITS', 'A formula can\'t combine these figures.');
    });
    if (units.get(n.node.id) === 'mixed') add(`${n.path}.terms`, 'FORMULA_UNITS', 'A formula can\'t mix amounts with counts or quantities.');
  });

  return issues;
}

/** The ids a definition names, by path (only at the id paths; unique, lower-case). */
export function builderRefs(def: BuilderDefinition): RbRefs {
  const refs: RbRefs = [];
  for (const { node, path } of walkBuilderNodes(def)) {
    if (node.type !== 'section') continue;
    node.filters.forEach((f, fi) => {
      const kind = ID_FIELDS[f.field];
      if (kind && f.ids) refs.push({ kind, path: `${path}.filters.${fi}.ids`, ids: [...new Set(f.ids.map((x) => x.toLowerCase()))] });
    });
    node.groupBy.forEach((g, gi) => {
      if (g.tagGroupId) refs.push({ kind: 'tagGroups', path: `${path}.groupBy.${gi}.tagGroupId`, ids: [g.tagGroupId.toLowerCase()] });
    });
  }
  return refs;
}

export type ParseBuilderResult =
  | { ok: true; definition: BuilderDefinition; refs: RbRefs }
  | { ok: false; tooLarge: true; bytes: number }
  | { ok: false; tooLarge?: false; issue: RbIssue };

function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** The path of the first value nested deeper than any valid definition can be, or null. */
function deepestPath(v: unknown, path: string, depth: number): string | null {
  // A node at RB_MAX_DEPTH sits at JSON depth 2 * RB_MAX_DEPTH; its filters add 4 more levels.
  if (depth > 2 * RB_MAX_DEPTH + 8) return path;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { const p = deepestPath(v[i], `${path}.${i}`, depth + 1); if (p) return p; }
  } else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { const p = deepestPath(x, `${path}.${k}`, depth + 1); if (p) return p; }
  }
  return null;
}

/** Size, shape, then rules. The definition returned is zod's output (what the engine stores). */
export function parseBuilderDefinition(raw: unknown): ParseBuilderResult {
  const bytes = utf8Bytes(JSON.stringify(raw) ?? '');
  if (bytes > RB_MAX_DEFINITION_BYTES) return { ok: false, tooLarge: true, bytes };
  // Bound the nesting before the recursive schema sees it.
  const tooDeep = deepestPath(raw, 'definition', 0);
  if (tooDeep) return { ok: false, issue: { path: tooDeep, code: 'TOO_DEEP', message: `Groups can be nested at most ${RB_MAX_DEPTH} deep.` } };
  const parsed = builderDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return { ok: false, issue: { path: ['definition', ...issue.path].join('.'), code: 'SCHEMA', message: issue.message } };
  }
  const issues = checkBuilderRules(parsed.data);
  if (issues.length > 0) return { ok: false, issue: issues[0]! };
  return { ok: true, definition: parsed.data, refs: builderRefs(parsed.data) };
}
