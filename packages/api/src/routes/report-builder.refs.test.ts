// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Saved reports and list maintenance (U-226, report-refs-v1; ClientLedger
// PR-A2 finding 5-B1, Q-PRA2b / Q-PRA2c):
//   - merging a contact or a tag (through the merge routes) rewrites every
//     saved report of the tenant that named the merged-away row to the kept
//     one, in the merge's transaction: builder and standard, every company
//     that can see both rows, a list holding the kept row twice holds it once,
//     version + 1; the merge's audit row counts them. The review's figure
//     (4,250.00) stays 4,250.00, saved and inline. Another company's report on
//     other rows, another tenant's, and a report whose company cannot see the
//     kept row keep their version.
//   - a saved report naming a deleted tag group or an unused deleted tag is
//     refused on run and drill (422 REPORT_REFERENCE_MISSING {path, nodeId,
//     field, kind, ids, missing}), and GET lists it in `missing` (builder and
//     standard); an inline run keeps 400 NOT_IN_COMPANY; a deactivated contact
//     still runs.

import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditLog, contacts, reportDefinitions, tagGroups, tags } from '../db/schema/index.js';
import { reportBuilderRouter } from './report-builder.routes.js';
import { contactsRouter } from './contacts.routes.js';
import { tagsRouter } from './tags.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as ledger from '../services/ledger.service.js';
import { fingerprintOf } from '../services/report-builder/request.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { makeCompany, cleanTenant, suffix, type Co } from '../services/templates/templates.test-helpers.js';
import { BUILDER_STARTERS, type BuilderDefinition, type RbSectionNode } from '@kis-books/shared';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
let c: Co;

interface Res { status: number; json: ReturnType<typeof JSON.parse> }

