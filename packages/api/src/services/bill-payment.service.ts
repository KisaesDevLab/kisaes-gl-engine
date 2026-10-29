// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and, sql, inArray } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
type Decimal = InstanceType<typeof Decimal>;
import { CHECK_MEMO_PRINT_LIMIT, vendorAccountMemo, toStoredPaymentMethod, type PayBillsInput } from '@kis-books/shared';
import { db, type Tx } from '../db/index.js';
import {
  transactions,
  journalLines,
  accounts,
  contacts,
  billPaymentApplications,
  vendorCreditApplications,
  reconciliations,
  reconciliationLines,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as billService from './bill.service.js';
import { checkLockDate, auditLockOverride, assertAccountsInScope, assertNotStale, assertBalanced, inOtherCompany, round4 } from './ledger.service.js';
import { claimIdempotency, recordIdempotentEntity } from './idempotency.service.js';
import { lockCheckCounter, assertCheckNumberRangeFree, advanceCheckCounterPast, allocateNextCheckNumber } from './check.service.js';
import { assertBillDiscountAccount, companyBillDiscountAccountId } from './bill-discount-account.js';

// Comparisons are exact (review S1): every amount is rounded to the
// ledger's 4 places first (round4), so a payment may not exceed a balance
// due, or a credit its open balance, by even 0.0001. (Was a 0.0001
// tolerance.)
const EPSILON = new Decimal('0');

async function getApAccountId(tenantId: string): Promise<string> {
  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'accounts_payable')),
  });
  if (!account) throw AppError.internal("System account 'accounts_payable' not found");
  return account.id;
}

/** Width of the printed_memo column. */
const MAX_PRINTED_MEMO = 255;

/**
 * Memo to print on the check face when the payer didn't type one. A vendor
 * needs to know which of their invoices the check covers, so default to
 * their invoice numbers, falling back to our bill number where the vendor
 * gave none.
 *
 * The list is budgeted against CHECK_MEMO_PRINT_LIMIT, not the column width:
 * the memo rule is three inches wide and check-pdf's drawText slices off
 * whatever runs past it with no ellipsis, so budgeting at 255 would print a
 * half-written invoice number and silently drop the rest. Trimming here keeps
 * whole references and says how many didn't fit — the stub itemizes every
 * bill in full either way.
 *
 * When the vendor record carries the account number they assigned us
 * (contacts.vendor_account_number), it leads the memo: it is what the vendor
 * keys the payment to, so it must survive even when the invoice list has to
 * be trimmed. The invoice references then share whatever room is left.
 */
function defaultPrintedMemo(grp: VendorPaymentGroup, vendorAccountNumber?: string | null): string | null {
  const acct = vendorAccountMemo(vendorAccountNumber);
  const prefix = acct ? `${acct} - ` : '';
  const budget = CHECK_MEMO_PRINT_LIMIT - prefix.length;

  const refs = grp.vendorBills
    .map((b) => (b.bill.vendorInvoiceNumber || b.bill.txnNumber || '').trim())
    .filter((r) => r.length > 0);
  if (refs.length === 0) return acct || null;

  const full = refs.join(', ');
  if (full.length <= budget) return prefix + full;

  const kept: string[] = [];
  for (const ref of refs) {
    const candidate = [...kept, ref].join(', ');
    const dropped = refs.length - (kept.length + 1);
    const suffix = dropped > 0 ? ` +${dropped} more` : '';
    if (candidate.length + suffix.length > budget) break;
    kept.push(ref);
  }
  // A single reference longer than the print line still goes in whole: the
  // register should hold the real invoice number even though the paper cuts
  // it. Only the column width can truncate it.
  if (kept.length === 0) return (prefix + refs[0]!).slice(0, MAX_PRINTED_MEMO);
  return `${prefix}${kept.join(', ')} +${refs.length - kept.length} more`;
}

