// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Report Builder schema v1 (U-118 / U-119). The fixtures under fixtures/ are
// shared with the ClientLedger desktop (serde, deny_unknown_fields): every
// starter is a fixture and parses; every case in fixtures/cases.json gets
// the engine result it lists. RB_WRITE_FIXTURES=1 rewrites the generated
// fixture files from the definitions below (the hand-written ones, marked
// `handWritten`, are left alone).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILDER_STARTERS, parseBuilderDefinition, RB_MAX_DEFINITION_BYTES, RB_MAX_NODES, RB_ERROR_CODES, RB_SOURCE_INFO,
  RB_DETAIL_FIELDS, RB_SOURCES, type BuilderDefinition, type RbNode,
} from './index.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const WRITE = process.env['RB_WRITE_FIXTURES'] === '1';
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const starter = (key: string): BuilderDefinition => clone(BUILDER_STARTERS.find((s) => s.key === key)!.definition);

type Expect = { ok: true } | { code: string; path: string };
interface Case { file: string; note: string; engine: Expect; desktop?: string; handWritten?: boolean }

function withNodes(nodes: RbNode[]): BuilderDefinition {
  const d = starter('profit_loss');
  d.nodes = nodes;
  return d;
}
const blank = (id: string): RbNode => ({ type: 'blank', id });
function nested(depth: number): RbNode {
  let n: RbNode = blank('leaf');
  for (let i = depth - 1; i >= 1; i--) n = { type: 'group', id: `g${i}`, caption: 'Group', children: [n], showTotal: false };
  return n;
}

