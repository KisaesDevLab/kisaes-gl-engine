// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// The run-due template filter (ClientLedger U-82, run-due-filter-v1):
//   - templateIds runs only those templates, excludeTemplateIds all but
//     those, both together "only these minus the excluded";
//   - an excluded template is untouched: no occurrence rows, no posts, its
//     next date unchanged, still due for the next run; `more` ignores it;
//   - malformed ids, an empty templateIds and non-arrays are 400;
//     well-formed unknown ids are ignored;
//   - the 31-per-run cap and closed-period skipping still apply;
//   - replaying a runId with a different filter posts only what the new
//     filter allows, never a date twice; `posted` lists every post of the run.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { companies, recurringSchedules, templateOccurrences, transactions } from '../../db/schema/index.js';
import { hashClosingPassword } from '../closing-password.service.js';
import { DESKTOP_CAPABILITIES } from '../../desktop/capabilities.js';
import { TestServer, makeCompany, cleanTenant, transferDraft, monthlyAuto, type Co } from './templates.test-helpers.js';

const srv = new TestServer();
const tenantIds: string[] = [];
let c: Co;

beforeEach(async () => {
  await srv.start();
  c = await makeCompany('rdf', tenantIds);
});

afterEach(async () => {
  await srv.stop();
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

const createTemplate = async (name: string, schedule: Record<string, unknown> = monthlyAuto('2026-01-31')) => {
  const r = await srv.request('POST', '/api/v1/templates', c.token, { name, kind: 'transfer', draft: transferDraft(c, '10.0000'), schedule }, c.companyId);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.template as { id: string };
};
const runDue = (body: Record<string, unknown>) => srv.request('POST', '/api/v1/recurring/run-due', c.token, body, c.companyId);

type Posted = { templateId: string; occurrenceDate: string };
const datesOf = (posted: Posted[], id: string) => posted.filter((p) => p.templateId === id).map((p) => p.occurrenceDate);

async function nextOf(templateId: string) {
  const [s] = await db.select().from(recurringSchedules).where(eq(recurringSchedules.templateId, templateId));
  return s!.nextOccurrence;
}
async function occurrencesOf(templateId: string) {
  return db.select().from(templateOccurrences).where(eq(templateOccurrences.templateId, templateId));
}
async function txnCount(templateId: string) {
  return (await db.select().from(transactions).where(eq(transactions.sourceId, templateId))).length;
}

describe('run-due template filter', () => {
  it('advertises run-due-filter-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('run-due-filter-v1');
  });

  it('templateIds runs only those; excludeTemplateIds all but those; both together', async () => {
    const a = await createTemplate('A');
    const b = await createTemplate('B');
    const d = await createTemplate('D');
    const e = await createTemplate('E');

    const only = await runDue({ asOf: '2026-03-31', templateIds: [a.id] });
    expect(only.status, JSON.stringify(only.json)).toBe(200);
    expect(only.json.posted.map((p: Posted) => p.templateId)).toEqual([a.id, a.id, a.id]);
    expect(datesOf(only.json.posted, a.id)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    for (const t of [b, d, e]) expect(await nextOf(t.id)).toBe('2026-01-31');

    const both = await runDue({ asOf: '2026-03-31', templateIds: [b.id, d.id], excludeTemplateIds: [d.id] });
    expect(both.status).toBe(200);
    expect(new Set(both.json.posted.map((p: Posted) => p.templateId))).toEqual(new Set([b.id]));
    expect(await nextOf(d.id)).toBe('2026-01-31');

    const except = await runDue({ asOf: '2026-03-31', excludeTemplateIds: [e.id] });
    expect(except.status).toBe(200);
    expect(new Set(except.json.posted.map((p: Posted) => p.templateId))).toEqual(new Set([d.id]));
    expect(datesOf(except.json.posted, d.id)).toHaveLength(3);
    expect(await nextOf(e.id)).toBe('2026-01-31');

    // Unfiltered: only E is still due; nothing posts twice.
    const rest = await runDue({ asOf: '2026-03-31' });
    expect(new Set(rest.json.posted.map((p: Posted) => p.templateId))).toEqual(new Set([e.id]));
    for (const t of [a, b, d, e]) expect(await txnCount(t.id)).toBe(3);
  });

  it('an excluded template stays due and untouched; more ignores it', async () => {
    const many = await createTemplate('Many', { mode: 'auto', frequency: 'daily', nextDate: '2026-01-01' });
    const small = await createTemplate('Small', monthlyAuto('2026-01-31'));

    const r = await runDue({ asOf: '2026-03-31', limit: 3, excludeTemplateIds: [many.id] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(datesOf(r.json.posted, small.id)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    expect(datesOf(r.json.posted, many.id)).toEqual([]);
    // The limit was reached, but only the excluded template is still due.
    expect(r.json.more).toBe(false);
    expect(r.json.skipped.filter((s: { templateId: string }) => s.templateId === many.id)).toEqual([]);
    expect(await occurrencesOf(many.id)).toHaveLength(0);
    expect(await txnCount(many.id)).toBe(0);
    expect(await nextOf(many.id)).toBe('2026-01-01');

    // Still due: the next unfiltered run picks it up (31-per-run cap intact).
    const later = await runDue({ asOf: '2026-03-31', templateIds: [many.id] });
    expect(datesOf(later.json.posted, many.id)).toHaveLength(31);
    expect(later.json.skipped).toContainEqual(expect.objectContaining({ templateId: many.id, reason: 'CATCH_UP_CAPPED', occurrenceDate: '2026-02-01' }));
    expect(later.json.more).toBe(false);
  });

  it('closed periods are still skipped for the templates the filter lets through', async () => {
    await db.update(companies).set({
      lockDate: '2026-02-28', closingPasswordHash: await hashClosingPassword('closing-pass-123'),
    }).where(eq(companies.id, c.companyId));
    const a = await createTemplate('A');
    const b = await createTemplate('B');
    const r = await runDue({ asOf: '2026-03-31', templateIds: [a.id] });
    expect(datesOf(r.json.posted, a.id)).toEqual(['2026-03-31']);
    expect(r.json.skipped.filter((s: { templateId: string }) => s.templateId === a.id).map((s: { reason: string }) => s.reason))
      .toEqual(['CLOSED_PERIOD', 'CLOSED_PERIOD']);
    expect(await occurrencesOf(b.id)).toHaveLength(0);
  });

  it('malformed filters are 400; unknown well-formed ids are ignored', async () => {
    const a = await createTemplate('A');
    for (const body of [
      { templateIds: ['not-a-uuid'] },
      { excludeTemplateIds: [123] },
      { templateIds: [] },
      { templateIds: a.id },
      { excludeTemplateIds: null },
      { templateIds: Array.from({ length: 501 }, () => a.id) },
    ]) {
      const r = await runDue({ asOf: '2026-03-31', ...body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await occurrencesOf(a.id)).toHaveLength(0);

    const unknown = await runDue({ asOf: '2026-03-31', templateIds: ['00000000-0000-4000-8000-000000000000'] });
    expect(unknown.status).toBe(200);
    expect(unknown.json.posted).toEqual([]);
    const emptyExclude = await runDue({ asOf: '2026-03-31', excludeTemplateIds: [] });
    expect(datesOf(emptyExclude.json.posted, a.id)).toHaveLength(3);
  });

  it('replaying a runId with a different filter posts what the new filter allows, never twice', async () => {
    const a = await createTemplate('A');
    const b = await createTemplate('B');
    const runId = '7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';

    const first = await runDue({ asOf: '2026-03-31', runId, templateIds: [a.id] });
    expect(first.json.runId).toBe(runId);
    expect(first.json.posted).toHaveLength(3);

    const second = await runDue({ asOf: '2026-03-31', runId, templateIds: [b.id] });
    expect(datesOf(second.json.posted, a.id)).toHaveLength(3);
    expect(datesOf(second.json.posted, b.id)).toHaveLength(3);

    const third = await runDue({ asOf: '2026-03-31', runId, excludeTemplateIds: [b.id] });
    expect(third.json.posted).toEqual(second.json.posted);
    expect(await txnCount(a.id)).toBe(3);
    expect(await txnCount(b.id)).toBe(3);
  });
});
