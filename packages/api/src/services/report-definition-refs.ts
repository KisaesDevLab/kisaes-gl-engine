// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * The entity ids inside saved report definitions (report_definitions
 * .definition_json), for both kinds — U-226, capability report-refs-v1
 * (ClientLedger PR-A2, Q-PRA2b / Q-PRA2c).
 *
 * Ids sit only at these paths (the paths parseDefinition and the shared
 * builder schema accept):
 *   - builder: nodes.**.filters.N.ids (filter field account, contact, item or
 *     tag) and nodes.**.groupBy.N.tagGroupId, at any `children` depth;
 *   - standard: options.filters.{accountIds, contactIds, tagIds, itemIds},
 *     options.tagSplit.tagGroupId, options.columnTagGroupId, options.budgetId.
 *
 * `idSites` gives mutable views of those places (the report file transfer,
 * U-220, and merges use them). `repointDefinitionRefs` rewrites a merged-away
 * id to the kept one in every saved report of the tenant that can see both,
 * inside the merge's transaction. `missingReferences` lists the ids of a
 * definition that are no longer rows of this tenant visible to the company
 * (a deleted tag, tag group or budget), so a run refuses it (422
 * REPORT_REFERENCE_MISSING) and a read marks it, instead of matching nothing.
 *
 * Pure apart from the two database helpers; names are never read or logged.
 */

import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { DbOrTx, Tx } from '../db/index.js';
import { accounts, auditLog, budgets, contacts, items, reportDefinitions, tagGroups, tags } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

export type RefKind = 'account' | 'contact' | 'item' | 'tag' | 'tagGroup' | 'budget';

/** Where an id sits: the list or scalar path (dotted from `definition`), its node and the field that holds it. */
export interface SiteAt { path: string; nodeId: string | null; field: string }

/**
 * One place an id sits in a definition: a list slot (filters) or a scalar.
 * `drop` removes it as the transfer drop rules say and returns the effect.
 */
export interface Site {
  kind: RefKind;
  path: string;
  at: SiteAt;
  get(): unknown;
  set(v: string): void;
  drop(): string;
}

const BUILDER_FIELD_KIND: Record<string, RefKind> = { account: 'account', contact: 'contact', item: 'item', tag: 'tag' };
export const STANDARD_LISTS: Record<string, RefKind> = { accountIds: 'account', contactIds: 'contact', tagIds: 'tag', itemIds: 'item' };
const NODE_DEPTH = 16;

const isObj = (v: unknown): v is Record<string, unknown> => Object.prototype.toString.call(v) === '[object Object]';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The id sites of a raw definition (mutable views into it) and its id lists.
 * Unknown shapes are skipped: the save check refuses them later. A list site
 * is a slot object, so drops never shift another site's position; `compact`
 * writes the lists back (dropped slots out, duplicates once, as a save stores
 * them) and runs the empty-list rules.
 */
export interface Sites { sites: Site[]; compact(): void }

