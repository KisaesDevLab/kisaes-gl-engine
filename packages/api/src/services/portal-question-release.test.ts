// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Releasing a portal question used to stamp notified_at and nothing else —
// no client was ever emailed about a question, and one with no assigned
// contact had no audience at all, so it could neither be released nor
// chased and sat as a draft forever.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, companies, users, portalContacts, portalContactCompanies,
  portalQuestions, reminderSends, auditLog,
} from '../db/schema/index.js';
import { listPendingBatches, sendQuestionNotices } from './portal-question.service.js';

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let tenantId = '';
let companyId = '';
let userId = '';
let answerer = '';
let other = '';
let noAccess = '';
let sentMail: Array<{ to: string; subject: string; preview: string }> = [];

beforeAll(async () => {
  const [t] = await db.insert(tenants).values({ name: `Ask ${stamp}`, slug: `ask-${stamp}` }).returning();
  tenantId = t!.id;
  const [co] = await db.insert(companies).values({ tenantId, businessName: 'Ask Co' }).returning();
  companyId = co!.id;
  const [u] = await db.insert(users).values({
    tenantId, email: `staff-${stamp}@example.com`, passwordHash: 'x'.repeat(60), displayName: 'Staff', role: 'owner',
  }).returning();
  userId = u!.id;
  const mk = async (label: string, questions: boolean) => {
    const [c] = await db.insert(portalContacts).values({
      tenantId, email: `${label}-${stamp}@example.com`, firstName: label, status: 'active',
    }).returning();
    await db.insert(portalContactCompanies).values({ contactId: c!.id, companyId, questionsForUsAccess: questions });
    return c!.id;
  };
  answerer = await mk('ann', true);
  other = await mk('otto', true);
  noAccess = await mk('nope', false);
});

afterAll(async () => {
  if (!tenantId) return;
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(reminderSends).where(eq(reminderSends.tenantId, tenantId));
  await db.delete(portalQuestions).where(eq(portalQuestions.tenantId, tenantId));
  for (const id of [answerer, other, noAccess]) {
    await db.delete(portalContactCompanies).where(eq(portalContactCompanies.contactId, id));
  }
  await db.delete(portalContacts).where(eq(portalContacts.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

beforeEach(() => {
  sentMail = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    try {
      const e = JSON.parse(String(line));
      if (e.component === 'reminder-mail-stub') sentMail.push({ to: e.to, subject: e.subject, preview: e.preview });
    } catch { /* not our line */ }
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete(reminderSends).where(eq(reminderSends.tenantId, tenantId));
  await db.delete(portalQuestions).where(eq(portalQuestions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
});

async function ask(body: string, assignedContactId: string | null) {
  const [q] = await db.insert(portalQuestions).values({
    tenantId, companyId, body, createdBy: userId, assignedContactId,
  }).returning();
  return q!.id;
}

describe('releasing a portal question', () => {
  it('emails the assigned contact and nobody else', async () => {
    const id = await ask('Which card is this?', answerer);
    const result = await sendQuestionNotices(tenantId, [id], userId);
    expect(result.released).toBe(1);
    expect(result.results.map((r) => r.outcome)).toEqual(['sent']);
    expect(sentMail.map((m) => m.to)).toEqual([`ann-${stamp}@example.com`]);
    const [q] = await db.select().from(portalQuestions).where(eq(portalQuestions.id, id));
    expect(q!.notifiedAt).not.toBeNull();
  });

  it('emails every contact who may answer when nobody is assigned', async () => {
    // The stuck case: Contact shows "—" on the staff list.
    const id = await ask('Please send the Amex statements.', null);
    const result = await sendQuestionNotices(tenantId, [id], userId);
    expect(result.noAudience).toBe(0);
    expect(sentMail.map((m) => m.to).sort()).toEqual(
      [`ann-${stamp}@example.com`, `otto-${stamp}@example.com`].sort(),
    );
    // The contact without questions access is not written to.
    expect(sentMail.some((m) => m.to.startsWith('nope'))).toBe(false);
  });

  it('sends one email per person, not one per question', async () => {
    const a = await ask('First?', answerer);
    const b = await ask('Second?', answerer);
    const result = await sendQuestionNotices(tenantId, [a, b], userId);
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0]!.subject).toContain('2 question(s)');
    expect(result.results[0]!.questionCount).toBe(2);
  });

  it('records the send on the same trail as every other portal message', async () => {
    const id = await ask('Anything?', answerer);
    await sendQuestionNotices(tenantId, [id], userId);
    const sends = await db.select().from(reminderSends).where(eq(reminderSends.tenantId, tenantId));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.questionId).toBe(id);
    expect(sends[0]!.error).toBeNull();
  });

  it('still releases a question nobody can receive, and says so', async () => {
    await db.update(portalContacts).set({ status: 'paused' }).where(eq(portalContacts.tenantId, tenantId));
    try {
      const id = await ask('Orphan?', null);
      const result = await sendQuestionNotices(tenantId, [id], userId);
      expect(result.noAudience).toBe(1);
      expect(result.results).toHaveLength(0);
      const [q] = await db.select().from(portalQuestions).where(eq(portalQuestions.id, id));
      expect(q!.notifiedAt).not.toBeNull();   // staff released it; it is not a draft any more
    } finally {
      await db.update(portalContacts).set({ status: 'active' }).where(eq(portalContacts.tenantId, tenantId));
    }
  });
});

describe('pending batches', () => {
  it('lists a draft that has no assigned contact', async () => {
    await ask('Unassigned draft', null);
    const batches = await listPendingBatches(tenantId);
    expect(batches.map((b) => b.email).sort()).toEqual(
      [`ann-${stamp}@example.com`, `otto-${stamp}@example.com`].sort(),
    );
  });

  it('drops a question once it has been released', async () => {
    const id = await ask('Released', answerer);
    await sendQuestionNotices(tenantId, [id], userId);
    expect(await listPendingBatches(tenantId)).toHaveLength(0);
  });
});
