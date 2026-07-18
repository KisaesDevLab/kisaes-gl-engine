// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// statement_routing modes on recurring document requests:
//   'inbox'                → receipt parks at awaits_routing, parser NOT run
//   'statement_processing' → parser runs immediately, receipt →
//                            statement_review, request fulfilled; parse
//                            failure parks the receipt recoverably
//   createRule/updateRule keep mode ↔ bankConnectionId consistent

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, companies, portalContacts, portalReceipts, documentRequests,
  recurringDocumentRequests, attachments,
} from '../db/schema/index.js';

const parseMock = vi.fn();
vi.mock('./ai-statement-parser.service.js', () => ({
  parseStatement: (...args: unknown[]) => parseMock(...args),
}));

import { routeStatementUpload } from './statement-routing.service.js';
import { createRule, updateRule } from './recurring-doc-request.service.js';

let tenantId = '';
let companyId = '';
let contactId = '';
const uniq = Date.now() + '-' + Math.random().toString(36).slice(2, 6);

async function seedRule(statementRouting: string) {
  const [rule] = await db.insert(recurringDocumentRequests).values({
    tenantId, companyId, contactId,
    documentType: 'bank_statement', description: 'Checking xxxx-1234',
    frequency: 'monthly', intervalValue: 1, dayOfMonth: 3,
    nextIssueAt: new Date(), dueDaysAfterIssue: 7, cadenceDays: [3, 7, 14],
    active: true, statementRouting,
  }).returning();
  const [req] = await db.insert(documentRequests).values({
    tenantId, companyId, recurringId: rule!.id, contactId,
    documentType: 'bank_statement', description: 'Checking xxxx-1234',
    periodLabel: '2026-07-' + statementRouting, status: 'pending',
  }).returning();
  const [receipt] = await db.insert(portalReceipts).values({
    tenantId, companyId, uploadedBy: contactId, uploadedByType: 'contact',
    storageKey: `${tenantId}/receipts/stmt-${uniq}.pdf`, filename: 'stmt.pdf',
    mimeType: 'application/pdf', status: 'pending_ocr', documentRequestId: req!.id,
  }).returning();
  return { rule: rule!, req: req!, receipt: receipt! };
}

beforeEach(async () => {
  parseMock.mockReset();
  const [t] = await db.insert(tenants).values({ name: 'StmtRoute', slug: 'stmt-route-' + uniq + Math.random().toString(36).slice(2, 5) }).returning();
  tenantId = t!.id;
  const [co] = await db.insert(companies).values({ tenantId, businessName: 'Stmt Co' }).returning();
  companyId = co!.id;
  const [pc] = await db.insert(portalContacts).values({
    tenantId, email: `stmt-route-${uniq}@example.com`, status: 'active',
  }).returning();
  contactId = pc!.id;
});