export function idSites(def: Record<string, unknown>): Sites {
  const sites: Site[] = [];
  const lists: Array<{ list: unknown[]; slots: Array<{ v: unknown; gone: boolean }>; onEmpty: () => void }> = [];
  const listSites = (list: unknown[], kind: RefKind, at: SiteAt, onEmpty: () => void, emptyEffect: string) => {
    const slots = list.map((v) => ({ v, gone: false }));
    lists.push({ list, slots, onEmpty });
    slots.forEach((slot, i) => {
      sites.push({
        kind, path: `${at.path}.${i}`, at,
        get: () => slot.v,
        set: (v) => { slot.v = v; },
        drop: () => { slot.gone = true; return slots.every((x) => x.gone) ? emptyEffect : 'removed_from_list'; },
      });
    });
  };
  const compact = () => {
    for (const l of lists) {
      if (!l.slots.some((x) => x.gone) && new Set(l.slots.map((x) => x.v)).size === l.slots.length) {
        l.slots.forEach((x, i) => { l.list[i] = x.v; });
        continue;
      }
      const kept = [...new Set(l.slots.filter((x) => !x.gone).map((x) => x.v))];
      l.list.splice(0, l.list.length, ...kept);
      if (kept.length === 0) l.onEmpty();
    }
  };
  if (def['kind'] === 'builder') {
    const walk = (nodes: unknown, path: string, depth: number) => {
      if (!Array.isArray(nodes) || depth > NODE_DEPTH) return;
      nodes.forEach((n, ni) => {
        if (!isObj(n)) return;
        const np = `${path}.${ni}`;
        if (n['type'] === 'group') { walk(n['children'], `${np}.children`, depth + 1); return; }
        if (n['type'] !== 'section') return;
        const nodeId = typeof n['id'] === 'string' ? n['id'] : null;
        const filters = n['filters'];
        if (Array.isArray(filters)) {
          filters.forEach((f, fi) => {
            if (!isObj(f) || !Array.isArray(f['ids'])) return;
            const kind = BUILDER_FIELD_KIND[String(f['field'])];
            if (!kind) return;
            listSites(f['ids'] as unknown[], kind, { path: `${np}.filters.${fi}.ids`, nodeId, field: String(f['field']) }, () => {
              const at = filters.indexOf(f);
              if (at >= 0) filters.splice(at, 1);
            }, 'filter_removed');
          });
        }
        const groupBy = n['groupBy'];
        if (Array.isArray(groupBy)) {
          groupBy.forEach((g, gi) => {
            if (!isObj(g) || g['tagGroupId'] === undefined) return;
            const path = `${np}.groupBy.${gi}.tagGroupId`;
            sites.push({
              kind: 'tagGroup', path, at: { path, nodeId, field: 'groupBy.tagGroupId' },
              get: () => g['tagGroupId'], set: (v) => { g['tagGroupId'] = v; },
              drop: () => { const at = groupBy.indexOf(g); if (at >= 0) groupBy.splice(at, 1); return 'group_by_removed'; },
            });
          });
        }
      });
    };
    walk(def['nodes'], 'definition.nodes', 0);
    return { sites, compact };
  }
  const options = def['options'];
  if (!isObj(options)) return { sites, compact };
  const filters = options['filters'];
  if (isObj(filters)) {
    for (const [key, kind] of Object.entries(STANDARD_LISTS)) {
      const list = filters[key];
      if (Array.isArray(list)) {
        listSites(list, kind, { path: `definition.options.filters.${key}`, nodeId: null, field: `filters.${key}` }, () => {}, 'removed_from_list');
      }
    }
  }
  const split = options['tagSplit'];
  if (isObj(split) && split['tagGroupId'] !== undefined && split['tagGroupId'] !== null) {
    const path = 'definition.options.tagSplit.tagGroupId';
    sites.push({
      kind: 'tagGroup', path, at: { path, nodeId: null, field: 'tagSplit.tagGroupId' },
      get: () => split['tagGroupId'], set: (v) => { split['tagGroupId'] = v; },
      drop: () => { options['tagSplit'] = null; return 'tag_split_removed'; },
    });
  }
  if (typeof options['columnTagGroupId'] === 'string') {
    const path = 'definition.options.columnTagGroupId';
    sites.push({
      kind: 'tagGroup', path, at: { path, nodeId: null, field: 'columnTagGroupId' },
      get: () => options['columnTagGroupId'], set: (v) => { options['columnTagGroupId'] = v; },
      drop: () => { delete options['columnTagGroupId']; options['columns'] = 'total'; return 'columns_total'; },
    });
  }
  if (typeof options['budgetId'] === 'string') {
    const path = 'definition.options.budgetId';
    sites.push({
      kind: 'budget', path, at: { path, nodeId: null, field: 'budgetId' },
      get: () => options['budgetId'], set: (v) => { options['budgetId'] = v; },
      drop: () => { throw new Error('a budget cannot be left out'); },
    });
  }
  return { sites, compact };
}

const TABLE = { account: accounts, contact: contacts, item: items, tag: tags, tagGroup: tagGroups, budget: budgets } as const;

