// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Saved report transfer (U-220, capability report-defs-transfer-v1;
 * ClientLedger A09 `.clreport`). Generic: any client can offer the same file.
 *
 * Export turns saved reports into id-free definitions: every id at an id path
 * (the paths parseDefinition accepts) becomes the token "$ref:N", and
 * `references[N]` describes what it named (kind, name, number, account type,
 * contact type, tag group, budget year) so another company can match it.
 * One reference per distinct id per report. An id that is no longer a row of
 * this company exports as {kind, missing: true} with no name. Each exported
 * report writes one audit row (action download, entity report_definition,
 * after {kind, reportKey, format: 'clreport'}; no names).
 *
 * Import preview matches the references in this company (tenant rows shared
 * or of this company, inactive rows included):
 *   - account: by number when the reference has one (one exact match); when
 *     it has none, by name (case-insensitive, trimmed). A number with no
 *     match is unresolved, with the accounts of the same name as candidates.
 *   - contact: by name and type (customer: customer or both; vendor: vendor
 *     or both; both: any).
 *   - item: by name. tag: by name and its group's name (no group = no group).
 *   - tag group: by name. budget: by name and fiscal year.
 * One match resolves; none or several leave the reference unresolved with up
 * to 20 candidates. `choices` ("<report index>:$ref:N" -> id | null) pick an
 * id (it must be a row of this company of the reference's kind, else 400
 * VALIDATION_ERROR) or leave the reference out (null). Leaving out (drop
 * rules): an id leaves its list; a builder filter whose list empties is
 * removed; a builder group-by on a tag group is removed; a standard list may
 * be left empty (no filter); a standard tagSplit becomes null; a standard
 * columnTagGroupId is removed and columns revert to 'total'; a budgetId
 * cannot be left out (it stays unresolved). When every reference is
 * resolved or left out, the definition is checked as a save would check it
 * (parseDefinition + assertRefsInScope); a failure is `ready: false` with
 * `problem {path, code}`, not an error. Preview writes nothing.
 */

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db } from '../db/index.js';
import {
  accounts, budgets, contacts, items, reportDefinitionGroups, reportDefinitions, tagGroups, tags, type ReportDefinitionKind,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLogMany } from '../middleware/audit.js';
import {
  assertRefsInScope, canEdit, definitionNotFound, groupNotFound, parseDefinition, refCode, type Viewer,
} from './report-definitions.service.js';

export type RefKind = 'account' | 'contact' | 'item' | 'tag' | 'tagGroup' | 'budget';

export interface TransferReference {
  kind: RefKind;
  name?: string;
  number?: string;
  accountType?: string;
  contactType?: 'customer' | 'vendor' | 'both';
  tagGroupName?: string | null;
  fiscalYear?: number;
  missing?: true;
}

export interface TransferReport {
  name: string;
  groupName: string | null;
  kind: ReportDefinitionKind;
  definition: Record<string, unknown>;
  references: TransferReference[];
}

/** Most reports one export or preview handles. */
export const MAX_TRANSFER_REPORTS = 200;
const MAX_CANDIDATES = 20;
const TOKEN_RE = /^\$ref:(0|[1-9]\d{0,5})$/;
const NODE_DEPTH = 16;

const isObj = (v: unknown): v is Record<string, unknown> => Object.prototype.toString.call(v) === '[object Object]';
const norm = (s: string) => s.trim().toLowerCase();

// ── Id sites ───────────────────────────────────────────────────────

/**
 * One place an id sits in a definition: a list (filters) or a scalar.
 * `drop` removes it as the drop rules say and returns the effect.
 */
interface Site {
  kind: RefKind;
  path: string;
  get(): unknown;
  set(v: string): void;
  drop(): string;
}

const BUILDER_FIELD_KIND: Record<string, RefKind> = { account: 'account', contact: 'contact', item: 'item', tag: 'tag' };
const STANDARD_LISTS: Record<string, RefKind> = { accountIds: 'account', contactIds: 'contact', tagIds: 'tag', itemIds: 'item' };

/**
 * The id sites of a raw definition (mutable views into it) and its id lists.
 * Unknown shapes are skipped: the save check refuses them later. A list site
 * is a slot object, so drops never shift another site's position; `compact`
 * writes the lists back (dropped slots out, duplicates once, as a save stores
 * them) and runs the empty-list rules.
 */