function call(method: string, path: string, body?: unknown, opts: { co?: string; token?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: `/api/v1${path}`, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.token ?? c.token}`,
        'X-Company-Id': opts.co ?? c.companyId,
        ...(data ? { 'Content-Length': String(data.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (x) => chunks.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); } catch { resolve({ status: res.statusCode ?? 0, json: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const RANGE = { dates: { from: '2026-01-01', to: '2026-12-31' }, fiscalYearStarts: ['2026-01-01'] };

/** Revenue (the starter) with extra filters / group-bys on its one section. */
function revenue(extra: { filters?: RbSectionNode['filters']; groupBy?: RbSectionNode['groupBy'] } = {}): BuilderDefinition {
  const d = JSON.parse(JSON.stringify(BUILDER_STARTERS.find((s) => s.key === 'revenue_by_category')!.definition)) as BuilderDefinition;
  const s = d.nodes[0] as RbSectionNode;
  s.filters.push(...(extra.filters ?? []));
  if (extra.groupBy) s.groupBy = extra.groupBy;
  return d;
}

const std = (options: Record<string, unknown>) => ({ schemaVersion: 1, kind: 'standard', reportKey: 'profit_and_loss', options });

async function save(name: string, definition: unknown, co?: string, token?: string) {
  const r = await call('POST', '/report-builder/definitions', { name, definition }, { co, token });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json as { id: string; version: number; definition: unknown };
}

const get = async (id: string, co?: string, token?: string) => (await call('GET', `/report-builder/definitions/${id}`, undefined, { co, token })).json;

/** The section Total of a run, as a number (the report's one figure). */
function totalOf(json: { rows: Array<{ kind: string; nodeId: string; cells: Array<string | null> }> }, nodeId = 'revenue'): number {
  const row = json.rows.find((r) => r.kind === 'total' && r.nodeId === nodeId);
  const cell = row?.cells.find((x) => x !== null && /^-?\d+(\.\d+)?$/.test(x));
  return cell === undefined ? 0 : Number(cell);
}

async function runSaved(id: string, version: number) {
  return call('POST', '/report-builder/run', { definitionId: id, version, ...RANGE });
}

async function runInline(definition: unknown) {
  return call('POST', '/report-builder/run', { definition, ...RANGE });
}

async function mergeAudit(entityType: string, entityId: string) {
  const [row] = await db.select().from(auditLog)
    .where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, entityType), eq(auditLog.entityId, entityId)));
  const after = row?.afterData;
  return (typeof after === 'string' ? JSON.parse(after) : after) as { merged_into: string; moved: Record<string, number> };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1/report-builder', reportBuilderRouter);
  app.use('/api/v1/contacts', contactsRouter);
  app.use('/api/v1/tags', tagsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

beforeEach(async () => {
  c = await makeCompany(`rf${suffix().slice(-4)}`, tenantIds);
});

it('is advertised (report-refs-v1)', () => {
  expect(DESKTOP_CAPABILITIES).toContain('report-refs-v1');
});

describe('a merge re-points saved reports (Q-PRA2b, 5-B1)', () => {
  it('contact and tag merge: builder and standard reports name the kept rows, 4,250.00 stays 4,250.00, audited; others untouched', async () => {
    const [llc] = await db.insert(contacts).values({ tenantId: c.tenantId, contactType: 'customer', displayName: 'Rivera Remodel LLC' }).returning();
    const [crewA] = await db.insert(tags).values({ tenantId: c.tenantId, name: `Crew A ${suffix()}` }).returning();
    const [crewB] = await db.insert(tags).values({ tenantId: c.tenantId, name: `Crew B ${suffix()}` }).returning();
    const dup = llc!.id;
    // A cash sale of 4,250.00 to the duplicate contact, on an income line tagged Crew A.
    await ledger.postTransaction(c.tenantId, {
      txnType: 'journal_entry', txnDate: '2026-03-10', memo: 'sale', contactId: dup, total: '4250.0000',
      lines: [
        { accountId: c.bank, debit: '4250.00', credit: '0', contactId: dup },
        { accountId: c.income, debit: '0', credit: '4250.00', contactId: dup, tagId: crewA!.id },
      ],
    } as never, c.userId, c.companyId);

    const byContact = await save('Sales LLC', revenue({ filters: [{ field: 'contact', op: 'in', ids: [dup] }] }));
    // Names both tags: after the merge the list holds Crew B once.
    const byTag = await save('Sales Crew A', revenue({ filters: [{ field: 'tag', op: 'in', ids: [crewA!.id, crewB!.id] }] }));
    const standard = await save('Std', std({ filters: { contactIds: [dup, c.customer], tagIds: [crewA!.id] } }));
    // Company B sees the tenant-wide duplicate: its report follows too. Another B report on other rows stays.
    const inB = await save('B by contact', revenue({ filters: [{ field: 'contact', op: 'in', ids: [dup] }] }), c.companyB);
    const otherB = await save('B vendor', revenue({ filters: [{ field: 'contact', op: 'in', ids: [c.vendor] }] }), c.companyB);
    // Another tenant's report (its own rows) is never read or changed.
    const o = await makeCompany(`rfo${suffix().slice(-4)}`, tenantIds);
    const other = await save('Other tenant', revenue({ filters: [{ field: 'contact', op: 'in', ids: [o.customer] }] }), o.companyId, o.token);

    for (const d of [byContact, byTag]) {
      const r = await runSaved(d.id, 1);
      expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
      expect(totalOf(r.json)).toBe(4250);
    }

    const mc = await call('POST', '/contacts/merge', { sourceId: dup, targetId: c.customer });
    expect(mc.status, JSON.stringify(mc.json)).toBe(200);
    const mt = await call('POST', '/tags/merge', { sourceTagId: crewA!.id, targetTagId: crewB!.id });
    expect(mt.status, JSON.stringify(mt.json)).toBe(200);

    const c1 = await get(byContact.id);
    expect(c1.version).toBe(2);
    expect(((c1.definition as BuilderDefinition).nodes[0] as RbSectionNode).filters.at(-1)).toEqual({ field: 'contact', op: 'in', ids: [c.customer] });
    expect(c1.missing).toEqual([]);
    const t1 = await get(byTag.id);
    expect(t1.version).toBe(2);
    expect(((t1.definition as BuilderDefinition).nodes[0] as RbSectionNode).filters.at(-1)).toEqual({ field: 'tag', op: 'in', ids: [crewB!.id] });
    const s1 = await get(standard.id);
    expect(s1.version).toBe(3); // one per merge
    expect(s1.definition).toEqual(std({ filters: { contactIds: [c.customer], tagIds: [crewB!.id] } }));
    expect((await get(inB.id, c.companyB)).version).toBe(2);
    expect((await get(otherB.id, c.companyB)).version).toBe(1);
    expect((await get(other.id, o.companyId, o.token)).version).toBe(1);

    // The figures: saved (by id and version) and inline (the definition as read) both still 4,250.00.
    for (const d of [c1, t1]) {
      const saved = await runSaved(d.id, d.version);
      expect(saved.status, JSON.stringify(saved.json).slice(0, 300)).toBe(200);
      expect(totalOf(saved.json)).toBe(4250);
      const inline = await runInline(d.definition);
      expect(inline.status).toBe(200);
      expect(totalOf(inline.json)).toBe(4250);
    }
    // An editor open on the old version is told to reload.
    const stale = await runSaved(byContact.id, 1);
    expect(stale.status).toBe(409);

    // The merges' audit rows count the reports; each rewritten report has its own update row naming the merge (S-1).
    expect((await mergeAudit('contact', dup)).moved['reportDefinitions']).toBe(3);
    expect((await mergeAudit('tag', crewA!.id)).moved['reportDefinitions']).toBe(2);
    const perReport = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'report_definition'), eq(auditLog.action, 'update')));
    const shape = (x: unknown) => x as Record<string, unknown>;
    const merged = (kind: string) => perReport.filter((r) => shape(r.afterData)['reason'] === 'merged' && shape(r.afterData)['mergedKind'] === kind);
    // Contact merge: byContact, standard (company A) and inB (company B); tag merge: byTag and standard.
    expect(merged('contact').map((r) => r.entityId).sort()).toEqual([byContact.id, standard.id, inB.id].sort());
    expect(merged('tag').map((r) => r.entityId).sort()).toEqual([byTag.id, standard.id].sort());
    expect(perReport).toHaveLength(5);
    for (const r of merged('contact')) {
      expect(r.userId).toBe(c.userId);
      expect(shape(r.afterData)).toMatchObject({ mergedFrom: dup, mergedInto: c.customer });
      expect(shape(r.afterData)['version']).toBe(shape(r.beforeData)['version'] as number + 1);
      // Never the definition body.
      expect(JSON.stringify(r.afterData)).not.toContain('filters');
      expect(JSON.stringify(r.beforeData)).not.toContain('filters');
    }
    for (const r of merged('tag')) expect(shape(r.afterData)).toMatchObject({ mergedFrom: crewA!.id, mergedInto: crewB!.id });
    // Reports the merges did not change have none.
    expect(perReport.some((r) => [otherB.id, other.id].includes(r.entityId!))).toBe(false);
  });

  it('a report whose company cannot see the kept row is left as it is and counted as skipped', async () => {
    const [shared] = await db.insert(contacts).values({ tenantId: c.tenantId, contactType: 'customer', displayName: `Shared ${suffix()}` }).returning();
    const [onlyA] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'customer', displayName: `Only A ${suffix()}` }).returning();
    const a = await save('A', revenue({ filters: [{ field: 'contact', op: 'in', ids: [shared!.id] }] }));
    const b = await save('B', revenue({ filters: [{ field: 'contact', op: 'in', ids: [shared!.id] }] }), c.companyB);
    const m = await call('POST', '/contacts/merge', { sourceId: shared!.id, targetId: onlyA!.id });
    expect(m.status, JSON.stringify(m.json)).toBe(200);
    expect((await get(a.id)).version).toBe(2);
    const gb = await get(b.id, c.companyB);
    expect(gb.version).toBe(1);
    // The merged-away contact is deactivated and its merge is recorded: B's report reads it as merged, with no hint (the kept row is not B's).
    expect(gb.missing).toEqual([{ path: 'definition.nodes.0.filters.1.ids', nodeId: 'revenue', field: 'contact', kind: 'contact', ids: [shared!.id], reason: 'merged' }]);
    const audit = await mergeAudit('contact', shared!.id);
    expect(audit.moved).toMatchObject({ reportDefinitions: 1, reportDefinitionsSkipped: 1 });
  });
});

describe('a deleted record under a saved report (Q-PRA2c, 5-B1)', () => {
  it('tag group and unused tag deleted: run and drill are 422 REPORT_REFERENCE_MISSING, GET lists missing; never a silent zero', async () => {
    const [group] = await db.insert(tagGroups).values({ tenantId: c.tenantId, companyId: c.companyId, name: `Crews ${suffix()}` }).returning();
    const [unused] = await db.insert(tags).values({ tenantId: c.tenantId, name: `Unused ${suffix()}` }).returning();
    const byGroup = await save('By crew', revenue({ groupBy: [{ key: 'tag', tagGroupId: group!.id }] }));
    const byTag = await save('Unused tag', revenue({ filters: [{ field: 'tag', op: 'in', ids: [unused!.id, c.tag] }] }));
    const standard = await save('Std by crew', std({ columnTagGroupId: group!.id, filters: { tagIds: [unused!.id] } }));
    expect((await runSaved(byGroup.id, 1)).status).toBe(200);
    expect((await get(byGroup.id)).missing).toEqual([]);

    expect((await call('DELETE', `/tags/groups/${group!.id}`)).status).toBeLessThan(300);
    expect((await call('DELETE', `/tags/${unused!.id}`)).status).toBeLessThan(300);

    const groupMissing = { path: 'definition.nodes.0.groupBy.0.tagGroupId', nodeId: 'revenue', field: 'groupBy.tagGroupId', kind: 'tagGroup', ids: [group!.id], reason: 'deleted' };
    const r = await runSaved(byGroup.id, 1);
    expect(r.status).toBe(422);
    expect(r.json.error).toMatchObject({ code: 'REPORT_REFERENCE_MISSING', details: { ...groupMissing, missing: [groupMissing] } });
    expect((await get(byGroup.id)).missing).toEqual([groupMissing]);

    const tagMissing = { path: 'definition.nodes.0.filters.1.ids', nodeId: 'revenue', field: 'tag', kind: 'tag', ids: [unused!.id], reason: 'deleted' };
    const rt = await call('POST', '/report-builder/run', { definitionId: byTag.id, version: 1, purpose: 'export', ...RANGE });
    expect(rt.status).toBe(422);
    expect(rt.json.error).toMatchObject({ code: 'REPORT_REFERENCE_MISSING', details: tagMissing });
    const preview = await call('POST', '/report-builder/run', { definitionId: byTag.id, version: 1, purpose: 'preview', ...RANGE });
    expect(preview.status).toBe(422);
    const ref = { definitionId: byTag.id, version: 1, ...RANGE };
    const drill = await call('POST', '/report-builder/run/detail', {
      ...ref, nodeId: 'revenue', path: ['n:revenue'], fingerprint: fingerprintOf(ref as never), stamp: 0,
    });
    expect(drill.status).toBe(422);
    expect(drill.json.error.code).toBe('REPORT_REFERENCE_MISSING');
    expect((await get(byTag.id)).missing).toEqual([tagMissing]);

    // Standard reports: the engine does not run them; GET marks the references and the list does too.
    const sm = (await get(standard.id)).missing;
    expect(sm).toEqual([
      { path: 'definition.options.filters.tagIds', nodeId: null, field: 'filters.tagIds', kind: 'tag', ids: [unused!.id], reason: 'deleted' },
      { path: 'definition.options.columnTagGroupId', nodeId: null, field: 'columnTagGroupId', kind: 'tagGroup', ids: [group!.id], reason: 'deleted' },
    ]);
    const list = (await call('GET', '/report-builder/definitions')).json.definitions as Array<{ id: string; missing: unknown[] }>;
    expect(list.find((d) => d.id === standard.id)!.missing).toEqual(sm);

    // Inline (the desktop's editor run): still 400 DEFINITION_INVALID NOT_IN_COMPANY at the path, with missing added.
    const inline = await runInline((await get(byGroup.id)).definition);
    expect(inline.status).toBe(400);
    expect(inline.json.error).toMatchObject({ code: 'DEFINITION_INVALID', details: { path: groupMissing.path, code: 'NOT_IN_COMPANY', missing: [groupMissing] } });
    const inlineDrillRef = { definition: (await get(byTag.id)).definition, ...RANGE };
    const inlineDrill = await call('POST', '/report-builder/run/detail', { ...inlineDrillRef, nodeId: 'revenue', path: ['n:revenue'], fingerprint: fingerprintOf(inlineDrillRef as never), stamp: 0 });
    expect(inlineDrill.status).toBe(400);
    expect(inlineDrill.json.error.details).toMatchObject({ path: tagMissing.path, code: 'NOT_IN_COMPANY', missing: [tagMissing] });
  });

  it('a deactivated contact still exists: the saved report runs and nothing is missing', async () => {
    const [gone] = await db.insert(contacts).values({ tenantId: c.tenantId, contactType: 'customer', displayName: `Old ${suffix()}` }).returning();
    const d = await save('Old customer', revenue({ filters: [{ field: 'contact', op: 'in', ids: [gone!.id] }] }));
    await db.update(contacts).set({ isActive: false }).where(eq(contacts.id, gone!.id));
    expect((await runSaved(d.id, 1)).status).toBe(200);
    expect((await get(d.id)).missing).toEqual([]);
    const [row] = await db.select().from(reportDefinitions).where(eq(reportDefinitions.id, d.id));
    expect(row!.version).toBe(1);
  });
});

describe('merged before report-refs-v1 (coordinator decision 3)', () => {
  /** What a merge before this change left: the source deactivated (contact) or deleted (tag), a merge audit row, reports untouched. */
  async function oldContactMerge(from: string, to: string) {
    await db.update(contacts).set({ isActive: false }).where(eq(contacts.id, from));
    await db.insert(auditLog).values({ tenantId: c.tenantId, userId: c.userId, action: 'update', entityType: 'contact', entityId: from, beforeData: null, afterData: { merged_into: to } });
  }

  it('a report left on a merged-away contact is missing (reason merged) with the survivor as a hint: GET, saved 422, inline 400; chains followed', async () => {
    const [x] = await db.insert(contacts).values({ tenantId: c.tenantId, contactType: 'customer', displayName: `Rivera old ${suffix()}` }).returning();
    const [y] = await db.insert(contacts).values({ tenantId: c.tenantId, contactType: 'customer', displayName: `Rivera mid ${suffix()}` }).returning();
    const d = await save('Left on X', revenue({ filters: [{ field: 'contact', op: 'in', ids: [x!.id, c.vendor] }] }));
    // X went into Y, later Y went into the kept customer.
    await oldContactMerge(x!.id, y!.id);
    await oldContactMerge(y!.id, c.customer);
    const entry = {
      path: 'definition.nodes.0.filters.1.ids', nodeId: 'revenue', field: 'contact', kind: 'contact', ids: [x!.id], reason: 'merged',
      mergedInto: { id: c.customer, label: 'Rivera Remodel (customer)' },
    };
    expect((await get(d.id)).missing).toEqual([entry]);
    const saved = await runSaved(d.id, 1);
    expect(saved.status).toBe(422);
    expect(saved.json.error).toMatchObject({ code: 'REPORT_REFERENCE_MISSING', details: { ...entry, missing: [entry] } });
    const inline = await runInline((await get(d.id)).definition);
    expect(inline.status).toBe(400);
    expect(inline.json.error).toMatchObject({ code: 'DEFINITION_INVALID', details: { path: entry.path, code: 'NOT_IN_COMPANY', missing: [entry] } });
  });

  it('a tag merged away before (deleted, with a merge row) is missing with its survivor; a reactivated contact is not missing', async () => {
    const [old] = await db.insert(tags).values({ tenantId: c.tenantId, name: `Old crew ${suffix()}` }).returning();
    const d = await save('Old crew', revenue({ filters: [{ field: 'tag', op: 'in', ids: [old!.id] }] }));
    await db.delete(tags).where(eq(tags.id, old!.id));
    await db.insert(auditLog).values({ tenantId: c.tenantId, userId: c.userId, action: 'delete', entityType: 'tag', entityId: old!.id, beforeData: null, afterData: { merged_into: c.tag } });
    const [tagRow] = await db.select().from(tags).where(eq(tags.id, c.tag));
    expect((await get(d.id)).missing).toEqual([{
      path: 'definition.nodes.0.filters.1.ids', nodeId: 'revenue', field: 'tag', kind: 'tag', ids: [old!.id], reason: 'merged',
      mergedInto: { id: c.tag, label: tagRow!.name },
    }]);

    const [z] = await db.insert(contacts).values({ tenantId: c.tenantId, contactType: 'customer', displayName: `Back ${suffix()}` }).returning();
    const dz = await save('Back again', revenue({ filters: [{ field: 'contact', op: 'in', ids: [z!.id] }] }));
    await oldContactMerge(z!.id, c.customer);
    await db.update(contacts).set({ isActive: true }).where(eq(contacts.id, z!.id));
    expect((await get(dz.id)).missing).toEqual([]);
    expect((await runSaved(dz.id, 1)).status).toBe(200);
  });
});