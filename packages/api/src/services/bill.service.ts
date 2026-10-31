// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { recomputeVendorCreditBalance as recomputeVendorCreditWithRefunds } from './deposit-links.service.js';
import { eq, and, sql, count, inArray } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
type DecimalValue = InstanceType<typeof Decimal>;
import { findPaymentTerm, type CreateBillInput, type BillFilters } from '@kis-books/shared';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import { transactions, accounts, contacts, items, journalLines as journalLinesTable } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';
import { escapeLike } from '../utils/sql-like.js';
import { addCalendarDays } from '../utils/calendar-date.js';
import { lineAmountFromQuantity, parseQuantity, parseUnitPrice, fitsMoneyColumn, sameAmount, exactSum, termsDiscountAmount } from '../utils/line-amount.js';
import { assertLineContacts } from './line-contacts.service.js';
import { relinkDraftAttachments } from './attachment.service.js';

// ─── Terms (U-86, bill-terms-v1) ────────────────────────────────

/** The terms fields a bill stores, resolved from the request and the vendor. */
export interface ResolvedBillTerms {
  paymentTerms: string | null;
  termsDays: number | null;
  discountPercent: string | null;
  discountDays: number | null;
  dueDate: string | null;
  discountDate: string | null;
  dueDateOverridden: boolean;
  discountDateOverridden: boolean;
  /** Where the terms came from: the request, the vendor's defaults, or none. */
  source: 'input' | 'vendor' | 'none';
}

export interface BillTermsRequest {
  txnDate: string;
  paymentTerms?: string;
  termsDays?: number;
  discountPercent?: string;
  discountDays?: number;
  dueDate?: string;
  discountDate?: string;
}

export interface VendorTermsDefaults {
  defaultPaymentTerms?: string | null;
  defaultTermsDays?: number | null;
  defaultDiscountPercent?: string | null;
  defaultDiscountDays?: number | null;
}

function termsError(message: string): AppError {
  return AppError.badRequest(message, 'VALIDATION_ERROR');
}

/** A discount percent as stored (numeric(7,4)): 0 < p < 100. */
function normalizePercent(value: string): string {
  const p = new Decimal(value);
  if (!p.greaterThan(0) || !p.lessThan(100)) throw termsError('discountPercent must be greater than 0 and less than 100');
  return p.toFixed(4);
}

/**
 * Resolves a bill's terms, due date and discount date (U-86). The one
 * function create, edit and GET /bills/terms-dates use. Dates are pure
 * calendar arithmetic (no time zone).
 *
 * Terms: the request's paymentTerms, else the vendor's default, else none.
 * A fixed code takes its net days and discount from PAYMENT_TERMS (sending
 * discountPercent / discountDays with one is 400). `custom` takes termsDays
 * (the request's, else the vendor's; without one there is no computed due
 * date) and an optional discount (discountPercent + discountDays, both or
 * neither; days fewer than the net days); with vendor custom terms the
 * request's own termsDays / discount win over the vendor's. An unknown vendor code (free text from before the
 * table) is kept as is with no computed dates.
 *
 * An explicit dueDate / discountDate is the owner's override and wins; it
 * is flagged so an edit doesn't recompute it.
 */
export function resolveBillTerms(req: BillTermsRequest, vendor: VendorTermsDefaults | null): ResolvedBillTerms {
  const fromInput = !!req.paymentTerms;
  const code = req.paymentTerms || vendor?.defaultPaymentTerms || null;
  const source: ResolvedBillTerms['source'] = fromInput ? 'input' : code ? 'vendor' : 'none';
  const def = findPaymentTerm(code);
  const sentDiscount = req.discountPercent !== undefined || req.discountDays !== undefined;

  let termsDays: number | null = null;
  let discountPercent: string | null = null;
  let discountDays: number | null = null;
  let known = true;

  if (!code) {
    if (sentDiscount) throw termsError('discountPercent and discountDays go with custom payment terms');
    termsDays = req.termsDays ?? null;
    known = false;
  } else if (!def) {
    // A legacy free-text vendor code: stored as before, no computed dates.
    if (sentDiscount) throw termsError('discountPercent and discountDays go with custom payment terms');
    termsDays = req.termsDays ?? vendor?.defaultTermsDays ?? null;
    known = false;
  } else if (def.code === 'custom') {
    // Without termsDays (from the request, else the vendor) there is no
    // computed due date, as before; the owner may still send dueDate.
    termsDays = req.termsDays ?? vendor?.defaultTermsDays ?? null;
    if (sentDiscount) {
      if (req.discountPercent === undefined || req.discountDays === undefined) {
        throw termsError('Send discountPercent and discountDays together');
      }
      discountPercent = normalizePercent(req.discountPercent);
      discountDays = req.discountDays;
      if (termsDays !== null && discountDays >= termsDays) {
        throw termsError('discountDays must be fewer than the net days (termsDays)');
      }
    } else if (!fromInput && vendor?.defaultDiscountPercent && vendor.defaultDiscountDays != null) {
      // The vendor's custom discount, when it is consistent with the net days.
      const p = new Decimal(vendor.defaultDiscountPercent);
      if (p.greaterThan(0) && p.lessThan(100) && (termsDays === null || vendor.defaultDiscountDays < termsDays)) {
        discountPercent = p.toFixed(4);
        discountDays = vendor.defaultDiscountDays;
      }
    }
  } else {
    if (sentDiscount) throw termsError('discountPercent and discountDays go with custom payment terms');
    termsDays = def.netDays;
    discountPercent = def.discountPercent;
    discountDays = def.discountDays;
  }

  const dueDateOverridden = !!req.dueDate;
  const dueDate = req.dueDate
    || (known && termsDays !== null ? addCalendarDays(req.txnDate, termsDays) : null);

  const discountDateOverridden = !!req.discountDate;
  if (req.discountDate && discountPercent === null) {
    throw termsError('discountDate needs payment terms with an early-payment discount');
  }
  const discountDate = req.discountDate
    || (discountPercent !== null && discountDays !== null ? addCalendarDays(req.txnDate, discountDays) : null);

  return {
    paymentTerms: code,
    termsDays,
    discountPercent,
    discountDays,
    dueDate,
    discountDate,
    dueDateOverridden,
    discountDateOverridden,
    source,
  };
}