interface VendorPaymentGroup {
  vendorId: string;
  /**
   * Bills selected for payment in this group.
   * `amount` is the user-entered "this bill takes X of coverage" — total
   * satisfaction (cash + credits allocated to this bill). Stored as
   * Decimal so per-bill credit allocation doesn't lose precision across
   * repeated sums.
   * `cashAmount` is computed after credit allocation: amount minus the
   * credits whose `billId` points at this bill. This is what gets persisted
   * in `bill_payment_applications` and what `bill.amount_paid` reflects.
   */
  vendorBills: Array<{
    billId: string;
    amount: Decimal;
    cashAmount: Decimal;
    /** Early-payment discount taken on the bill (U-101), on top of amount. */
    discountAmount: Decimal;
    bill: typeof transactions.$inferSelect;
  }>;
  vendorCredits: Array<{ creditId: string; billId: string; amount: Decimal }>;
  totalBills: Decimal;
  totalCredits: Decimal;
  totalDiscount: Decimal;
  netPayment: Decimal;
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
 *
 * Early-payment discounts (U-101, bill-discounts-v1): bills[].discountAmount
 * settles that much more of the bill without cash. The AP debit grows by
 * the discounts and a credit line on the discount account (discountAccountId,
 * default the company's billDiscountAccountId) balances it; the bill's
 * application row carries discount_amount, and is written even when the
 * cash on the bill is 0 (credits + discount).
 *
 * Idempotency-Key (U-102, idempotency-pay-bills-v1): claimed on the posting
 * transaction; the first payment is the recorded entity.
 *
 * checkNumber (U-103, bill-payment-check-number-v1): consecutive numbers,
 * one per vendor payment that pays cash, in the order of the response.
 */
export async function payBills(
  tenantId: string,
  input: PayBillsInput,
  userId?: string,
  companyId?: string,
  // Where the payment was initiated when not by a signed-in staff user —
  // e.g. { source: 'client_portal', sourceId: portalContactId }. Stamped
  // on the payment header (transactions.source/source_id) so the print
  // queue and audit trail can attribute client-triggered checks.
  //
  // `alreadyCleared` is for a payment the bank has already made (a bank-feed
  // line matched to an open bill): there is nothing left to print and no
  // check number to hand out. It overrides input.method — the feed knows a
  // check number or it knows nothing, so the method is 'check' or unrecorded.
  origin?: { source: string; sourceId: string; alreadyCleared?: { checkNumber: number | null } },
) {
  if (input.bills.length === 0) throw AppError.badRequest('Must select at least one bill to pay');

  // U-103: a starting check number is for checks written now (not queued
  // for printing, not already through the bank).
  const firstCheckNumber = input.checkNumber !== undefined ? Number(input.checkNumber) : null;
  if (firstCheckNumber !== null && (input.method !== 'check' || input.printLater !== false || origin?.alreadyCleared)) {
    throw AppError.badRequest('checkNumber is only for method check with printLater false', 'VALIDATION_ERROR');
  }

  const apAccountId = await getApAccountId(tenantId);

  // Load and validate all referenced bills + credits up front (outside the
  // tx, then re-load with FOR UPDATE inside the tx so concurrent payments
  // can't double-pay the same bill).
  const billIds = input.bills.map((b) => b.billId);
  const creditIds = (input.credits || []).map((c) => c.creditId);

  return await db.transaction(async (tx) => {
    // Idempotency-Key (U-102): claimed on this transaction; a no-op without one.
    await claimIdempotency(tx);
    // Same guards postTransaction applies — this path posts to the GL
    // directly (header + lines + balances) and used to skip both,
    // letting a bill payment land in a locked prior year or credit a
    // bank account outside the caller's tenant/company scope.
    // The closed-period override is audited once per payment, with its id
    // and date, after the payments exist (review M4).
    const lockOverride = await checkLockDate(tx, tenantId, input.txnDate, companyId ?? null, undefined, { deferAudit: true });
    await assertAccountsInScope(tx, tenantId, companyId ?? null, [input.bankAccountId]);

    // Lock the bills + credits for the duration of the transaction. A bill
    // or credit of another company in the tenant is not found (review M3),
    // checked after the lock.
    const lockedBills = (await tx.select().from(transactions)
      .where(and(
        eq(transactions.tenantId, tenantId),
        eq(transactions.txnType, 'bill'),
        inArray(transactions.id, billIds),
      ))
      .for('update'))
      .filter((b) => !inOtherCompany(b, companyId));

    if (lockedBills.length !== billIds.length) {
      throw AppError.badRequest('One or more bills not found');
    }

    for (const bill of lockedBills) {
      // Only a posted bill can be paid (review B2): a void or deleted bill
      // keeps its old balance_due, which must not be paid again.
      if (bill.status !== 'posted') {
        throw AppError.badRequest(`Bill ${bill.txnNumber || bill.id} is ${bill.status}`, 'BILL_NOT_PAYABLE', { billId: bill.id, status: bill.status });
      }
      if (bill.billStatus === 'paid') throw AppError.badRequest(`Bill ${bill.txnNumber || bill.id} is already fully paid`);
      // Not received yet (U-87): in A/P, but not payable until it is ticked.
      if (bill.billReceived === false) {
        throw AppError.conflict(
          `Bill ${bill.txnNumber || bill.id} is not marked received yet. Mark it received, then pay it.`,
          'BILL_NOT_RECEIVED',
          { billId: bill.id },
        );
      }
    }

    const lockedCredits = creditIds.length > 0
      ? (await tx.select().from(transactions)
          .where(and(
            eq(transactions.tenantId, tenantId),
            eq(transactions.txnType, 'vendor_credit'),
            inArray(transactions.id, creditIds),
          ))
          .for('update'))
          .filter((cr) => !inOtherCompany(cr, companyId))
      : [];

    if (lockedCredits.length !== creditIds.length) {
      throw AppError.badRequest('One or more vendor credits not found');
    }
    // Only a posted credit can be applied (review B2).
    for (const credit of lockedCredits) {
      if (credit.status !== 'posted') {
        throw AppError.badRequest(`Vendor credit ${credit.txnNumber || credit.id} is ${credit.status}`, 'CREDIT_NOT_AVAILABLE', { creditId: credit.id, status: credit.status });
      }
    }

    // Group by vendor: one bill_payment transaction per vendor.
    // All monetary math runs through Decimal.js so cumulative rounding
    // across many selected bills can't drift the AP debit off the bank
    // credit by a fraction of a cent.
    const groups = new Map<string, VendorPaymentGroup>();
    for (const billLine of input.bills) {
      const bill = lockedBills.find((b) => b.id === billLine.billId);
      if (!bill || !bill.contactId) {
        throw AppError.badRequest(`Bill ${billLine.billId} has no vendor`);
      }
      const amount = round4(billLine.amount);  // ledger scale first (U-65)
      const discount = round4(billLine.discountAmount ?? '0');
      if (discount.isNegative()) throw AppError.badRequest('Discount amount must not be negative', 'VALIDATION_ERROR');
      // Amount 0 is allowed only with a discount (credits + discount, no cash).
      if (amount.isNegative() || (amount.isZero() && discount.isZero())) {
        throw AppError.badRequest('Payment amount must be positive');
      }
      const balanceDue = new Decimal(bill.balanceDue || '0');
      if (amount.plus(discount).minus(balanceDue).greaterThan(EPSILON)) {
        throw AppError.badRequest(discount.isZero()
          ? `Payment amount ${amount.toFixed(2)} exceeds balance due ${balanceDue.toFixed(2)} on bill ${bill.txnNumber || bill.id}`
          : `Payment amount ${amount.toFixed(2)} plus discount ${discount.toFixed(2)} exceeds balance due ${balanceDue.toFixed(2)} on bill ${bill.txnNumber || bill.id}`,
        );
      }

      const grp = groups.get(bill.contactId) || {
        vendorId: bill.contactId,
        vendorBills: [],
        vendorCredits: [],
        totalBills: new Decimal('0'),
        totalCredits: new Decimal('0'),
        totalDiscount: new Decimal('0'),
        netPayment: new Decimal('0'),
      };
      grp.vendorBills.push({ billId: bill.id, amount, cashAmount: amount, discountAmount: discount, bill });
      grp.totalBills = grp.totalBills.plus(amount);
      grp.totalDiscount = grp.totalDiscount.plus(discount);
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
      const amount = round4(credLine.amount);  // ledger scale first (U-65)
      if (amount.lessThanOrEqualTo(0)) throw AppError.badRequest('Credit application amount must be positive');

      const creditAvailable = new Decimal(credit.balanceDue || '0');
      if (amount.minus(creditAvailable).greaterThan(EPSILON)) {
        throw AppError.badRequest(
          `Credit ${credit.txnNumber || credit.id} only has ${creditAvailable.toFixed(2)} available`,
        );
      }

      const grp = groups.get(credit.contactId);
      if (!grp) throw AppError.badRequest('Cannot apply credit to a vendor with no selected bills');
      grp.vendorCredits.push({ creditId: credit.id, billId: targetBill.id, amount });
      grp.totalCredits = grp.totalCredits.plus(amount);
    }

    // Validate per-vendor: credits cannot exceed bills
    for (const grp of groups.values()) {
      if (grp.totalCredits.minus(grp.totalBills).greaterThan(EPSILON)) {
        throw AppError.badRequest('Total credits applied for a vendor cannot exceed total bills selected');
      }
      grp.netPayment = grp.totalBills.minus(grp.totalCredits);

      // Allocate credits per bill: subtract credits targeting this bill from
      // the bill's cash portion. We accept the user's per-bill credit
      // allocation as authoritative.
      const creditByBill = new Map<string, Decimal>();
      for (const cr of grp.vendorCredits) {
        const prior = creditByBill.get(cr.billId) || new Decimal('0');
        creditByBill.set(cr.billId, prior.plus(cr.amount));
      }
      for (const b of grp.vendorBills) {
        const creditForThisBill = creditByBill.get(b.billId) || new Decimal('0');
        let cash = b.amount.minus(creditForThisBill);
        if (cash.lessThan(EPSILON.negated())) {
          throw AppError.badRequest(
            `Credits applied to bill ${b.bill.txnNumber || b.billId} exceed the bill's payment amount`,
          );
        }
        // Clamp sub-penny negatives that are within tolerance
        if (cash.isNegative()) cash = new Decimal('0');
        b.cashAmount = cash;
      }
    }

    // Discount account (U-101): the request's, else the company default.
    const anyDiscount = [...groups.values()].some((g) => g.totalDiscount.greaterThan(0));
    let discountAccountId: string | null = null;
    if (anyDiscount) {
      discountAccountId = input.discountAccountId ?? await companyBillDiscountAccountId(tx, tenantId, companyId);
      if (!discountAccountId) {
        throw AppError.badRequest(
          'Choose the account for early-payment discounts, or set a default discount account in company settings.',
          'DISCOUNT_ACCOUNT_REQUIRED',
        );
      }
      await assertBillDiscountAccount(tx, tenantId, companyId, discountAccountId, input.bankAccountId);
    }

    // Check numbers (U-103): one per vendor payment that pays cash, in
    // vendor order. The counter row is locked first so a concurrent save of
    // the same numbers waits, then sees these and is refused.
    const checkNumberFor = new Map<string, number>();
    let lastCheckNumber: number | null = null;
    if (firstCheckNumber !== null) {
      const cashGroups = [...groups.values()].filter((g) => g.netPayment.greaterThan(0));
      if (cashGroups.length > 0) {
        lastCheckNumber = firstCheckNumber + cashGroups.length - 1;
        await lockCheckCounter(tx, tenantId, companyId);
        await assertCheckNumberRangeFree(tx, tenantId, input.bankAccountId, firstCheckNumber, lastCheckNumber);
        cashGroups.forEach((g, i) => checkNumberFor.set(g.vendorId, firstCheckNumber + i));
      }
    }

    // Create one bill_payment transaction per vendor
    const createdPayments: Array<{
      payment: typeof transactions.$inferSelect;
      group: VendorPaymentGroup;
    }> = [];

    // The account number each vendor assigned us, for the default check memo.
    // One read for the whole batch; an explicit input.printedMemo still wins.
    const vendorAccountNumbers = new Map<string, string | null>();
    if (input.method === 'check' || input.method === 'check_handwritten') {
      const vendorRows = await tx
        .select({ id: contacts.id, vendorAccountNumber: contacts.vendorAccountNumber })
        .from(contacts)
        .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, [...groups.keys()])));
      for (const v of vendorRows) vendorAccountNumbers.set(v.id, v.vendorAccountNumber);
    }

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

      // The discounts settle A/P too (U-101): DR A/P amounts + discounts.
      lines.push({
        accountId: apAccountId,
        debit: grp.totalBills.plus(grp.totalDiscount).toFixed(4),
        credit: '0',
        description: 'Bill payment',
      });

      if (grp.netPayment.greaterThan(0)) {
        lines.push({
          accountId: input.bankAccountId,
          debit: '0',
          credit: grp.netPayment.toFixed(4),
          description: 'Cash paid',
        });
      }

      if (grp.totalCredits.greaterThan(0)) {
        lines.push({
          accountId: apAccountId,
          debit: '0',
          credit: grp.totalCredits.toFixed(4),
          description: 'Vendor credit applied',
        });
      }

      if (grp.totalDiscount.greaterThan(0)) {
        lines.push({
          accountId: discountAccountId!,
          debit: '0',
          credit: grp.totalDiscount.toFixed(4),
          description: 'Early-payment discount',
        });
      }

      // Debits == credits exactly at the stored scale (U-65).
      assertBalanced(lines);

      // Determine check number / print status
      let checkNumber: number | null = null;
      let printStatus: string | null = null;
      const cleared = origin?.alreadyCleared;
      const paysByCheck = !cleared && (input.method === 'check' || input.method === 'check_handwritten');
      if (cleared && cleared.checkNumber != null) {
        // Written outside the system and already through the bank: keep the
        // bank's number, stay out of the print queue.
        checkNumber = cleared.checkNumber;
        printStatus = 'hand_written';
      }
      if (paysByCheck) {
        if (input.method === 'check_handwritten') {
          // The company's counter for this bank account, claimed on the posting
          // transaction under the counter lock (Q-PR2b): a refused payment takes
          // no number and companies of one tenant count independently. A
          // payment of credits and discounts only writes no check, so it takes
          // no number either (U-117 S1).
          if (grp.netPayment.greaterThan(0)) {
            await lockCheckCounter(tx, tenantId, companyId);
            checkNumber = await allocateNextCheckNumber(tx, tenantId, input.bankAccountId, companyId);
            printStatus = 'hand_written';
          }
        } else if (checkNumberFor.has(grp.vendorId)) {
          // Numbered now (U-103), like a hand-written check from Write Checks.
          checkNumber = checkNumberFor.get(grp.vendorId)!;
          printStatus = 'hand_written';
        } else if (input.printLater !== false && grp.netPayment.greaterThan(0)) {
          // Default: queue for printing. A payment of credits and discounts
          // only pays no cash, so there is no check to print (U-117 S1).
          printStatus = 'queue';
        }
      }

      // printed_memo is what lands on the check's memo line; transactions.memo
      // stays the bookkeeping note. Only checks carry one.
      const printedMemo = paysByCheck
        ? (input.printedMemo?.trim() || defaultPrintedMemo(grp, vendorAccountNumbers.get(grp.vendorId)))
        : null;

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
        // A check was written or queued for this payment (U-117, Q-PR2e).
        isCheck: printStatus !== null,
        printedMemo,
        paymentMethod: cleared
          ? (cleared.checkNumber != null ? 'check' : null)
          : toStoredPaymentMethod(input.method),
        referenceNumber: input.referenceNumber?.trim() || null,
        source: origin?.source ?? null,
        sourceId: origin?.sourceId ?? null,
      }).returning();
      if (!payment) throw AppError.internal('Failed to create bill payment');
      await recordIdempotentEntity(tx, 'transaction', payment.id);

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

      // Update account balances. Arithmetic is Decimal-side; the actual
      // UPDATE remains SQL-atomic (`balance = balance + delta::decimal`).
      for (const l of lines) {
        const delta = new Decimal(l.debit).minus(l.credit);
        if (!delta.isZero()) {
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
      // Skip bills with neither cash nor discount (credits cover the entire
      // bill): CHECK (amount >= 0 AND amount + discount_amount > 0) would
      // reject them and recomputeBillStatus reads from both tables anyway.
      // A bill with a discount keeps its row even at cash 0 (U-101).
      const billApps = grp.vendorBills.filter((b) => b.cashAmount.greaterThan(0) || b.discountAmount.greaterThan(0));
      if (billApps.length > 0) {
        await tx.insert(billPaymentApplications).values(billApps.map((b) => ({
          tenantId,
          paymentId: payment.id,
          billId: b.billId,
          amount: b.cashAmount.toFixed(4),
          discountAmount: b.discountAmount.toFixed(4),
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
        net: grp.netPayment.toFixed(4),
        ...(grp.totalDiscount.greaterThan(0) ? { discount: grp.totalDiscount.toFixed(4), discountAccountId } : {}),
        ...(origin ? { source: origin.source, sourceId: origin.sourceId } : {}),
      }, userId, tx);
      if (lockOverride) {
        await auditLockOverride(tx, tenantId, lockOverride, { txnId: payment.id, oldDate: null, newDate: input.txnDate });
      }

      createdPayments.push({ payment, group: grp });
    }

    // The bank account's counter moves past the last number (never back).
    if (lastCheckNumber !== null) {
      await advanceCheckCounterPast(tx, tenantId, input.bankAccountId, lastCheckNumber, companyId);
    }

    return {
      payments: createdPayments.map(({ payment, group }) => ({
        ...payment,
        billsPaid: group.vendorBills.length,
        creditsApplied: group.vendorCredits.length,
        netPayment: group.netPayment.toFixed(4),
        discountTotal: group.totalDiscount.toFixed(4),
      })),
    };
  });
}

/**
 * The payments one payBills request posted, in the response shape, for an
 * Idempotency-Key replay without a stored body (U-102): every bill payment
 * of the tenant and company created in the same database transaction as
 * `firstPaymentId` (one created_at), ordered by check number, then id.
 */
export async function paymentsPostedWith(tenantId: string, firstPaymentId: string, companyId?: string) {
  const [first] = await db.select().from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, firstPaymentId), eq(transactions.txnType, 'bill_payment')));
  if (!first || inOtherCompany(first, companyId)) throw AppError.notFound('Bill payment not found');
  const rows = await db.select().from(transactions)
    .where(and(
      eq(transactions.tenantId, tenantId),
      eq(transactions.txnType, 'bill_payment'),
      // Compared in the database: a JS Date drops created_at's microseconds.
      first.createdAt
        ? sql`${transactions.createdAt} = (SELECT f.created_at FROM transactions f WHERE f.tenant_id = ${tenantId} AND f.id = ${first.id})`
        : eq(transactions.id, first.id),
      first.companyId ? eq(transactions.companyId, first.companyId) : sql`${transactions.companyId} IS NULL`,
    ))
    .orderBy(sql`${transactions.checkNumber} ASC NULLS LAST`, transactions.id);
  const ids = rows.map((r) => r.id);
  const billApps = await db.select().from(billPaymentApplications)
    .where(and(eq(billPaymentApplications.tenantId, tenantId), inArray(billPaymentApplications.paymentId, ids)));
  const creditApps = await db.select().from(vendorCreditApplications)
    .where(and(eq(vendorCreditApplications.tenantId, tenantId), inArray(vendorCreditApplications.paymentId, ids)));
  return rows.map((p) => {
    const mine = billApps.filter((a) => a.paymentId === p.id);
    const myCredits = creditApps.filter((a) => a.paymentId === p.id);
    const bills = new Set([...mine.map((a) => a.billId), ...myCredits.map((a) => a.billId)]);
    return {
      ...p,
      billsPaid: bills.size,
      creditsApplied: myCredits.length,
      netPayment: new Decimal(p.total || '0').toFixed(4),
      discountTotal: mine.reduce((s, a) => s.plus(a.discountAmount), new Decimal('0')).toFixed(4),
    };
  });
}

