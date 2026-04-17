// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, aiConfig, aiJobs, aiUsageLog,
  aiPromptTemplates, categorizationHistory, bankFeedItems,
  chatConversations, chatMessages,
  auditLog,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as aiConfigService from './ai-config.service.js';
import * as chatService from './chat.service.js';
import * as aiConsent from './ai-consent.service.js';
import * as providers from './ai-providers/index.js';
import { encrypt } from '../utils/encryption.js';

let tenantId: string;
let userId: string;
let companyId: string;

async function cleanDb() {
  await db.delete(chatMessages);
  await db.delete(chatConversations);
  await db.delete(aiUsageLog);
  await db.delete(aiJobs);
  await db.delete(aiPromptTemplates);
  await db.delete(categorizationHistory);
  await db.delete(bankFeedItems);
  await db.delete(aiConfig);
  await db.delete(auditLog);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
}

async function setup() {
  const reg = await authService.register({
    email: 'chat-test@example.com',
    password: 'password123',
    displayName: 'Chat Test User',
    companyName: 'Chat Test Co',
  });
  userId = reg.user.id;
  tenantId = reg.user.tenantId;
  // Find the company that registration created
  const company = await db.query.companies.findFirst({
    where: eq(companies.tenantId, tenantId),
  });
  companyId = company!.id;
  // Accept the system AI disclosure once per test — the new PII
  // consent gate blocks updateConfig({ isEnabled: true }) without it.
  // Chat tests don't exercise the disclosure flow, so we accept up
  // front to keep the existing setup working.
  await aiConsent.acceptSystemDisclosure(userId);
}

