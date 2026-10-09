// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Portal "Your uploads": receipt-button uploads vs files sent against a
// document request, and a contact may open only their own file.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, companies, portalContacts, portalReceipts, documentRequests } from '../db/schema/index.js';
import { listContactUploads, getContactUploadFile } from './portal-receipts.service.js';

let tenantId = '';
let companyId = '';
let contactId = '';
let otherContactId = '';
const uniq = () => Date.now() + '-' + Math.random().toString(36).slice(2, 7);

async function mkReceipt(uploadedBy: string, filename: string, documentRequestId: string | null = null) {
  const [r] = await db.insert(portalReceipts).values({
    tenantId, companyId, uploadedBy, uploadedByType: 'contact',
    storageKey: `${tenantId}/receipts/${uniq()}.pdf`, filename, mimeType: 'application/pdf',
    status: 'pending_ocr', documentRequestId,
  }).returning();
  return r!.id;
}

beforeEach(async () => {
  const [t] = await db.insert(tenants).values({ name: 'Uploads', slug: `uploads-${uniq()}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Uploads Co' }).returning();
  companyId = c!.id;
  const [pc] = await db.insert(portalContacts).values({ tenantId, email: `a-${uniq()}@ex.com`, status: 'active' }).returning();
  contactId = pc!.id;
  const [oc] = await db.insert(portalContacts).values({ tenantId, email: `b-${uniq()}@ex.com`, status: 'active' }).returning();
  otherContactId = oc!.id;
});

afterEach(async () => {
  await db.delete(portalReceipts).where(eq(portalReceipts.tenantId, tenantId));
  await db.delete(documentRequests).where(eq(documentRequests.tenantId, tenantId));
  await db.delete(portalContacts).where(eq(portalContacts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.id, companyId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

describe('portal contact uploads', () => {
  it('separates receipt-button uploads from document-request files, and shows only the contact\'s own', async () => {
    const [req] = await db.insert(documentRequests).values({
      tenantId, companyId, contactId, documentType: 'cc_statement', description: 'Sept 2025 Amex statement',
      periodLabel: 'Sept 2025', status: 'submitted',
    }).returning();
    const receipt = await mkReceipt(contactId, 'lunch.pdf');
    const stmt = await mkReceipt(contactId, 'september 2025.pdf', req!.id);
    await mkReceipt(otherContactId, 'not-mine.pdf');

    const receipts = await listContactUploads(tenantId, { companyId, contactId, kind: 'receipt' });
    expect(receipts.map((r) => r.id)).toEqual([receipt]);

    const requested = await listContactUploads(tenantId, { companyId, contactId, kind: 'request' });
    expect(requested.map((r) => r.id)).toEqual([stmt]);
    expect(requested[0]!.requestDescription).toBe('Sept 2025 Amex statement');

    const all = await listContactUploads(tenantId, { companyId, contactId });
    expect(all.map((r) => r.id).sort()).toEqual([receipt, stmt].sort());
  });

  it('refuses to serve another contact\'s file', async () => {
    const theirs = await mkReceipt(otherContactId, 'not-mine.pdf');
    await expect(getContactUploadFile(tenantId, contactId, theirs)).rejects.toThrow(/not found/i);
  });
});