/** A bill payment with its applications; another company's is not found (U-104). */
export async function getBillPayment(tenantId: string, paymentId: string, companyId?: string) {
  const [txn] = await db.select().from(transactions)
    .where(and(
      eq(transactions.tenantId, tenantId),
      eq(transactions.id, paymentId),
      eq(transactions.txnType, 'bill_payment'),
    ));
  if (!txn || inOtherCompany(txn, companyId)) throw AppError.notFound('Bill payment not found');

  const billApps = await db.select().from(billPaymentApplications)
    .where(and(eq(billPaymentApplications.tenantId, tenantId), eq(billPaymentApplications.paymentId, paymentId)));
  const creditApps = await db.select().from(vendorCreditApplications)
    .where(and(eq(vendorCreditApplications.tenantId, tenantId), eq(vendorCreditApplications.paymentId, paymentId)));

  // U-108 (voucher stubs): each application carries the document it applies
  // — `bill` on a bill application, `credit` (the vendor credit) on a credit
  // application — with its number, vendor invoice number, date and total
  // (a decimal string). Null when the document is gone.
  const docIds = [...new Set([...billApps.map((a) => a.billId), ...creditApps.map((a) => a.creditId)])];
  const docs = docIds.length === 0 ? [] : await db.select({
    id: transactions.id,
    txnNumber: transactions.txnNumber,
    vendorInvoiceNumber: transactions.vendorInvoiceNumber,
    txnDate: transactions.txnDate,
    total: transactions.total,
  }).from(transactions).where(and(eq(transactions.tenantId, tenantId), inArray(transactions.id, docIds)));
  const docById = new Map(docs.map((d) => [d.id, {
    txnNumber: d.txnNumber ?? null,
    vendorInvoiceNumber: d.vendorInvoiceNumber ?? null,
    txnDate: d.txnDate,
    total: d.total ?? null,
  }]));

  return {
    ...txn,
    billApplications: billApps.map((a) => ({ ...a, bill: docById.get(a.billId) ?? null })),
    creditApplications: creditApps.map((a) => ({ ...a, credit: docById.get(a.creditId) ?? null })),
  };
}

