// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants,
  bankConnections,
  bankFeedItems,
  contacts,
  transactions,
  recurringSchedules,
} from '../db/schema/index.js';
import {
  findMatches,
  compositeScore,
  _internal,
} from './potential-match.service.js';

let tenantId: string;
let connectionId: string;
let secondConnectionId: string;
let customerId: string;
let vendorId: string;

async function setup() {
  const [t] = await db.insert(tenants).values({
    name: 'Match Test',
    slug: 'match-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  }).returning();
  tenantId = t!.id;

  const [c1] = await db.insert(bankConnections).values({
    tenantId, accountId: crypto.randomUUID(), institutionName: 'Test Bank A',
  }).returning();
  connectionId = c1!.id;

  const [c2] = await db.insert(bankConnections).values({
    tenantId, accountId: crypto.randomUUID(), institutionName: 'Test Bank B',
  }).returning();
  secondConnectionId = c2!.id;

  const [cust] = await db.insert(contacts).values({
    tenantId, displayName: 'Acme Corp', contactType: 'customer',
  }).returning();
  customerId = cust!.id;

  const [vend] = await db.insert(contacts).values({
    tenantId, displayName: 'Globex Inc', contactType: 'vendor',
  }).returning();
  vendorId = vend!.id;
}

async function cleanup() {
  if (!tenantId) return;
  await db.delete(recurringSchedules).where(eq(recurringSchedules.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function seedFeedItem(opts: {
  amount: string;
  feedDate: string;
  description?: string;
  connectionId?: string;
}) {
  const [item] = await db.insert(bankFeedItems).values({
    tenantId,
    bankConnectionId: opts.connectionId ?? connectionId,
    feedDate: opts.feedDate,
    amount: opts.amount,
    description: opts.description ?? 'Test Vendor Co',
    originalDescription: opts.description ?? 'Test Vendor Co',
    status: 'pending',
  }).returning();
  return item!;
}

async function seedInvoice(opts: {
  total: string;
  balanceDue: string;
  txnDate: string;
  contactId?: string;
  txnNumber?: string;
}) {
  const [t] = await db.insert(transactions).values({
    tenantId,
    txnType: 'invoice',
    txnDate: opts.txnDate,
    txnNumber: opts.txnNumber ?? null,
    contactId: opts.contactId ?? customerId,
    total: opts.total,
    balanceDue: opts.balanceDue,
    invoiceStatus: 'sent',
    status: 'posted',
  }).returning();
  return t!;
}

async function seedBill(opts: {
  total: string;
  balanceDue: string;
  txnDate: string;
  contactId?: string;
  vendorInvoiceNumber?: string;
}) {
  const [t] = await db.insert(transactions).values({
    tenantId,
    txnType: 'bill',
    txnDate: opts.txnDate,
    contactId: opts.contactId ?? vendorId,
    vendorInvoiceNumber: opts.vendorInvoiceNumber ?? null,
    total: opts.total,
    balanceDue: opts.balanceDue,
    billStatus: 'open',
    status: 'posted',
  }).returning();
  return t!;
}

async function seedJE(opts: { total: string; txnDate: string; memo?: string; txnNumber?: string }) {
  const [t] = await db.insert(transactions).values({
    tenantId,
    txnType: 'journal_entry',
    txnDate: opts.txnDate,
    total: opts.total,
    memo: opts.memo ?? null,
    txnNumber: opts.txnNumber ?? null,
    status: 'posted',
  }).returning();
  return t!;
}

beforeEach(async () => {
  await cleanup();
  await setup();
});

afterEach(async () => {
  await cleanup();
});

describe('amountScore', () => {
  it('returns 1.0 for exact', () => {
    expect(_internal.amountScore(100, 100)).toBe(1);
  });
  it('returns 0.85 within 1%', () => {
    expect(_internal.amountScore(99.5, 100)).toBe(0.85);
  });
  it('returns 0.60 within 5%', () => {
    expect(_internal.amountScore(96, 100)).toBe(0.60);
  });
  it('returns 0 outside 5%', () => {
    expect(_internal.amountScore(80, 100)).toBe(0);
  });
});

describe('dateScore', () => {
  it('returns 1.0 for exact date', () => {
    expect(_internal.dateScore('2026-04-15', '2026-04-15')).toBe(1);
  });
  it('returns 0.85 within 3 days', () => {
    expect(_internal.dateScore('2026-04-15', '2026-04-13')).toBe(0.85);
    expect(_internal.dateScore('2026-04-15', '2026-04-18')).toBe(0.85);
  });
  it('returns 0.60 within 7 days', () => {
    expect(_internal.dateScore('2026-04-15', '2026-04-22')).toBe(0.60);
  });
  it('returns 0 beyond 7 days', () => {
    expect(_internal.dateScore('2026-04-15', '2026-04-25')).toBe(0);
  });
});

describe('compositeScore', () => {
  it('weighted-sums per MATCH_SCORE_WEIGHTS', () => {
    // 1.0 * 0.5 + 1.0 * 0.3 + 1.0 * 0.2 = 1.0
    expect(compositeScore({ amount: 1, date: 1, name: 1 })).toBe(1);
    // 1.0 * 0.5 + 1.0 * 0.3 + 0 * 0.2 = 0.8
    expect(compositeScore({ amount: 1, date: 1, name: 0 })).toBeCloseTo(0.8, 5);
  });
});

describe('findMatches — open invoices', () => {
  it('finds an exact-amount, same-date invoice for a deposit', async () => {
    const inv = await seedInvoice({
      total: '500.00',
      balanceDue: '500.00',
      txnDate: '2026-04-15',
      txnNumber: 'INV-1001',
    });
    // Deposits are negative-amount feed items in our model.
    const item = await seedFeedItem({
      amount: '-500.00',
      feedDate: '2026-04-15',
      description: 'Acme Corp Wire',
    });
    const candidates = await findMatches(tenantId, item.id);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates[0]?.kind).toBe('invoice');
    expect(candidates[0]?.targetId).toBe(inv.id);
    expect(candidates[0]?.score).toBeGreaterThanOrEqual(0.8);
  });

  it('does not find paid invoices (balanceDue = 0)', async () => {
    await seedInvoice({
      total: '500.00',
      balanceDue: '0.00',
      txnDate: '2026-04-15',
    });
    const item = await seedFeedItem({ amount: '-500.00', feedDate: '2026-04-15' });
    const candidates = await findMatches(tenantId, item.id);
    expect(candidates).toEqual([]);
  });

  it('does not match invoices for an EXPENSE feed item (positive amount)', async () => {
    await seedInvoice({ total: '500.00', balanceDue: '500.00', txnDate: '2026-04-15' });
    const item = await seedFeedItem({ amount: '500.00', feedDate: '2026-04-15' });
    const candidates = await findMatches(tenantId, item.id);
    expect(candidates.filter((c) => c.kind === 'invoice')).toEqual([]);
  });

  it('survives the qualify threshold filter when amount + date are exact, regardless of name match', async () => {
    await seedInvoice({
      total: '500.00',
      balanceDue: '500.00',
      txnDate: '2026-04-15',
    });
    const item = await seedFeedItem({
      amount: '-500.00',
      feedDate: '2026-04-15',
      description: 'Random Bank Noise XYZ',
    });
    const candidates = await findMatches(tenantId, item.id);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    // 1.0 * 0.5 + 1.0 * 0.3 + (low name) * 0.2 ≥ 0.8 even with name=0
    expect(candidates[0]?.score).toBeGreaterThanOrEqual(0.8);
  });
});

describe('findMatches — open bills', () => {
  it('finds an exact-match bill for an expense feed item', async () => {
    const bill = await seedBill({
      total: '250.00',
      balanceDue: '250.00',
      txnDate: '2026-04-15',
      vendorInvoiceNumber: 'GLBX-99',
    });
    const item = await seedFeedItem({ amount: '250.00', feedDate: '2026-04-15' });
    const candidates = await findMatches(tenantId, item.id);
    const billCandidate = candidates.find((c) => c.kind === 'bill');
    expect(billCandidate).toBeDefined();
    expect(billCandidate?.targetId).toBe(bill.id);
  });

  it('does not match bills for deposits', async () => {
    await seedBill({ total: '250.00', balanceDue: '250.00', txnDate: '2026-04-15' });
    const item = await seedFeedItem({ amount: '-250.00', feedDate: '2026-04-15' });
    const candidates = await findMatches(tenantId, item.id);
    expect(candidates.filter((c) => c.kind === 'bill')).toEqual([]);
  });
});

describe('findMatches — journal entries', () => {
  it('finds an exact-amount JE within 7 days with high name match on memo', async () => {
    const je = await seedJE({
      total: '1000.00',
      txnDate: '2026-04-15',
      memo: 'Rent April',
      txnNumber: 'JE-001',
    });
    const item = await seedFeedItem({
      amount: '1000.00',
      feedDate: '2026-04-15',
      description: 'Rent April',
    });
    const candidates = await findMatches(tenantId, item.id);
    const jeCandidate = candidates.find((c) => c.kind === 'journal_entry');
    expect(jeCandidate).toBeDefined();
    expect(jeCandidate?.targetId).toBe(je.id);
  });
});

describe('findMatches — inter-account transfers', () => {
  it('detects opposite-sign feed items on different accounts within 3 days', async () => {
    // First side: $200 expense from connection A
    const a = await seedFeedItem({
      amount: '200.00',
      feedDate: '2026-04-15',
      connectionId,
    });
    // Second side: -$200 deposit on connection B same day
    const b = await seedFeedItem({
      amount: '-200.00',
      feedDate: '2026-04-15',
      connectionId: secondConnectionId,
    });
    const candidatesForA = await findMatches(tenantId, a.id);
    const transferCandidate = candidatesForA.find((c) => c.kind === 'transfer');
    expect(transferCandidate).toBeDefined();
    expect(transferCandidate?.targetId).toBe(b.id);
  });

  it('does not pair items from the SAME bank connection', async () => {
    const a = await seedFeedItem({ amount: '200.00', feedDate: '2026-04-15', connectionId });
    await seedFeedItem({ amount: '-200.00', feedDate: '2026-04-15', connectionId });
    const candidates = await findMatches(tenantId, a.id);
    expect(candidates.filter((c) => c.kind === 'transfer')).toEqual([]);
  });
});

describe('findMatches — recurring templates', () => {
  it('finds an upcoming recurrence whose amount + date match', async () => {
    const tpl = await seedJE({ total: '99.00', txnDate: '2026-04-15' });
    const [sched] = await db.insert(recurringSchedules).values({
      tenantId,
      templateTransactionId: tpl.id,
      frequency: 'monthly',
      startDate: '2026-01-15',
      nextOccurrence: '2026-04-15',
      isActive: true,
    }).returning();
    const item = await seedFeedItem({ amount: '99.00', feedDate: '2026-04-15' });
    const candidates = await findMatches(tenantId, item.id);
    const recurCandidate = candidates.find((c) => c.kind === 'recurring');
    expect(recurCandidate).toBeDefined();
    expect(recurCandidate?.targetId).toBe(sched!.id);
  });
});

describe('findMatches — orchestrator behavior', () => {
  it('caps results at MAX_MATCH_CANDIDATES (3) sorted by score desc', async () => {
    // Seed 5 invoices that all match exactly on amount + date.
    for (let i = 0; i < 5; i++) {
      await seedInvoice({
        total: '100.00',
        balanceDue: '100.00',
        txnDate: '2026-04-15',
      });
    }
    const item = await seedFeedItem({
      amount: '-100.00',
      feedDate: '2026-04-15',
      description: 'Acme Corp Payment',
    });
    const candidates = await findMatches(tenantId, item.id);
    expect(candidates).toHaveLength(3);
    // Sorted desc.
    expect(candidates[0]!.score).toBeGreaterThanOrEqual(candidates[1]!.score);
    expect(candidates[1]!.score).toBeGreaterThanOrEqual(candidates[2]!.score);
  });

  it('drops candidates below the 0.80 qualify threshold', async () => {
    // Date 8 days off → date score = 0; amount exact → 1.0 * 0.5 +
    // 0 * 0.3 + low-name * 0.2 = ~0.5, below 0.80.
    await seedInvoice({
      total: '500.00',
      balanceDue: '500.00',
      txnDate: '2026-04-07',
    });
    const item = await seedFeedItem({
      amount: '-500.00',
      feedDate: '2026-04-15',
      description: 'No Match Here',
    });
    const candidates = await findMatches(tenantId, item.id);
    expect(candidates).toEqual([]);
  });

  it('returns empty for an unknown feed item id', async () => {
    const candidates = await findMatches(tenantId, '00000000-0000-0000-0000-000000000000');
    expect(candidates).toEqual([]);
  });

  it('isolates tenants — does not match invoices from another tenant', async () => {
    // Create a second tenant with an invoice.
    const [other] = await db.insert(tenants).values({
      name: 'Other Tenant',
      slug: 'other-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    }).returning();
    try {
      await db.insert(transactions).values({
        tenantId: other!.id,
        txnType: 'invoice',
        txnDate: '2026-04-15',
        total: '500.00',
        balanceDue: '500.00',
        status: 'posted',
        invoiceStatus: 'sent',
      });
      const item = await seedFeedItem({ amount: '-500.00', feedDate: '2026-04-15' });
      const candidates = await findMatches(tenantId, item.id);
      // The cross-tenant invoice must not appear.
      expect(candidates.filter((c) => c.kind === 'invoice')).toEqual([]);
    } finally {
      await db.delete(transactions).where(eq(transactions.tenantId, other!.id));
      await db.delete(tenants).where(eq(tenants.id, other!.id));
    }
  });
});
