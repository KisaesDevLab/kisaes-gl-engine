// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { aiJobs, chatConversations, chatMessages } from '../db/schema/index.js';
import { purgeOldAiJobs, purgeOldChatConversations } from './ai-retention.service.js';

// Scope every row to a unique tenant so this suite is isolated from the
// other DB-touching test files (vitest runs files in parallel against the
// shared test DB; truncating shared tables would race). We only ever
// touch / delete rows under these ids.
const tenantId = randomUUID();
const userId = randomUUID();

const daysAgo = (n: number): Date => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

afterEach(async () => {
  await db.delete(aiJobs).where(eq(aiJobs.tenantId, tenantId));
  // chatMessages cascade with their conversation, but delete defensively
  // in case a test inserted an orphan.
  await db.delete(chatConversations).where(eq(chatConversations.tenantId, tenantId));
});

describe('purgeOldAiJobs', () => {
  it('deletes jobs older than the horizon and keeps recent ones', async () => {
    const oldId = randomUUID();
    const newId = randomUUID();
    await db.insert(aiJobs).values([
      { id: oldId, tenantId, jobType: 'categorize', status: 'complete', createdAt: daysAgo(120) },
      { id: newId, tenantId, jobType: 'categorize', status: 'complete', createdAt: daysAgo(10) },
    ]);

    const purged = await purgeOldAiJobs(90);
    expect(purged).toBe(1);

    const remaining = await db.select({ id: aiJobs.id }).from(aiJobs).where(eq(aiJobs.tenantId, tenantId));
    expect(remaining.map((r) => r.id)).toEqual([newId]);
  });

  it('is a no-op when retentionDays <= 0 (disabled)', async () => {
    await db.insert(aiJobs).values({ id: randomUUID(), tenantId, jobType: 'ocr_receipt', status: 'complete', createdAt: daysAgo(500) });
    expect(await purgeOldAiJobs(0)).toBe(0);
    expect(await purgeOldAiJobs(-1)).toBe(0);
    const remaining = await db.select({ id: aiJobs.id }).from(aiJobs).where(eq(aiJobs.tenantId, tenantId));
    expect(remaining).toHaveLength(1);
  });
});

describe('purgeOldChatConversations', () => {
  it('deletes stale conversations (and cascades messages), keeps active ones', async () => {
    const oldConvId = randomUUID();
    const newConvId = randomUUID();
    await db.insert(chatConversations).values([
      { id: oldConvId, tenantId, userId, lastMessageAt: daysAgo(400), createdAt: daysAgo(410) },
      { id: newConvId, tenantId, userId, lastMessageAt: daysAgo(5), createdAt: daysAgo(6) },
    ]);
    await db.insert(chatMessages).values([
      { conversationId: oldConvId, tenantId, role: 'user', content: 'old message' },
      { conversationId: newConvId, tenantId, role: 'user', content: 'new message' },
    ]);

    const purged = await purgeOldChatConversations(365);
    expect(purged).toBe(1);

    const convs = await db.select({ id: chatConversations.id }).from(chatConversations).where(eq(chatConversations.tenantId, tenantId));
    expect(convs.map((c) => c.id)).toEqual([newConvId]);

    // The old conversation's messages cascade-deleted; the new one's survive.
    const oldMsgs = await db.select({ id: chatMessages.id }).from(chatMessages)
      .where(and(eq(chatMessages.tenantId, tenantId), eq(chatMessages.conversationId, oldConvId)));
    expect(oldMsgs).toHaveLength(0);
    const newMsgs = await db.select({ id: chatMessages.id }).from(chatMessages)
      .where(and(eq(chatMessages.tenantId, tenantId), eq(chatMessages.conversationId, newConvId)));
    expect(newMsgs).toHaveLength(1);
  });

  it('falls back to created_at when last_message_at is null', async () => {
    const convId = randomUUID();
    await db.insert(chatConversations).values({ id: convId, tenantId, userId, lastMessageAt: null, createdAt: daysAgo(400) });
    expect(await purgeOldChatConversations(365)).toBe(1);
    const convs = await db.select({ id: chatConversations.id }).from(chatConversations).where(eq(chatConversations.tenantId, tenantId));
    expect(convs).toHaveLength(0);
  });

  it('is a no-op when retentionDays <= 0 (disabled)', async () => {
    await db.insert(chatConversations).values({ id: randomUUID(), tenantId, userId, lastMessageAt: daysAgo(9999), createdAt: daysAgo(9999) });
    expect(await purgeOldChatConversations(0)).toBe(0);
    const convs = await db.select({ id: chatConversations.id }).from(chatConversations).where(eq(chatConversations.tenantId, tenantId));
    expect(convs).toHaveLength(1);
  });
});