/** Generated cases: [file, note, definition, engine result, desktop note]. */
function generated(): Array<[string, string, unknown, Expect, string?]> {
  const pl = starter('profit_loss');
  const out: Array<[string, string, unknown, Expect, string?]> = [];
  const mut = (f: (d: BuilderDefinition & Record<string, unknown>) => void) => { const d = clone(pl) as BuilderDefinition & Record<string, unknown>; f(d); return d; };
  const sec = (d: BuilderDefinition, i = 0) => d.nodes[i] as Extract<RbNode, { type: 'section' }>;

  out.push(['valid/ids_and_values.json', 'ids at every id path (account, contact, item, tag filters; tag group), value filters', mut((d) => {
    sec(d).filters.push({ field: 'contact', op: 'in', ids: [U1] }, { field: 'tag', op: 'not_in', ids: [U2] }, { field: 'txn_type', op: 'in', values: ['invoice', 'journal_entry'] },
      { field: 'item', op: 'is_none' }, { field: 'amount', op: 'gte', value: '10.005' });
    sec(d).groupBy = [{ key: 'tag', tagGroupId: U2 }, { key: 'account' }];
    d.nodes.push({ type: 'group', id: 'grp', caption: 'Nested', showTotal: true, children: [
      { ...sec(clone(pl)), id: 'deep', filters: [{ field: 'account', op: 'in', ids: [U1, U2] }], polarity: 'credit' },
    ] });
  }), { ok: true }]);
  out.push(['valid/nodes_200.json', `${RB_MAX_NODES} nodes (nested)`, withNodes([
    { type: 'group', id: 'outer', caption: 'Outer', showTotal: false, children: Array.from({ length: RB_MAX_NODES - 1 }, (_, i) => blank(`b${i}`)) },
  ]), { ok: true }]);
  out.push(['valid/detail_fields_all.json', `every detail field (${RB_DETAIL_FIELDS.length}; the cap is 24)`, mut((d) => {
    d.columns.detailFields = [...RB_DETAIL_FIELDS];
    d.nodes = [{ ...sec(d), source: 'gl', polarity: 'debit', display: 'detail', filters: [] }];
  }), { ok: true }]);
  out.push(['valid/depth_8.json', 'groups nested 8 deep', withNodes([nested(8)]), { ok: true }]);
  out.push(['valid/multibyte_text.json', 'multibyte text (each character 3–4 bytes in UTF-8)', mut((d) => {
    d.title = 'Résumé — 東京 📈';
    d.nodes.push({ type: 'text', id: 'note', text: '売上高と費用 ✓ '.repeat(20) });
  }), { ok: true }]);

  out.push(['valid/nodes_200_flat.json', `${RB_MAX_NODES} nodes in one list`, withNodes(Array.from({ length: RB_MAX_NODES }, (_, i) => blank(`b${i}`))), { ok: true }]);
  out.push(['valid/caption_astral_200_units.json', 'a caption of 100 emoji: 200 UTF-16 units (the cap; lengths count UTF-16 units)', mut((d) => { sec(d).caption = '📈'.repeat(100); }), { ok: true }]);
  out.push(['valid/check_type.json', 'the check transaction type (an expense with is_check)', mut((d) => {
    d.nodes = [{ ...sec(d), source: 'purchases', filters: [{ field: 'txn_type', op: 'in', values: ['check', 'expense'] }], groupBy: [{ key: 'contact' }] }];
  }), { ok: true }]);
  out.push(['invalid/caption_astral_202_units.json', 'a caption of 101 emoji: 101 characters but 202 UTF-16 units', mut((d) => { sec(d).caption = '📈'.repeat(101); }),
    { code: 'SCHEMA', path: 'definition.nodes.0.caption' }, 'count String::encode_utf16().count(), not chars or bytes']);
  out.push(['invalid/caption_edge_space.json', 'a caption ending in a space (text is stored as sent, never trimmed)', mut((d) => { sec(d).caption = 'Income '; }),
    { code: 'SCHEMA', path: 'definition.nodes.0.caption' }]);
  out.push(['invalid/nodes_201_flat.json', `${RB_MAX_NODES + 1} nodes in one list (same rule as nested)`, withNodes(Array.from({ length: RB_MAX_NODES + 1 }, (_, i) => blank(`b${i}`))),
    { code: 'TOO_MANY_NODES', path: 'definition.nodes' }]);
  out.push(['invalid/unknown_field.json', 'an unknown key on a section', mut((d) => { (sec(d) as unknown as Record<string, unknown>)['sortBy'] = 'amount'; }),
    { code: 'SCHEMA', path: 'definition.nodes.0' }]);
  out.push(['invalid/unknown_top_field.json', 'an unknown top-level key', mut((d) => { d['extra'] = true; }), { code: 'SCHEMA', path: 'definition' }]);
  out.push(['invalid/newer_version.json', 'schemaVersion 2', mut((d) => { (d as { schemaVersion: number }).schemaVersion = 2; }),
    { code: 'SCHEMA', path: 'definition.schemaVersion' }, 'DefinitionError::Newer ("update ClientLedger"), checked before anything else']);
  out.push(['invalid/nodes_201.json', `${RB_MAX_NODES + 1} nodes (nested)`, withNodes([
    { type: 'group', id: 'outer', caption: 'Outer', showTotal: false, children: Array.from({ length: RB_MAX_NODES }, (_, i) => blank(`b${i}`)) },
  ]), { code: 'TOO_MANY_NODES', path: 'definition.nodes' }]);
  out.push(['invalid/depth_9.json', 'groups nested 9 deep', withNodes([nested(9)]),
    { code: 'TOO_DEEP', path: 'definition.nodes.0.children.0.children.0.children.0.children.0.children.0.children.0.children.0.children.0' }]);
  out.push(['invalid/detail_fields_25.json', '25 detail fields (repeats)', mut((d) => {
    d.columns.detailFields = [...RB_DETAIL_FIELDS, 'date', 'memo', 'amount'];
  }), { code: 'SCHEMA', path: 'definition.columns.detailFields' }]);
  out.push(['invalid/detail_field_repeated.json', 'a detail field twice', mut((d) => { d.columns.detailFields = ['date', 'date']; }),
    { code: 'SCHEMA', path: 'definition.columns.detailFields' }]);
  out.push(['invalid/uuid_in_caption.json', 'an id inside a caption', mut((d) => { sec(d).caption = `Income ${U1}`; }),
    { code: 'UUID_IN_TEXT', path: 'definition.nodes.0.caption' }]);
  out.push(['invalid/uuid_in_text.json', 'an id inside a text node', mut((d) => { d.nodes.push({ type: 'text', id: 't', text: `see ${U2}` }); }),
    { code: 'UUID_IN_TEXT', path: 'definition.nodes.8.text' }]);
  out.push(['invalid/uuid_as_node_id.json', 'a uuid as a node id', mut((d) => { d.nodes.push(blank(U1)); }),
    { code: 'SCHEMA', path: 'definition.nodes.8.id' }]);
  out.push(['invalid/duplicate_node_id.json', 'two nodes with one id', mut((d) => { d.nodes.push(blank('income')); }),
    { code: 'DUPLICATE_ID', path: 'definition.nodes.8.id' }]);
  out.push(['invalid/value_not_in_enum.json', 'an unknown account type', mut((d) => { sec(d).filters = [{ field: 'account_type', op: 'in', values: ['revenue', 'income'] }]; }),
    { code: 'FILTER_OP', path: 'definition.nodes.0.filters.0.values.1' }]);
  out.push(['invalid/ids_on_value_field.json', 'ids on a value filter', mut((d) => { sec(d).filters.push({ field: 'txn_type', op: 'in', ids: [U1] }); }),
    { code: 'FILTER_OP', path: 'definition.nodes.0.filters.1.op' }]);
  out.push(['invalid/ids_501.json', '501 ids in one filter', mut((d) => {
    sec(d).filters.push({ field: 'contact', op: 'in', ids: Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) });
  }), { code: 'SCHEMA', path: 'definition.nodes.0.filters.1.ids' }]);
  out.push(['invalid/not_in_source.json', 'quantity on a gl section', mut((d) => { sec(d).measure = 'quantity'; }),
    { code: 'NOT_IN_SOURCE', path: 'definition.nodes.0.measure' }]);
  out.push(['invalid/tag_group_without_tag.json', 'a tag group on a non-tag grouping', mut((d) => { sec(d).groupBy = [{ key: 'account', tagGroupId: U1 }]; }),
    { code: 'SCHEMA', path: 'definition.nodes.0.groupBy.0.tagGroupId' }]);
  out.push(['invalid/formula_forward_ref.json', 'a formula using a later node', mut((d) => {
    d.nodes.splice(2, 1, { type: 'formula', id: 'gross_profit', caption: 'Gross Profit', terms: [{ nodeId: 'income', sign: 1 }, { nodeId: 'expenses', sign: -1 }] });
  }), { code: 'FORMULA_FORWARD_REF', path: 'definition.nodes.2.terms.1.nodeId' }]);
  out.push(['invalid/formula_ancestor.json', 'a formula using its own group', mut((d) => {
    d.nodes.push({ type: 'group', id: 'outer', caption: 'Outer', showTotal: true, children: [{ type: 'formula', id: 'f', caption: 'F', terms: [{ nodeId: 'outer', sign: 1 }] }] });
  }), { code: 'FORMULA_FORWARD_REF', path: 'definition.nodes.8.children.0.terms.0.nodeId' }]);
  out.push(['invalid/formula_text_term.json', 'a formula using a text node', mut((d) => {
    d.nodes.unshift({ type: 'text', id: 'intro', text: 'Hello' });
    d.nodes.push({ type: 'formula', id: 'f', caption: 'F', terms: [{ nodeId: 'intro', sign: 1 }] });
  }), { code: 'FORMULA_FORWARD_REF', path: 'definition.nodes.9.terms.0.nodeId' }]);
  out.push(['invalid/formula_units.json', 'a formula mixing an amount and a count', mut((d) => {
    d.nodes.push({ ...sec(d), id: 'n', measure: 'count' }, { type: 'formula', id: 'f', caption: 'F', terms: [{ nodeId: 'income', sign: 1 }, { nodeId: 'n', sign: 1 }] });
  }), { code: 'FORMULA_UNITS', path: 'definition.nodes.9.terms' }]);
  out.push(['invalid/percent_base.json', 'percent of a count', mut((d) => {
    d.nodes.push({ ...sec(d), id: 'n', measure: 'count' });
    d.columns.percentOf = 'n';
  }), { code: 'PERCENT_BASE', path: 'definition.columns.percentOf' }]);
  out.push(['invalid/earnings_filter.json', 'earnings with a name filter', mut((d) => {
    d.nodes = [{ ...sec(d), measure: 'balance', earnings: 'balance_sheet', filters: [{ field: 'account_type', op: 'in', values: ['equity'] }, { field: 'contact', op: 'in', ids: [U1] }] }];
  }), { code: 'EARNINGS_FILTER', path: 'definition.nodes.0.filters.1.field' }]);
  out.push(['invalid/earnings_measure.json', 'earnings on an amount section', mut((d) => { sec(d).earnings = 'balance_sheet'; }),
    { code: 'EARNINGS_FILTER', path: 'definition.nodes.0.earnings' }]);
  out.push(['invalid/buckets_periods.json', 'aging columns with periods', mut((d) => {
    d.columns.agingBuckets = true; d.columns.periods = 'month';
    d.nodes = [{ ...sec(d), source: 'ar_open', measure: 'open_balance', filters: [], groupBy: [{ key: 'contact' }] }];
  }), { code: 'BUCKETS_PERIODS', path: 'definition.columns.agingBuckets' }]);
  out.push(['invalid/buckets_on_gl.json', 'aging columns on a gl section', mut((d) => { d.columns.agingBuckets = true; }),
    { code: 'BUCKETS_PERIODS', path: 'definition.nodes.0.source' }]);
  out.push(['invalid/running_balance.json', 'a running balance grouped by name', mut((d) => {
    d.columns.detailFields = ['date', 'amount', 'running_balance'];
    d.nodes = [{ ...sec(d), display: 'detail', groupBy: [{ key: 'contact' }] }];
  }), { code: 'RUNNING_BALANCE', path: 'definition.nodes.0.groupBy' }]);
  out.push(['invalid/mixed_polarity.json', 'natural signs over every account', mut((d) => { sec(d).filters = []; }),
    { code: 'MIXED_POLARITY', path: 'definition.nodes.0.polarity' }]);
  out.push(['invalid/mixed_polarity_types.json', 'natural signs over income and expense types', mut((d) => {
    sec(d).filters = [{ field: 'account_type', op: 'in', values: ['revenue', 'expense'] }];
  }), { code: 'MIXED_POLARITY', path: 'definition.nodes.0.polarity' }]);
  return out;
}