// ── Missing references (Q-PRA2c) ───────────────────────────────────

/** The row a merged-away contact or tag went into (the merge audit row's after.merged_into), when this company sees it. */
export interface MergedInto { id: string; label: string }

/**
 * An id of a saved definition that no longer names a usable row of this
 * company. reason `deleted`: not a row of this tenant visible to the company
 * (a deleted tag, tag group or budget). reason `merged`: a contact or tag that
 * was merged into another before report-refs-v1 (merges since then rewrite
 * saved reports): an inactive contact, or a deleted tag, whose merge audit row
 * (entity contact / tag, after.merged_into; written by every merge since the
 * first release, never pruned) names the row it went into; `mergedInto` is
 * that row (followed through later merges, at most 5) when it is live and
 * visible to this company, else absent. A merely deactivated row (no merge
 * row, or reactivated since) still works and is not missing.
 * `ids` are the ids of that list or scalar with that reason (and survivor), in
 * definition order: one entry per path, reason and survivor. `field` is the
 * filter field for a builder filter (account, contact, item, tag),
 * `groupBy.tagGroupId` for a builder group-by, and the option path for a
 * standard report (filters.accountIds … , tagSplit.tagGroupId,
 * columnTagGroupId, budgetId).
 */
export interface MissingReference {
  path: string; nodeId: string | null; field: string; kind: RefKind; ids: string[];
  reason: 'deleted' | 'merged'; mergedInto?: MergedInto;
}

const MERGE_HOPS = 5;

/** id -> merged_into of the latest merge audit row of each id (contact or tag). */
async function mergedIntoOf(exec: DbOrTx, tenantId: string, kind: 'contact' | 'tag', ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  // auditLog() stores after_data as a JSON text scalar (JSON.stringify); rows written as objects are read too.
  const rows = await exec.select({ id: auditLog.entityId, after: auditLog.afterData }).from(auditLog)
    .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, kind), inArray(auditLog.entityId, ids),
      sql`position('merged_into' in ${auditLog.afterData}::text) > 0`))
    .orderBy(asc(auditLog.id));
  for (const r of rows) {
    let after: unknown = r.after;
    if (typeof after === 'string') { try { after = JSON.parse(after); } catch { continue; } }
    const into = isObj(after) ? after['merged_into'] : undefined;
    if (r.id && typeof into === 'string' && UUID_RE.test(into)) out.set(r.id.toLowerCase(), into.toLowerCase());
  }
  return out;
}

/** Live rows visible to the company: id -> label (contacts: active only). */
async function liveLabels(exec: DbOrTx, tenantId: string, companyId: string, kind: 'contact' | 'tag', ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  if (kind === 'contact') {
    const rows = await exec.select({ id: contacts.id, name: contacts.displayName, type: contacts.contactType }).from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), or(isNull(contacts.companyId), eq(contacts.companyId, companyId)),
        eq(contacts.isActive, true), inArray(contacts.id, ids)));
    for (const r of rows) out.set(r.id.toLowerCase(), `${r.name} (${['customer', 'vendor', 'both'].includes(r.type) ? r.type : 'both'})`);
  } else {
    const rows = await exec.select({ id: tags.id, name: tags.name, groupName: tagGroups.name }).from(tags)
      .leftJoin(tagGroups, and(eq(tagGroups.id, tags.groupId), eq(tagGroups.tenantId, tenantId)))
      .where(and(eq(tags.tenantId, tenantId), or(isNull(tags.companyId), eq(tags.companyId, companyId)), inArray(tags.id, ids)));
    for (const r of rows) out.set(r.id.toLowerCase(), r.groupName ? `${r.groupName}: ${r.name}` : r.name);
  }
  return out;
}

/**
 * The missing references of each definition, in a few queries per kind for
 * the whole batch. Deactivated rows that were not merged away still exist and
 * are not missing. A definition that holds no recognisable id sites gives [].
 */
