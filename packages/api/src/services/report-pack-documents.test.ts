// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { db } from '../db/index.js';
import {
  tenants, accounts, companies, auditLog, transactions, journalLines, attachments,
  reconciliations, bankStatements,
} from '../db/schema/index.js';
import * as attachmentService from './attachment.service.js';
import * as ledger from './ledger.service.js';
import { REPORT_PACK_DOCUMENT_RENDERERS, type DocumentSectionContext } from './report-pack-documents.js';

let tenantId = '';
let companyId = '';
let otherCompanyId = '';
let checkingId = '';
let cardId = '';
let otherBankId = '';
let expenseId = '';

async function wipe(id: string) {
  if (!id) return;
  await db.delete(bankStatements).where(eq(bankStatements.tenantId, id));
  await db.delete(reconciliations).where(eq(reconciliations.tenantId, id));
  await db.delete(attachments).where(eq(attachments.tenantId, id));
  await db.delete(journalLines).where(eq(journalLines.tenantId, id));
  await db.delete(transactions).where(eq(transactions.tenantId, id));
  await db.delete(auditLog).where(eq(auditLog.tenantId, id));
  await db.delete(accounts).where(eq(accounts.tenantId, id));
  await db.delete(companies).where(eq(companies.tenantId, id));
  await db.delete(tenants).where(eq(tenants.id, id));
}

async function setup() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [tenant] = await db.insert(tenants).values({ name: 'Pack Docs Test', slug: `pack-docs-${stamp}` }).returning();
  tenantId = tenant!.id;
  const [co] = await db.insert(companies).values({ tenantId, businessName: 'Acme Farms' }).returning();
  companyId = co!.id;
  const [other] = await db.insert(companies).values({ tenantId, businessName: 'Other Co' }).returning();
  otherCompanyId = other!.id;
  const [checking] = await db.insert(accounts).values({ tenantId, companyId, name: 'Checking', accountType: 'asset', detailType: 'bank', accountNumber: '1010' }).returning();
  checkingId = checking!.id;
  const [card] = await db.insert(accounts).values({ tenantId, companyId, name: 'Visa', accountType: 'liability', detailType: 'credit_card', accountNumber: '2100' }).returning();
  cardId = card!.id;
  const [ob] = await db.insert(accounts).values({ tenantId, companyId: otherCompanyId, name: 'Other Bank', accountType: 'asset', detailType: 'bank', accountNumber: '1020' }).returning();
  otherBankId = ob!.id;
  const [exp] = await db.insert(accounts).values({ tenantId, companyId, name: 'Supplies', accountType: 'expense', accountNumber: '6100' }).returning();
  expenseId = exp!.id;
}

async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

async function uploadFile(name: string, mimetype: string, buffer: Buffer, type = 'bank_statement', ownerId: string = crypto.randomUUID()) {
  const att = await attachmentService.upload(tenantId, { originalname: name, buffer, mimetype, size: buffer.length }, type, ownerId, { skipAutoClassify: true });
  if (!att) throw new Error('upload failed');
  return att;
}

async function rec(accountId: string, statementDate: string, status: 'complete' | 'in_progress' = 'complete') {
  const [r] = await db.insert(reconciliations).values({
    tenantId, accountId, statementDate, statementEndingBalance: '1000.0000', beginningBalance: '900.0000',
    clearedBalance: '1000.0000', difference: '0.0000', status, completedAt: status === 'complete' ? new Date() : null,
  }).returning();
  return r!;
}

async function statement(accountId: string, periodEnd: string, opts: { attachmentId?: string | null; reconciliationId?: string | null } = {}) {
  const [s] = await db.insert(bankStatements).values({
    tenantId, accountId, periodStart: `${periodEnd.slice(0, 8)}01`, periodEnd,
    openingBalance: '900.0000', closingBalance: '1000.0000',
    attachmentId: opts.attachmentId ?? null, reconciliationId: opts.reconciliationId ?? null,
    institutionName: 'First Bank',
  }).returning();
  return s!;
}

