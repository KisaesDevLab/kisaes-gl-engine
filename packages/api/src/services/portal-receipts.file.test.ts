// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// getReceiptFile backs the "view the attachment" action on the Open
// document requests grid. It serves client documents, so the tenant
// scoping is the security boundary worth pinning down.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, companies, portalReceipts } from '../db/schema/index.js';
import { getReceiptFile } from './portal-receipts.service.js';

describe('portal-receipts — getReceiptFile tenant scoping', () => {
  let tenantA: string;
  let tenantB: string;
  let receiptA: string;
  let noFileReceipt: string;

  beforeAll(async () => {
    const stamp = Date.now();
    const [a] = await db.insert(tenants).values({ name: 'Recv A', slug: `test-recv-a-${stamp}` }).returning();
    const [b] = await db.insert(tenants).values({ name: 'Recv B', slug: `test-recv-b-${stamp}` }).returning();
    tenantA = a!.id;
    tenantB = b!.id;
    const [co] = await db.insert(companies).values({ tenantId: tenantA, businessName: 'Recv Co' }).returning();
    const [r] = await db.insert(portalReceipts).values({
      tenantId: tenantA, companyId: co!.id, captureSource: 'portal',
      uploadedBy: co!.id, uploadedByType: 'contact',
      storageKey: `test/${stamp}/nonexistent.pdf`, filename: 'statement.pdf', mimeType: 'application/pdf',
    }).returning();
    receiptA = r!.id;
    const [r2] = await db.insert(portalReceipts).values({
      tenantId: tenantA, companyId: co!.id, captureSource: 'portal',
      uploadedBy: co!.id, uploadedByType: 'contact',
      storageKey: '', filename: 'empty.pdf',
    }).returning();
    noFileReceipt = r2!.id;
  });

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      if (!t) continue;
      await db.delete(portalReceipts).where(eq(portalReceipts.tenantId, t));
      await db.delete(companies).where(eq(companies.tenantId, t));
      await db.delete(tenants).where(eq(tenants.id, t));
    }
  });

  it('404s when another tenant asks for the receipt', async () => {
    // The id is valid and exists — only the tenant differs. This must not
    // leak another firm's client document.
    await expect(getReceiptFile(tenantB, receiptA)).rejects.toThrow(/not found/i);
  });

  it('404s for an unknown receipt id', async () => {
    await expect(getReceiptFile(tenantA, '00000000-0000-4000-8000-0000000000cc'))
      .rejects.toThrow(/not found/i);
  });

  it('404s when the row has no stored file rather than throwing a storage error', async () => {
    await expect(getReceiptFile(tenantA, noFileReceipt)).rejects.toThrow(/no stored file/i);
  });

  it('reports a missing object as not-found for the owning tenant', async () => {
    // Right tenant, right row, but the bytes are gone from storage — the
    // viewer should render "File not found", not a 500.
    await expect(getReceiptFile(tenantA, receiptA)).rejects.toThrow(/not found/i);
  });
});