afterEach(async () => {
  const { bankConnections } = await import('../db/schema/index.js');
  await db.delete(attachments).where(eq(attachments.tenantId, tenantId));
  await db.delete(recurringDocumentRequests).where(eq(recurringDocumentRequests.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.execute(
    // audit rows reference nothing but block nothing — clear by tenant
    (await import('drizzle-orm')).sql`DELETE FROM audit_log WHERE tenant_id = ${tenantId}`,
  );
  await db.delete(portalReceipts).where(eq(portalReceipts.tenantId, tenantId));
  await db.delete(documentRequests).where(eq(documentRequests.tenantId, tenantId));
  await db.delete(recurringDocumentRequests).where(eq(recurringDocumentRequests.tenantId, tenantId));
  await db.delete(portalContacts).where(eq(portalContacts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.id, companyId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

function routeInput(req: { id: string; recurringId: string | null }, receiptId: string) {
  return {
    tenantId, receiptId, documentRequestId: req.id, contactId,
    recurringId: req.recurringId, documentType: 'bank_statement' as const,
  };
}

describe('routeStatementUpload — statement_routing modes', () => {
  it("'inbox' parks the receipt for manual pick and never parses", async () => {
    const { req, receipt } = await seedRule('inbox');
    const result = await routeStatementUpload(routeInput(req, receipt.id));
    expect(result.status).toBe('awaits_routing');
    expect(parseMock).not.toHaveBeenCalled();
    const r = await db.query.portalReceipts.findFirst({ where: eq(portalReceipts.id, receipt.id) });
    expect(r?.status).toBe('awaits_routing');
    const d = await db.query.documentRequests.findFirst({ where: eq(documentRequests.id, req.id) });
    expect(d?.status).toBe('pending'); // fulfilled only when the CPA routes it
  });

  it("'statement_processing' parses immediately, fulfils the request, receipt → statement_review", async () => {
    parseMock.mockResolvedValue({ transactions: [] });
    const { req, receipt } = await seedRule('statement_processing');
    const result = await routeStatementUpload(routeInput(req, receipt.id));
    expect(result.status).toBe('parsed_for_review');
    expect(parseMock).toHaveBeenCalledTimes(1);

    // Shadow attachment for the parse job exists and points at the receipt.
    const shadows = await db.select().from(attachments)
      .where(inArray(attachments.attachableId, [receipt.id]));
    expect(shadows).toHaveLength(1);
    expect(shadows[0]!.attachableType).toBe('portal_receipt_statement');
    expect(parseMock).toHaveBeenCalledWith(tenantId, shadows[0]!.id);

    const r = await db.query.portalReceipts.findFirst({ where: eq(portalReceipts.id, receipt.id) });
    expect(r?.status).toBe('statement_review');
    const d = await db.query.documentRequests.findFirst({ where: eq(documentRequests.id, req.id) });
    expect(d?.status).toBe('submitted');
    expect(d?.submittedReceiptId).toBe(receipt.id);
  });

  it("'statement_processing' parse failure parks the receipt, request stays pending", async () => {
    parseMock.mockRejectedValue(new Error('vision model unavailable'));
    const { req, receipt } = await seedRule('statement_processing');
    const result = await routeStatementUpload(routeInput(req, receipt.id));
    expect(result.status).toBe('awaits_routing');
    const r = await db.query.portalReceipts.findFirst({ where: eq(portalReceipts.id, receipt.id) });
    expect(r?.status).toBe('awaits_routing');
    const d = await db.query.documentRequests.findFirst({ where: eq(documentRequests.id, req.id) });
    expect(d?.status).toBe('pending');
  });
});

describe('createRule / updateRule — routing mode consistency', () => {
  const base = {
    contactId: '', documentType: 'bank_statement' as const, description: 'x',
    cadenceKind: 'frequency' as const, frequency: 'monthly' as const,
    intervalValue: 1, dayOfMonth: 3, dueDaysAfterIssue: 7,
    cadenceDays: [3, 7, 14], active: true,
  };

  it('statement_processing never stores a bound connection', async () => {
    const { id } = await createRule(tenantId, contactId, {
      ...base, contactId,
      statementRouting: 'statement_processing',
      bankConnectionId: crypto.randomUUID(), // deliberately contradictory
    });
    const row = await db.query.recurringDocumentRequests.findFirst({ where: eq(recurringDocumentRequests.id, id) });
    expect(row?.statementRouting).toBe('statement_processing');
    expect(row?.bankConnectionId).toBeNull();
  });

  it('omitted mode derives from bankConnectionId; switching away clears the binding', async () => {
    const { id } = await createRule(tenantId, contactId, { ...base, contactId });
    let row = await db.query.recurringDocumentRequests.findFirst({ where: eq(recurringDocumentRequests.id, id) });
    expect(row?.statementRouting).toBe('inbox');

    await updateRule(tenantId, contactId, id, { statementRouting: 'statement_processing' });
    row = await db.query.recurringDocumentRequests.findFirst({ where: eq(recurringDocumentRequests.id, id) });
    expect(row?.statementRouting).toBe('statement_processing');
    expect(row?.bankConnectionId).toBeNull();
  });

  it('legacy connection-only PATCH keeps the mode in lockstep', async () => {
    // Bind-without-mode → auto_import; clear-without-mode → inbox (an
    // unbound auto_import would silently fall back to the heuristic).
    const { id } = await createRule(tenantId, contactId, { ...base, contactId });
    const { bankConnections } = await import('../db/schema/index.js');
    const [conn] = await db.insert(bankConnections).values({
      tenantId, companyId, accountId: crypto.randomUUID(), institutionName: 'Test Bank',
    }).returning();
    const connId = conn!.id;

    await updateRule(tenantId, contactId, id, { bankConnectionId: connId });
    let row = await db.query.recurringDocumentRequests.findFirst({ where: eq(recurringDocumentRequests.id, id) });
    expect(row?.statementRouting).toBe('auto_import');
    expect(row?.bankConnectionId).toBe(connId);

    await updateRule(tenantId, contactId, id, { bankConnectionId: null });
    row = await db.query.recurringDocumentRequests.findFirst({ where: eq(recurringDocumentRequests.id, id) });
    expect(row?.statementRouting).toBe('inbox');
    expect(row?.bankConnectionId).toBeNull();
  });

  it('a PATCH without routing fields leaves existing routing untouched', async () => {
    // The UI omits statementRouting/bankConnectionId when the flag is
    // off or the doc type has no routing — an unrelated edit must not
    // reset the rule's configuration.
    const { id } = await createRule(tenantId, contactId, {
      ...base, contactId, statementRouting: 'statement_processing',
    });
    await updateRule(tenantId, contactId, id, { description: 'changed cadence note' });
    const row = await db.query.recurringDocumentRequests.findFirst({ where: eq(recurringDocumentRequests.id, id) });
    expect(row?.statementRouting).toBe('statement_processing');
  });

  it('accepts the new document types', async () => {
    for (const dt of ['sales_tax_report', 'accounts_receivable', 'inventory', 'accounts_payable', 'loan_balance'] as const) {
      const { id } = await createRule(tenantId, contactId, { ...base, contactId, documentType: dt });
      const row = await db.query.recurringDocumentRequests.findFirst({ where: eq(recurringDocumentRequests.id, id) });
      expect(row?.documentType).toBe(dt);
    }
  });
});
