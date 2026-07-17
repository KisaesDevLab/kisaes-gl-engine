// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import {
  tenants,
  companies,
  contacts,
  accounts,
  transactions,
  journalLines,
  attachments,
  bankConnections,
  bankFeedItems,
  conditionalRules,
  conditionalRuleAudit,
} from '../../../db/schema/index.js';
import { HANDLERS } from './index.js';

// Phase 6 §6.3 — one fixture-driven test file covering all
// 13 stock check handlers. Each describe block: a positive
// case (handler emits a finding when conditions warrant it)
// and a negative case (handler emits no finding when nothing
// warrants it). Per plan §D8 each handler is bounded by the
// orchestrator's run cap; we don't re-test that here.

let tenantId: string;
let companyId: string;
let contactId: string;
// Initialized in setup() before any test runs; explicit defaults
// silence TS's "used before assigned" without changing semantics.
let revenueAccountId = '';
let expenseAccountId = '';

async function setup() {
  const [t] = await db.insert(tenants).values({
    name: 'Checks Test',
    slug: 'checks-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  }).returning();
  tenantId = t!.id;

  const [c] = await db.insert(companies).values({
    tenantId,
    businessName: 'Checks Test Co',
  }).returning();
  companyId = c!.id;

  const [cust] = await db.insert(contacts).values({
    tenantId,
    displayName: 'Acme Corp',
    contactType: 'customer',
  }).returning();
  contactId = cust!.id;

  const [rev] = await db.insert(accounts).values({
    tenantId,
    companyId,
    name: 'Revenue',
    accountType: 'revenue',
    accountNumber: '4000',
    balance: '0',
  }).returning();
  revenueAccountId = rev!.id;

  const [exp] = await db.insert(accounts).values({
    tenantId,
    companyId,
    name: 'Office Supplies',
    accountType: 'expense',
    accountNumber: '6100',
    balance: '0',
  }).returning();
  expenseAccountId = exp!.id;
}

async function cleanup() {
  if (!tenantId) return;
  await db.delete(conditionalRuleAudit).where(eq(conditionalRuleAudit.tenantId, tenantId));
  await db.delete(conditionalRules).where(eq(conditionalRules.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(attachments).where(eq(attachments.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
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

// ─── Helpers ──────────────────────────────────────────────────

async function seedTransaction(opts: {
  txnType: string;
  total: string;
  txnDate: string;
  contactId?: string | null;
  status?: string;
  invoiceStatus?: string;
}) {
  const [t] = await db.insert(transactions).values({
    tenantId,
    companyId,
    txnType: opts.txnType,
    txnDate: opts.txnDate,
    total: opts.total,
    contactId: opts.contactId !== undefined ? opts.contactId : contactId,
    status: opts.status ?? 'posted',
    invoiceStatus: opts.invoiceStatus,
  }).returning();
  return t!;
}

// ─── parent_account_posting ──────────────────────────────────

describe('parent_account_posting', () => {
  it('flags when posting to an account that has children', async () => {
    const [parent] = await db.insert(accounts).values({
      tenantId, companyId, name: 'Parent Acct', accountType: 'expense', accountNumber: '6000',
    }).returning();
    await db.insert(accounts).values({
      tenantId, companyId, name: 'Child Acct', accountType: 'expense', accountNumber: '6010', parentId: parent!.id,
    });
    const txn = await seedTransaction({ txnType: 'expense', total: '100.0000', txnDate: '2026-04-15' });
    await db.insert(journalLines).values([
      // company_id mirrors what production ledger.postTransaction
      // sets — the handler filters by jl.company_id when scoped.
      { tenantId, companyId, transactionId: txn.id, accountId: parent!.id, debit: '100.0000', credit: '0' },
    ]);

    const drafts = await HANDLERS['parent_account_posting']!(tenantId, companyId, {});
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.checkKey).toBe('parent_account_posting');
    expect(drafts[0]?.transactionId).toBe(txn.id);
  });

  it('does not flag when posting to a leaf account', async () => {
    const txn = await seedTransaction({ txnType: 'expense', total: '100.0000', txnDate: '2026-04-15' });
    await db.insert(journalLines).values([
      { tenantId, companyId, transactionId: txn.id, accountId: expenseAccountId, debit: '100.0000', credit: '0' },
    ]);
    const drafts = await HANDLERS['parent_account_posting']!(tenantId, companyId, {});
    expect(drafts).toEqual([]);
  });
});

// ─── missing_attachment_above_threshold ───────────────────────

describe('missing_attachment_above_threshold', () => {
  it('flags an expense ≥ threshold with no attachment', async () => {
    await seedTransaction({ txnType: 'expense', total: '100.0000', txnDate: '2026-04-15' });
    const drafts = await HANDLERS['missing_attachment_above_threshold']!(tenantId, companyId, { thresholdAmount: 75 });
    expect(drafts).toHaveLength(1);
    // Reviewer-facing payload contract: a one-line summary of the
    // record, a plain-language reason, and a suggested action.
    const p = drafts[0]!.payload as Record<string, unknown>;
    expect(String(p['summary'])).toContain('2026-04-15');
    expect(String(p['summary'])).toContain('$100.00');
    expect(String(p['reason'])).toMatch(/no receipt or bill copy/i);
    expect(String(p['suggestion'])).toMatch(/attach/i);
  });

  it('does not flag expenses below the threshold', async () => {
    await seedTransaction({ txnType: 'expense', total: '50.0000', txnDate: '2026-04-15' });
    const drafts = await HANDLERS['missing_attachment_above_threshold']!(tenantId, companyId, { thresholdAmount: 75 });
    expect(drafts).toEqual([]);
  });

  it('does not flag when attachment exists (stored under the txn_type, the app convention)', async () => {
    const txn = await seedTransaction({ txnType: 'expense', total: '100.0000', txnDate: '2026-04-15' });
    await db.insert(attachments).values({
      tenantId, companyId,
      fileName: 'receipt.pdf', filePath: '/uploads/x.pdf',
      // The app stores transaction attachments under the txn_type
      // ('expense'), NOT the literal 'transaction' — the check must
      // recognize the real convention or it false-positives on every
      // documented transaction.
      attachableType: 'expense', attachableId: txn.id,
    });
    const drafts = await HANDLERS['missing_attachment_above_threshold']!(tenantId, companyId, { thresholdAmount: 75 });
    expect(drafts).toEqual([]);
  });

  it('also accepts the legacy attachable_type=transaction value', async () => {
    const txn = await seedTransaction({ txnType: 'expense', total: '100.0000', txnDate: '2026-04-15' });
    await db.insert(attachments).values({
      tenantId, companyId,
      fileName: 'receipt.pdf', filePath: '/uploads/x.pdf',
      attachableType: 'transaction', attachableId: txn.id,
    });
    const drafts = await HANDLERS['missing_attachment_above_threshold']!(tenantId, companyId, { thresholdAmount: 75 });
    expect(drafts).toEqual([]);
  });
});

// ─── uncategorized_stale ──────────────────────────────────────

describe('uncategorized_stale', () => {
  it('flags a stale pending bank-feed item', async () => {
    const [conn] = await db.insert(bankConnections).values({
      tenantId, companyId, accountId: crypto.randomUUID(), institutionName: 'Bank',
    }).returning();
    await db.execute(sql`
      INSERT INTO bank_feed_items (tenant_id, company_id, bank_connection_id, feed_date, amount, status, created_at)
      VALUES (${tenantId}, ${companyId}, ${conn!.id}, '2026-03-01', 100.00, 'pending', now() - INTERVAL '30 days')
    `);
    const drafts = await HANDLERS['uncategorized_stale']!(tenantId, companyId, { olderThanDays: 14 });
    expect(drafts).toHaveLength(1);
  });

  it('does not flag fresh pending items', async () => {
    const [conn] = await db.insert(bankConnections).values({
      tenantId, companyId, accountId: crypto.randomUUID(), institutionName: 'Bank',
    }).returning();
    await db.insert(bankFeedItems).values({
      tenantId, companyId, bankConnectionId: conn!.id, feedDate: '2026-04-15', amount: '100', status: 'pending',
    });
    const drafts = await HANDLERS['uncategorized_stale']!(tenantId, companyId, { olderThanDays: 14 });
    expect(drafts).toEqual([]);
  });
});

// ─── transaction_above_materiality ───────────────────────────

describe('transaction_above_materiality', () => {
  it('flags a transaction over the threshold', async () => {
    await seedTransaction({ txnType: 'expense', total: '15000.0000', txnDate: '2026-04-15' });
    const drafts = await HANDLERS['transaction_above_materiality']!(tenantId, companyId, { thresholdAmount: 10000 });
    expect(drafts).toHaveLength(1);
  });

  it('does not flag transactions under the threshold', async () => {
    await seedTransaction({ txnType: 'expense', total: '500.0000', txnDate: '2026-04-15' });
    const drafts = await HANDLERS['transaction_above_materiality']!(tenantId, companyId, { thresholdAmount: 10000 });
    expect(drafts).toEqual([]);
  });
});

// ─── duplicate_candidate ─────────────────────────────────────

describe('duplicate_candidate', () => {
  it('flags two transactions with same vendor + total within window', async () => {
    await seedTransaction({ txnType: 'expense', total: '250.0000', txnDate: '2026-04-15' });
    await seedTransaction({ txnType: 'expense', total: '250.0000', txnDate: '2026-04-17' });
    const drafts = await HANDLERS['duplicate_candidate']!(tenantId, companyId, { windowDays: 7 });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.payload).toHaveProperty('partnerTransactionId');
  });

  it('does not flag pairs outside the window', async () => {
    await seedTransaction({ txnType: 'expense', total: '250.0000', txnDate: '2026-04-01' });
    await seedTransaction({ txnType: 'expense', total: '250.0000', txnDate: '2026-04-30' });
    const drafts = await HANDLERS['duplicate_candidate']!(tenantId, companyId, { windowDays: 7 });
    expect(drafts).toEqual([]);
  });
});

// ─── round_dollar_above_threshold ────────────────────────────

describe('round_dollar_above_threshold', () => {
  it('flags whole-dollar amounts at or above the threshold', async () => {
    await seedTransaction({ txnType: 'expense', total: '1000.0000', txnDate: '2026-04-15' });
    const drafts = await HANDLERS['round_dollar_above_threshold']!(tenantId, companyId, { thresholdAmount: 500 });
    expect(drafts).toHaveLength(1);
  });

  it('does not flag non-round amounts', async () => {
    await seedTransaction({ txnType: 'expense', total: '1000.4500', txnDate: '2026-04-15' });
    const drafts = await HANDLERS['round_dollar_above_threshold']!(tenantId, companyId, { thresholdAmount: 500 });
    expect(drafts).toEqual([]);
  });
});

// ─── weekend_holiday_posting ─────────────────────────────────

describe('weekend_holiday_posting', () => {
  // The no-period path only looks back 90 days from now(), so
  // hardcoded dates are a time bomb — they silently age out of the
  // window. Seed relative to today instead: the most recent past
  // day-of-week is always inside the guard.
  function lastDayOfWeek(targetDow: number): string {
    const d = new Date();
    const back = (d.getUTCDay() - targetDow + 7) % 7 || 7;
    d.setUTCDate(d.getUTCDate() - back);
    return d.toISOString().slice(0, 10);
  }

  it('flags Saturday postings', async () => {
    await seedTransaction({ txnType: 'expense', total: '100.0000', txnDate: lastDayOfWeek(6) });
    const drafts = await HANDLERS['weekend_holiday_posting']!(tenantId, companyId, {});
    expect(drafts).toHaveLength(1);
  });

  it('does not flag weekday postings', async () => {
    await seedTransaction({ txnType: 'expense', total: '100.0000', txnDate: lastDayOfWeek(3) });
    const drafts = await HANDLERS['weekend_holiday_posting']!(tenantId, companyId, {});
    expect(drafts).toEqual([]);
  });
});

// ─── negative_non_liability ──────────────────────────────────

describe('negative_non_liability', () => {
  it('flags asset/expense/revenue accounts with negative balances', async () => {
    await db.update(accounts).set({ balance: '-50.0000' }).where(eq(accounts.id, expenseAccountId));
    const drafts = await HANDLERS['negative_non_liability']!(tenantId, companyId, {});
    expect(drafts.length).toBeGreaterThanOrEqual(1);
    expect(drafts[0]?.payload).toHaveProperty('accountName', 'Office Supplies');
  });

  it('does not flag positive balances', async () => {
    const drafts = await HANDLERS['negative_non_liability']!(tenantId, companyId, {});
    expect(drafts).toEqual([]);
  });
});

// ─── closed_period_posting ───────────────────────────────────

describe('closed_period_posting', () => {
  it('returns empty (stub until close-lock feature ships)', async () => {
    const drafts = await HANDLERS['closed_period_posting']!(tenantId, companyId, {});
    expect(drafts).toEqual([]);
  });
});

// ─── vendor_1099_threshold_no_w9 ─────────────────────────────

describe('vendor_1099_threshold_no_w9', () => {
  it('flags vendors paid >= threshold YTD with no tax_id', async () => {
    const [vend] = await db.insert(contacts).values({
      tenantId, displayName: 'Contractor Bob', contactType: 'vendor', taxId: null,
    }).returning();
    await db.insert(transactions).values({
      tenantId, companyId,
      txnType: 'expense',
      txnDate: new Date().toISOString().slice(0, 10),
      total: '700.0000',
      contactId: vend!.id,
      status: 'posted',
    });
    const drafts = await HANDLERS['vendor_1099_threshold_no_w9']!(tenantId, companyId, { thresholdAmount: 600 });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.vendorId).toBe(vend!.id);
  });

  it('does not flag when vendor has tax_id', async () => {
    const [vend] = await db.insert(contacts).values({
      tenantId, displayName: 'Contractor Bob', contactType: 'vendor', taxId: '12-3456789',
    }).returning();
    await db.insert(transactions).values({
      tenantId, companyId,
      txnType: 'expense',
      txnDate: new Date().toISOString().slice(0, 10),
      total: '700.0000',
      contactId: vend!.id,
      status: 'posted',
    });
    const drafts = await HANDLERS['vendor_1099_threshold_no_w9']!(tenantId, companyId, { thresholdAmount: 600 });
    expect(drafts).toEqual([]);
  });
});

// ─── missing_required_customer ───────────────────────────────

describe('missing_required_customer', () => {
  it('flags an invoice with no contact_id', async () => {
    await seedTransaction({ txnType: 'invoice', total: '100.0000', txnDate: '2026-04-15', contactId: null });
    const drafts = await HANDLERS['missing_required_customer']!(tenantId, companyId, {});
    expect(drafts).toHaveLength(1);
  });

  it('does not flag invoices with a contact', async () => {
    await seedTransaction({ txnType: 'invoice', total: '100.0000', txnDate: '2026-04-15' });
    const drafts = await HANDLERS['missing_required_customer']!(tenantId, companyId, {});
    expect(drafts).toEqual([]);
  });
});

// ─── tag_inconsistency_vs_history ────────────────────────────
// ─── auto_posted_by_rule_sampling ────────────────────────────
// Smoke-tested only: both handlers depend on data in
// adjacent tables (categorization_history, conditional_rule_audit)
// that exists in fixtures elsewhere. Negative-path positive
// here ensures they don't crash on empty tenants.

describe('tag_inconsistency_vs_history (smoke)', () => {
  it('returns empty for an empty tenant', async () => {
    const drafts = await HANDLERS['tag_inconsistency_vs_history']!(tenantId, companyId, {});
    expect(drafts).toEqual([]);
  });
});

describe('auto_posted_by_rule_sampling (smoke)', () => {
  it('returns empty when no audit rows exist', async () => {
    const drafts = await HANDLERS['auto_posted_by_rule_sampling']!(tenantId, companyId, { samplePercent: 1.0 });
    expect(drafts).toEqual([]);
  });
});

// ─── receipt_amount_mismatch ──────────────────────────────────

describe('receipt_amount_mismatch', () => {
  // Helper to seed a bank-feed item + an attached, OCR-complete
  // receipt with the given totals. Returns the bank feed item id
  // and attachment id so each test can assert on them.
  async function seedBankItemWithReceipt(opts: {
    bankAmount: string;
    ocrTotal: string | null;
    ocrStatus?: string;
  }): Promise<{ bankFeedItemId: string; attachmentId: string }> {
    const [conn] = await db.insert(bankConnections).values({
      tenantId,
      accountId: crypto.randomUUID(),
      institutionName: 'Test Bank',
    }).returning();
    const [item] = await db.insert(bankFeedItems).values({
      tenantId,
      companyId,
      bankConnectionId: conn!.id,
      feedDate: '2026-04-15',
      description: 'Acme Hardware',
      amount: opts.bankAmount,
      status: 'pending',
    }).returning();
    const [att] = await db.insert(attachments).values({
      tenantId,
      fileName: 'receipt.jpg',
      filePath: '/tmp/receipt.jpg',
      mimeType: 'image/jpeg',
      attachableType: 'bank_feed_items',
      attachableId: item!.id,
      ocrStatus: opts.ocrStatus ?? 'complete',
      ocrVendor: 'Acme Hardware',
      ocrDate: '2026-04-15',
      ocrTotal: opts.ocrTotal,
    }).returning();
    return { bankFeedItemId: item!.id, attachmentId: att!.id };
  }

  it('flags an attached receipt whose total exceeds the dollar tolerance', async () => {
    const { attachmentId } = await seedBankItemWithReceipt({
      bankAmount: '50.0000', // bank says $50
      ocrTotal: '52.5000', // receipt says $52.50 — variance 2.50, > $1 and > 2%
    });
    const drafts = await HANDLERS['receipt_amount_mismatch']!(tenantId, companyId, {
      toleranceDollars: 1,
      tolerancePercent: 0.02,
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.payload?.['attachmentId']).toBe(attachmentId);
    expect(drafts[0]?.payload?.['dedupe_key']).toBe(`attachment:${attachmentId}`);
  });

  it('does not flag a small variance within both tolerances', async () => {
    await seedBankItemWithReceipt({
      bankAmount: '100.0000', // 2% = $2, $1 absolute → tolerance is max($1, $2) = $2
      ocrTotal: '101.5000', // variance $1.50 — under $2
    });
    const drafts = await HANDLERS['receipt_amount_mismatch']!(tenantId, companyId, {
      toleranceDollars: 1,
      tolerancePercent: 0.02,
    });
    expect(drafts).toEqual([]);
  });

  it('skips attachments where OCR has not completed', async () => {
    await seedBankItemWithReceipt({
      bankAmount: '50.0000',
      ocrTotal: '999.0000', // would normally flag
      ocrStatus: 'processing',
    });
    const drafts = await HANDLERS['receipt_amount_mismatch']!(tenantId, companyId, {});
    expect(drafts).toEqual([]);
  });

  it('respects company scoping', async () => {
    // Seed an out-of-company item; company scope must filter it out.
    const [otherCo] = await db.insert(companies).values({
      tenantId,
      businessName: 'Other Co',
    }).returning();
    const [conn] = await db.insert(bankConnections).values({
      tenantId,
      accountId: crypto.randomUUID(),
      institutionName: 'Other Bank',
    }).returning();
    const [item] = await db.insert(bankFeedItems).values({
      tenantId,
      companyId: otherCo!.id,
      bankConnectionId: conn!.id,
      feedDate: '2026-04-15',
      description: 'Other Co Vendor',
      amount: '50.0000',
      status: 'pending',
    }).returning();
    await db.insert(attachments).values({
      tenantId,
      fileName: 'r.jpg',
      filePath: '/tmp/r.jpg',
      mimeType: 'image/jpeg',
      attachableType: 'bank_feed_items',
      attachableId: item!.id,
      ocrStatus: 'complete',
      ocrTotal: '99.0000',
    });
    const drafts = await HANDLERS['receipt_amount_mismatch']!(tenantId, companyId, {});
    expect(drafts).toEqual([]); // companyId scope excludes it
  });
});

// ─── expense_without_payee ────────────────────────────────────

describe('expense_without_payee', () => {
  it('flags a posted expense with no contact', async () => {
    await seedTransaction({ txnType: 'expense', total: '80.0000', txnDate: '2026-04-15', contactId: null });
    const drafts = await HANDLERS['expense_without_payee']!(tenantId, companyId, {});
    expect(drafts).toHaveLength(1);
    const p = drafts[0]!.payload as Record<string, unknown>;
    expect(String(p['suggestion'])).toMatch(/assign the vendor/i);
  });

  it('does not flag an expense that has a payee', async () => {
    await seedTransaction({ txnType: 'expense', total: '80.0000', txnDate: '2026-04-15' });
    const drafts = await HANDLERS['expense_without_payee']!(tenantId, companyId, {});
    expect(drafts).toEqual([]);
  });
});

// ─── journal_entry_without_attachment ─────────────────────────

describe('journal_entry_without_attachment', () => {
  it('flags a JE with no attachment', async () => {
    const txn = await seedTransaction({ txnType: 'journal_entry', total: '500.0000', txnDate: '2026-04-15', contactId: null });
    const drafts = await HANDLERS['journal_entry_without_attachment']!(tenantId, companyId, {});
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.transactionId).toBe(txn.id);
  });

  it('does not flag a JE with support attached (stored as journal_entry, the app convention)', async () => {
    const txn = await seedTransaction({ txnType: 'journal_entry', total: '500.0000', txnDate: '2026-04-15', contactId: null });
    await db.insert(attachments).values({
      tenantId, companyId,
      fileName: 'schedule.pdf', filePath: '/uploads/s.pdf',
      attachableType: 'journal_entry', attachableId: txn.id,
    });
    const drafts = await HANDLERS['journal_entry_without_attachment']!(tenantId, companyId, {});
    expect(drafts).toEqual([]);
  });

  it('respects the amount threshold', async () => {
    await seedTransaction({ txnType: 'journal_entry', total: '50.0000', txnDate: '2026-04-15', contactId: null });
    const drafts = await HANDLERS['journal_entry_without_attachment']!(tenantId, companyId, { thresholdAmount: 100 });
    expect(drafts).toEqual([]);
  });
});

// ─── new_entities_review ──────────────────────────────────────

describe('new_entities_review', () => {
  it('flags contacts and accounts created inside the period', async () => {
    // The fixture's contact + accounts were created "now", inside July 2026.
    const drafts = await HANDLERS['new_entities_review']!(tenantId, companyId, {
      periodStart: '2026-07-01', periodEnd: '2026-08-01',
    });
    const names = drafts.map((d) => (d.payload as Record<string, unknown>)['entityName']);
    expect(names).toContain('Acme Corp');
    expect(names).toContain('Office Supplies');
  });

  it('does not flag entities created outside the period', async () => {
    const drafts = await HANDLERS['new_entities_review']!(tenantId, companyId, {
      periodStart: '2020-01-01', periodEnd: '2020-02-01',
    });
    expect(drafts).toEqual([]);
  });
});

// ─── duplicate_entity_names ───────────────────────────────────

describe('duplicate_entity_names', () => {
  it('flags two contacts whose names differ only by punctuation/case', async () => {
    await db.insert(contacts).values({ tenantId, displayName: 'ACME Corp.', contactType: 'vendor' });
    const drafts = await HANDLERS['duplicate_entity_names']!(tenantId, null, {});
    expect(drafts).toHaveLength(1);
    const p = drafts[0]!.payload as Record<string, unknown>;
    expect([p['nameA'], p['nameB']].sort()).toEqual(['ACME Corp.', 'Acme Corp']);
  });

  it('does not flag distinct names', async () => {
    await db.insert(contacts).values({ tenantId, displayName: 'Globex LLC', contactType: 'vendor' });
    const drafts = await HANDLERS['duplicate_entity_names']!(tenantId, null, {});
    expect(drafts).toEqual([]);
  });
});

// ─── flux_variance ────────────────────────────────────────────

describe('flux_variance', () => {
  async function seedMonthlyExpense(month: string, amount: string) {
    const txn = await seedTransaction({ txnType: 'expense', total: amount, txnDate: `${month}-10` });
    await db.insert(journalLines).values([
      { tenantId, companyId, transactionId: txn.id, accountId: expenseAccountId, debit: amount, credit: '0' },
    ]);
  }

  it('flags an account whose period activity jumps from its trailing average', async () => {
    await seedMonthlyExpense('2026-03', '100.0000');
    await seedMonthlyExpense('2026-04', '100.0000');
    await seedMonthlyExpense('2026-05', '100.0000');
    await seedMonthlyExpense('2026-06', '1000.0000'); // 10x jump
    const drafts = await HANDLERS['flux_variance']!(tenantId, companyId, {
      periodStart: '2026-06-01', periodEnd: '2026-07-01',
    });
    expect(drafts).toHaveLength(1);
    const p = drafts[0]!.payload as Record<string, unknown>;
    expect(p['accountName']).toBe('Office Supplies');
    expect(String(p['reason'])).toMatch(/up \d+%/);
  });

  it('stays quiet when activity matches the trailing average', async () => {
    await seedMonthlyExpense('2026-03', '100.0000');
    await seedMonthlyExpense('2026-04', '100.0000');
    await seedMonthlyExpense('2026-05', '100.0000');
    await seedMonthlyExpense('2026-06', '105.0000');
    const drafts = await HANDLERS['flux_variance']!(tenantId, companyId, {
      periodStart: '2026-06-01', periodEnd: '2026-07-01',
    });
    expect(drafts).toEqual([]);
  });

  it('returns nothing without a close period', async () => {
    const drafts = await HANDLERS['flux_variance']!(tenantId, companyId, {});
    expect(drafts).toEqual([]);
  });
});

// ─── account_inconsistency_vs_history / posted_into_reconciled_range ──
// Smoke: both depend on aged created_at fixtures (history windows,
// completed reconciliations) that are exercised in service-level tests;
// here we ensure they run clean on an empty tenant.

describe('account_inconsistency_vs_history (smoke)', () => {
  it('returns empty for an empty tenant', async () => {
    const drafts = await HANDLERS['account_inconsistency_vs_history']!(tenantId, companyId, {});
    expect(drafts).toEqual([]);
  });
});

describe('posted_into_reconciled_range (smoke)', () => {
  it('returns empty when no completed reconciliations exist', async () => {
    const drafts = await HANDLERS['posted_into_reconciled_range']!(tenantId, companyId, {});
    expect(drafts).toEqual([]);
  });
});

// Touch unused vars to silence the lint without changing the
// fixture surface. The id is stashed for handlers that need a
// revenue account in future tests.
void revenueAccountId;