interface Sites { sites: Site[]; compact(): void }

function idSites(def: Record<string, unknown>): Sites {
  const sites: Site[] = [];
  const lists: Array<{ list: unknown[]; slots: Array<{ v: unknown; gone: boolean }>; onEmpty: () => void }> = [];
  const listSites = (list: unknown[], kind: RefKind, path: string, onEmpty: () => void, emptyEffect: string) => {
    const slots = list.map((v) => ({ v, gone: false }));
    lists.push({ list, slots, onEmpty });
    slots.forEach((slot, i) => {
      sites.push({
        kind, path: `${path}.${i}`,
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
        const filters = n['filters'];
        if (Array.isArray(filters)) {
          filters.forEach((f, fi) => {
            if (!isObj(f) || !Array.isArray(f['ids'])) return;
            const kind = BUILDER_FIELD_KIND[String(f['field'])];
            if (!kind) return;
            listSites(f['ids'] as unknown[], kind, `${np}.filters.${fi}.ids`, () => {
              const at = filters.indexOf(f);
              if (at >= 0) filters.splice(at, 1);
            }, 'filter_removed');
          });
        }
        const groupBy = n['groupBy'];
        if (Array.isArray(groupBy)) {
          groupBy.forEach((g, gi) => {
            if (!isObj(g) || g['tagGroupId'] === undefined) return;
            sites.push({
              kind: 'tagGroup', path: `${np}.groupBy.${gi}.tagGroupId`,
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
      if (Array.isArray(list)) listSites(list, kind, `definition.options.filters.${key}`, () => {}, 'removed_from_list');
    }
  }
  const split = options['tagSplit'];
  if (isObj(split) && split['tagGroupId'] !== undefined && split['tagGroupId'] !== null) {
    sites.push({
      kind: 'tagGroup', path: 'definition.options.tagSplit.tagGroupId',
      get: () => split['tagGroupId'], set: (v) => { split['tagGroupId'] = v; },
      drop: () => { options['tagSplit'] = null; return 'tag_split_removed'; },
    });
  }
  if (typeof options['columnTagGroupId'] === 'string') {
    sites.push({
      kind: 'tagGroup', path: 'definition.options.columnTagGroupId',
      get: () => options['columnTagGroupId'], set: (v) => { options['columnTagGroupId'] = v; },
      drop: () => { delete options['columnTagGroupId']; options['columns'] = 'total'; return 'columns_total'; },
    });
  }
  if (typeof options['budgetId'] === 'string') {
    sites.push({
      kind: 'budget', path: 'definition.options.budgetId',
      get: () => options['budgetId'], set: (v) => { options['budgetId'] = v; },
      drop: () => { throw new Error('a budget cannot be left out'); },
    });
  }
  return { sites, compact };
}

// ── Lookups ────────────────────────────────────────────────────────

/** Rows of this tenant, shared or of this company. */
const inCompany = (t: { tenantId: PgColumn; companyId: PgColumn }, tenantId: string, companyId: string) =>
  and(eq(t.tenantId, tenantId), or(isNull(t.companyId), eq(t.companyId, companyId)));

interface Described { id: string; ref: TransferReference; label: string }

/** The references (and candidate labels) of rows of this company, by kind and id. */
async function describeRows(tenantId: string, companyId: string, kind: RefKind, ids: string[]): Promise<Map<string, Described>> {
  const out = new Map<string, Described>();
  if (ids.length === 0) return out;
  switch (kind) {
    case 'account': {
      const rows = await db.select({ id: accounts.id, name: accounts.name, number: accounts.accountNumber, type: accounts.accountType })
        .from(accounts).where(and(inCompany(accounts, tenantId, companyId), inArray(accounts.id, ids)));
      for (const r of rows) {
        out.set(r.id, {
          id: r.id, label: r.number ? `${r.number} · ${r.name}` : r.name,
          ref: { kind, name: r.name, ...(r.number ? { number: r.number } : {}), accountType: r.type },
        });
      }
      break;
    }
    case 'contact': {
      const rows = await db.select({ id: contacts.id, name: contacts.displayName, type: contacts.contactType })
        .from(contacts).where(and(inCompany(contacts, tenantId, companyId), inArray(contacts.id, ids)));
      for (const r of rows) {
        const ct = (['customer', 'vendor', 'both'].includes(r.type) ? r.type : 'both') as 'customer' | 'vendor' | 'both';
        out.set(r.id, { id: r.id, label: `${r.name} (${ct})`, ref: { kind, name: r.name, contactType: ct } });
      }
      break;
    }
    case 'item': {
      const rows = await db.select({ id: items.id, name: items.name }).from(items)
        .where(and(inCompany(items, tenantId, companyId), inArray(items.id, ids)));
      for (const r of rows) out.set(r.id, { id: r.id, label: r.name, ref: { kind, name: r.name } });
      break;
    }
    case 'tag': {
      const rows = await db.select({ id: tags.id, name: tags.name, groupName: tagGroups.name }).from(tags)
        .leftJoin(tagGroups, and(eq(tagGroups.id, tags.groupId), eq(tagGroups.tenantId, tenantId)))
        .where(and(inCompany(tags, tenantId, companyId), inArray(tags.id, ids)));
      for (const r of rows) {
        out.set(r.id, { id: r.id, label: r.groupName ? `${r.groupName}: ${r.name}` : r.name, ref: { kind, name: r.name, tagGroupName: r.groupName ?? null } });
      }
      break;
    }
    case 'tagGroup': {
      const rows = await db.select({ id: tagGroups.id, name: tagGroups.name }).from(tagGroups)
        .where(and(inCompany(tagGroups, tenantId, companyId), inArray(tagGroups.id, ids)));
      for (const r of rows) out.set(r.id, { id: r.id, label: r.name, ref: { kind, name: r.name } });
      break;
    }
    case 'budget': {
      const rows = await db.select({ id: budgets.id, name: budgets.name, fy: budgets.fiscalYear }).from(budgets)
        .where(and(inCompany(budgets, tenantId, companyId), inArray(budgets.id, ids)));
      for (const r of rows) out.set(r.id, { id: r.id, label: `${r.name} (${r.fy})`, ref: { kind, name: r.name, fiscalYear: r.fy } });
      break;
    }
  }
  return out;
}

/** Rows of this company matching a reference: ids, best first (at most MAX_CANDIDATES + 1, to tell one from many). */
async function matches(tenantId: string, companyId: string, ref: TransferReference): Promise<{ exact: string[]; byName: string[] }> {
  const name = ref.name?.trim();
  if (ref.missing || !name) return { exact: [], byName: [] };
  const lim = MAX_CANDIDATES + 1;
  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
  switch (ref.kind) {
    case 'account': {
      const byName = ids(await db.select({ id: accounts.id }).from(accounts)
        .where(and(inCompany(accounts, tenantId, companyId), sql`lower(trim(${accounts.name})) = ${norm(name)}`))
        .orderBy(accounts.accountNumber, accounts.id).limit(lim));
      if (ref.number && ref.number.trim()) {
        const exact = ids(await db.select({ id: accounts.id }).from(accounts)
          .where(and(inCompany(accounts, tenantId, companyId), eq(accounts.accountNumber, ref.number.trim()))).limit(lim));
        return { exact, byName };
      }
      return { exact: byName, byName };
    }
    case 'contact': {
      const types = ref.contactType === 'customer' ? ['customer', 'both'] : ref.contactType === 'vendor' ? ['vendor', 'both'] : null;
      const exact = ids(await db.select({ id: contacts.id }).from(contacts)
        .where(and(inCompany(contacts, tenantId, companyId), sql`lower(trim(${contacts.displayName})) = ${norm(name)}`,
          types ? inArray(contacts.contactType, types) : sql`TRUE`))
        .orderBy(contacts.displayName, contacts.id).limit(lim));
      return { exact, byName: exact };
    }
    case 'item': {
      const exact = ids(await db.select({ id: items.id }).from(items)
        .where(and(inCompany(items, tenantId, companyId), sql`lower(trim(${items.name})) = ${norm(name)}`)).orderBy(items.id).limit(lim));
      return { exact, byName: exact };
    }
    case 'tag': {
      const group = ref.tagGroupName?.trim();
      const exact = ids(await db.select({ id: tags.id }).from(tags)
        .leftJoin(tagGroups, and(eq(tagGroups.id, tags.groupId), eq(tagGroups.tenantId, tenantId)))
        .where(and(inCompany(tags, tenantId, companyId), sql`lower(trim(${tags.name})) = ${norm(name)}`,
          group ? sql`lower(trim(${tagGroups.name})) = ${norm(group)}` : isNull(tags.groupId)))
        .orderBy(tags.id).limit(lim));
      return { exact, byName: exact };
    }
    case 'tagGroup': {
      const exact = ids(await db.select({ id: tagGroups.id }).from(tagGroups)
        .where(and(inCompany(tagGroups, tenantId, companyId), sql`lower(trim(${tagGroups.name})) = ${norm(name)}`)).orderBy(tagGroups.id).limit(lim));
      return { exact, byName: exact };
    }
    case 'budget': {
      const exact = ids(await db.select({ id: budgets.id }).from(budgets)
        .where(and(inCompany(budgets, tenantId, companyId), sql`lower(trim(${budgets.name})) = ${norm(name)}`,
          ref.fiscalYear !== undefined ? eq(budgets.fiscalYear, ref.fiscalYear) : sql`TRUE`))
        .orderBy(budgets.id).limit(lim));
      return { exact, byName: exact };
    }
  }
}

// ── Export ─────────────────────────────────────────────────────────

export async function exportDefinitions(tenantId: string, companyId: string, userId: string | undefined, input: { ids: string[] } | { groupId: string }): Promise<{ reports: TransferReport[] }> {
  const live = and(eq(reportDefinitions.tenantId, tenantId), eq(reportDefinitions.companyId, companyId), isNull(reportDefinitions.deletedAt));
  let rows: Array<typeof reportDefinitions.$inferSelect>;
  if ('groupId' in input) {
    const [g] = await db.select({ id: reportDefinitionGroups.id }).from(reportDefinitionGroups)
      .where(and(eq(reportDefinitionGroups.tenantId, tenantId), eq(reportDefinitionGroups.companyId, companyId),
        isNull(reportDefinitionGroups.deletedAt), eq(reportDefinitionGroups.id, input.groupId))).limit(1);
    if (!g) throw groupNotFound();
    rows = await db.select().from(reportDefinitions).where(and(live, eq(reportDefinitions.groupId, input.groupId)))
      .orderBy(sql`lower(${reportDefinitions.name})`, reportDefinitions.id).limit(MAX_TRANSFER_REPORTS + 1);
    if (rows.length > MAX_TRANSFER_REPORTS) {
      throw AppError.badRequest(`A file holds at most ${MAX_TRANSFER_REPORTS} reports; this group has more.`, 'VALIDATION_ERROR', { field: 'groupId', limit: MAX_TRANSFER_REPORTS });
    }
  } else {
    const want = [...new Set(input.ids.map((x) => x.toLowerCase()))];
    const found = await db.select().from(reportDefinitions).where(and(live, inArray(reportDefinitions.id, want)));
    if (found.length !== want.length) throw definitionNotFound();
    const by = new Map(found.map((r) => [r.id, r]));
    rows = want.map((id) => by.get(id)!);
  }

  const groupIds = [...new Set(rows.map((r) => r.groupId).filter((x): x is string => !!x))];
  const groupNames = new Map<string, string>();
  if (groupIds.length) {
    for (const g of await db.select({ id: reportDefinitionGroups.id, name: reportDefinitionGroups.name }).from(reportDefinitionGroups)
      .where(and(eq(reportDefinitionGroups.tenantId, tenantId), inArray(reportDefinitionGroups.id, groupIds), isNull(reportDefinitionGroups.deletedAt)))) {
      groupNames.set(g.id, g.name);
    }
  }

  // Describe every id of every report in one query per kind.
  const prepared = rows.map((r) => {
    const definition = JSON.parse(JSON.stringify(r.definitionJson)) as Record<string, unknown>;
    const { sites, compact } = idSites(definition);
    return { r, definition, sites, compact };
  });
  const byKind = new Map<RefKind, Set<string>>();
  for (const p of prepared) {
    for (const s of p.sites) {
      const v = s.get();
      if (typeof v === 'string') { const set = byKind.get(s.kind) ?? new Set(); set.add(v.toLowerCase()); byKind.set(s.kind, set); }
    }
  }
  const described = new Map<string, Described>();
  for (const [kind, ids] of byKind) {
    for (const [id, d] of await describeRows(tenantId, companyId, kind, [...ids])) described.set(`${kind}:${id}`, d);
  }

  const reports: TransferReport[] = prepared.map(({ r, definition, sites, compact }) => {
    const references: TransferReference[] = [];
    const index = new Map<string, number>();
    for (const s of sites) {
      const v = s.get();
      if (typeof v !== 'string') continue;
      const key = `${s.kind}:${v.toLowerCase()}`;
      let n = index.get(key);
      if (n === undefined) {
        n = references.length;
        index.set(key, n);
        references.push(described.get(key)?.ref ?? { kind: s.kind, missing: true });
      }
      s.set(`$ref:${n}`);
    }
    compact();
    return { name: r.name, groupName: r.groupId ? groupNames.get(r.groupId) ?? null : null, kind: r.kind, definition, references };
  });

  if (rows.length > 0) {
    await auditLogMany(tenantId, rows.map((r) => ({
      action: 'download' as const, entityType: 'report_definition', entityId: r.id, before: null,
      after: { kind: r.kind, reportKey: (r.definitionJson as { reportKey?: unknown }).reportKey ?? null, format: 'clreport' },
    })), userId);
  }
  return { reports };
}

// ── Import preview ─────────────────────────────────────────────────

export interface PreviewInput {
  reports: Array<{ name: string; groupName?: string | null; kind: ReportDefinitionKind; definition: unknown; references: TransferReference[] }>;
  choices?: Record<string, string | null>;
}

export interface PreviewReport {
  name: string;
  kind: ReportDefinitionKind;
  ready: boolean;
  definition: unknown;
  unresolved: Array<{ ref: string; reference: TransferReference; candidates: Array<{ id: string; label: string }> }>;
  dropped: Array<{ ref: string; effect: string }>;
  groupId: string | null;
  nameTaken: { id: string; version: number; kind: ReportDefinitionKind; canEdit: boolean } | null;
  problem?: { path: string; code: string };
}

function fileInvalid(message: string, path: string, code?: string): AppError {
  return AppError.badRequest(message, 'DEFINITION_INVALID', code ? { path, code } : { path });
}

const KIND_TABLE: Record<RefKind, string> = { account: 'accounts', contact: 'contacts', item: 'items', tag: 'tags', tagGroup: 'tagGroups', budget: 'budgets' };

export async function previewImport(tenantId: string, companyId: string, viewer: Viewer, input: PreviewInput): Promise<{ reports: PreviewReport[] }> {
  const choices = input.choices ?? {};
  // Shape checks first (whole request): newer schema, kind, tokens.
  const work = input.reports.map((rep, i) => {
    const base = `reports.${i}.definition`;
    if (!isObj(rep.definition)) throw fileInvalid('A report in the file has no definition.', base);
    const sv = rep.definition['schemaVersion'];
    if (typeof sv === 'number' && Number.isInteger(sv) && sv > 1) {
      throw fileInvalid('This report was saved by a newer version. Update to open it.', `${base}.schemaVersion`, 'SCHEMA_NEWER');
    }
    if (rep.definition['kind'] !== rep.kind) throw fileInvalid('kind must match definition.kind.', `reports.${i}.kind`);
    const definition = JSON.parse(JSON.stringify(rep.definition)) as Record<string, unknown>;
    const { sites, compact } = idSites(definition);
    const at = sites.map((s) => {
      const v = s.get();
      const m = typeof v === 'string' ? TOKEN_RE.exec(v) : null;
      if (!m) throw fileInvalid('A report file names things only by reference ("$ref:N").', s.path.replace(/^definition/, base));
      const n = Number(m[1]);
      if (n >= rep.references.length) throw fileInvalid(`$ref:${n} has no reference.`, s.path.replace(/^definition/, base));
      return { site: s, n };
    });
    return { rep, i, definition, at, compact };
  });
  // Choices: well formed, of a report and reference that exist, ids in scope and of the reference's kind.
  const chosenIds = new Map<RefKind, Set<string>>();
  for (const [key, id] of Object.entries(choices)) {
    const m = /^(\d+):\$ref:(\d+)$/.exec(key);
    const w = m ? work[Number(m[1])] : undefined;
    const ref = w && m ? w.rep.references[Number(m[2])] : undefined;
    if (!m || !w || !ref) throw AppError.badRequest('A choice names a reference that is not in the file.', 'VALIDATION_ERROR', { field: 'choices', key });
    if (id === null) continue;
    const s = chosenIds.get(ref.kind) ?? new Set<string>();
    s.add(id.toLowerCase());
    chosenIds.set(ref.kind, s);
  }
  const chosenOk = new Map<string, Described>();
  for (const [kind, ids] of chosenIds) {
    const d = await describeRows(tenantId, companyId, kind, [...ids]);
    for (const id of ids) {
      if (!d.has(id)) throw AppError.badRequest('A chosen row is not in this company.', 'VALIDATION_ERROR', { field: 'choices', kind: KIND_TABLE[kind] });
      chosenOk.set(`${kind}:${id}`, d.get(id)!);
    }
  }

  // Match every reference once per report.
  const groupsByName = new Map<string, string>();
  for (const g of await db.select({ id: reportDefinitionGroups.id, name: reportDefinitionGroups.name }).from(reportDefinitionGroups)
    .where(and(eq(reportDefinitionGroups.tenantId, tenantId), eq(reportDefinitionGroups.companyId, companyId), isNull(reportDefinitionGroups.deletedAt)))) {
    groupsByName.set(g.name.toLowerCase(), g.id);
  }

  const out: PreviewReport[] = [];
  for (const { rep, i, definition, at, compact } of work) {
    const resolved = new Map<number, string | null>();
    const unresolved: PreviewReport['unresolved'] = [];
    const used = [...new Set(at.map((x) => x.n))].sort((a, b) => a - b);
    for (const n of used) {
      const ref = rep.references[n]!;
      const key = `${i}:$ref:${n}`;
      // A budget asked to be left out stays unresolved (it can't be): the owner picks one or cancels.
      const keepOpen = key in choices && choices[key] === null && ref.kind === 'budget';
      if (key in choices && !keepOpen) {
        const id = choices[key];
        resolved.set(n, id === null ? null : id!.toLowerCase());
        continue;
      }
      const { exact, byName } = await matches(tenantId, companyId, ref);
      if (exact.length === 1 && !keepOpen) { resolved.set(n, exact[0]!); continue; }
      const cand = (exact.length > 1 ? exact : byName).slice(0, MAX_CANDIDATES);
      const labels = await describeRows(tenantId, companyId, ref.kind, cand);
      unresolved.push({ ref: `$ref:${n}`, reference: ref, candidates: cand.filter((id) => labels.has(id)).map((id) => ({ id, label: labels.get(id)!.label })) });
    }
    // Substitute, then drop (drops change list positions, so they go last).
    const dropped: PreviewReport['dropped'] = [];
    const drops: Array<{ site: Site; n: number }> = [];
    for (const { site, n } of at) {
      if (!resolved.has(n)) continue;
      const id = resolved.get(n)!;
      if (id === null) drops.push({ site, n }); else site.set(id);
    }
    for (const { site, n } of drops) dropped.push({ ref: `$ref:${n}`, effect: site.drop() });
    // Lists: dropped slots out, an id twice once (as a save stores it), emptied builder filters removed.
    compact();
    const ready = unresolved.length === 0;
    let problem: PreviewReport['problem'];
    let finalDef: unknown = definition;
    if (ready) {
      try {
        const parsed = parseDefinition(definition);
        await db.transaction(async (tx) => { await assertRefsInScope(tx, tenantId, companyId, parsed.refs, refCode(parsed.definition)); });
        finalDef = parsed.definition;
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        const d = (err.details ?? {}) as { path?: string; code?: string };
        problem = { path: d.path ?? 'definition', code: d.code ?? err.code ?? 'DEFINITION_INVALID' };
      }
    }
    const [taken] = await db.select().from(reportDefinitions)
      .where(and(eq(reportDefinitions.tenantId, tenantId), eq(reportDefinitions.companyId, companyId), isNull(reportDefinitions.deletedAt),
        sql`lower(${reportDefinitions.name}) = ${rep.name.toLowerCase()}`)).limit(1);
    out.push({
      name: rep.name, kind: rep.kind, ready: ready && !problem, definition: finalDef, unresolved, dropped,
      groupId: rep.groupName ? groupsByName.get(rep.groupName.toLowerCase()) ?? null : null,
      nameTaken: taken ? { id: taken.id, version: taken.version, kind: taken.kind, canEdit: canEdit(taken, viewer) } : null,
      ...(problem ? { problem } : {}),
    });
  }
  return { reports: out };
}