const HAND_WRITTEN: Case[] = [
  {
    file: 'invalid/duplicate_key.json', handWritten: true,
    note: 'the key "caption" twice in one section. JSON.parse keeps the last one, so the engine accepts it (and stores JSON.stringify of the parsed value, so stored definitions never repeat a key); serde refuses it.',
    engine: { ok: true }, desktop: 'refused: duplicate field',
  },
];

describe('report builder schema v1', () => {
  it('every starter parses, and its fixture is the same definition', () => {
    expect(BUILDER_STARTERS.length).toBeGreaterThanOrEqual(16);
    expect(new Set(BUILDER_STARTERS.map((s) => s.key)).size).toBe(BUILDER_STARTERS.length);
    for (const s of BUILDER_STARTERS) {
      const r = parseBuilderDefinition(s.definition);
      expect(r, s.key).toMatchObject({ ok: true });
      const file = path.join(FIXTURES, 'starters', `${s.key}.json`);
      if (WRITE) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(s.definition, null, 2)}\n`); }
      expect(JSON.parse(fs.readFileSync(file, 'utf8')), s.key).toEqual(s.definition);
      // The stored form is zod's output: parsing is the identity on a starter.
      if (r.ok) expect(r.definition).toEqual(s.definition);
    }
  });

  it('every case gets the engine result fixtures/cases.json lists', () => {
    const cases: Case[] = [];
    for (const [file, note, definition, engine, desktop] of generated()) {
      cases.push({ file, note, engine, ...(desktop ? { desktop } : {}) });
      if (WRITE) { fs.mkdirSync(path.dirname(path.join(FIXTURES, file)), { recursive: true }); fs.writeFileSync(path.join(FIXTURES, file), `${JSON.stringify(definition, null, 2)}\n`); }
    }
    cases.push(...HAND_WRITTEN);
    const index = path.join(FIXTURES, 'cases.json');
    if (WRITE) fs.writeFileSync(index, `${JSON.stringify(cases, null, 2)}\n`);
    expect(JSON.parse(fs.readFileSync(index, 'utf8'))).toEqual(cases);
    for (const c of cases) {
      const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, c.file), 'utf8')) as unknown;
      const r = parseBuilderDefinition(raw);
      if ('ok' in c.engine) expect(r, c.file).toMatchObject({ ok: true });
      else expect(r.ok ? r : (r as { issue?: unknown }).issue, c.file).toMatchObject({ code: c.engine.code, path: c.engine.path });
    }
    // One case per rule code at least.
    const codes = new Set(cases.flatMap((c) => ('code' in c.engine ? [c.engine.code] : [])));
    for (const code of RB_ERROR_CODES) expect(codes.has(code), code).toBe(true);
  });

  it('caps the size at 256 KB counting UTF-8 bytes', () => {
    const d = starter('profit_loss');
    // 3-byte characters: under the cap by characters, over it by bytes.
    const chunk = '東'.repeat(450);
    d.nodes = Array.from({ length: RB_MAX_NODES }, (_, i) => ({ type: 'text' as const, id: `t${i}`, text: chunk }));
    const over = parseBuilderDefinition(d);
    expect(JSON.stringify(d).length).toBeLessThan(RB_MAX_DEFINITION_BYTES);
    expect(over).toMatchObject({ ok: false, tooLarge: true });
    d.nodes = d.nodes.slice(0, 50);
    expect(parseBuilderDefinition(d)).toMatchObject({ ok: true });
  });

  it('collects ids by path at any depth', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'valid/ids_and_values.json'), 'utf8')) as unknown;
    const r = parseBuilderDefinition(raw);
    if (!r.ok) throw new Error('expected ok');
    expect(r.refs).toEqual([
      { kind: 'contacts', path: 'definition.nodes.0.filters.1.ids', ids: [U1] },
      { kind: 'tags', path: 'definition.nodes.0.filters.2.ids', ids: [U2] },
      { kind: 'tagGroups', path: 'definition.nodes.0.groupBy.0.tagGroupId', ids: [U2] },
      { kind: 'accounts', path: 'definition.nodes.8.children.0.filters.0.ids', ids: [U1, U2] },
    ]);
  });

  it('every source offers what its catalogue entry says, and nothing unknown', () => {
    for (const s of RB_SOURCES) {
      const info = RB_SOURCE_INFO[s];
      expect(info.key).toBe(s);
      for (const m of info.accrualOnly) expect(info.measures).toContain(m);
    }
  });
});
