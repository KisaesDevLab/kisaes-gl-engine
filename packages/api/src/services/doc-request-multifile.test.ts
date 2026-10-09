// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Multi-file document requests: portal uploads with keepRequestOpen link
// to the request without completing it; "I'm done" (completeByContact)
// submits it with every file. Uploads without the flag (Vibe PM, staff)
// still complete on upload.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, companies, portalContacts, portalReceipts, documentRequests } from '../db/schema/index.js';

vi.mock('./storage/storage-provider.factory.js', () => ({
  getProviderForTenant: async () => ({ upload: async () => undefined, download: async () => Buffer.from('x') }),
}));

import { uploadReceipt } from './portal-receipts.service.js';
import { completeByContact, listForPortalContact } from './recurring-doc-request.service.js';

let tenantId = '';
let companyId = '';
let contactId = '';
const uniq = () => Date.now() + '-' + Math.random().toString(36).slice(2, 7);

async function mkRequest(description = 'Receipts for September') {
  const [r] = await db.insert(documentRequests).values({
    tenantId, companyId, contactId, documentType: 'receipt_batch', description,
    periodLabel: `Sept ${uniq()}`, status: 'pending',
  }).returning();
  return r!.id;
}

const up = (documentRequestId: string, name: string, keepRequestOpen?: boolean) => uploadReceipt({
  tenantId, companyId, uploadedBy: contactId, uploadedByType: 'contact', captureSource: 'portal',
  filename: name, mimeType: 'application/pdf', buffer: Buffer.from(`${name}-${uniq()}`),
  documentRequestId, keepRequestOpen,
});

const statusOf = async (id: string) =>
  (await db.select().from(documentRequests).where(eq(documentRequests.id, id)))[0]!;

beforeEach(async () => {
  const [t] = await db.insert(tenants).values({ name: 'Multi', slug: `multi-${uniq()}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Multi Co' }).returning();
  companyId = c!.id;
  const [pc] = await db.insert(portalContacts).values({ tenantId, email: `m-${uniq()}@ex.com`, status: 'active' }).returning();
  contactId = pc!.id;
});

afterEach(async () => {
  await db.execute((await import('drizzle-orm')).sql`DELETE FROM audit_log WHERE tenant_id = ${tenantId}`);
  await db.delete(portalReceipts).where(eq(portalReceipts.tenantId, tenantId));
  await db.delete(documentRequests).where(eq(documentRequests.tenantId, tenantId));
  await db.delete(portalContacts).where(eq(portalContacts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.id, companyId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

describe('multi-file document requests', () => {
  it('keeps the request open across uploads, then "I\'m done" submits it with every file', async () => {
    const reqId = await mkRequest();
    await expect(completeByContact(tenantId, contactId, reqId)).rejects.toThrow(/at least one file/);

    await up(reqId, 'receipt-1.pdf', true);
    const second = await up(reqId, 'receipt-2.pdf', true);
    expect((await statusOf(reqId)).status).toBe('pending');

    const listed = await listForPortalContact(tenantId, contactId);
    expect(listed.find((r) => r.id === reqId)!.files!.map((f) => f.filename)).toEqual(['receipt-1.pdf', 'receipt-2.pdf']);

    expect(await completeByContact(tenantId, contactId, reqId)).toEqual({ fileCount: 2 });
    const done = await statusOf(reqId);
    expect(done.status).toBe('submitted');
    expect(done.submittedReceiptId).toBe(second.id);
    expect(done.reviewedAt).toBeNull(); // shows as New for staff
    await expect(completeByContact(tenantId, contactId, reqId)).rejects.toThrow(/already complete/);
  });

  it('another contact cannot complete the request', async () => {
    const reqId = await mkRequest();
    await up(reqId, 'a.pdf', true);
    const [other] = await db.insert(portalContacts).values({ tenantId, email: `o-${uniq()}@ex.com`, status: 'active' }).returning();
    await expect(completeByContact(tenantId, other!.id, reqId)).rejects.toThrow(/not found/i);
  });

  it('an upload without keepRequestOpen still completes the request (Vibe PM / staff behaviour)', async () => {
    const reqId = await mkRequest();
    await up(reqId, 'only.pdf');
    expect((await statusOf(reqId)).status).toBe('submitted');
  });
});