export async function missingReferencesMany(exec: DbOrTx, tenantId: string, companyId: string, definitions: unknown[]): Promise<MissingReference[][]> {
  const perDef = definitions.map((d) => (isObj(d) ? idSites(JSON.parse(JSON.stringify(d)) as Record<string, unknown>).sites : []));
  const want = new Map<RefKind, Set<string>>();
  for (const sites of perDef) {
    for (const s of sites) {
      const v = s.get();
      if (typeof v !== 'string' || !UUID_RE.test(v)) continue;
      const set = want.get(s.kind) ?? new Set<string>();
      set.add(v.toLowerCase());
      want.set(s.kind, set);
    }
  }
  const found = new Set<string>();
  const inactiveContacts: string[] = [];
  for (const [kind, ids] of want) {
    const t = TABLE[kind];
    const rows = await exec.select({ id: t.id, active: kind === 'contact' ? contacts.isActive : sql<boolean>`TRUE` }).from(t)
      .where(and(eq(t.tenantId, tenantId), or(isNull(t.companyId), eq(t.companyId, companyId)), inArray(t.id, [...ids])));
    for (const r of rows) {
      found.add(`${kind}:${r.id.toLowerCase()}`);
      if (kind === 'contact' && r.active === false) inactiveContacts.push(r.id.toLowerCase());
    }
  }
  // Merged away before report-refs-v1: an inactive contact or a deleted tag with a merge audit row.
  const merged = new Map<string, MergedInto | null>(); // "<kind>:<id>" -> survivor (null: not live here)
  const goneTags = [...(want.get('tag') ?? [])].filter((id) => !found.has(`tag:${id}`));
  for (const [kind, start] of [['contact', inactiveContacts], ['tag', goneTags]] as const) {
    const first = await mergedIntoOf(exec, tenantId, kind, start);
    if (first.size === 0) continue;
    // Follow later merges of the survivor (a chain), at most MERGE_HOPS.
    const final = new Map(first);
    for (let hop = 0; hop < MERGE_HOPS; hop++) {
      const next = await mergedIntoOf(exec, tenantId, kind, [...new Set(final.values())]);
      const live = await liveLabels(exec, tenantId, companyId, kind, [...new Set(final.values())]);
      let moved = false;
      for (const [from, to] of final) if (!live.has(to) && next.has(to)) { final.set(from, next.get(to)!); moved = true; }
      if (!moved) break;
    }
    const labels = await liveLabels(exec, tenantId, companyId, kind, [...new Set(final.values())]);
    for (const [from, to] of final) merged.set(`${kind}:${from}`, labels.has(to) ? { id: to, label: labels.get(to)! } : null);
  }
  return perDef.map((sites) => {
    const out: MissingReference[] = [];
    const byKey = new Map<string, MissingReference>();
    for (const s of sites) {
      const v = s.get();
      if (typeof v !== 'string' || !UUID_RE.test(v)) continue;
      const id = v.toLowerCase();
      const k = `${s.kind}:${id}`;
      const isMerged = merged.has(k);
      if (found.has(k) && !isMerged) continue;
      const into = isMerged ? merged.get(k) ?? undefined : undefined;
      const key = `${s.at.path}\u0000${isMerged ? 'merged' : 'deleted'}\u0000${into?.id ?? ''}`;
      let m = byKey.get(key);
      if (!m) {
        m = { path: s.at.path, nodeId: s.at.nodeId, field: s.at.field, kind: s.kind, ids: [], reason: isMerged ? 'merged' : 'deleted', ...(into ? { mergedInto: into } : {}) };
        byKey.set(key, m);
        out.push(m);
      }
      if (!m.ids.includes(id)) m.ids.push(id);
    }
    return out;
  });
}

export async function missingReferences(exec: DbOrTx, tenantId: string, companyId: string, definition: unknown): Promise<MissingReference[]> {
  return (await missingReferencesMany(exec, tenantId, companyId, [definition]))[0]!;
}

/**
 * 422 REPORT_REFERENCE_MISSING: a saved report names a record that no longer
 * exists in this company. details: the first missing reference's
 * {path, nodeId, field, kind, ids}, and `missing` (all of them).
 */
