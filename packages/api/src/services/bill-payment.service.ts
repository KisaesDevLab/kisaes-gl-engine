// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, sql, inArray } from 'drizzle-orm';
import type { PayBillsInput } from '@kis-books/shared';
import { db } from '../db/index.js';
import {
  transactions,
  journalLines,
  accounts,
  billPaymentApplications,
  vendorCreditApplications,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as billService from './bill.service.js';

async function getApAccountId(tenantId: string): Promise<string> {
  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'accounts_payable')),
  });
  if (!account) throw AppError.internal("System account 'accounts_payable' not found");
  return account.id;
}

async function allocateCheckNumber(tenantId: string): Promise<number> {
  const result = await db.execute(sql`
    UPDATE companies
    SET check_settings = jsonb_set(
      COALESCE(check_settings, '{}'::jsonb),
      '{nextCheckNumber}',
      to_jsonb(COALESCE((check_settings->>'nextCheckNumber')::int, 1001) + 1)
    )
    WHERE tenant_id = ${tenantId}
    RETURNING (check_settings->>'nextCheckNumber')::int - 1 AS assigned_number
  `);
  const assigned = (result.rows[0] as { assigned_number: number | null } | undefined)?.assigned_number;
  if (assigned === null || assigned === undefined) {
    throw AppError.internal('Failed to allocate check number');
  }
  return Number(assigned);
}

interface VendorPaymentGroup {
  vendorId: string;
  /**
   * Bills selected for payment in this group.
   * `amount` is the user-entered "this bill takes X of coverage" — total
   * satisfaction (cash + credits allocated to this bill).
   * `cashAmount` is computed after credit allocation: amount minus the
   * credits whose `billId` points at this bill. This is what gets persisted
   * in `bill_payment_applications` and what `bill.amount_paid` reflects.
   */
  vendorBills: Array<{
    billId: string;
    amount: number;
    cashAmount: number;
    bill: typeof transactions.$inferSelect;
  }>;
  vendorCredits: Array<{ creditId: string; billId: string; amount: number }>;
  totalBills: number;
  totalCredits: number;
  netPayment: number;
}

/**
 * Pay one or more bills, optionally applying vendor credits, in a single
 * atomic database transaction. The result is one bill_payment transaction
 * per vendor (multiple bills for the same vendor are combined into one check).
 *
 * Journal entry per vendor payment:
 *   DR Accounts Payable  (sum of bills paid, including the credit-covered portion)
 *   CR Bank Account      (net cash leaving — bills minus credits applied)
 *   CR Accounts Payable  (sum of credits applied — this and the credit's
 *                         existing AP-debit cancel out so AP balance moves
 *                         only by the cash leg)
 *
 * Equivalently the simpler view: AP debit = total bills, bank credit = net
 * payment, and the difference (= credits applied) is balanced by the credit
 * line on AP. We use the simpler form below: a single AP debit for the net
 * cash amount (bills - credits), since the credit's original journal entry
 * has already moved AP for the credit portion.
 */
