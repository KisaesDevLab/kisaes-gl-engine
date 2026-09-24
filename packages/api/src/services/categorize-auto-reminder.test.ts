// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Automated chasing for uncategorized transactions: a reminder_schedules row
// with trigger 'categorize_reminder'.
//
// The rules that matter are the ones that decide NOT to send. A client who
// answered yesterday, a queue that is empty, a contact already at their
// weekly cap and a cadence that has run out must all produce silence —
// automation that nags is worse than no automation.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, companies, accounts, portalContacts, portalContactCompanies, tenantFeatureFlags,
  bankConnections, bankFeedItems, clientCategorySuggestions, reminderSends, reminderSchedules,
  transactionClassificationState, auditLog,
} from '../db/schema/index.js';
import { scanCategorizeReminders, dispatchCategorizeReminders } from './categorize-help-request.service.js';

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let tenantId = '';
let companyId = '';
let contactId = '';
let scheduleId = '';
let feedItemId = '';
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  const [t] = await db.insert(tenants).values({ name: `Auto ${stamp}`, slug: `auto-${stamp}` }).returning();
  tenantId = t!.id;
  const [co] = await db.insert(companies).values({ tenantId, businessName: 'Auto Co' }).returning();
  companyId = co!.id;
  await db.insert(tenantFeatureFlags).values({ tenantId, flagKey: 'PORTAL_CATEGORIZE_V1', enabled: true });
  const [c] = await db.insert(portalContacts).values({
    tenantId, email: `auto-${stamp}@example.com`, firstName: 'Ada', status: 'active',
  }).returning();
  contactId = c!.id;
  await db.insert(portalContactCompanies).values({ contactId, companyId, categorizeAccess: true });

  // One unclassified bank line = one row waiting on the client.
  const [bank] = await db.insert(accounts).values({
    tenantId, companyId, name: 'Checking', accountType: 'asset', detailType: 'bank', accountNumber: `1${stamp.slice(0, 4)}`,
  }).returning();
  const [conn] = await db.insert(bankConnections).values({
    tenantId, accountId: bank!.id, provider: 'manual', institutionName: 'Bank',
  }).returning();
  const [item] = await db.insert(bankFeedItems).values({
    tenantId, companyId, bankConnectionId: conn!.id, feedDate: '2026-08-05',
    description: 'UNKNOWN MERCHANT', amount: '-10.9400', status: 'pending',
  }).returning();
  feedItemId = item!.id;
  // The portal queue only shows lines the classifier gave up on.
  await db.insert(transactionClassificationState).values({
    tenantId, companyId, bankFeedItemId: feedItemId, bucket: 'needs_review',
  });

  const [s] = await db.insert(reminderSchedules).values({
    tenantId, companyId, triggerType: 'categorize_reminder',
    cadenceDays: [3, 7, 14], channelStrategy: 'email_only',
    quietHoursStart: 0, quietHoursEnd: 0, timezone: 'UTC', maxPerWeek: 3, active: true,
  }).returning();
  scheduleId = s!.id;
});

