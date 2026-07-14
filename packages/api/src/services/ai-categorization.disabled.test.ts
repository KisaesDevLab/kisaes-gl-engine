// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// F7 — the "Enable this function" checkbox must actually gate execution.
// When taskOptions.categorization.enabled === false, categorize() (the
// service behind POST /ai/categorize) throws a clear AppError with the
// stable code `ai_function_disabled` (the route serializes statusCode +
// code verbatim through the error middleware).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog,
  aiConfig, aiJobs, bankConnections, bankFeedItems,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as aiCategorization from './ai-categorization.service.js';
import { AppError } from '../utils/errors.js';
import { encrypt } from '../utils/encryption.js';

// The tenant created by the current test's setupFeedItem(); cleanup is
// scoped to it so concurrently-running suites' data survives.
let tenantId = '';

async function cleanDb() {
  if (tenantId) {
    await db.delete(aiJobs).where(eq(aiJobs.tenantId, tenantId));
  }
  // global table — no tenant column; suites share it by design
  await db.delete(aiConfig);
  if (!tenantId) return;
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(
    inArray(sessions.userId, db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId))),
  );
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

describe('categorize() — per-function disabled gate', () => {
  beforeEach(cleanDb);
  afterEach(cleanDb);

  async function setupFeedItem(): Promise<{ tenantId: string; feedItemId: string }> {
    const { user } = await authService.register({
      email: `fn-disabled-${Date.now()}@example.com`,
      password: 'password123',
      displayName: 'Fn Disabled Test',
      companyName: 'Fn Disabled Co',
    });
    tenantId = user.tenantId; // track for the tenant-scoped cleanup
    const account = await db.query.accounts.findFirst({ where: eq(accounts.tenantId, user.tenantId) });
    const [conn] = await db.insert(bankConnections).values({
      tenantId: user.tenantId,
      accountId: account!.id,
      provider: 'manual',
    }).returning();
    const [item] = await db.insert(bankFeedItems).values({
      tenantId: user.tenantId,
      bankConnectionId: conn!.id,
      feedDate: '2026-06-01',
      description: 'ZZQX SOME VENDOR 001',
      originalDescription: 'ZZQX SOME VENDOR 001',
      amount: '42.0000',
      status: 'pending',
    }).returning();
    return { tenantId: user.tenantId, feedItemId: item!.id };
  }

  it('throws ai_function_disabled (400) when the checkbox is off', async () => {
    const { tenantId, feedItemId } = await setupFeedItem();
    await db.insert(aiConfig).values({
      isEnabled: true,
      categorizationProvider: 'anthropic',
      anthropicApiKeyEncrypted: encrypt('sk-test'),
      taskOptions: { categorization: { enabled: false } },
    });

    let caught: AppError | undefined;
    try {
      await aiCategorization.categorize(tenantId, feedItemId);
    } catch (err) {
      caught = err as AppError;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect(caught!.statusCode).toBe(400);
    expect(caught!.code).toBe('ai_function_disabled');
    expect(caught!.message).toContain('disabled in Admin → AI');
  });

  it('the disabled gate is per-function: disabling OCR does not block categorization config checks', async () => {
    const { tenantId, feedItemId } = await setupFeedItem();
    await db.insert(aiConfig).values({
      isEnabled: true,
      categorizationProvider: 'anthropic',
      // No API key at all — categorize should get PAST the enabled gate
      // (ocr disabled is irrelevant) and fail later on the provider call,
      // NOT with ai_function_disabled. The fallback chain is pinned to
      // anthropic-only so the test can't accidentally reach a live local
      // Ollama on the dev machine.
      taskOptions: { ocr: { enabled: false }, categorization: { fallbackChain: ['anthropic'] } },
    });

    let caught: (Error & { code?: string }) | undefined;
    try {
      await aiCategorization.categorize(tenantId, feedItemId);
    } catch (err) {
      caught = err as Error & { code?: string };
    }

    expect(caught).toBeDefined();
    expect(caught!.code).not.toBe('ai_function_disabled');
  });
});