/**
 * Compute due date from a bill date + payment terms (kept for callers of the
 * old helper). Custom terms use customDays. Calendar arithmetic (U-86): the
 * old local-time setDate came out a day early across the March DST change.
 */
export function computeBillDueDate(txnDate: string, terms: string | undefined, customDays: number | undefined): string | undefined {
  if (!terms) return undefined;
  const def = findPaymentTerm(terms);
  const days = !def ? undefined : def.code === 'custom' ? customDays : def.netDays ?? undefined;
  if (days === undefined) return undefined;
  return addCalendarDays(txnDate, days);
}

/** GET /bills/terms-dates: what create would compute, read-only (U-86). */
export async function getTermsDates(
  tenantId: string,
  query: BillTermsRequest & { contactId?: string },
  companyId?: string,
) {
  const vendor = query.contactId ? await loadVendorDefaults(db, tenantId, query.contactId, companyId) : null;
  const t = resolveBillTerms({ ...query, dueDate: undefined, discountDate: undefined }, vendor);
  return {
    dueDate: t.dueDate,
    discountDate: t.discountDate,
    paymentTerms: t.paymentTerms,
    termsDays: t.termsDays,
    discountPercent: t.discountPercent,
    discountDays: t.discountDays,
    source: t.source,
  };
}

// ─── Lines (U-85, bill-lines-v1) ────────────────────────────────

/** A bill or vendor-credit line as the request carries it. */
export interface ApLineInput {
  accountId: string;
  description?: string;
  amount: string;
  itemId?: string | null;
  quantity?: string | null;
  unitPrice?: string | null;
  tagId?: string | null;
  contactId?: string | null;
  isBillable?: boolean;
}

export interface BuiltApLine {
  accountId: string;
  amount: DecimalValue;
  description?: string;
  itemId: string | null;
  quantity: string | null;
  unitPrice: string | null;
  tagId?: string | null;
  contactId: string | null;
  isBillable: boolean;
}

// A line amount as bills have always taken it (balance-exact-v1): a plain
// decimal string, optionally negative, rounded to the ledger's 4 places
// (half away from zero). Exponents, separators, currency signs or anything
// non-numeric are 400 VALIDATION_ERROR (they used to reach the database).
const AP_AMOUNT_RE = /^-?\d{1,15}(\.\d+)?$/;
function apLineAmount(value: unknown, field: string): DecimalValue {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!AP_AMOUNT_RE.test(s)) {
    throw AppError.badRequest(`${field} must be a decimal amount`, 'VALIDATION_ERROR');
  }
  const amount = ledger.round4(s);
  if (!fitsMoneyColumn(amount)) throw AppError.badRequest(`${field} is too large`, 'VALIDATION_ERROR');
  return amount;
}

/**
 * Validates a bill's or vendor credit's lines in memory (400s): amount a
 * plain decimal string, rounded to 4 places (VALIDATION_ERROR); unitPrice
 * without quantity → LINE_QTY_RATE_INCOMPLETE; quantity and unitPrice both
 * given → amount must equal round(quantity x unitPrice, 2, half away from
 * zero), else LINE_AMOUNT_MISMATCH (details.lineIndex, details.expected);
 * quantity with amount and no unitPrice is fine. `isBillable` only where
 * allowed (bills), and only with a line contactId. The total must fit a
 * money column.
 */
export function buildApLines(lines: readonly ApLineInput[], opts: { allowBillable: boolean }): { lines: BuiltApLine[]; total: DecimalValue } {
  const built = lines.map((l, i): BuiltApLine => {
    const field = `lines[${i}]`;
    const amount = apLineAmount(l.amount, `${field}.amount`);
    const hasQty = l.quantity !== undefined && l.quantity !== null;
    const hasPrice = l.unitPrice !== undefined && l.unitPrice !== null;
    if (hasPrice && !hasQty) {
      throw AppError.badRequest(`Line ${i + 1} has a cost (unitPrice) but no quantity`, 'LINE_QTY_RATE_INCOMPLETE', { lineIndex: i });
    }
    let quantity: string | null = null;
    let unitPrice: string | null = null;
    if (hasQty) {
      quantity = parseQuantity(l.quantity, `${field}.quantity`).toFixed();
      if (hasPrice) {
        unitPrice = parseUnitPrice(l.unitPrice, `${field}.unitPrice`).toFixed();
        const expected = lineAmountFromQuantity(quantity, unitPrice, field);
        if (!sameAmount(expected, amount.toFixed(4))) {
          throw AppError.badRequest(
            `Line ${i + 1}: amount ${amount.toFixed(2)} is not quantity x cost (${expected})`,
            'LINE_AMOUNT_MISMATCH',
            { lineIndex: i, expected },
          );
        }
      }
    }
    if (l.isBillable === true && !opts.allowBillable) {
      throw AppError.badRequest(`Line ${i + 1}: a vendor credit line cannot be billable`, 'VALIDATION_ERROR');
    }
    return {
      accountId: l.accountId,
      amount,
      description: l.description,
      itemId: l.itemId || null,
      quantity,
      unitPrice,
      tagId: l.tagId,
      contactId: l.contactId || null,
      isBillable: l.isBillable === true,
    };
  });
  // Summed at 40 digits (review L4), then bounded to the money column.
  const total = exactSum(built.map((l) => l.amount));
  if (!fitsMoneyColumn(total)) throw AppError.badRequest('The total is too large', 'VALIDATION_ERROR');
  return { lines: built, total };
}