export async function payBills(tenantId: string, input: PayBillsInput, userId?: string, companyId?: string) {
  if (input.bills.length === 0) throw AppError.badRequest('Must select at least one bill to pay');

  const apAccountId = await getApAccountId(tenantId);

  // Load and validate all referenced bills + credits up front (outside the
  // tx, then re-load with FOR UPDATE inside the tx so concurrent payments
  // can't double-pay the same bill).
  const billIds = input.bills.map((b) => b.billId);
  const creditIds = (input.credits || []).map((c) => c.creditId);

  return await db.transaction(async (tx) => {
    // Lock the bills + credits for the duration of the transaction
    const lockedBills = await tx.select().from(transactions)
      .where(and(
        eq(transactions.tenantId, tenantId),
        eq(transactions.txnType, 'bill'),
        inArray(transactions.id, billIds),
      ))
      .for('update');

    if (lockedBills.length !== billIds.length) {
      throw AppError.badRequest('One or more bills not found');
    }

    for (const bill of lockedBills) {
      if (bill.status === 'void') throw AppError.badRequest(`Bill ${bill.txnNumber || bill.id} is void`);
      if (bill.billStatus === 'paid') throw AppError.badRequest(`Bill ${bill.txnNumber || bill.id} is already fully paid`);
    }

    const lockedCredits = creditIds.length > 0
      ? await tx.select().from(transactions)
          .where(and(
            eq(transactions.tenantId, tenantId),
            eq(transactions.txnType, 'vendor_credit'),
            inArray(transactions.id, creditIds),
          ))
          .for('update')
      : [];

    if (lockedCredits.length !== creditIds.length) {
      throw AppError.badRequest('One or more vendor credits not found');
    }

    // Group by vendor: one bill_payment transaction per vendor
    const groups = new Map<string, VendorPaymentGroup>();
    for (const billLine of input.bills) {
      const bill = lockedBills.find((b) => b.id === billLine.billId);
      if (!bill || !bill.contactId) {
        throw AppError.badRequest(`Bill ${billLine.billId} has no vendor`);
      }
      const amount = parseFloat(billLine.amount);
      if (amount <= 0) throw AppError.badRequest('Payment amount must be positive');
      const balanceDue = parseFloat(bill.balanceDue || '0');
      if (amount > balanceDue + 0.0001) {
        throw AppError.badRequest(
          `Payment amount ${amount.toFixed(2)} exceeds balance due ${balanceDue.toFixed(2)} on bill ${bill.txnNumber || bill.id}`,
        );
      }

      const grp = groups.get(bill.contactId) || {
        vendorId: bill.contactId,
        vendorBills: [],
        vendorCredits: [],
        totalBills: 0,
        totalCredits: 0,
        netPayment: 0,
      };
      grp.vendorBills.push({ billId: bill.id, amount, cashAmount: amount, bill });
      grp.totalBills += amount;
      groups.set(bill.contactId, grp);
    }

    // Distribute credits to their vendor groups, validating ownership
    for (const credLine of input.credits || []) {
      const credit = lockedCredits.find((c) => c.id === credLine.creditId);
      if (!credit || !credit.contactId) {
        throw AppError.badRequest(`Vendor credit ${credLine.creditId} not found`);
      }
      const targetBill = lockedBills.find((b) => b.id === credLine.billId);
      if (!targetBill) throw AppError.badRequest(`Target bill for credit ${credit.txnNumber || credit.id} not found`);
      if (targetBill.contactId !== credit.contactId) {
        throw AppError.badRequest('A vendor credit can only be applied to bills from the same vendor');
      }
      const amount = parseFloat(credLine.amount);
      if (amount <= 0) throw AppError.badRequest('Credit application amount must be positive');

      const creditAvailable = parseFloat(credit.balanceDue || '0');
      if (amount > creditAvailable + 0.0001) {
        throw AppError.badRequest(
          `Credit ${credit.txnNumber || credit.id} only has ${creditAvailable.toFixed(2)} available`,
        );
      }

      const grp = groups.get(credit.contactId);
      if (!grp) throw AppError.badRequest('Cannot apply credit to a vendor with no selected bills');
      grp.vendorCredits.push({ creditId: credit.id, billId: targetBill.id, amount });
      grp.totalCredits += amount;
    }

    // Validate per-vendor: credits cannot exceed bills
    for (const grp of groups.values()) {
      if (grp.totalCredits > grp.totalBills + 0.0001) {
        throw AppError.badRequest('Total credits applied for a vendor cannot exceed total bills selected');
      }
      grp.netPayment = grp.totalBills - grp.totalCredits;

      // Allocate credits per bill: subtract credits targeting this bill from
      // the bill's cash portion. We accept the user's per-bill credit
      // allocation as authoritative.
      const creditByBill = new Map<string, number>();
      for (const cr of grp.vendorCredits) {
        creditByBill.set(cr.billId, (creditByBill.get(cr.billId) || 0) + cr.amount);
      }
      for (const b of grp.vendorBills) {
        const creditForThisBill = creditByBill.get(b.billId) || 0;
        b.cashAmount = b.amount - creditForThisBill;
        if (b.cashAmount < -0.0001) {
          throw AppError.badRequest(
            `Credits applied to bill ${b.bill.txnNumber || b.billId} exceed the bill's payment amount`,
          );
        }
        // Clamp tiny floating-point negatives
        if (b.cashAmount < 0) b.cashAmount = 0;
      }
    }

    // Create one bill_payment transaction per vendor
    const createdPayments: Array<{
      payment: typeof transactions.$inferSelect;
      group: VendorPaymentGroup;
    }> = [];

    for (const grp of groups.values()) {
      // Build journal lines.
      // - DR AP for the total of bills being paid (this clears the AP balance
      //   the bill originally posted).
      // - CR Bank for the net cash leaving.
      // - CR AP for the credits applied (this re-debits AP because the credit's
      //   original journal entry already debited AP — when we apply the credit
      //   here we're effectively saying "the AP that the credit cleared was
      //   really for these bills"). The two AP lines net to (total - credits)
      //   = net cash, so the entry balances against the bank credit.
      //
      // Equivalent simpler form (when no credits): DR AP total, CR Bank total.
      const lines: Array<{ accountId: string; debit: string; credit: string; description?: string }> = [];

      lines.push({
        accountId: apAccountId,
        debit: grp.totalBills.toFixed(4),
        credit: '0',
        description: 'Bill payment',
      });

      if (grp.netPayment > 0) {
        lines.push({
          accountId: input.bankAccountId,
          debit: '0',
          credit: grp.netPayment.toFixed(4),
          description: 'Cash paid',
        });
      }

      if (grp.totalCredits > 0) {
        lines.push({
          accountId: apAccountId,
          debit: '0',
          credit: grp.totalCredits.toFixed(4),
          description: 'Vendor credit applied',
        });
      }

      // Sanity: debits == credits
      const debits = lines.reduce((s, l) => s + parseFloat(l.debit), 0);
      const credits = lines.reduce((s, l) => s + parseFloat(l.credit), 0);
      if (Math.abs(debits - credits) > 0.0001) {
        throw AppError.internal('Bill payment journal does not balance');
      }

      // Determine check number / print status
      let checkNumber: number | null = null;
      let printStatus: string | null = null;
      if (input.method === 'check' || input.method === 'check_handwritten') {
        if (input.method === 'check_handwritten') {
          checkNumber = await allocateCheckNumber(tenantId);
          printStatus = 'hand_written';
        } else if (input.printLater !== false) {
          // Default: queue for printing
          printStatus = 'queue';
        }
      }

      // Insert transaction header directly (we're inside an active tx; we
      // don't go through ledger.postTransaction because we need to set
      // bill-payment specific fields and stay in this tx).
      const [payment] = await tx.insert(transactions).values({
        tenantId,
        companyId: companyId || null,
        txnType: 'bill_payment',
        txnDate: input.txnDate,
        contactId: grp.vendorId,
        memo: input.memo || `Payment to vendor`,
        total: grp.netPayment.toFixed(4),
        status: 'posted',
        checkNumber,
        printStatus,
      }).returning();
      if (!payment) throw AppError.internal('Failed to create bill payment');

      // Insert journal lines
      const lineValues = lines.map((l, i) => ({
        tenantId,
        companyId: companyId || null,
        transactionId: payment.id,
        accountId: l.accountId,
        debit: l.debit,
        credit: l.credit,
        description: l.description || null,
        lineOrder: i,
      }));
      await tx.insert(journalLines).values(lineValues);

      // Update account balances
      for (const l of lines) {
        const delta = parseFloat(l.debit) - parseFloat(l.credit);
        if (delta !== 0) {
          await tx.update(accounts).set({
            balance: sql`${accounts.balance} + ${delta.toFixed(4)}::decimal`,
            updatedAt: new Date(),
          }).where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, l.accountId)));
        }
      }

      // Insert bill_payment_applications. Use the *cash* portion of each
      // bill's payment (not the user-entered total coverage), so that
      // bill.amount_paid represents only the cash that flowed against the
      // bill — credits are tracked separately in vendor_credit_applications.
      // Skip bills whose cash portion is zero (credits cover the entire bill);
      // the schema's CHECK (amount > 0) constraint would reject them and
      // recomputeBillStatus reads from both tables anyway.
      const cashApps = grp.vendorBills.filter((b) => b.cashAmount > 0);
      if (cashApps.length > 0) {
        await tx.insert(billPaymentApplications).values(cashApps.map((b) => ({
          tenantId,
          paymentId: payment.id,
          billId: b.billId,
          amount: b.cashAmount.toFixed(4),
        })));
      }

      // Insert vendor_credit_applications
      if (grp.vendorCredits.length > 0) {
        await tx.insert(vendorCreditApplications).values(grp.vendorCredits.map((c) => ({
          tenantId,
          paymentId: payment.id,
          creditId: c.creditId,
          billId: c.billId,
          amount: c.amount.toFixed(4),
        })));
      }

      // Recompute bill statuses
      for (const b of grp.vendorBills) {
        await billService.recomputeBillStatus(tx, tenantId, b.billId);
      }
      // Recompute credit balances
      const touchedCreditIds = [...new Set(grp.vendorCredits.map((c) => c.creditId))];
      for (const cid of touchedCreditIds) {
        await billService.recomputeVendorCreditBalance(tx, tenantId, cid);
      }

      await auditLog(tenantId, 'create', 'transaction', payment.id, null, {
        txnType: 'bill_payment',
        vendorId: grp.vendorId,
        bills: grp.vendorBills.length,
        credits: grp.vendorCredits.length,
        net: grp.netPayment,
      }, userId, tx);

      createdPayments.push({ payment, group: grp });
    }

    return {
      payments: createdPayments.map(({ payment, group }) => ({
        ...payment,
        billsPaid: group.vendorBills.length,
        creditsApplied: group.vendorCredits.length,
        netPayment: group.netPayment.toFixed(4),
      })),
    };
  });
}