describe('Chat Service', () => {
  beforeEach(async () => {
    await cleanDb();
    await setup();
  });
  afterEach(async () => {
    await cleanDb();
    vi.restoreAllMocks();
  });

  describe('two-tier consent', () => {
    it('reports disabled when AI processing is off', async () => {
      const status = await chatService.isChatAvailable(tenantId);
      expect(status.enabled).toBe(false);
      expect(status.systemEnabled).toBe(false);
      expect(status.reason).toMatch(/AI processing/i);
    });

    it('reports disabled when AI is on but chat support is off', async () => {
      await aiConfigService.updateConfig({
        isEnabled: true,
        chatSupportEnabled: false,
      });
      const status = await chatService.isChatAvailable(tenantId);
      expect(status.enabled).toBe(false);
      expect(status.systemEnabled).toBe(false);
    });

    it('reports disabled when system is on but no company has opted in', async () => {
      await aiConfigService.updateConfig({
        isEnabled: true,
        chatSupportEnabled: true,
      });
      const status = await chatService.isChatAvailable(tenantId);
      expect(status.enabled).toBe(false);
      expect(status.systemEnabled).toBe(true);
      expect(status.companyEnabled).toBe(false);
      expect(status.reason).toMatch(/company/i);
    });

    it('reports enabled when both tiers are on', async () => {
      await aiConfigService.updateConfig({
        isEnabled: true,
        chatSupportEnabled: true,
      });
      await db.update(companies)
        .set({ chatSupportEnabled: true })
        .where(eq(companies.id, companyId));

      const status = await chatService.isChatAvailable(tenantId);
      expect(status.enabled).toBe(true);
      expect(status.systemEnabled).toBe(true);
      expect(status.companyEnabled).toBe(true);
    });

    it('sendMessage rejects with 403 when chat is disabled', async () => {
      await expect(
        chatService.sendMessage(tenantId, userId, { message: 'hello' }),
      ).rejects.toThrow(/CHAT_DISABLED|Chat support|AI processing/i);
    });
  });

  describe('sendMessage happy path', () => {
    beforeEach(async () => {
      // Enable both tiers + a fake provider key so chatService can
      // pick a preferredProvider without 'no provider configured'.
      await aiConfigService.updateConfig({
        isEnabled: true,
        chatSupportEnabled: true,
        chatProvider: 'anthropic',
        chatModel: 'claude-test',
        anthropicApiKey: 'sk-test-fake-key',
      });
      await db.update(companies)
        .set({ chatSupportEnabled: true })
        .where(eq(companies.id, companyId));
    });

    it('creates a conversation, persists user + assistant messages, logs usage', async () => {
      // Mock the AI provider call so we don't hit a real API. The
      // function is `executeWithFallback` from ai-providers/index.js,
      // which chat.service imports and calls directly.
      const fakeReply = 'Payments Clearing is a holding account...';
      const spy = vi.spyOn(providers, 'executeWithFallback').mockResolvedValue({
        text: fakeReply,
        inputTokens: 100,
        outputTokens: 50,
        model: 'claude-test',
        provider: 'anthropic',
        durationMs: 250,
      });

      const result = await chatService.sendMessage(tenantId, userId, {
        message: 'What is Payments Clearing?',
        context: {
          current_screen: 'dashboard',
          current_path: '/',
        },
      });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.assistantMessage).toBe(fakeReply);
      expect(result.conversationId).toBeTruthy();
      expect(result.inputTokens).toBe(100);
      expect(result.outputTokens).toBe(50);

      // Conversation persisted with auto-derived title
      const conv = await db.query.chatConversations.findFirst({
        where: eq(chatConversations.id, result.conversationId),
      });
      expect(conv).toBeTruthy();
      expect(conv?.userId).toBe(userId);
      expect(conv?.tenantId).toBe(tenantId);
      expect(conv?.title).toBe('What is Payments Clearing?');
      expect(conv?.messageCount).toBe(2);

      // Both messages persisted
      const messages = await db.select().from(chatMessages)
        .where(eq(chatMessages.conversationId, result.conversationId));
      expect(messages).toHaveLength(2);
      const userMsg = messages.find((m) => m.role === 'user');
      const asstMsg = messages.find((m) => m.role === 'assistant');
      expect(userMsg?.content).toBe('What is Payments Clearing?');
      expect(userMsg?.screenContext).toBe('dashboard');
      expect(asstMsg?.content).toBe(fakeReply);
      expect(asstMsg?.provider).toBe('anthropic');
      expect(asstMsg?.model).toBe('claude-test');
      expect(asstMsg?.inputTokens).toBe(100);

      // Usage logged
      const usage = await db.select().from(aiUsageLog).where(eq(aiUsageLog.tenantId, tenantId));
      expect(usage.length).toBeGreaterThanOrEqual(1);
      expect(usage[0]?.jobType).toBe('chat');
      expect(usage[0]?.inputTokens).toBe(100);
    });

    it('continues an existing conversation when conversationId is supplied', async () => {
      vi.spyOn(providers, 'executeWithFallback').mockResolvedValue({
        text: 'first reply',
        inputTokens: 10,
        outputTokens: 5,
        model: 'claude-test',
        provider: 'anthropic',
        durationMs: 100,
      });

      const first = await chatService.sendMessage(tenantId, userId, {
        message: 'first message',
      });

      vi.spyOn(providers, 'executeWithFallback').mockResolvedValue({
        text: 'second reply',
        inputTokens: 20,
        outputTokens: 8,
        model: 'claude-test',
        provider: 'anthropic',
        durationMs: 110,
      });

      const second = await chatService.sendMessage(tenantId, userId, {
        conversationId: first.conversationId,
        message: 'second message',
      });

      expect(second.conversationId).toBe(first.conversationId);

      const messages = await db.select().from(chatMessages)
        .where(eq(chatMessages.conversationId, first.conversationId));
      expect(messages).toHaveLength(4);
    });

    it('rejects empty messages without calling the provider', async () => {
      const spy = vi.spyOn(providers, 'executeWithFallback');
      await expect(
        chatService.sendMessage(tenantId, userId, { message: '   ' }),
      ).rejects.toThrow(/required/i);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('conversation CRUD', () => {
    beforeEach(async () => {
      await aiConfigService.updateConfig({
        isEnabled: true,
        chatSupportEnabled: true,
        chatProvider: 'anthropic',
        anthropicApiKey: 'sk-test',
      });
      await db.update(companies)
        .set({ chatSupportEnabled: true })
        .where(eq(companies.id, companyId));
    });

    it('lists only conversations belonging to the requesting user', async () => {
      // Create a conversation for our user
      const conv = await chatService.createConversation(tenantId, userId, 'Test conv');
      expect(conv.id).toBeTruthy();

      // Create a second user in the same tenant + a conversation for them
      const [otherUser] = await db.insert(users).values({
        tenantId,
        email: 'other@example.com',
        passwordHash: 'fake',
        displayName: 'Other',
      }).returning();
      await chatService.createConversation(tenantId, otherUser!.id, 'Other conv');

      const list = await chatService.listConversations(tenantId, userId);
      expect(list).toHaveLength(1);
      expect(list[0]?.title).toBe('Test conv');
    });

    it('soft-deletes (archives) a conversation', async () => {
      const conv = await chatService.createConversation(tenantId, userId, 'To delete');
      await chatService.deleteConversation(tenantId, userId, conv.id);

      // Still in db, but not in active list
      const stillThere = await db.query.chatConversations.findFirst({
        where: eq(chatConversations.id, conv.id),
      });
      expect(stillThere?.status).toBe('archived');

      const list = await chatService.listConversations(tenantId, userId);
      expect(list.find((c) => c.id === conv.id)).toBeUndefined();
    });
  });

  describe('suggestions', () => {
    it('returns screen-specific suggestions', async () => {
      const billSuggestions = chatService.getSuggestions('enter-bill');
      expect(billSuggestions.length).toBeGreaterThan(0);
      expect(billSuggestions.some((s) => /bill/i.test(s))).toBe(true);
    });

    it('returns default suggestions for unknown screens', async () => {
      const def = chatService.getSuggestions('made-up-screen');
      expect(def.length).toBeGreaterThan(0);
    });
  });
});