export function referenceMissing(missing: MissingReference[]): AppError {
  return new AppError(
    422,
    'This report uses a name that was deleted. Pick another one or remove it from the report, then run it again.',
    'REPORT_REFERENCE_MISSING',
    { ...missing[0]!, missing } as unknown as Record<string, unknown>,
  );
}

/**
 * An inline definition (the desktop's editor run) naming a missing record:
 * 400 DEFINITION_INVALID {path, code: NOT_IN_COMPANY} as before, at the first
 * missing reference's path, with `missing` (all of them) added.
 */
export function inlineReferenceMissing(missing: MissingReference[]): AppError {
  return AppError.badRequest(
    'This report uses a name that was deleted. Pick another one or remove it from the report, then run it again.',
    'DEFINITION_INVALID',
    { path: missing[0]!.path, code: 'NOT_IN_COMPANY', missing } as unknown as Record<string, unknown>,
  );
}

// ── Merges (Q-PRA2b) ───────────────────────────────────────────────

export interface RepointResult {
  /** Saved reports rewritten to the kept id (each got the next version). */
  updated: number;
  /** Saved reports that name the merged-away id but whose company cannot see the kept row: left as they are. */
  skipped: number;
}

/**
 * In the merge's transaction: every live saved report of the tenant (both
 * kinds, every company) that names `sourceId` at an id site of `kind` now
 * names `targetId`; a list that then holds the kept id twice holds it once.
 * Each changed row gets version + 1, updatedAt and updatedBy (the merging
 * user) as an edit does, so an editor open on the old version gets 409
 * STALE_VERSION. A report whose company cannot see the kept row (the kept row
 * belongs to another company) is not changed and is counted as skipped; its
 * reference then reads as missing if the merged-away row is gone. No audit
 * row per report: the merge's audit row carries the counts.
 */
export async function repointDefinitionRefs(
  tx: Tx, tenantId: string, kind: RefKind, sourceId: string, targetId: string, userId?: string,
): Promise<RepointResult> {
  const from = sourceId.toLowerCase();
  const to = targetId.toLowerCase();
  if (from === to) return { updated: 0, skipped: 0 };
  // Text prefilter: an id can only sit inside the JSON text; the sites decide.
  const rows = await tx.select({ id: reportDefinitions.id, companyId: reportDefinitions.companyId, version: reportDefinitions.version, definitionJson: reportDefinitions.definitionJson })
    .from(reportDefinitions)
    .where(and(eq(reportDefinitions.tenantId, tenantId), isNull(reportDefinitions.deletedAt),
      sql`position(${from} in lower(${reportDefinitions.definitionJson}::text)) > 0`))
    .for('update');
  if (rows.length === 0) return { updated: 0, skipped: 0 };
  const t = TABLE[kind];
  const [target] = await tx.select({ companyId: t.companyId }).from(t).where(and(eq(t.tenantId, tenantId), eq(t.id, targetId))).limit(1);
  let updated = 0;
  let skipped = 0;
  for (const r of rows) {
    const definition = JSON.parse(JSON.stringify(r.definitionJson)) as Record<string, unknown>;
    const { sites, compact } = idSites(definition);
    const hits = sites.filter((s) => s.kind === kind && typeof s.get() === 'string' && (s.get() as string).toLowerCase() === from);
    if (hits.length === 0) continue;
    if (!target || (target.companyId !== null && target.companyId !== r.companyId)) { skipped++; continue; }
    for (const s of hits) s.set(to);
    // Lists hold an id once: a filter that already named the kept row now names it once.
    for (const s of sites) { const v = s.get(); if (s.kind === kind && typeof v === 'string' && v.toLowerCase() === to) s.set(to); }
    compact();
    await tx.update(reportDefinitions).set({
      definitionJson: definition, version: r.version + 1, updatedBy: userId ?? null, updatedAt: new Date(),
    }).where(and(eq(reportDefinitions.tenantId, tenantId), eq(reportDefinitions.id, r.id)));
    updated++;
  }
  return { updated, skipped };
}