export async function getBillPayment(tenantId: string, paymentId: string) {
  const [txn] = await db.select().from(transactions)
    .where(and(
      eq(transactions.tenantId, tenantId),
      eq(transactions.id, paymentId),
      eq(transactions.txnType, 'bill_payment'),
    ));
  if (!txn) throw AppError.notFound('Bill payment not found');

  const billApps = await db.select().from(billPaymentApplications)
    .where(and(eq(billPaymentApplications.tenantId, tenantId), eq(billPaymentApplications.paymentId, paymentId)));
  const creditApps = await db.select().from(vendorCreditApplications)
    .where(and(eq(vendorCreditApplications.tenantId, tenantId), eq(vendorCreditApplications.paymentId, paymentId)));

  return { ...txn, billApplications: billApps, creditApplications: creditApps };
}

export async function listBillPayments(tenantId: string, filters: {
  contactId?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}) {
  const conditions = [
    eq(transactions.tenantId, tenantId),
    eq(transactions.txnType, 'bill_payment'),
  ];
  if (filters.contactId) conditions.push(eq(transactions.contactId, filters.contactId));
  if (filters.startDate) conditions.push(sql`${transactions.txnDate} >= ${filters.startDate}`);
  if (filters.endDate) conditions.push(sql`${transactions.txnDate} <= ${filters.endDate}`);

  return db.select().from(transactions)
    .where(and(...conditions))
    .orderBy(sql`${transactions.txnDate} DESC`)
    .limit(filters.limit ?? 50)
    .offset(filters.offset ?? 0);
}