afterAll(async () => {
  if (!tenantId) return;
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(reminderSchedules).where(eq(reminderSchedules.tenantId, tenantId));
  await db.delete(reminderSends).where(eq(reminderSends.tenantId, tenantId));
  await db.delete(clientCategorySuggestions).where(eq(clientCategorySuggestions.tenantId, tenantId));
  await db.delete(transactionClassificationState).where(eq(transactionClassificationState.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(portalContactCompanies).where(eq(portalContactCompanies.contactId, contactId));
  await db.delete(portalContacts).where(eq(portalContacts.tenantId, tenantId));
  await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await db.delete(reminderSends).where(eq(reminderSends.tenantId, tenantId));
  await db.delete(clientCategorySuggestions).where(eq(clientCategorySuggestions.tenantId, tenantId));
  await db.update(reminderSchedules).set({ active: true, cadenceDays: [3, 7, 14], maxPerWeek: 3 })
    .where(eq(reminderSchedules.id, scheduleId));
});

/** A past send, as the engine would have recorded it. */
async function recordSend(daysAgo: number) {
  await db.insert(reminderSends).values({
    tenantId, scheduleId, contactId, questionId: companyId, channel: 'email',
    sentAt: new Date(Date.now() - daysAgo * DAY),
  });
}

async function recordAnswer(daysAgo: number) {
  await db.insert(clientCategorySuggestions).values({
    tenantId, companyId, targetKind: 'bank_feed_item', bankFeedItemId: feedItemId,
    submittedByContactId: contactId, clientNote: 'It was fuel',
    snapshotAmount: '-10.9400', snapshotDate: '2026-08-05',
    submittedAt: new Date(Date.now() - daysAgo * DAY),
  });
}

const scan = () => scanCategorizeReminders(tenantId);

describe('automated categorize reminders', () => {
  it('opens the conversation when nobody has chased them yet', async () => {
    const due = await scan();
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ contactId, companyId, step: 1, queueCount: 1 });
  });

  it('waits for the cadence step before following up', async () => {
    await recordSend(1);                       // chased yesterday
    expect(await scan()).toHaveLength(0);      // cadence[0] is 3 days
  });

  it('follows up once the step comes due', async () => {
    await recordSend(4);
    const due = await scan();
    expect(due).toHaveLength(1);
    expect(due[0]!.step).toBe(2);
  });

  it('stops when the cadence runs out', async () => {
    // The opener plus one message per cadence entry: [3,7,14] is four
    // messages in all, and then silence until they answer.
    await recordSend(30);                      // opener
    await recordSend(27);                      // +3
    await recordSend(23);                      // +7
    await recordSend(16);                      // +14
    expect(await scan()).toHaveLength(0);
  });

  it('goes quiet as soon as the client answers, then restarts a step later', async () => {
    await recordSend(10);
    await recordAnswer(1);                     // answered yesterday
    expect(await scan()).toHaveLength(0);

    await db.delete(clientCategorySuggestions).where(eq(clientCategorySuggestions.tenantId, tenantId));
    await recordAnswer(5);                     // answered 5 days ago, still open rows
    const due = await scan();
    expect(due).toHaveLength(1);
    expect(due[0]!.step).toBe(1);              // the clock restarts from their answer
  });

  it('says nothing when there is nothing waiting', async () => {
    await db.update(bankFeedItems).set({ status: 'categorized' }).where(eq(bankFeedItems.id, feedItemId));
    expect(await scan()).toHaveLength(0);
    await db.update(bankFeedItems).set({ status: 'pending' }).where(eq(bankFeedItems.id, feedItemId));
  });

  it('never sends twice in one day, whatever the cadence says', async () => {
    await db.update(reminderSchedules).set({ cadenceDays: [1, 1, 1] }).where(eq(reminderSchedules.id, scheduleId));
    await recordSend(0.2);                     // ~5 hours ago
    expect(await scan()).toHaveLength(0);
  });

  it('respects the per-contact weekly cap instead of piling on', async () => {
    await db.update(reminderSchedules).set({ maxPerWeek: 1 }).where(eq(reminderSchedules.id, scheduleId));
    // One message this week already, about something else entirely (a
    // document request): it does not touch this spell, but it does count
    // against what the contact should receive in a week.
    await db.insert(reminderSends).values({
      tenantId, scheduleId: null, contactId, questionId: crypto.randomUUID(), channel: 'email',
    });
    const result = await dispatchCategorizeReminders(tenantId);
    expect(result).toMatchObject({ capped: 1, sent: 0 });
  });

  it('ignores a paused schedule', async () => {
    await db.update(reminderSchedules).set({ active: false }).where(eq(reminderSchedules.id, scheduleId));
    expect(await scan()).toHaveLength(0);
  });

  it('sends, and records it against the schedule that sent it', async () => {
    const result = await dispatchCategorizeReminders(tenantId);
    expect(result).toMatchObject({ attempted: 1, sent: 1, failed: 0 });
    const sends = await db.select().from(reminderSends).where(eq(reminderSends.tenantId, tenantId));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.scheduleId).toBe(scheduleId);   // automated, not a staff click
    expect(sends[0]!.questionId).toBe(companyId);
    // …and the next tick stays quiet.
    expect(await dispatchCategorizeReminders(tenantId)).toMatchObject({ attempted: 0, sent: 0 });
  });
});