// Every HTML render is one blank page; keeps what was rendered.
function ctxFor(itemOptions: DocumentSectionContext['options'] = {}, over: Partial<DocumentSectionContext> = {}) {
  const html: string[] = [];
  const ctx: DocumentSectionContext = {
    tenantId, companyId, companyName: 'Acme Farms',
    rangeStart: '2026-07-01', rangeEnd: '2026-09-30',
    options: itemOptions,
    allowAttachments: true,
    allowTransactions: true,
    renderHtml: async (h) => { html.push(h); return new Uint8Array(await makePdf(1)); },
    ...over,
  };
  return { ctx, html };
}

async function pages(bytes: Uint8Array) {
  return (await PDFDocument.load(bytes)).getPageCount();
}

describe('report-pack-documents', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await wipe(tenantId); tenantId = ''; });

  describe('bank-reconciliations', () => {
    it('includes completed in-range reconciliations only, each followed by its statement file', async () => {
      const julyRec = await rec(checkingId, '2026-07-31');
      const augCard = await rec(cardId, '2026-08-31');
      await rec(checkingId, '2026-08-31', 'in_progress'); // not completed
      await rec(checkingId, '2026-06-30'); // out of range
      await rec(otherBankId, '2026-07-31'); // other company
      const file = await uploadFile('july.pdf', 'application/pdf', await makePdf(3));
      await statement(checkingId, '2026-07-31', { attachmentId: file.id, reconciliationId: julyRec.id });
      await statement(cardId, '2026-08-31', { reconciliationId: augCard.id }); // OFX: no file

      const { ctx, html } = ctxFor();
      const bytes = await REPORT_PACK_DOCUMENT_RENDERERS['bank-reconciliations']!(ctx);
      // summary (1) + checking rec (1) + its 3 statement pages + card rec (1)
      expect(await pages(bytes)).toBe(6);
      expect(html).toHaveLength(3);
      // Ordered by account number: 1010 Checking before 2100 Visa.
      expect(html[1]).toContain('1010 Checking');
      expect(html[1]).toContain('july.pdf');
      expect(html[2]).toContain('2100 Visa');
      expect(html[2]).toContain('no file');
      expect(html[0]).not.toContain('Other Bank');
    });

    it('leaves statements out when asked, or when the requester cannot read attachments', async () => {
      const r = await rec(checkingId, '2026-07-31');
      const file = await uploadFile('july.pdf', 'application/pdf', await makePdf(3));
      await statement(checkingId, '2026-07-31', { attachmentId: file.id, reconciliationId: r.id });

      const omitted = ctxFor({ omitStatements: true });
      expect(await pages(await REPORT_PACK_DOCUMENT_RENDERERS['bank-reconciliations']!(omitted.ctx))).toBe(2);
      expect(omitted.html[1]).not.toContain('Statement file');

      const denied = ctxFor({}, { allowAttachments: false });
      expect(await pages(await REPORT_PACK_DOCUMENT_RENDERERS['bank-reconciliations']!(denied.ctx))).toBe(2);
      expect(denied.html[0]).toContain('your role does not have access to attachments');
    });

    it('notes an unreadable statement file instead of failing', async () => {
      const r = await rec(checkingId, '2026-07-31');
      const file = await uploadFile('broken.pdf', 'application/pdf', Buffer.from('%PDF-1.4 not really'));
      await statement(checkingId, '2026-07-31', { attachmentId: file.id, reconciliationId: r.id });
      const { ctx, html } = ctxFor();
      expect(await pages(await REPORT_PACK_DOCUMENT_RENDERERS['bank-reconciliations']!(ctx))).toBe(2);
      expect(html[1]).toContain('broken.pdf — could not be included');
    });

    it('is one page saying so when nothing was reconciled', async () => {
      const { ctx, html } = ctxFor();
      expect(await pages(await REPORT_PACK_DOCUMENT_RENDERERS['bank-reconciliations']!(ctx))).toBe(1);
      expect(html[0]).toContain('No completed reconciliations');
    });
  });

  describe('bank-statements', () => {
    it('indexes every statement ending in range, reconciled or not, then appends the files', async () => {
      const r = await rec(checkingId, '2026-07-31');
      const pdf = await uploadFile('july.pdf', 'application/pdf', await makePdf(2));
      const img = await uploadFile('aug.png', 'image/png', Buffer.from('not-really-a-png'));
      await statement(checkingId, '2026-07-31', { attachmentId: pdf.id, reconciliationId: r.id });
      await statement(checkingId, '2026-08-31', { attachmentId: img.id }); // unreconciled
      await statement(cardId, '2026-09-30'); // OFX
      await statement(checkingId, '2026-10-31'); // out of range
      await statement(otherBankId, '2026-08-31'); // other company

      const { ctx, html } = ctxFor();
      const bytes = await REPORT_PACK_DOCUMENT_RENDERERS['bank-statements']!(ctx);
      // index (1) + pdf (2) + image page (1)
      expect(await pages(bytes)).toBe(4);
      const index = html[0]!;
      expect(index.match(/<tr>/g)?.length).toBe(4); // header + 3 statements
      expect(index).toContain('No file');
      expect(index).not.toContain('Other Bank');
      expect(html[1]).toContain('<img src="data:image/png;base64,');
    });

    it('lists but does not embed files without attachment access', async () => {
      const pdf = await uploadFile('july.pdf', 'application/pdf', await makePdf(2));
      await statement(checkingId, '2026-07-31', { attachmentId: pdf.id });
      const { ctx, html } = ctxFor({}, { allowAttachments: false });
      expect(await pages(await REPORT_PACK_DOCUMENT_RENDERERS['bank-statements']!(ctx))).toBe(1);
      expect(html[0]).toContain('no access to attachments');
    });
  });

  describe('transaction-report', () => {
    async function expense(date: string, n: number) {
      return ledger.postTransaction(tenantId, {
        txnType: 'expense', txnDate: date, txnNumber: `E-${n}`, total: '10.00',
        lines: [{ accountId: expenseId, debit: '10.00', credit: '0' }, { accountId: checkingId, debit: '0', credit: '10.00' }],
      }, undefined, companyId);
    }

    it('includes every planned part back to back', async () => {
      // 41 transactions with one PDF each → two parts (≤ 40 files a part).
      for (let i = 0; i < 41; i++) {
        const t = await expense(`2026-08-${String((i % 28) + 1).padStart(2, '0')}`, i);
        await uploadFile(`r${i}.pdf`, 'application/pdf', await makePdf(1), 'expense', t.id);
      }
      const { ctx, html } = ctxFor({ includeAttachments: true });
      const bytes = await REPORT_PACK_DOCUMENT_RENDERERS['transaction-report']!(ctx);
      const summary = html.join('');
      expect(summary).toContain('Part 1 of 2');
      expect(summary).toContain('Part 2 of 2');
      // 41 attachment pages plus at least one rendered page per part.
      expect(await pages(bytes)).toBeGreaterThanOrEqual(43);
    }, 60_000);

    it('says attachments were left out of the pack when the option is off', async () => {
      const t = await expense('2026-08-05', 1);
      await uploadFile('r.pdf', 'application/pdf', await makePdf(2), 'expense', t.id);
      const { ctx, html } = ctxFor();
      expect(await pages(await REPORT_PACK_DOCUMENT_RENDERERS['transaction-report']!(ctx))).toBe(1);
      expect(html.join('')).toContain('Attachments are not included in this report pack.');
    });

    it('fails the section without transaction access', async () => {
      const { ctx } = ctxFor({}, { allowTransactions: false });
      await expect(REPORT_PACK_DOCUMENT_RENDERERS['transaction-report']!(ctx)).rejects.toThrow(/access to transactions/);
    });
  });
});