export async function listBillPayments(tenantId: string, filters: {
  contactId?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
  /** The request's company (U-104); rows without a company are included, as payBills accepts them. */
  companyId?: string;
}) {
  const conditions = [
    eq(transactions.tenantId, tenantId),
    eq(transactions.txnType, 'bill_payment'),
  ];
  if (filters.companyId) {
    conditions.push(sql`(${transactions.companyId} = ${filters.companyId} OR ${transactions.companyId} IS NULL)`);
  }
  if (filters.contactId) conditions.push(eq(transactions.contactId, filters.contactId));
  if (filters.startDate) conditions.push(sql`${transactions.txnDate} >= ${filters.startDate}`);
  if (filters.endDate) conditions.push(sql`${transactions.txnDate} <= ${filters.endDate}`);

  return db.select().from(transactions)
    .where(and(...conditions))
    .orderBy(sql`${transactions.txnDate} DESC`)
    .limit(filters.limit ?? 50)
    .offset(filters.offset ?? 0);
}

export interface VoidBillPaymentOptions {
  /** ap-edit-v1: updatedAt as last read; mismatch is 409 STALE. */
  expectedUpdatedAt?: string;
  /** The request's company: another company's payment is not found (review M3). */
  companyId?: string;
}

export async function voidBillPayment(
  tenantId: string, paymentId: string, reason: string, userId?: string, opts: VoidBillPaymentOptions = {},
) {
  return await db.transaction((tx) => voidBillPaymentInTx(tx, tenantId, paymentId, reason, userId, opts));
}

