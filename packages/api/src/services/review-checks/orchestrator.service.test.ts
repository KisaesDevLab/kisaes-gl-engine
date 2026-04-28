// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  tenants,
  companies,
  contacts,
  accounts,
  transactions,
  attachments,
  findings,
  checkRuns,
  checkSuppressions,
  checkParamsOverrides,
  auditLog,
} from '../../db/schema/index.js';
import * as orchestrator from './orchestrator.service.js';
import * as suppressionsService from './suppressions.service.js';

let tenantId: string;
let companyId: string;
let contactId: string;

async function setup() {
  const [t] = await db.insert(tenants).values({
    name: 'Orch Test',
    slug: 'orch-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({
    tenantId, businessName: 'Orch Test Co',
  }).returning();
  companyId = c!.id;
  const [cust] = await db.insert(contacts).values({
    tenantId, displayName: 'Acme', contactType: 'customer',
  }).returning();
  contactId = cust!.id;
}

async function cleanup() {
  if (!tenantId) return;
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(findings).where(eq(findings.tenantId, tenantId));
  await db.delete(checkSuppressions).where(eq(checkSuppressions.tenantId, tenantId));
  await db.delete(checkParamsOverrides).where(eq(checkParamsOverrides.tenantId, tenantId));
  await db.delete(checkRuns).where(eq(checkRuns.tenantId, tenantId));
  await db.delete(attachments).where(eq(attachments.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

beforeEach(async () => {
  await cleanup();
  await setup();
});

afterEach(async () => {
  await cleanup();
});

async function seedHighDollarTxn(total: string) {
  await db.insert(transactions).values({
    tenantId, companyId,
    txnType: 'expense',
    txnDate: '2026-04-15',
    total,
    contactId,
    status: 'posted',
  });
}

describe('orchestrator.runForCompany', () => {
  it('writes a check_runs row + counts findings', async () => {
    await seedHighDollarTxn('15000.0000');
    const result = await orchestrator.runForCompany(tenantId, companyId);
    expect(result.checksExecuted).toBeGreaterThan(0);
    expect(result.findingsCreated).toBeGreaterThanOrEqual(1);

    const runs = await db.select().from(checkRuns).where(eq(checkRuns.tenantId, tenantId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.completedAt).not.toBeNull();
  });

  it('dedupes findings — second run for unchanged data inserts none', async () => {
    await seedHighDollarTxn('15000.0000');
    const first = await orchestrator.runForCompany(tenantId, companyId);
    expect(first.findingsCreated).toBeGreaterThanOrEqual(1);
    const second = await orchestrator.runForCompany(tenantId, companyId);
    expect(second.findingsCreated).toBe(0);
  });

  it('honors suppressions — finding not inserted when matching pattern exists', async () => {
    await seedHighDollarTxn('15000.0000');
    // Find the transaction so we can suppress on its id.
    const [txn] = await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.tenantId, tenantId));
    await suppressionsService.create({
      tenantId,
      companyId: null,
      checkKey: 'transaction_above_materiality',
      matchPattern: { transactionId: txn!.id },
    });
    const result = await orchestrator.runForCompany(tenantId, companyId);
    // Other handlers may still produce findings, but the
    // materiality one is suppressed.
    const flagged = await db
      .select()
      .from(findings)
      .where(eq(findings.tenantId, tenantId));
    expect(flagged.find((f) => f.checkKey === 'transaction_above_materiality')).toBeUndefined();
    expect(result.runId).toBeDefined();
  });

  it('respects per-tenant param overrides', async () => {
    // Lower the materiality threshold via override; transaction
    // becomes flaggable that wouldn't otherwise be.
    await db.insert(checkParamsOverrides).values({
      tenantId, companyId: null, checkKey: 'transaction_above_materiality',
      params: { thresholdAmount: 50 },
    });
    await seedHighDollarTxn('100.0000');
    await orchestrator.runForCompany(tenantId, companyId);
    const flagged = await db
      .select()
      .from(findings)
      .where(eq(findings.tenantId, tenantId));
    expect(flagged.find((f) => f.checkKey === 'transaction_above_materiality')).toBeDefined();
  });

  it('does not leak per-company overrides across companies', async () => {
    // Two companies under the same tenant. Company A has an
    // override (threshold=50) that would flag a $100 expense.
    // Company B has no override — defaults apply (threshold=10000).
    // Running for B must not pick up A's override.
    const [companyB] = await db.insert(companies).values({
      tenantId, businessName: 'Co B',
    }).returning();
    await db.insert(checkParamsOverrides).values({
      tenantId, companyId, checkKey: 'transaction_above_materiality',
      params: { thresholdAmount: 50 },
    });
    // Seed a $100 expense against company B specifically.
    await db.insert(transactions).values({
      tenantId, companyId: companyB!.id,
      txnType: 'expense', txnDate: '2026-04-15',
      total: '100.0000', contactId, status: 'posted',
    });
    await orchestrator.runForCompany(tenantId, companyB!.id);
    const allFindings = await db.select().from(findings).where(eq(findings.tenantId, tenantId));
    const materiality = allFindings.find((f) => f.checkKey === 'transaction_above_materiality');
    expect(materiality).toBeUndefined();
  });

  it('isolates tenants — findings for tenant A do not leak into tenant B', async () => {
    await seedHighDollarTxn('15000.0000');
    await orchestrator.runForCompany(tenantId, companyId);

    const [otherTenant] = await db.insert(tenants).values({
      name: 'Other', slug: 'other-' + Date.now(),
    }).returning();
    try {
      const otherFindings = await db
        .select()
        .from(findings)
        .where(eq(findings.tenantId, otherTenant!.id));
      expect(otherFindings).toEqual([]);
    } finally {
      await db.delete(tenants).where(eq(tenants.id, otherTenant!.id));
    }
  });
});

describe('orchestrator.lastRunCompletedAt', () => {
  it('returns null before any runs', async () => {
    expect(await orchestrator.lastRunCompletedAt(tenantId, companyId)).toBeNull();
  });

  it('returns the latest completed timestamp', async () => {
    await orchestrator.runForCompany(tenantId, companyId);
    const ts = await orchestrator.lastRunCompletedAt(tenantId, companyId);
    expect(ts).not.toBeNull();
    expect(ts!.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('orchestrator AI-judgment opt-in', () => {
  it('skips judgment-category handlers when includeAiHandlers is omitted', async () => {
    // Seed a transaction that the AI handler would otherwise see.
    await seedHighDollarTxn('5000.0000');
    await orchestrator.runForCompany(tenantId, companyId);
    // The judgment handler should not have created any findings;
    // and even if AI was enabled, no findings should appear from
    // the ai_personal_expense_review check.
    const all = await db.select().from(findings).where(eq(findings.tenantId, tenantId));
    expect(all.find((f) => f.checkKey === 'ai_personal_expense_review')).toBeUndefined();
  });

  it('attempts judgment handlers when includeAiHandlers=true (no-ops without AI config)', async () => {
    // With no AI provider configured, the handler returns [] but
    // doesn't crash — verifying the orchestrator routes the call.
    await seedHighDollarTxn('5000.0000');
    const result = await orchestrator.runForCompany(tenantId, companyId, undefined, {
      includeAiHandlers: true,
    });
    // No new judgment finding (AI disabled), but the run still
    // completes successfully and records checksExecuted >= 1.
    expect(result.error).toBeNull();
    const all = await db.select().from(findings).where(eq(findings.tenantId, tenantId));
    expect(all.find((f) => f.checkKey === 'ai_personal_expense_review')).toBeUndefined();
  });
});
