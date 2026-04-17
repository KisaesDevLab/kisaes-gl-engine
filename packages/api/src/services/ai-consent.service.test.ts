// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, aiConfig, aiJobs, aiUsageLog,
  aiPromptTemplates, categorizationHistory, bankFeedItems, auditLog,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as aiConfigService from './ai-config.service.js';
import * as aiConsent from './ai-consent.service.js';
import * as aiOrchestrator from './ai-orchestrator.service.js';
import { AppError } from '../utils/errors.js';

let tenantId: string;
let userId: string;
let companyId: string;

async function cleanDb() {
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
    email: 'consent-test@example.com',
    password: 'password123',
    displayName: 'Consent Test User',
    companyName: 'Consent Test Co',
  });
  userId = reg.user.id;
  tenantId = reg.user.tenantId;
  const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) });
  companyId = company!.id;
}

describe('ai-consent service', () => {
  beforeEach(async () => { await cleanDb(); await setup(); });
  afterEach(async () => { await cleanDb(); });

  describe('system disclosure gate', () => {
    it('blocks updateConfig({ isEnabled: true }) before admin accepts disclosure', async () => {
      await expect(aiConfigService.updateConfig({ isEnabled: true })).rejects.toBeInstanceOf(AppError);
    });

    it('allows updateConfig({ isEnabled: true }) after admin accepts', async () => {
      await aiConsent.acceptSystemDisclosure(userId);
      const cfg = await aiConfigService.updateConfig({ isEnabled: true, categorizationProvider: 'anthropic' });
      expect(cfg.isEnabled).toBe(true);
    });

    it('records acceptor identity and timestamp', async () => {
      await aiConsent.acceptSystemDisclosure(userId);
      const d = await aiConsent.getSystemDisclosure();
      expect(d.acceptedBy).toBe(userId);
      expect(d.acceptedAt).toBeInstanceOf(Date);
    });
  });

  describe('changeRequiresReconsent — rules from addendum', () => {
    const base: aiConsent.DataFlowSnapshot = {
      isEnabled: true,
      categorizationProvider: 'ollama',
      ocrProvider: 'ollama',
      documentClassificationProvider: 'ollama',
      chatProvider: null,
      piiProtectionLevel: 'strict',
      cloudVisionEnabled: false,
    };

    it('self-hosted → cloud: bumps', () => {
      const next = { ...base, categorizationProvider: 'anthropic' };
      expect(aiConsent.changeRequiresReconsent(base, next)).toMatch(/categorization_provider_local_to_cloud/);
    });

    it('cloud → self-hosted: does NOT bump (more protective)', () => {
      const prev = { ...base, categorizationProvider: 'anthropic' };
      const next = { ...base, categorizationProvider: 'ollama' };
      expect(aiConsent.changeRequiresReconsent(prev, next)).toBeNull();
    });

    it('cloud A → cloud B: bumps (different data policy)', () => {
      const prev = { ...base, categorizationProvider: 'anthropic' };
      const next = { ...base, categorizationProvider: 'openai' };
      expect(aiConsent.changeRequiresReconsent(prev, next)).toMatch(/cloud_switch/);
    });

    it('strict → permissive: bumps', () => {
      const next = { ...base, piiProtectionLevel: 'permissive' };
      expect(aiConsent.changeRequiresReconsent(base, next)).toMatch(/pii_protection_level_loosened/);
    });

    it('permissive → strict: does NOT bump', () => {
      const prev = { ...base, piiProtectionLevel: 'permissive' };
      const next = { ...base, piiProtectionLevel: 'strict' };
      expect(aiConsent.changeRequiresReconsent(prev, next)).toBeNull();
    });

    it('cloud_vision off → on: bumps', () => {
      const next = { ...base, cloudVisionEnabled: true };
      expect(aiConsent.changeRequiresReconsent(base, next)).toMatch(/cloud_vision_enabled/);
    });

    it('dropping a provider (clearing it): no bump', () => {
      const prev = { ...base, ocrProvider: 'anthropic' };
      const next = { ...base, ocrProvider: null };
      expect(aiConsent.changeRequiresReconsent(prev, next)).toBeNull();
    });
  });

  describe('invalidateCompanyConsent integration via updateConfig', () => {
    async function enableAndOptIn(provider: string) {
      await aiConsent.acceptSystemDisclosure(userId);
      await aiConfigService.updateConfig({ isEnabled: true, categorizationProvider: provider });
      await aiConsent.acceptCompanyDisclosure(tenantId, companyId, userId);
      await aiConsent.setCompanyTaskToggles(tenantId, companyId, { categorization: true }, userId);
    }

    it('switching ollama → anthropic invalidates company consent', async () => {
      await enableAndOptIn('ollama');
      const before = await aiConsent.getCompanyDisclosure(tenantId, companyId);
      expect(before.isStale).toBe(false);

      // Super admin switches categorization to a cloud provider.
      await aiConfigService.updateConfig({ categorizationProvider: 'anthropic' });

      const after = await aiConsent.getCompanyDisclosure(tenantId, companyId);
      expect(after.isStale).toBe(true);
      expect(after.systemVersion).toBeGreaterThan(before.systemVersion);
    });

    it('switching anthropic → ollama does NOT invalidate', async () => {
      await enableAndOptIn('anthropic');
      const before = await aiConsent.getCompanyDisclosure(tenantId, companyId);

      await aiConfigService.updateConfig({ categorizationProvider: 'ollama' });

      const after = await aiConsent.getCompanyDisclosure(tenantId, companyId);
      expect(after.isStale).toBe(false);
      expect(after.systemVersion).toBe(before.systemVersion);
    });

    it('raising PII level from strict → permissive invalidates', async () => {
      await enableAndOptIn('anthropic');

      await aiConfigService.updateConfig({ piiProtectionLevel: 'permissive' });

      const after = await aiConsent.getCompanyDisclosure(tenantId, companyId);
      expect(after.isStale).toBe(true);
    });
  });

  describe('orchestrator gate — two-tier matrix', () => {
    it('blocks job when system disabled', async () => {
      await expect(
        aiOrchestrator.createJob(tenantId, 'categorize', 'bank_feed_item', '00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow();
    });

    it('blocks job when company not opted in', async () => {
      await aiConsent.acceptSystemDisclosure(userId);
      await aiConfigService.updateConfig({ isEnabled: true, categorizationProvider: 'anthropic' });
      await expect(
        aiOrchestrator.createJob(tenantId, 'categorize', 'bank_feed_item', '00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(/has not opted in|company/i);
    });

    it('blocks job when task is disabled even though company is opted in', async () => {
      await aiConsent.acceptSystemDisclosure(userId);
      await aiConfigService.updateConfig({ isEnabled: true, categorizationProvider: 'anthropic' });
      await aiConsent.acceptCompanyDisclosure(tenantId, companyId, userId);
      // Do NOT toggle categorization on.
      await expect(
        aiOrchestrator.createJob(tenantId, 'categorize', 'bank_feed_item', '00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(/task is disabled/i);
    });

    it('blocks job when company consent is stale', async () => {
      await aiConsent.acceptSystemDisclosure(userId);
      await aiConfigService.updateConfig({ isEnabled: true, categorizationProvider: 'ollama' });
      await aiConsent.acceptCompanyDisclosure(tenantId, companyId, userId);
      await aiConsent.setCompanyTaskToggles(tenantId, companyId, { categorization: true }, userId);

      // Admin makes a loosening change after consent was accepted.
      await aiConfigService.updateConfig({ categorizationProvider: 'anthropic' });

      await expect(
        aiOrchestrator.createJob(tenantId, 'categorize', 'bank_feed_item', '00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(/re-accept|review/i);
    });

    it('allows job when both tiers + task + consent-current line up', async () => {
      await aiConsent.acceptSystemDisclosure(userId);
      await aiConfigService.updateConfig({ isEnabled: true, categorizationProvider: 'anthropic' });
      await aiConsent.acceptCompanyDisclosure(tenantId, companyId, userId);
      await aiConsent.setCompanyTaskToggles(tenantId, companyId, { categorization: true }, userId);

      const job = await aiOrchestrator.createJob(tenantId, 'categorize', 'bank_feed_item', '00000000-0000-0000-0000-000000000000');
      expect(job.status).toBe('pending');
    });
  });

  describe('per-task isolation', () => {
    it('enabling receipt_ocr does not enable categorization', async () => {
      await aiConsent.acceptSystemDisclosure(userId);
      await aiConfigService.updateConfig({ isEnabled: true, categorizationProvider: 'anthropic', ocrProvider: 'anthropic' });
      await aiConsent.acceptCompanyDisclosure(tenantId, companyId, userId);
      await aiConsent.setCompanyTaskToggles(tenantId, companyId, { receipt_ocr: true }, userId);

      // Categorization still disabled → blocked.
      await expect(
        aiOrchestrator.createJob(tenantId, 'categorize', 'bank_feed_item', '00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(/task is disabled/i);

      // Receipt OCR task allowed.
      const job = await aiOrchestrator.createJob(tenantId, 'ocr_receipt', 'attachment', '00000000-0000-0000-0000-000000000000');
      expect(job.status).toBe('pending');
    });
  });

  describe('revoke', () => {
    it('turns off aiEnabled and clears per-task toggles', async () => {
      await aiConsent.acceptSystemDisclosure(userId);
      await aiConfigService.updateConfig({ isEnabled: true, categorizationProvider: 'anthropic' });
      await aiConsent.acceptCompanyDisclosure(tenantId, companyId, userId);
      await aiConsent.setCompanyTaskToggles(tenantId, companyId, { categorization: true }, userId);

      await aiConsent.revokeCompanyConsent(tenantId, companyId, userId);

      const d = await aiConsent.getCompanyDisclosure(tenantId, companyId);
      expect(d.aiEnabled).toBe(false);
      expect(d.enabledTasks.categorization).toBe(false);
      expect(d.acceptedAt).toBeNull();
    });
  });

  describe('cross-tenant guard', () => {
    it('acceptCompanyDisclosure refuses a companyId from a different tenant', async () => {
      // Create a second tenant + company.
      const other = await authService.register({
        email: 'other@example.com', password: 'password123',
        displayName: 'Other', companyName: 'Other Co',
      });
      const otherCompany = await db.query.companies.findFirst({ where: eq(companies.tenantId, other.user.tenantId) });

      await aiConsent.acceptSystemDisclosure(userId);
      await aiConfigService.updateConfig({ isEnabled: true, categorizationProvider: 'anthropic' });

      // Our tenant tries to accept for the other tenant's company.
      await expect(
        aiConsent.acceptCompanyDisclosure(tenantId, otherCompany!.id, userId),
      ).rejects.toThrow(/not found/i);
    });
  });
});