/** Items named on lines must be this tenant's (and in the company scope). */
export async function assertItemsInScope(executor: DbOrTx, tenantId: string, companyId: string | null | undefined, itemIds: Array<string | null>) {
  const ids = [...new Set(itemIds.filter((v): v is string => !!v))];
  if (ids.length === 0) return;
  const rows = await executor.select({ id: items.id, companyId: items.companyId }).from(items)
    .where(and(eq(items.tenantId, tenantId), inArray(items.id, ids)));
  if (rows.length !== ids.length || (companyId && rows.some((r) => r.companyId !== null && r.companyId !== companyId))) {
    throw AppError.badRequest('One or more line items do not belong to this company', 'VALIDATION_ERROR');
  }
}

/** Database-backed line checks, on the posting's transaction. */
export async function assertApLineRefs(executor: DbOrTx, tenantId: string, companyId: string | undefined, lines: BuiltApLine[]) {
  await assertAccountsInTenant(executor, tenantId, lines.map((l) => l.accountId));
  await assertItemsInScope(executor, tenantId, companyId, lines.map((l) => l.itemId));
  await assertLineContacts(tenantId, lines, executor, companyId);
}

const LINE_DETAIL_KEYS = ['itemId', 'quantity', 'unitPrice', 'contactId', 'isBillable'] as const;

/**
 * An edit's lines sent back unchanged keep their stored item, quantity,
 * cost, customer and billable mark (review L1): a client that doesn't know
 * those fields (an older app, a script) would otherwise wipe them by
 * omission. A line counts as sent back unchanged when it omits all five
 * fields (undefined; null clears) and its position, account, amount and
 * description match the stored document line at that position. Updates
 * `built` in place; reads on the caller's transaction after the row lock.
 */
export async function keepUnchangedLineDetails(
  executor: DbOrTx,
  tenantId: string,
  existing: { id: string; txnType: string; memo: string | null },
  rawLines: readonly ApLineInput[],
  built: BuiltApLine[],
  apAccountId: string,
  memo: string | undefined,
): Promise<void> {
  const candidates = rawLines.map((l, i) => (LINE_DETAIL_KEYS.every((k) => l[k] === undefined) ? i : -1)).filter((i) => i >= 0);
  if (candidates.length === 0) return;
  let stored = await executor.select().from(journalLinesTable)
    .where(and(
      eq(journalLinesTable.tenantId, tenantId),
      eq(journalLinesTable.transactionId, existing.id),
      eq(journalLinesTable.isVoidReversal, false),
    ))
    .orderBy(journalLinesTable.lineOrder);
  // The A/P line: last on a bill (credit), first on a vendor credit (debit).
  const isBill = existing.txnType === 'bill';
  if (isBill && stored.at(-1)?.accountId === apAccountId) stored = stored.slice(0, -1);
  if (!isBill && stored[0]?.accountId === apAccountId) stored = stored.slice(1);
  for (const i of candidates) {
    const s = stored[i];
    const raw = rawLines[i]!;
    const b = built[i]!;
    if (!s || s.accountId !== b.accountId) continue;
    if (!new Decimal((isBill ? s.debit : s.credit) || '0').equals(b.amount)) continue;
    const description = s.description ?? null;
    const sameDescription = description === (raw.description || memo || null)
      || (!raw.description && description === (existing.memo ?? null));
    if (!sameDescription) continue;
    b.itemId = s.itemId ?? null;
    b.quantity = s.quantity ?? null;
    b.unitPrice = s.unitPrice ?? null;
    b.contactId = s.contactId ?? null;
    b.isBillable = isBill && s.isBillable === true;
  }
}

function lineExtras(l: BuiltApLine) {
  return {
    itemId: l.itemId ?? undefined,
    quantity: l.quantity ?? undefined,
    unitPrice: l.unitPrice ?? undefined,
    contactId: l.contactId,
    isBillable: l.isBillable,
  };
}

// ─── Helpers ────────────────────────────────────────────────────

async function getApAccountId(executor: DbOrTx, tenantId: string): Promise<string> {
  const [account] = await executor.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'accounts_payable')))
    .limit(1);
  if (!account) throw AppError.internal("System account 'accounts_payable' not found. Seed COA first.");
  return account.id;
}

async function getNextBillNumber(tenantId: string): Promise<string> {
  // Atomically pick the next bill number based on the current count of bills.
  // We don't have a dedicated counter on companies, so use a count-based
  // sequence prefixed BILL-. Concurrent inserts may briefly collide on the
  // numeric portion, but txnNumber is purely informational (not unique), so
  // this is acceptable for an MVP.
  const [row] = await db.select({ c: count() }).from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.txnType, 'bill')));
  const next = (row?.c ?? 0) + 1;
  return `BILL-${String(next).padStart(5, '0')}`;
}