/**
 * voidBillPayment inside the caller's database transaction. ledger
 * voidTransaction routes bill payments here (review B1), so voiding one
 * from the register (POST /transactions/:id/void) also removes its
 * applications and reopens the bills and credits it settled.
 */
export async function voidBillPaymentInTx(
  tx: Tx, tenantId: string, paymentId: string, reason: string, userId?: string, opts: VoidBillPaymentOptions = {},
) {
  {
    // Idempotency-Key (idempotency-ap-v1): claimed in this transaction; a
    // no-op without a key, or when ledger.voidTransaction already claimed
    // on this transaction (POST /transactions/:id/void).
    await claimIdempotency(tx);
    await recordIdempotentEntity(tx, 'transaction', paymentId);
    const [payment] = await tx.select().from(transactions)
      .where(and(
        eq(transactions.tenantId, tenantId),
        eq(transactions.id, paymentId),
        eq(transactions.txnType, 'bill_payment'),
      ))
      .for('update');

    if (!payment || payment.status === 'deleted' || inOtherCompany(payment, opts.companyId)) {
      throw AppError.notFound('Bill payment not found');
    }
    if (payment.status === 'void') throw AppError.badRequest('Bill payment is already void');
    assertNotStale(payment, opts.expectedUpdatedAt, 'This bill payment');

    // Same guards as ledger.voidTransaction — this custom void path used
    // to skip both, so a bill payment in a LOCKED prior year could be
    // voided (silently changing closed-year Cash/AP), and voiding a
    // payment cleared in a completed bank rec left the rec unreconcilable.
    // An override's audit row names the payment and its date (review M4).
    await checkLockDate(tx, tenantId, payment.txnDate, payment.companyId, undefined, {
      txnId: paymentId, oldDate: payment.txnDate, newDate: null,
    });
    const clearedInCompleted = await tx.execute(sql`
      SELECT 1
      FROM ${reconciliationLines} rl
      JOIN ${reconciliations} r ON r.id = rl.reconciliation_id
      JOIN ${journalLines} jl ON jl.id = rl.journal_line_id
      WHERE r.tenant_id = ${tenantId}
        AND r.status = 'complete'
        AND rl.is_cleared = true
        AND jl.transaction_id = ${paymentId}
      LIMIT 1
    `);
    if ((clearedInCompleted.rows as unknown[]).length > 0) {
      throw AppError.badRequest(
        'Cannot void a bill payment whose lines are cleared in a completed bank reconciliation. ' +
          'Undo the reconciliation first, then void and post a correcting entry.',
      );
    }

    // Reverse the journal entries
    const originalLines = await tx.select().from(journalLines)
      .where(and(
        eq(journalLines.tenantId, tenantId),
        eq(journalLines.transactionId, paymentId),
        eq(journalLines.isVoidReversal, false),
      ));

    // Persist the reversing lines (rule 23) — same convention as
    // ledger.voidTransaction: attached to the voided header, marked
    // is_void_reversal so document views skip them.
    if (originalLines.length > 0) {
      const maxOrder = originalLines.reduce((m, l) => Math.max(m, l.lineOrder ?? 0), 0);
      await tx.insert(journalLines).values(originalLines.map((line, i) => ({
        tenantId,
        companyId: line.companyId,
        transactionId: paymentId,
        accountId: line.accountId,
        debit: line.credit,
        credit: line.debit,
        description: `Void: ${line.description || ''}`.trim(),
        tagId: line.tagId,
        lineOrder: maxOrder + 1 + i,
        isVoidReversal: true,
      })));
    }

    for (const line of originalLines) {
      // Reversed: was debit/credit → becomes credit-minus-debit.
      const delta = new Decimal(line.credit).minus(line.debit);
      if (!delta.isZero()) {
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
      // A void check waiting to print leaves the print queue (U-115).
      ...(payment.printStatus === 'queue' ? { printStatus: null } : {}),
    }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, paymentId)));

    // Recompute touched bills: those it paid (cash or discount) and those
    // only its credits settled, which have no bill application row.
    const touchedBillIds = [...new Set([...billApps.map((b) => b.billId), ...creditApps.map((c) => c.billId)])];
    for (const id of touchedBillIds) {
      await billService.recomputeBillStatus(tx, tenantId, id);
    }
    // Recompute touched credits
    const touchedCreditIds = [...new Set(creditApps.map((c) => c.creditId))];
    for (const id of touchedCreditIds) {
      await billService.recomputeVendorCreditBalance(tx, tenantId, id);
    }

    // The application rows are deleted above: the before-image carries them,
    // so the audit trail still shows what the payment settled (U-117 S5).
    await auditLog(tenantId, 'void', 'transaction', paymentId, {
      ...payment, billApplications: billApps, creditApplications: creditApps,
    }, { reason }, userId, tx);
  }
}
