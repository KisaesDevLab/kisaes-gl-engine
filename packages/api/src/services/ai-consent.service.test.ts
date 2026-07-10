// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

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

    it('M11: setting a cloud chatProvider where there was none: bumps', () => {
      const next = { ...base, chatProvider: 'anthropic' };
      expect(aiConsent.changeRequiresReconsent(base, next)).toMatch(/chat_provider_added_cloud/);
    });

    it('M11: switching chatProvider cloud A → cloud B: bumps', () => {
      const prev = { ...base, chatProvider: 'anthropic' };
      const next = { ...base, chatProvider: 'openai' };
      expect(aiConsent.changeRequiresReconsent(prev, next)).toMatch(/chat_provider_cloud_switch/);
    });

    it('M11: clearing chatProvider (cloud → none): no bump', () => {
      const prev = { ...base, chatProvider: 'anthropic' };
      const next = { ...base, chatProvider: null };
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

    it('blocks a SENSITIVE task (judgment_review) that accepting the disclosure does NOT auto-enable', async () => {
      await aiConsent.acceptSystemDisclosure(userId);
      await aiConfigService.updateConfig({ isEnabled: true, categorizationProvider: 'anthropic' });
      await aiConsent.acceptCompanyDisclosure(tenantId, companyId, userId);
      // FIX 1: accepting enables the CORE tasks (categorize now allowed), but
      // the sensitive judgment_review stays opt-in → still blocked.
      const catJob = await aiOrchestrator.createJob(tenantId, 'categorize', 'bank_feed_item', '00000000-0000-0000-0000-000000000000');
      expect(catJob.status).toBe('pending');
      await expect(
        aiOrchestrator.createJob(tenantId, 'judgment_review', 'transaction', '00000000-0000-0000-0000-000000000000'),
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
    it('accepting enables the CORE tasks but leaves SENSITIVE ones off (isolation preserved)', async () => {
      await aiConsent.acceptSystemDisclosure(userId);
      await aiConfigService.updateConfig({ isEnabled: true, categorizationProvider: 'anthropic', ocrProvider: 'anthropic' });
      await aiConsent.acceptCompanyDisclosure(tenantId, companyId, userId);

      // FIX 1: the core processing tasks are on after accept…
      const catJob = await aiOrchestrator.createJob(tenantId, 'categorize', 'bank_feed_item', '00000000-0000-0000-0000-000000000000');
      expect(catJob.status).toBe('pending');
      const ocrJob = await aiOrchestrator.createJob(tenantId, 'ocr_receipt', 'attachment', '00000000-0000-0000-0000-000000000000');
      expect(ocrJob.status).toBe('pending');

      // …but a sensitive task (enrich_vendor) stays off until explicitly enabled.
      await expect(
        aiOrchestrator.createJob(tenantId, 'enrich_vendor', 'contact', '00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(/task is disabled/i);
    });
  });

  describe('FIX 1 — consent-on-accept (core vs sensitive split; H6/H7)', () => {
    async function enableSystemAndAccept() {
      await aiConsent.acceptSystemDisclosure(userId);
      await aiConfigService.updateConfig({ isEnabled: true, categorizationProvider: 'anthropic', ocrProvider: 'anthropic' });
      await aiConsent.acceptCompanyDisclosure(tenantId, companyId, userId);
    }

    it('accepting the disclosure grants the four CORE task consents', async () => {
      await enableSystemAndAccept();
      for (const task of ['categorization', 'receipt_ocr', 'statement_parsing', 'document_classification'] as aiConsent.AiTaskKey[]) {
        const check = await aiConsent.checkTenantTaskConsent(tenantId, task, companyId);
        expect(check.allowed).toBe(true);
      }
    });

    it('report_summary (and the other sensitive tasks) stay OFF until explicitly enabled (H6)', async () => {
      await enableSystemAndAccept();
      for (const task of ['report_summary', 'judgment_review', 'enrich_vendor'] as aiConsent.AiTaskKey[]) {
        const check = await aiConsent.checkTenantTaskConsent(tenantId, task, companyId);
        expect(check.allowed).toBe(false);
        expect(check.reason).toBe('task_disabled');
      }

      // The owner opts report_summary in explicitly → now allowed.
      await aiConsent.setCompanyTaskToggles(tenantId, companyId, { report_summary: true }, userId);
      const after = await aiConsent.checkTenantTaskConsent(tenantId, 'report_summary', companyId);
      expect(after.allowed).toBe(true);
    });

    it('turning categorization back off after accept is honored (granular control intact)', async () => {
      await enableSystemAndAccept();
      await aiConsent.setCompanyTaskToggles(tenantId, companyId, { categorization: false }, userId);
      const check = await aiConsent.checkTenantTaskConsent(tenantId, 'categorization', companyId);
      expect(check.allowed).toBe(false);
      expect(check.reason).toBe('task_disabled');
    });

    it('H7 isolation: accepting for company A does NOT enable company B', async () => {
      await aiConsent.acceptSystemDisclosure(userId);
      await aiConfigService.updateConfig({ isEnabled: true, categorizationProvider: 'anthropic' });
      // Second company in the SAME tenant.
      const [companyB] = await db.insert(companies).values({
        tenantId, businessName: 'Company B',
      }).returning();

      await aiConsent.acceptCompanyDisclosure(tenantId, companyId, userId);

      const a = await aiConsent.checkTenantTaskConsent(tenantId, 'categorization', companyId);
      const b = await aiConsent.checkTenantTaskConsent(tenantId, 'categorization', companyB!.id);
      expect(a.allowed).toBe(true);
      expect(b.allowed).toBe(false);
      expect(b.reason).toBe('company_not_opted_in');
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