async function loadVendorDefaults(executor: DbOrTx, tenantId: string, contactId: string, companyId?: string) {
  const [vendor] = await executor.select().from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)))
    .limit(1);
  if (!vendor || (companyId && vendor.companyId && vendor.companyId !== companyId)) {
    throw AppError.badRequest('Vendor not found');
  }
  return vendor;
}

/**
 * Verify that every accountId referenced by a bill's lines belongs
 * to the caller's tenant. Without this check, a crafted payload
 * could reference an account id from another tenant — the ledger
 * service would happily post a journal line against it. Rejecting
 * at the bill layer keeps the error message specific to what the
 * user actually submitted.
 */
async function assertAccountsInTenant(executor: DbOrTx, tenantId: string, accountIds: string[]): Promise<void> {
  if (accountIds.length === 0) return;
  const unique = [...new Set(accountIds)];
  const rows = await executor
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, unique)));
  if (rows.length !== unique.length) {
    throw AppError.badRequest('One or more bill line accounts do not belong to this tenant');
  }
}

/** Number of payment and credit applications on a bill (read on the caller's tx). */
async function countBillApplications(executor: DbOrTx, tenantId: string, billId: string): Promise<number> {
  const res = await executor.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM bill_payment_applications WHERE tenant_id = ${tenantId} AND bill_id = ${billId})::int
      + (SELECT COUNT(*) FROM vendor_credit_applications WHERE tenant_id = ${tenantId} AND bill_id = ${billId})::int AS n
  `);
  return (res.rows as Array<{ n: number }>)[0]?.n ?? 0;
}

// ─── Create / read / edit / void ────────────────────────────────

/**
 * Posts a bill: DR each line's account, CR Accounts Payable for the exact
 * sum. Validation, terms, the posting and the draft-attachment relink run
 * in one database transaction (`outerTx` to join the caller's).
 */
export async function createBill(tenantId: string, input: CreateBillInput, userId?: string, companyId?: string, outerTx?: Tx) {
  if (input.lines.length === 0) throw AppError.badRequest('Bill must have at least one line');
  const { lines, total } = buildApLines(input.lines, { allowBillable: true });
  // Each line is an exact 4-place amount (U-65): the A/P credit is their sum.
  if (total.lessThanOrEqualTo(0)) throw AppError.badRequest('Bill total must be positive');

  const run = async (tx: Tx) => {
    await assertApLineRefs(tx, tenantId, companyId, lines);
    const apAccountId = await getApAccountId(tx, tenantId);
    const vendor = await loadVendorDefaults(tx, tenantId, input.contactId, companyId);
    const terms = resolveBillTerms(input, vendor);

    const journalLines = [
      ...lines.map((l) => ({
        accountId: l.accountId,
        debit: l.amount.toFixed(4),
        credit: '0',
        description: l.description || input.memo,
        tagId: l.tagId,
        ...lineExtras(l),
      })),
      { accountId: apAccountId, debit: '0', credit: total.toFixed(4) },
    ];

    const txnNumber = await getNextBillNumber(tenantId);

    const bill = await ledger.postTransaction(tenantId, {
      txnType: 'bill',
      txnNumber,
      txnDate: input.txnDate,
      dueDate: terms.dueDate ?? undefined,
      contactId: input.contactId,
      memo: input.memo,
      internalNotes: input.internalNotes,
      paymentTerms: terms.paymentTerms ?? undefined,
      termsDays: terms.termsDays ?? undefined,
      discountPercent: terms.discountPercent,
      discountDays: terms.discountDays,
      discountDate: terms.discountDate,
      dueDateOverridden: terms.dueDateOverridden,
      discountDateOverridden: terms.discountDateOverridden,
      billReceived: input.billReceived ?? true,
      vendorInvoiceNumber: input.vendorInvoiceNumber,
      total: total.toFixed(4),
      balanceDue: total.toFixed(4),
      amountPaid: '0',
      creditsApplied: '0',
      billStatus: 'unpaid',
      lines: journalLines,
    }, userId, companyId, tx);

    if (input.draftAttachmentId) {
      await relinkDraftAttachments(tx, tenantId, input.draftAttachmentId, 'bill', bill.id, userId, companyId);
    }
    return bill;
  };
  return outerTx ? run(outerTx) : db.transaction(run);
}

/** companyId (U-117 security note): a bill of another company is 404 (rows without a company pass). */
export async function getBill(tenantId: string, billId: string, companyId?: string) {
  const bill = await ledger.getTransaction(tenantId, billId, companyId);
  if (companyId && bill.companyId && bill.companyId !== companyId) throw AppError.notFound('Transaction not found');
  if (bill.txnType !== 'bill') throw AppError.badRequest('Not a bill');
  return bill;
}

/**
 * Edits a bill in one database transaction (review B1, B3): the row is
 * locked FOR UPDATE, `expectedUpdatedAt` checked (409 STALE), and "locked"
 * decided from the application rows under that lock. The ledger edit, the
 * bill's own columns and the payment status are written in the same
 * transaction; the reply is the bill as committed.
 */
export async function updateBill(tenantId: string, billId: string, input: CreateBillInput, userId?: string, companyId?: string) {
  if (input.lines.length === 0) throw AppError.badRequest('Bill must have at least one line');
  const { lines, total } = buildApLines(input.lines, { allowBillable: true });
  if (total.lessThanOrEqualTo(0)) throw AppError.badRequest('Bill total must be positive');

  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, billId)))
      .for('update')
      .limit(1);
    if (!existing || existing.status === 'deleted'
      || (companyId && existing.companyId && existing.companyId !== companyId)) {
      throw AppError.notFound('Transaction not found');
    }
    if (existing.txnType !== 'bill') throw AppError.badRequest('Not a bill');
    if (existing.status === 'void') throw AppError.badRequest('Cannot edit a void bill');
    ledger.assertNotStale(existing, input.expectedUpdatedAt, 'This bill');

    // Free-text terms from before the PAYMENT_TERMS table are accepted only
    // sent back unchanged (review L1); any other unknown code is 400.
    const legacyTerms = !!input.paymentTerms && !findPaymentTerm(input.paymentTerms);
    if (legacyTerms && input.paymentTerms !== existing.paymentTerms) {
      throw AppError.badRequest('paymentTerms must be one of the codes from GET /payment-terms', 'VALIDATION_ERROR');
    }

    const apAccountId = await getApAccountId(tx, tenantId);
    await keepUnchangedLineDetails(tx, tenantId, existing, input.lines, lines, apAccountId, input.memo);
    await assertApLineRefs(tx, tenantId, companyId, lines);

    // A bill is "locked" for total/vendor/date edits as soon as any payment
    // or vendor credit is applied to it — read from the application rows
    // under the row lock (not bill_status, which a racing payment may not
    // have written yet). The lines can still be reallocated, but the TOTAL,
    // the VENDOR and the BILL DATE stay, so the applications stay right.
    const isLocked = (await countBillApplications(tx, tenantId, billId)) > 0;

    let resolvedContactId: string;
    if (isLocked) {
      if (!existing.contactId) throw AppError.internal('Paid bill missing contactId');
      if (input.contactId && input.contactId !== existing.contactId) {
        throw AppError.badRequest(
          'Cannot change the vendor on a bill that has payments or credits applied. ' +
          'Void the payments first, or create a new bill with the correct vendor.',
        );
      }
      resolvedContactId = existing.contactId;
    } else {
      resolvedContactId = input.contactId;
    }
    const vendor = await loadVendorDefaults(tx, tenantId, resolvedContactId, companyId);

    if (isLocked && input.txnDate && input.txnDate !== existing.txnDate) {
      throw AppError.badRequest('Cannot change the bill date on a bill that has payments or credits applied.');
    }
    const resolvedTxnDate = isLocked ? existing.txnDate : input.txnDate;

    // Received flag (U-87): omitted keeps it; it can't go back to "not
    // received" once something is applied to the bill (review S4).
    const billReceived = input.billReceived ?? existing.billReceived;
    if (isLocked && billReceived === false && existing.billReceived !== false) {
      throw AppError.conflict(
        'This bill has payments or credits applied, so it can’t be marked not received.',
        'BILL_HAS_PAYMENTS',
      );
    }

    // Terms: a locked bill keeps its terms and dates; otherwise they are
    // resolved as on create (an omitted dueDate is recomputed).
    const terms: Omit<ResolvedBillTerms, 'source'> = isLocked
      ? {
        paymentTerms: existing.paymentTerms,
        termsDays: existing.termsDays,
        discountPercent: existing.discountPercent,
        discountDays: existing.discountDays,
        dueDate: existing.dueDate,
        discountDate: existing.discountDate,
        dueDateOverridden: existing.dueDateOverridden,
        discountDateOverridden: existing.discountDateOverridden,
      }
      : legacyTerms && !input.dueDate
        // Legacy terms compute no date: the stored due date stays.
        ? {
          ...resolveBillTerms({ ...input, txnDate: resolvedTxnDate }, vendor),
          dueDate: existing.dueDate,
          dueDateOverridden: existing.dueDateOverridden,
        }
        : resolveBillTerms({ ...input, txnDate: resolvedTxnDate }, vendor);

    // Total lock, exact (review S1; was a 0.01 tolerance).
    const existingTotal = new Decimal(existing.total || '0');
    if (isLocked && !total.equals(existingTotal)) {
      throw AppError.badRequest(
        `Cannot change the total on a paid bill. Expected $${existingTotal.toFixed(2)}, ` +
        `got $${total.toFixed(2)}. Reallocate between expense accounts instead — ` +
        `the sum of all lines must equal the original total.`,
      );
    }

    const journalLines = [
      ...lines.map((l) => ({
        accountId: l.accountId,
        debit: l.amount.toFixed(4),
        credit: '0',
        description: l.description || input.memo,
        tagId: l.tagId,
        ...lineExtras(l),
      })),
      { accountId: apAccountId, debit: '0', credit: total.toFixed(4) },
    ];

    // The expense/AP journal change, on this transaction. For a locked bill
    // the total is unchanged, so A/P doesn't move; only the expense-account
    // allocation shifts. For an unlocked bill A/P moves with the new total.
    await ledger.updateTransaction(tenantId, billId, {
      txnType: 'bill',
      txnDate: resolvedTxnDate,
      dueDate: terms.dueDate ?? undefined,
      contactId: resolvedContactId,
      memo: input.memo,
      internalNotes: input.internalNotes,
      paymentTerms: terms.paymentTerms ?? undefined,
      termsDays: terms.termsDays ?? undefined,
      vendorInvoiceNumber: input.vendorInvoiceNumber,
      total: total.toFixed(4),
      balanceDue: isLocked ? (existing.balanceDue || '0') : total.toFixed(4),
      lines: journalLines,
    }, userId, companyId, tx, { apDocumentEdit: true });

    // The bill's own columns (the ledger edit doesn't write them), then the
    // payment status recomputed from the application rows — same
    // transaction, so the reply's updatedAt is the final one (review B3).
    await tx.update(transactions).set({
      paymentTerms: terms.paymentTerms || null,
      termsDays: terms.termsDays ?? null,
      discountPercent: terms.discountPercent,
      discountDays: terms.discountDays,
      discountDate: terms.discountDate,
      dueDateOverridden: terms.dueDateOverridden,
      discountDateOverridden: terms.discountDateOverridden,
      billReceived,
      vendorInvoiceNumber: input.vendorInvoiceNumber || null,
      ...(input.internalNotes !== undefined ? { internalNotes: input.internalNotes || null } : {}),
      updatedAt: new Date(),
    }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, billId)));

    await recomputeBillStatus(tx, tenantId, billId);
  });

  return getBill(tenantId, billId);
}

/**
 * Voids a bill. Refused while anything is applied to it (409
 * BILL_HAS_PAYMENTS, read under the row lock) or on an expectedUpdatedAt
 * mismatch (409 STALE).
 */
export async function voidBill(
  tenantId: string, billId: string, reason: string, userId?: string,
  opts: { expectedUpdatedAt?: string; companyId?: string } = {},
) {
  return ledger.voidTransaction(tenantId, billId, reason, userId, { ...opts, expectType: 'bill' });
}

export async function listBills(tenantId: string, filters: BillFilters, companyId?: string) {
  const conditions = [
    eq(transactions.tenantId, tenantId),
    eq(transactions.txnType, 'bill'),
  ];
  if (companyId) conditions.push(eq(transactions.companyId, companyId));

  if (filters.contactId) conditions.push(eq(transactions.contactId, filters.contactId));
  if (Array.isArray(filters.billStatus)) {
    if (filters.billStatus.length > 0) {
      // The table derives "overdue" from the due date (the column keeps the
      // literal until a sweep updates it), so a set that includes 'overdue'
      // must match what the column shows: stored overdue OR past-due
      // unpaid/partial.
      const set = filters.billStatus;
      const stored = sql`${transactions.billStatus} IN (${sql.join(set.map((v) => sql`${v}`), sql`, `)})`;
      conditions.push(set.includes('overdue')
        ? sql`(${stored} OR (${transactions.billStatus} IN ('unpaid', 'partial') AND ${transactions.dueDate} < CURRENT_DATE))`
        : stored);
    }
  } else if (filters.billStatus) {
    conditions.push(eq(transactions.billStatus, filters.billStatus));
  }
  if (filters.startDate) conditions.push(sql`${transactions.txnDate} >= ${filters.startDate}`);
  if (filters.endDate) conditions.push(sql`${transactions.txnDate} <= ${filters.endDate}`);
  // ADR 0XX §5.2 — header-level tag filter via EXISTS on the line set.
  if ((filters as BillFilters & { tagId?: string }).tagId) {
    const tagId = (filters as BillFilters & { tagId?: string }).tagId!;
    conditions.push(sql`EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.transaction_id = ${transactions.id} AND jl.tenant_id = ${tenantId} AND jl.tag_id = ${tagId})`);
  }
  if (filters.dueOnOrBefore) conditions.push(sql`${transactions.dueDate} <= ${filters.dueOnOrBefore}`);
  if (filters.overdueOnly) {
    conditions.push(sql`${transactions.dueDate} < CURRENT_DATE`);
    conditions.push(sql`${transactions.billStatus} IN ('unpaid', 'partial', 'overdue')`);
  }
  if (filters.search) {
    const term = `%${escapeLike(filters.search)}%`;
    conditions.push(sql`(${transactions.memo} ILIKE ${term} OR ${transactions.txnNumber} ILIKE ${term} OR ${transactions.vendorInvoiceNumber} ILIKE ${term} OR ${contacts.displayName} ILIKE ${term})`);
  }

  const where = and(...conditions);

  // Whitelisted column sort; without one the list keeps its "due soonest
  // first" order. Stable createdAt/id tiebreak either way.
  const dirSql = filters.sortDir === 'asc' ? sql`ASC` : sql`DESC`;
  const sortExpr = (() => {
    switch (filters.sortBy) {
      case 'number': return sql`${transactions.txnNumber}`;
      case 'vendor': return sql`${contacts.displayName}`;
      case 'vendorInvoiceNumber': return sql`${transactions.vendorInvoiceNumber}`;
      case 'date': return sql`${transactions.txnDate}`;
      case 'dueDate': return sql`${transactions.dueDate}`;
      case 'status': return sql`${transactions.billStatus}`;
      case 'total': return sql`CAST(${transactions.total} AS DECIMAL)`;
      case 'balance': return sql`CAST(${transactions.balanceDue} AS DECIMAL)`;
      default: return null;
    }
  })();
  const orderBy = sortExpr
    ? [sql`${sortExpr} ${dirSql} NULLS LAST`, sql`${transactions.createdAt} DESC`, sql`${transactions.id}`]
    : [sql`${transactions.dueDate} ASC NULLS LAST`, sql`${transactions.txnDate} DESC`, sql`${transactions.createdAt} DESC`, sql`${transactions.id}`];

  const [data, totalRow] = await Promise.all([
    db.select({
      id: transactions.id,
      txnNumber: transactions.txnNumber,
      txnDate: transactions.txnDate,
      dueDate: transactions.dueDate,
      contactId: transactions.contactId,
      contactName: contacts.displayName,
      vendorInvoiceNumber: transactions.vendorInvoiceNumber,
      paymentTerms: transactions.paymentTerms,
      discountDate: transactions.discountDate,
      billReceived: transactions.billReceived,
      total: transactions.total,
      amountPaid: transactions.amountPaid,
      creditsApplied: transactions.creditsApplied,
      balanceDue: transactions.balanceDue,
      billStatus: transactions.billStatus,
      memo: transactions.memo,
      status: transactions.status,
      createdAt: transactions.createdAt,
      updatedAt: transactions.updatedAt,
      // Derived, from the database's own date (one "today" with the
      // CURRENT_DATE filters above; review S3).
      daysOverdue: sql<number>`CASE WHEN ${transactions.dueDate} < CURRENT_DATE AND ${transactions.billStatus} IS DISTINCT FROM 'paid'
        THEN (CURRENT_DATE - ${transactions.dueDate}) ELSE 0 END::int`,
    }).from(transactions)
      .leftJoin(contacts, eq(transactions.contactId, contacts.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(filters.limit ?? 50)
      .offset(filters.offset ?? 0),
    db.select({ c: count() }).from(transactions)
      .leftJoin(contacts, eq(transactions.contactId, contacts.id))
      .where(where),
  ]);

  return { data, total: totalRow[0]?.c ?? 0 };
}

/**
 * SQL-aggregated AP roll-up for one vendor. The contact detail page used to
 * derive these numbers from its (paginated) bill list, which understated the
 * balance for vendors with more bills than one page. Posted documents only
 * (U-84d): a void or deleted bill or credit keeps its old balance_due and
 * used to be counted.
 */
export async function getVendorApSummary(tenantId: string, contactId: string, companyId?: string) {
  const conditions = [
    eq(transactions.tenantId, tenantId),
    eq(transactions.contactId, contactId),
    inArray(transactions.txnType, ['bill', 'vendor_credit']),
    eq(transactions.status, 'posted'),
  ];
  if (companyId) conditions.push(eq(transactions.companyId, companyId));

  const [row] = await db.select({
    unpaidCount: sql<number>`COUNT(*) FILTER (WHERE ${transactions.txnType} = 'bill' AND ${transactions.billStatus} <> 'paid' AND COALESCE(${transactions.balanceDue}, 0) > 0)::int`,
    totalOwed: sql<string>`COALESCE(SUM(${transactions.balanceDue}) FILTER (WHERE ${transactions.txnType} = 'bill' AND ${transactions.billStatus} <> 'paid' AND COALESCE(${transactions.balanceDue}, 0) > 0), 0)`,
    overdueCount: sql<number>`COUNT(*) FILTER (WHERE ${transactions.txnType} = 'bill' AND ${transactions.billStatus} <> 'paid' AND COALESCE(${transactions.balanceDue}, 0) > 0 AND ${transactions.dueDate} < CURRENT_DATE)::int`,
    totalOverdue: sql<string>`COALESCE(SUM(${transactions.balanceDue}) FILTER (WHERE ${transactions.txnType} = 'bill' AND ${transactions.billStatus} <> 'paid' AND COALESCE(${transactions.balanceDue}, 0) > 0 AND ${transactions.dueDate} < CURRENT_DATE), 0)`,
    availableCreditsCount: sql<number>`COUNT(*) FILTER (WHERE ${transactions.txnType} = 'vendor_credit' AND COALESCE(${transactions.balanceDue}, 0) > 0)::int`,
    totalAvailableCredits: sql<string>`COALESCE(SUM(${transactions.balanceDue}) FILTER (WHERE ${transactions.txnType} = 'vendor_credit' AND COALESCE(${transactions.balanceDue}, 0) > 0), 0)`,
  }).from(transactions).where(and(...conditions));

  return row!;
}

/**
 * Returns all unpaid/partial bills for the tenant (optionally filtered to one
 * vendor), plus the available vendor credits whose vendors appear in the
 * payable bill list. Used by the Pay Bills page. A bill not marked received
 * (U-87) is left out: it is in A/P but not payable yet.
 */
export async function getPayableBills(
  tenantId: string,
  opts: { contactId?: string; dueOnOrBefore?: string; paymentDate?: string; companyId?: string; companyIncludesNull?: boolean },
) {
  const billConds = [
    eq(transactions.tenantId, tenantId),
    eq(transactions.txnType, 'bill'),
    eq(transactions.status, 'posted'),
    eq(transactions.billReceived, true),
    sql`${transactions.billStatus} IN ('unpaid', 'partial', 'overdue')`,
    sql`COALESCE(${transactions.balanceDue}, 0) > 0`,
  ];
  if (opts.contactId) billConds.push(eq(transactions.contactId, opts.contactId));
  if (opts.dueOnOrBefore) billConds.push(sql`${transactions.dueDate} <= ${opts.dueOnOrBefore}`);
  // Company scope (portal callers). companyIncludesNull admits legacy
  // NULL-company bills — pass it only for single-company tenants, where
  // a NULL company is unambiguous.
  // The staff routes (U-104) pass the request's company with
  // companyIncludesNull, the rows payBills accepts (inOtherCompany).
  // The same scope applies to the vendor credits below.
  const companyCond = opts.companyId
    ? (opts.companyIncludesNull
        ? sql`(${transactions.companyId} = ${opts.companyId} OR ${transactions.companyId} IS NULL)`
        : eq(transactions.companyId, opts.companyId))
    : null;
  if (companyCond) billConds.push(companyCond);
  // Early-payment discount available on the payment date (U-101,
  // bill-discounts-v1): the bill's discount percent of its balance due,
  // rounded to cents half away from zero, when the payment date is on or
  // before the discount date; else 0.00. Without paymentDate the database's
  // current date is used (as daysOverdue does).
  const payDate = opts.paymentDate ? sql`${opts.paymentDate}::date` : sql`CURRENT_DATE`;

  const billRows = await db.select({
    id: transactions.id,
    txnNumber: transactions.txnNumber,
    contactId: transactions.contactId,
    contactName: contacts.displayName,
    txnDate: transactions.txnDate,
    dueDate: transactions.dueDate,
    discountDate: transactions.discountDate,
    discountPercent: transactions.discountPercent,
    vendorInvoiceNumber: transactions.vendorInvoiceNumber,
    total: transactions.total,
    amountPaid: transactions.amountPaid,
    creditsApplied: transactions.creditsApplied,
    balanceDue: transactions.balanceDue,
    billStatus: transactions.billStatus,
    paymentTerms: transactions.paymentTerms,
    memo: transactions.memo,
    updatedAt: transactions.updatedAt,
    daysOverdue: sql<number>`CASE WHEN ${transactions.dueDate} < CURRENT_DATE THEN (CURRENT_DATE - ${transactions.dueDate}) ELSE 0 END::int`,
    discountEligible: sql<boolean>`(${transactions.discountPercent} IS NOT NULL AND ${transactions.discountDate} IS NOT NULL AND ${payDate} <= ${transactions.discountDate})`,
  }).from(transactions)
    .leftJoin(contacts, eq(transactions.contactId, contacts.id))
    .where(and(...billConds))
    .orderBy(sql`${transactions.dueDate} ASC NULLS LAST`);

  const bills = billRows.map(({ discountEligible, ...b }) => ({
    ...b,
    discountAvailable: discountEligible ? termsDiscountAmount(b.balanceDue || '0', b.discountPercent || '0') : '0.00',
  }));

  // Pull vendor credits with available balance for the same vendors
  const vendorIds = [...new Set(bills.map((b) => b.contactId).filter((v): v is string => !!v))];
  let credits: Array<{
    id: string;
    txnNumber: string | null;
    contactId: string | null;
    contactName: string | null;
    txnDate: string;
    total: string | null;
    balanceDue: string | null;
    memo: string | null;
  }> = [];
  if (vendorIds.length > 0) {
    credits = await db.select({
      id: transactions.id,
      txnNumber: transactions.txnNumber,
      contactId: transactions.contactId,
      contactName: contacts.displayName,
      txnDate: transactions.txnDate,
      total: transactions.total,
      balanceDue: transactions.balanceDue,
      memo: transactions.memo,
    }).from(transactions)
      .leftJoin(contacts, eq(transactions.contactId, contacts.id))
      .where(and(
        eq(transactions.tenantId, tenantId),
        eq(transactions.txnType, 'vendor_credit'),
        eq(transactions.status, 'posted'),
        sql`COALESCE(${transactions.balanceDue}, 0) > 0`,
        inArray(transactions.contactId, vendorIds),
        ...(companyCond ? [companyCond] : []),
      ))
      .orderBy(sql`${transactions.txnDate} ASC`);
  }

  return { bills, credits };
}

/**
 * Recalculate amount_paid, credits_applied, balance_due, and bill_status from
 * the underlying application tables. Called by the bill payment service when
 * payments or voids change a bill's state, and by a bill edit. A payment's
 * early-payment discount (bill_payment_applications.discount_amount, P18)
 * counts toward the bill with its cash. Exact (review S1): "paid" only when
 * nothing at all is left (was a 0.01 tolerance that dropped the cent from
 * aging and Pay Bills while A/P kept it).
 */
export async function recomputeBillStatus(executor: DbOrTx, tenantId: string, billId: string) {
  const result = await executor.execute(sql`
    SELECT
      t.total,
      COALESCE((SELECT SUM(amount) FROM bill_payment_applications WHERE bill_id = ${billId} AND tenant_id = ${tenantId}), 0) AS paid,
      COALESCE((SELECT SUM(discount_amount) FROM bill_payment_applications WHERE bill_id = ${billId} AND tenant_id = ${tenantId}), 0) AS discounts,
      COALESCE((SELECT SUM(amount) FROM vendor_credit_applications WHERE bill_id = ${billId} AND tenant_id = ${tenantId}), 0) AS credits
    FROM transactions t
    WHERE t.id = ${billId} AND t.tenant_id = ${tenantId}
  `);
  const row = (result.rows as Array<{ total: string | null; paid: string | number; discounts: string | number; credits: string | number }>)[0];
  if (!row) return;

  const total = new Decimal(row.total || '0');
  const paid = new Decimal(String(row.paid));
  const discounts = new Decimal(String(row.discounts));
  const credits = new Decimal(String(row.credits));
  let balanceDue = total.minus(paid).minus(discounts).minus(credits);
  if (balanceDue.isNegative()) balanceDue = new Decimal('0');

  let status: 'unpaid' | 'partial' | 'paid' = 'unpaid';
  if (balanceDue.isZero()) status = 'paid';
  else if (paid.greaterThan(0) || discounts.greaterThan(0) || credits.greaterThan(0)) status = 'partial';

  await executor.update(transactions).set({
    amountPaid: paid.toFixed(4),
    creditsApplied: credits.toFixed(4),
    balanceDue: balanceDue.toFixed(4),
    billStatus: status,
    paidAt: status === 'paid' ? new Date() : null,
    updatedAt: new Date(),
  }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, billId)));
}

/**
 * Recalculate a vendor credit's remaining balance from the application table.
 */
export async function recomputeVendorCreditBalance(executor: DbOrTx, tenantId: string, creditId: string) {
  // Open balance = total − bill-payment applications − posted deposit
  // refunds (U-54). One implementation, shared with the deposit path.
  await recomputeVendorCreditWithRefunds(executor, tenantId, creditId);
}
