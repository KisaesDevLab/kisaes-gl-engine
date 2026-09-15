// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// updateStatementJobTransactions — review-table amount corrections persist
// onto the parse job (the source the statement-line capture reads), re-run
// the Golden Rule, keep provenance, and are refused once imported.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, attachments, aiJobs, auditLog } from '../db/schema/index.js';
import * as parser from './ai-statement-parser.service.js';
import * as bankStatementsService from './bank-statements.service.js';
import * as accountsService from './accounts.service.js';

let tenantId = '';
let jobId = '';

async function cleanDb() {
  if (!tenantId) return;
  const { bankStatementLines, bankStatements, accounts } = await import('../db/schema/index.js');
  await db.delete(bankStatementLines).where(eq(bankStatementLines.tenantId, tenantId));
  await db.delete(bankStatements).where(eq(bankStatements.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(aiJobs).where(eq(aiJobs.tenantId, tenantId));
  await db.delete(attachments).where(eq(attachments.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = ''; jobId = '';
}

beforeEach(async () => {
  await cleanDb();
  const [t] = await db.insert(tenants).values({ name: 'Edit Test', slug: `edit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }).returning();
  tenantId = t!.id;
  const [att] = await db.insert(attachments).values({
    tenantId, fileName: 'stmt.pdf', filePath: '/tmp/stmt.pdf',
    attachableType: 'bank_statement', attachableId: '00000000-0000-0000-0000-000000000001',
  }).returning();
  const [job] = await db.insert(aiJobs).values({
    tenantId, jobType: 'ocr_statement', status: 'complete', inputType: 'attachment', inputId: att!.id,
    outputData: {
      transactions: [
        { date: '2026-04-03', description: 'POS COFFEE', amount: '20.00', type: 'debit', balance: '80.00' },
        { date: '2026-04-07', description: 'DEPOSIT', amount: '700.00', type: 'credit', balance: '150.00' }, // misread (70.00)
      ],
      checks: [],
      accountNumberMasked: '4321',
      statementPeriod: { start: '2026-04-01', end: '2026-04-30' },
      openingBalance: '100.00', closingBalance: '150.00',
      institutionName: 'Test Bank', accountTypeHint: 'CHECKING',
      confidence: 0.9, qualityWarnings: ['statement_did_not_reconcile'], extractionSource: 'text_layer',
      reconciliation: { status: 'discrepancy', deltaCents: -63000, expectedClosingCents: 78000, actualClosingCents: 15000, repaired: false },
      suspectRows: [{ index: 1, deltaCents: -63000 }],
      notes: null,
    },
  }).returning();
  jobId = job!.id;
});
afterEach(cleanDb);

describe('updateStatementJobTransactions', () => {
  it('rewrites the row, re-verifies the Golden Rule, clears suspects, keeps provenance', async () => {
    const out = await parser.updateStatementJobTransactions(tenantId, jobId, [{ index: 1, amount: '70' }], undefined);
    expect(out.transactions[1]!.amount).toBe('70.00');
    expect(out.reconciliation.status).toBe('verified');
    expect(out.suspectRows).toEqual([]);
    expect(out.qualityWarnings).not.toContain('statement_did_not_reconcile');
    expect(out.qualityWarnings).toContain('amounts_edited_in_review');

    const job = await db.query.aiJobs.findFirst({ where: eq(aiJobs.id, jobId) });
    const data = job!.outputData as { transactions: Array<{ amount: string }>; amountEdits: unknown[] };
    expect(data.transactions[1]!.amount).toBe('70.00');
    expect(data.amountEdits).toHaveLength(1);

    // The statement-line capture reads the corrected row.
    const bank = await accountsService.create(tenantId, { name: 'Checking', accountType: 'asset', accountNumber: '1010' });
    const capture = await bankStatementsService.captureStatementOnImport(tenantId, { jobId, accountId: bank.id });
    const { bankStatementLines } = await import('../db/schema/index.js');
    const lines = await db.select().from(bankStatementLines).where(eq(bankStatementLines.statementId, capture!.statement.id));
    expect(lines.find((l) => l.description === 'DEPOSIT')!.amount).toBe('70.0000');
    expect(capture!.statement.goldenRuleStatus).toBe('verified');
  });

  it('can flip direction, rejects bad indexes / amounts, and refuses after import', async () => {
    const flipped = await parser.updateStatementJobTransactions(tenantId, jobId, [{ index: 0, amount: '20.00', type: 'credit' }]);
    expect(flipped.transactions[0]!.type).toBe('credit');
    await expect(parser.updateStatementJobTransactions(tenantId, jobId, [{ index: 9, amount: '1.00' }]))
      .rejects.toMatchObject({ code: 'STATEMENT_ROW_INDEX' });
    await expect(parser.updateStatementJobTransactions(tenantId, jobId, [{ index: 0, amount: 'nope' }]))
      .rejects.toMatchObject({ code: 'STATEMENT_AMOUNT_INVALID' });
    await parser.markStatementJobImported(tenantId, jobId);
    await expect(parser.updateStatementJobTransactions(tenantId, jobId, [{ index: 0, amount: '1.00' }]))
      .rejects.toMatchObject({ code: 'STATEMENT_ALREADY_IMPORTED' });
  });
});
