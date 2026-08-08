// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Leadsheet row attachments: ref-code sequencing per leadsheet + tax
// year (A001, A002, B001; restart next year), original-name retention,
// annotation lifecycle with burn-on-download stamping, delete, and
// tenant guards.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';

const stored = new Map<string, Buffer>();
vi.mock('../storage/storage-provider.factory.js', () => ({
  getProviderForTenant: async () => ({
    name: 'local',
    upload: vi.fn(async (key: string, buffer: Buffer) => { stored.set(key, buffer); return { key }; }),
    download: vi.fn(async (key: string) => stored.get(key) ?? Buffer.alloc(0)),
    downloadStream: vi.fn(async (key: string) => Readable.from(stored.get(key) ?? Buffer.alloc(0))),
    delete: vi.fn(async (key: string) => { stored.delete(key); }),
  }),
  invalidateProviderCache: () => undefined,
}));

import { db, pool } from '../../db/index.js';
import {
  accounts, attachments, companies, tbGroupings, tbRowAttachments, tbTickmarks, tenants,
} from '../../db/schema/index.js';
import {
  attachRowPdf, listRowAttachments, removeRowAttachment,
  addAnnotation, removeAnnotation, renderRowAttachmentPdf,
} from './row-attachments.service.js';

let tenantId: string;
let companyId: string;
let groupA: string;
let groupB: string;
let accountId: string;
let tickmarkId: string;
let pdfBytes: Buffer;

beforeAll(async () => {
  const [t] = await db.insert(tenants).values({ name: 'tb-rowatt', slug: `tb-rowatt-${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'RowAtt Co', fiscalYearStartMonth: 1 }).returning();
  companyId = c!.id;
  const [ga] = await db.insert(tbGroupings).values({ tenantId, companyId, name: 'Cash', leadsheetCode: 'A', sortOrder: 1 }).returning();
  groupA = ga!.id;
  const [gb] = await db.insert(tbGroupings).values({ tenantId, companyId, name: 'AR', leadsheetCode: 'B', sortOrder: 2 }).returning();
  groupB = gb!.id;
  const [a] = await db.insert(accounts).values({ tenantId, companyId, accountNumber: '1000', name: 'Cash', accountType: 'asset' }).returning();
  accountId = a!.id;
  const [mark] = await db.insert(tbTickmarks).values({ tenantId, symbol: 'F', description: 'Footed', color: 'green', sortOrder: 1 }).returning();
  tickmarkId = mark!.id;

  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  pdfBytes = Buffer.from(await doc.save());
});

afterAll(async () => {
  await db.delete(tbRowAttachments).where(eq(tbRowAttachments.tenantId, tenantId));
  await db.delete(attachments).where(eq(attachments.tenantId, tenantId));
  await db.delete(tbTickmarks).where(eq(tbTickmarks.tenantId, tenantId));
  await db.delete(tbGroupings).where(eq(tbGroupings.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  await pool.end();
});

describe('leadsheet row attachments', () => {
  it('sequences ref codes per leadsheet + tax year and keeps the original name', async () => {
    const first = await attachRowPdf(tenantId, companyId, {
      groupingId: groupA, accountId, taxYear: 2026, filename: 'bank statement dec.pdf', buffer: pdfBytes,
    });
    const second = await attachRowPdf(tenantId, companyId, {
      groupingId: groupA, accountId, taxYear: 2026, filename: 'recon.pdf', buffer: pdfBytes,
    });
    const other = await attachRowPdf(tenantId, companyId, {
      groupingId: groupB, accountId, taxYear: 2026, filename: 'aging.pdf', buffer: pdfBytes,
    });
    expect(first.refCode).toBe('A001');
    expect(second.refCode).toBe('A002');
    expect(other.refCode).toBe('B001');
    expect(first.fileName).toBe('A001.pdf');
    expect(first.sourceFileName).toBe('bank statement dec.pdf');

    // Next tax year restarts the sequence.
    const nextYear = await attachRowPdf(tenantId, companyId, {
      groupingId: groupA, accountId, taxYear: 2027, filename: 'py.pdf', buffer: pdfBytes,
    });
    expect(nextYear.refCode).toBe('A001');

    const list = await listRowAttachments(tenantId, companyId, 2026);
    expect(list.map((r) => r.refCode)).toEqual(['A001', 'A002', 'B001']);
    // The stored attachment row carries the ref-code display name.
    const [att] = await db.select().from(attachments).where(eq(attachments.id, (await db.select().from(tbRowAttachments).where(eq(tbRowAttachments.id, first.id)))[0]!.attachmentId));
    expect(att!.fileName).toBe('A001.pdf');
    expect(att!.attachableType).toBe('tb_leadsheet');
  });

  it('stamps annotations onto the served PDF and removes them cleanly', async () => {
    const list = await listRowAttachments(tenantId, companyId, 2026);
    const target = list.find((r) => r.refCode === 'A001')!;

    const ann = await addAnnotation(tenantId, companyId, target.id, {
      page: 1, xPct: 0.5, yPct: 0.25, tickmarkId, note: 'agreed to bank',
    });
    expect(ann.symbol).toBe('F');
    expect(ann.color).toBe('green');

    const stamped = await renderRowAttachmentPdf(tenantId, companyId, target.id);
    expect(stamped.fileName).toBe('A001.pdf');
    const doc = await PDFDocument.load(stamped.buffer);
    expect(doc.getPageCount()).toBe(1);
    // Stamped output must differ from the original bytes; the original
    // must be untouched.
    const original = await renderRowAttachmentPdf(tenantId, companyId, target.id, false);
    expect(stamped.buffer.equals(original.buffer)).toBe(false);
    expect(original.buffer.equals(pdfBytes)).toBe(true);

    await removeAnnotation(tenantId, companyId, target.id, ann.id);
    const after = await listRowAttachments(tenantId, companyId, 2026);
    expect(after.find((r) => r.id === target.id)!.annotations).toHaveLength(0);
    await expect(removeAnnotation(tenantId, companyId, target.id, ann.id))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('delete removes the side row and the underlying attachment', async () => {
    const list = await listRowAttachments(tenantId, companyId, 2026);
    const target = list.find((r) => r.refCode === 'B001')!;
    const [side] = await db.select().from(tbRowAttachments).where(eq(tbRowAttachments.id, target.id));
    await removeRowAttachment(tenantId, companyId, target.id);
    const gone = await db.select().from(tbRowAttachments).where(eq(tbRowAttachments.id, target.id));
    expect(gone).toHaveLength(0);
    const att = await db.select().from(attachments).where(eq(attachments.id, side!.attachmentId));
    expect(att).toHaveLength(0);
  });

  it('refuses cross-tenant access', async () => {
    const list = await listRowAttachments(tenantId, companyId, 2026);
    await expect(renderRowAttachmentPdf('00000000-0000-0000-0000-000000000001', companyId, list[0]!.id))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(attachRowPdf(tenantId, companyId, {
      groupingId: '00000000-0000-0000-0000-000000000002', accountId, taxYear: 2026, filename: 'x.pdf', buffer: pdfBytes,
    })).rejects.toMatchObject({ statusCode: 404 });
  });
});