export async function voidBillPayment(tenantId: string, paymentId: string, reason: string, userId?: string) {
  return await db.transaction(async (tx) => {
    const [payment] = await tx.select().from(transactions)
      .where(and(
        eq(transactions.tenantId, tenantId),
        eq(transactions.id, paymentId),
        eq(transactions.txnType, 'bill_payment'),
      ))
      .for('update');

    if (!payment) throw AppError.notFound('Bill payment not found');
    if (payment.status === 'void') throw AppError.badRequest('Bill payment is already void');

    // Reverse the journal entries
    const originalLines = await tx.select().from(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, paymentId)));

    for (const line of originalLines) {
      const delta = parseFloat(line.credit) - parseFloat(line.debit); // reversed
      if (delta !== 0) {
        await tx.update(accounts).set({
          balance: sql`${accounts.balance} + ${delta.toFixed(4)}::decimal`,
          updatedAt: new Date(),
        }).where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, line.accountId)));
      }
    }

    // Capture and delete bill/credit applications, then recompute touched bills/credits
    const billApps = await tx.select().from(billPaymentApplications)
      .where(and(eq(billPaymentApplications.tenantId, tenantId), eq(billPaymentApplications.paymentId, paymentId)));
    const creditApps = await tx.select().from(vendorCreditApplications)
      .where(and(eq(vendorCreditApplications.tenantId, tenantId), eq(vendorCreditApplications.paymentId, paymentId)));

    await tx.delete(billPaymentApplications)
      .where(and(eq(billPaymentApplications.tenantId, tenantId), eq(billPaymentApplications.paymentId, paymentId)));
    await tx.delete(vendorCreditApplications)
      .where(and(eq(vendorCreditApplications.tenantId, tenantId), eq(vendorCreditApplications.paymentId, paymentId)));

    await tx.update(transactions).set({
      status: 'void',
      voidReason: reason,
      voidedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, paymentId)));

    // Recompute touched bills
    const touchedBillIds = [...new Set(billApps.map((b) => b.billId))];
    for (const id of touchedBillIds) {
      await billService.recomputeBillStatus(tx, tenantId, id);
    }
    // Recompute touched credits
    const touchedCreditIds = [...new Set(creditApps.map((c) => c.creditId))];
    for (const id of touchedCreditIds) {
      await billService.recomputeVendorCreditBalance(tx, tenantId, id);
    }

    await auditLog(tenantId, 'void', 'transaction', paymentId, payment, { reason }, userId, tx);
  });
}
