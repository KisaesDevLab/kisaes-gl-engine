// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Saved report transfer (U-220, report-defs-transfer-v1; ClientLedger A09
// `.clreport`):
//   - export: ids at id paths become "$ref:N" with references (no uuid in
//     the response), one download audit row per report, group export, 404s;
//   - import preview: same-company round trip is identical; another tenant
//     remaps by number / name / type / group; several matches are
//     candidates; choices pick or leave out (drop rules per path; a budget
//     can't be left out); a newer schemaVersion is SCHEMA_NEWER; choices of
//     another company or tenant are refused; preview writes nothing;
//   - create / update take origin: 'import' (in the audit row).

import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, auditLog, budgets, contacts, reportDefinitionGroups, reportDefinitions, tagGroups, tags } from '../db/schema/index.js';
import { reportBuilderRouter } from './report-builder.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { makeCompany, cleanTenant, suffix, type Co } from '../services/templates/templates.test-helpers.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { BUILDER_STARTERS, type BuilderDefinition } from '@kis-books/shared';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
let a: Co;
let b: Co;
let tgA = '';
let tgB = '';
let budgetA = '';
let budgetB = '';
let tagA2 = '';

interface Res { status: number; json: ReturnType<typeof JSON.parse> }

function call(co: Co, method: string, path: string, body?: unknown, companyId = co.companyId): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: `/api/v1/report-builder${path}`, method,
      headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${co.token}`, 'X-Company-Id': companyId,
        ...(data ? { 'Content-Length': String(data.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (x) => chunks.push(x));
      res.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function standardDef(co: Co, tg: string, budget: string) {
  return {
    schemaVersion: 1, kind: 'standard', reportKey: 'budget_vs_actual',
    options: {
      dateRange: { preset: 'this_year' }, columns: 'tag_group', columnTagGroupId: tg, tagSplit: { tagGroupId: tg }, budgetId: budget,
      filters: { accountIds: [co.bank, co.expense], contactIds: [co.vendor, co.customer], tagIds: [co.tag] },
    },
  };
}

function builderDef(co: Co, tg: string): BuilderDefinition {
  const d = clone(BUILDER_STARTERS.find((s) => s.key === 'profit_loss')!.definition);
  const exp = d.nodes.find((n) => n.type === 'section' && n.id === 'expenses');
  if (!exp || exp.type !== 'section') throw new Error('starter');
  exp.filters.push({ field: 'account', op: 'in', ids: [co.expense, co.expense2] }, { field: 'tag', op: 'in', ids: [co.tag] });
  exp.groupBy = [{ key: 'account' }, { key: 'tag', tagGroupId: tg }];
  return d;
}

async function save(co: Co, name: string, definition: unknown, groupId?: string) {
  const r = await call(co, 'POST', '/definitions', { name, definition, ...(groupId ? { groupId } : {}) });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json as { id: string; definition: unknown; version: number };
}

async function exportIds(co: Co, ids: string[]) {
  const r = await call(co, 'POST', '/definitions/export', { ids });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json as { reports: Array<{ name: string; groupName: string | null; kind: string; definition: Record<string, unknown>; references: Array<Record<string, unknown>> }> };
}

async function preview(co: Co, reports: unknown[], choices?: Record<string, string | null>) {
  return call(co, 'POST', '/definitions/import/preview', { reports, ...(choices ? { choices } : {}) });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/v1/report-builder', reportBuilderRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
  const s = suffix().slice(-4);
  a = await makeCompany(`rta${s}`, tenantIds);
  b = await makeCompany(`rtb${s}`, tenantIds);
  // Same names in both tenants: the tag group, the tag (by its group), the budget.
  for (const co of [a, b]) {
    const [tg] = await db.insert(tagGroups).values({ tenantId: co.tenantId, name: 'Crews' }).returning();
    await db.update(tags).set({ name: 'North crew', groupId: tg!.id }).where(eq(tags.id, co.tag));
    const [bu] = await db.insert(budgets).values({ tenantId: co.tenantId, companyId: co.companyId, name: 'Plan', fiscalYear: 2026 }).returning();
    if (co === a) { tgA = tg!.id; budgetA = bu!.id; } else { tgB = tg!.id; budgetB = bu!.id; }
  }
  const [t2] = await db.insert(tags).values({ tenantId: a.tenantId, name: 'South crew', groupId: tgA }).returning();
  tagA2 = t2!.id;
}, 60_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

describe('report-defs-transfer-v1 (U-220)', () => {
  it('is advertised', () => {
    expect(DESKTOP_CAPABILITIES).toContain('report-defs-transfer-v1');
  });

  it('export: tokens and references, no uuid anywhere, one download audit row per report', async () => {
    const [g] = await db.insert(reportDefinitionGroups).values({ tenantId: a.tenantId, companyId: a.companyId, name: `For the bank ${suffix()}` }).returning();
    const std = await save(a, `Budget ${suffix()}`, standardDef(a, tgA, budgetA), g!.id);
    const bld = await save(a, `Builder ${suffix()}`, builderDef(a, tgA));
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(auditLog)
      .where(and(eq(auditLog.tenantId, a.tenantId), eq(auditLog.action, 'download'), eq(auditLog.entityType, 'report_definition')));
    const out = await exportIds(a, [std.id, bld.id]);
    expect(JSON.stringify(out)).not.toMatch(UUID);
    expect(out.reports.map((r) => r.kind)).toEqual(['standard', 'builder']);
    expect(out.reports[0]!.groupName).toBe(g!.name);
    expect(out.reports[1]!.groupName).toBeNull();
    const s = out.reports[0]!;
    const opts = s.definition['options'] as { filters: { accountIds: string[] }; tagSplit: { tagGroupId: string }; columnTagGroupId: string };
    // One reference per distinct id: the tag group appears twice and is one ref.
    expect(opts.columnTagGroupId).toBe(opts.tagSplit.tagGroupId);
    expect(opts.filters.accountIds).toEqual(['$ref:0', '$ref:1']);
    const kinds = s.references.map((r) => r['kind']);
    expect(kinds.filter((k) => k === 'tagGroup')).toHaveLength(1);
    expect(s.references.find((r) => r['kind'] === 'budget')).toEqual({ kind: 'budget', name: 'Plan', fiscalYear: 2026 });
    expect(s.references.find((r) => r['kind'] === 'tag')).toEqual({ kind: 'tag', name: 'North crew', tagGroupName: 'Crews' });
    expect(s.references.find((r) => r['kind'] === 'contact' && r['contactType'] === 'vendor')).toEqual({ kind: 'contact', name: 'Cosmos Granite', contactType: 'vendor' });
    const acct = s.references[0]!;
    expect(acct['kind']).toBe('account');
    expect(typeof acct['name']).toBe('string');
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(auditLog)
      .where(and(eq(auditLog.tenantId, a.tenantId), eq(auditLog.action, 'download'), eq(auditLog.entityType, 'report_definition')));
    expect(after[0]!.n - before[0]!.n).toBe(2);
    const [row] = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, a.tenantId), eq(auditLog.action, 'download'), eq(auditLog.entityId, std.id)));
    expect(row!.afterData).toEqual({ kind: 'standard', reportKey: 'budget_vs_actual', format: 'clreport' });

    // Group export, and 404s.
    const gr = await call(a, 'POST', '/definitions/export', { groupId: g!.id });
    expect(gr.status).toBe(200);
    expect(gr.json.reports.map((r: { name: string }) => r.name)).toEqual([s.name]);
    expect((await call(a, 'POST', '/definitions/export', { ids: [std.id, b.tag] })).status).toBe(404);
    expect((await call(a, 'POST', '/definitions/export', { groupId: b.tag })).status).toBe(404);
    expect((await call(b, 'POST', '/definitions/export', { ids: [std.id] })).status).toBe(404);
  });

  it('same company: preview gives back the saved definitions, ready, matched by group name; writes nothing', async () => {
    const [g] = await db.insert(reportDefinitionGroups).values({ tenantId: a.tenantId, companyId: a.companyId, name: `Monthly ${suffix()}` }).returning();
    const std = await save(a, `Round ${suffix()}`, standardDef(a, tgA, budgetA), g!.id);
    const bld = await save(a, `Round B ${suffix()}`, builderDef(a, tgA));
    const out = await exportIds(a, [std.id, bld.id]);
    const count = async () => ({
      defs: (await db.select({ n: sql<number>`count(*)::int` }).from(reportDefinitions).where(eq(reportDefinitions.tenantId, a.tenantId)))[0]!.n,
      audit: (await db.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(eq(auditLog.tenantId, a.tenantId)))[0]!.n,
    });
    const before = await count();
    const p = await preview(a, out.reports);
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(await count()).toEqual(before);
    const [ps, pb] = p.json.reports;
    expect(ps.ready).toBe(true);
    expect(ps.unresolved).toEqual([]);
    expect(ps.definition).toEqual(std.definition);
    expect(ps.groupId).toBe(g!.id);
    expect(ps.nameTaken).toEqual({ id: std.id, version: std.version, kind: 'standard', canEdit: true });
    expect(pb.ready).toBe(true);
    expect(pb.definition).toEqual(bld.definition);
    expect(pb.groupId).toBeNull();
  });

  it('another tenant: remapped by number, name and type, tag by group; a choice resolves the rest', async () => {
    const std = await save(a, `Remap ${suffix()}`, standardDef(a, tgA, budgetA));
    const bld = await save(a, `Remap B ${suffix()}`, builderDef(a, tgA));
    const out = await exportIds(a, [std.id, bld.id]);
    const p = await preview(b, out.reports);
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    const [ps, pb] = p.json.reports;
    expect(ps.unresolved).toEqual([]);
    expect(ps.ready, JSON.stringify(ps.problem)).toBe(true);
    expect(ps.definition.options.filters).toEqual({ accountIds: [b.bank, b.expense], contactIds: [b.vendor, b.customer], tagIds: [b.tag] });
    expect(ps.definition.options.columnTagGroupId).toBe(tgB);
    expect(ps.definition.options.budgetId).toBe(budgetB);
    expect(pb.ready).toBe(true);
    expect(JSON.stringify(pb.definition)).toBe(JSON.stringify(builderDef(b, tgB)));
    // Nothing of tenant a crosses over.
    for (const id of [a.bank, a.expense, a.vendor, a.tag, tgA, budgetA]) expect(JSON.stringify(p.json)).not.toContain(id);
  });

  it('several matches are candidates; choices pick one or leave it out', async () => {
    const std = await save(a, `Amb ${suffix()}`, { schemaVersion: 1, kind: 'standard', reportKey: 'expense_by_vendor', options: { filters: { contactIds: [a.vendor] } } });
    const out = await exportIds(a, [std.id]);
    const [v2] = await db.insert(contacts).values({ tenantId: b.tenantId, contactType: 'both', displayName: 'Cosmos Granite' }).returning();
    try {
      const p = await preview(b, out.reports);
      const r = p.json.reports[0];
      expect(r.ready).toBe(false);
      expect(r.unresolved).toHaveLength(1);
      expect(r.unresolved[0].ref).toBe('$ref:0');
      expect(r.unresolved[0].reference).toEqual({ kind: 'contact', name: 'Cosmos Granite', contactType: 'vendor' });
      expect(r.unresolved[0].candidates.map((x: { id: string }) => x.id).sort()).toEqual([b.vendor, v2!.id].sort());
      const picked = await preview(b, out.reports, { '0:$ref:0': v2!.id });
      expect(picked.json.reports[0].ready).toBe(true);
      expect(picked.json.reports[0].definition.options.filters.contactIds).toEqual([v2!.id]);
      const left = await preview(b, out.reports, { '0:$ref:0': null });
      expect(left.json.reports[0].ready).toBe(true);
      expect(left.json.reports[0].dropped).toEqual([{ ref: '$ref:0', effect: 'removed_from_list' }]);
      expect(left.json.reports[0].definition.options.filters.contactIds).toEqual([]);
    } finally {
      await db.delete(contacts).where(eq(contacts.id, v2!.id));
    }
  });

  it('drop rules per path; a budget cannot be left out', async () => {
    const std = await save(a, `Drop ${suffix()}`, standardDef(a, tgA, budgetA));
    const bld = await save(a, `Drop B ${suffix()}`, builderDef(a, tgA));
    const out = await exportIds(a, [std.id, bld.id]);
    const refOf = (i: number, pred: (r: Record<string, unknown>) => boolean) => `${i}:$ref:${out.reports[i]!.references.findIndex(pred)}`;
    const choices: Record<string, null> = {
      [refOf(0, (r) => r['kind'] === 'tagGroup')]: null,
      [refOf(0, (r) => r['kind'] === 'budget')]: null,
      [refOf(1, (r) => r['kind'] === 'tagGroup')]: null,
      [refOf(1, (r) => r['kind'] === 'tag')]: null,
    };
    const p = await preview(a, out.reports, choices);
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    const [ps, pb] = p.json.reports;
    // Standard: tagSplit null, columns back to total, the budget stays unresolved.
    expect(ps.dropped.map((d: { effect: string }) => d.effect).sort()).toEqual(['columns_total', 'tag_split_removed']);
    expect(ps.definition.options.tagSplit).toBeNull();
    expect(ps.definition.options.columns).toBe('total');
    expect(ps.definition.options.columnTagGroupId).toBeUndefined();
    expect(ps.ready).toBe(false);
    expect(ps.unresolved.map((u: { reference: { kind: string } }) => u.reference.kind)).toEqual(['budget']);
    // Builder: the tag filter (its only id) is removed; the tag group-by is removed.
    expect(pb.dropped.map((d: { effect: string }) => d.effect).sort()).toEqual(['filter_removed', 'group_by_removed']);
    expect(pb.ready).toBe(true);
    const exp = pb.definition.nodes.find((n: { id: string }) => n.id === 'expenses');
    expect(exp.filters.map((f: { field: string }) => f.field)).toEqual(['account_type', 'account']);
    expect(exp.groupBy).toEqual([{ key: 'account' }]);
  });

  it('a newer schemaVersion is SCHEMA_NEWER; tokens are required at id paths', async () => {
    const std = await save(a, `Newer ${suffix()}`, standardDef(a, tgA, budgetA));
    const out = await exportIds(a, [std.id]);
    const newer = clone(out.reports);
    newer[0]!.definition['schemaVersion'] = 2;
    const r = await preview(a, newer);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('DEFINITION_INVALID');
    expect(r.json.error.details).toEqual({ path: 'reports.0.definition.schemaVersion', code: 'SCHEMA_NEWER' });
    const raw = clone(out.reports);
    (raw[0]!.definition['options'] as { filters: { accountIds: string[] } }).filters.accountIds = [a.bank];
    const r2 = await preview(a, raw);
    expect(r2.status).toBe(400);
    expect(r2.json.error.details.path).toBe('reports.0.definition.options.filters.accountIds.0');
  });

  it('choices of another company or tenant are refused; a deleted row exports as missing', async () => {
    const std = await save(a, `Scope ${suffix()}`, { schemaVersion: 1, kind: 'standard', reportKey: 'profit_and_loss', options: { filters: { accountIds: [a.expense2], tagIds: [tagA2] } } });
    const out = await exportIds(a, [std.id]);
    const [other] = await db.insert(accounts).values({ tenantId: a.tenantId, companyId: a.companyB, name: `Other co ${suffix()}`, accountType: 'expense' }).returning();
    for (const id of [other!.id, b.expense]) {
      const r = await preview(a, out.reports, { '0:$ref:0': id });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(r.json)).not.toContain('Other co');
    }
    expect((await preview(a, out.reports, { '5:$ref:0': null })).status).toBe(400);
    // Move the tag to the other company: it is no longer this company's, so it exports with no name.
    await db.update(tags).set({ companyId: a.companyB }).where(eq(tags.id, tagA2));
    try {
      const again = await exportIds(a, [std.id]);
      expect(again.reports[0]!.references[1]).toEqual({ kind: 'tag', missing: true });
      const p = await preview(a, again.reports);
      expect(p.json.reports[0].unresolved).toEqual([{ ref: '$ref:1', reference: { kind: 'tag', missing: true }, candidates: [] }]);
    } finally {
      await db.update(tags).set({ companyId: null }).where(eq(tags.id, tagA2));
    }
  });

  it("create and update take origin 'import' (in the audit row)", async () => {
    const name = `Imported ${suffix()}`;
    const r = await call(a, 'POST', '/definitions', { name, origin: 'import', definition: { schemaVersion: 1, kind: 'standard', reportKey: 'profit_and_loss', options: {} } });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.origin).toBeUndefined();
    const [c1] = await db.select().from(auditLog).where(and(eq(auditLog.entityId, r.json.id), eq(auditLog.action, 'create')));
    expect((c1!.afterData as Record<string, unknown>)['origin']).toBe('import');
    const u = await call(a, 'PUT', `/definitions/${r.json.id}`, { version: r.json.version, origin: 'import', definition: { schemaVersion: 1, kind: 'standard', reportKey: 'profit_and_loss', options: { basis: 'cash' } } });
    expect(u.status, JSON.stringify(u.json)).toBe(200);
    const [u1] = await db.select().from(auditLog).where(and(eq(auditLog.entityId, r.json.id), eq(auditLog.action, 'update')));
    expect((u1!.afterData as Record<string, unknown>)['origin']).toBe('import');
    // Without origin, nothing is added.
    const plain = await save(a, `Plain ${suffix()}`, { schemaVersion: 1, kind: 'standard', reportKey: 'profit_and_loss', options: {} });
    const [p1] = await db.select().from(auditLog).where(and(eq(auditLog.entityId, plain.id), eq(auditLog.action, 'create')));
    expect((p1!.afterData as Record<string, unknown>)['origin']).toBeUndefined();
    expect((await call(a, 'POST', '/definitions', { name: `Bad ${suffix()}`, origin: 'paste', definition: { schemaVersion: 1, kind: 'standard', reportKey: 'profit_and_loss', options: {} } })).status).toBe(400);
  });
});
