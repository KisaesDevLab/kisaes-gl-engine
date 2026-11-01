// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import {
  receivePaymentSchema, previewPaymentSchema, updateCustomerPaymentSchema, unapplyPaymentSchema,
  voidPaymentSchema, bouncePaymentSchema, listPaymentsQuerySchema, applyPaymentCreditSchema,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { closingPasswordLimiter } from '../middleware/closing-password-limiter.js';
import { lockContextMiddleware } from '../services/lock-context.js';
import { idempotent } from '../middleware/idempotent.js';
import { db } from '../db/index.js';
import * as paymentService from '../services/payment.service.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const paymentsRouter = Router();
paymentsRouter.use(authenticate);
paymentsRouter.use(companyContext);
paymentsRouter.use(requireResource('receive_payment'));

// Closed periods (closing-password-v1): a write dated on or before the
// closing date takes closingPassword (or a staff overrideConfirmed).
const closingPasswordDoc = z.string().optional().describe('closing-date password (closing-password-v1); never stored or echoed');
const closedPeriodNote = 'A change dated on or before the closing date needs closingPassword (or a staff overrideConfirmed): ' +
  '423 TB_PERIOD_LOCKED, 403 CLOSING_PASSWORD_INVALID, 429 CLOSING_PASSWORD_RATE_LIMIT.';
const closing = { closingPassword: closingPasswordDoc, overrideConfirmed: z.boolean().optional() };

const exactRules = 'Amounts are decimal strings in whole cents (at most 2 places; trailing zeros to 4 places accepted), compared exactly ' +
  'with no tolerance (Q-P21g): more places is 400 VALIDATION_ERROR. An invoice takes at most its cent balance, round2(balance_due) half ' +
  'away from zero; a legacy sub-cent residue is never posted (Q-P21t). applications[].expectedBalanceDue (optional) is the invoice\'s ' +
  'balanceDueExact as read, echoed unchanged: a different stored balance is 409 INVOICE_BALANCE_CHANGED {invoiceId, balanceDue, ' +
  'balanceDueExact} and nothing posts.';
const receiveErrors = '400 AMOUNT_REQUIRED (amount 0); 400 APPLICATIONS_EXCEED_AMOUNT (the applications add up to more than the amount; ' +
  'less is fine, the rest stays an A/R credit); 400 OVERAPPLIED {invoiceId, balanceDue} (more than the cent balance; a paid or void ' +
  'invoice takes 0.00); 400 INVOICE_NOT_FOR_CUSTOMER {invoiceId}; 400 DEPOSIT_ACCOUNT_INVALID (not an asset of this company, or A/R or ' +
  'Customer Deposits); 400 TOO_MANY_APPLICATIONS (more than 1,000); 404 for a customer or invoice of another company. ' +
  'payment-settle-v1 / payment-discounts-v1: applications may be empty (the whole amount stays a credit); applications[].writeOffAmount and ' +
  '.discountAmount settle more of the invoice (cash + discount + write-off + credits <= the cent balance, else OVERAPPLIED); amount may be ' +
  '0.00 only with a write-off or discount (then no deposit line). Posting: Dr depositTo amount, Dr writeOffAccountId (default the company ' +
  'setting writeOffAccountId) the write-offs, Dr discountAccountId (default salesDiscountAccountId) the discounts, Cr A/R the sum. ' +
  '400 WRITE_OFF_ACCOUNT_REQUIRED / WRITE_OFF_ACCOUNT_INVALID, DISCOUNT_ACCOUNT_REQUIRED / DISCOUNT_ACCOUNT_INVALID (A/R, A/P, Payments ' +
  'Clearing, Customer Deposits, depositTo, inactive, another company). creditApplications [{sourcePaymentId, invoiceId, amount, ' +
  'expectedBalanceDue?}] apply existing credits of the same client in the same transaction (no GL effect; the source is locked): over its ' +
  'remaining 409 CREDIT_NOT_AVAILABLE {sourcePaymentId, remaining}; a bounced source 409 PAYMENT_BOUNCED; another client 400 ' +
  'CREDIT_NOT_FOR_CUSTOMER.';

const paymentRecordNote = 'PaymentRecord: {id, txnType, txnNumber, customerId, date, amount, depositTo, paymentMethod, refNo, memo, updatedAt, ' +
  'status (posted | void), depositedIn? {depositId, date}, bounce? {returnId, date}, applications: [{invoiceId, invoiceNumber, amount, ' +
  'discount, writeOff, appliedDate, voided, reversed}] (every row, live and set aside; its credit applied later carries that date), ' +
  'unappliedRemaining (amount - live applications - live refunds; 0.00 when void or bounced), ' +
  'holdsDeposit, depositRemaining}; money as 2-place strings.';

// ─── Literal routes first: GET /:id is registered last so it can't shadow them.

paymentsRouter.get('/', describe({
  summary: 'List customer payments (receive-payment-v1)',
  description: 'Response {data: PaymentSummary[], total}: {id, customerId, customerName, date, amount, paymentMethod, refNo, memo, ' +
    'status, bounced, deposited, unappliedRemaining, updatedAt}, newest first, this company only.',
  query: listPaymentsQuerySchema,
}), async (req, res) => {
  const result = await paymentService.listPayments(req.tenantId, listPaymentsQuerySchema.parse(req.query), req.companyId);
  res.json(result);
});

// Idempotency-Key (idempotency-receive-payment-v1): after the closed-period
// middleware, before validation (bill-payments.routes.ts order). Replayed
// from the stored response; the reader rebuilds it from the posted payment.
paymentsRouter.post('/receive', closingPasswordLimiter, lockContextMiddleware, idempotent({
  successStatus: 201,
  replay: async (req, entity) => ({ payment: await paymentService.getPayment(req.tenantId, entity!.id, req.companyId) }),
}), validate(receivePaymentSchema), describe({
  summary: 'Receive a customer payment (receive-payment-v1)',
  description: `Response 201 {payment: PaymentRecord}. Posts Dr depositTo / Cr A/R for the amount and writes the applications in one ` +
    `database transaction. ${exactRules} ${receiveErrors} ${closedPeriodNote} ${paymentRecordNote}`,
  body: receivePaymentSchema.extend(closing),
}), async (req, res) => {
  const posted = await paymentService.receivePayment(req.tenantId, req.body, req.userId, req.companyId);
  const payment = await paymentService.getPayment(req.tenantId, posted.id, req.companyId);
  res.status(201).json({ payment });
});

paymentsRouter.post('/preview', validate(previewPaymentSchema), describe({
  summary: 'Preview a customer payment; posts nothing (receive-payment-v1)',
  description: 'Every figure of the Receive Payment form, from the engine (the same compute the posting routes use). Auto: no ' +
    'applications, the amount fills open invoices oldest first (txnDate, number, id). Explicit: the rows sent; amount null fills what ' +
    'is left of the payment in date order; rows not sent get 0.00; with no amount, fill rows take their cent balance and amount is ' +
    'their sum (amountSource from_applications). Response PaymentPreview: {contactBalanceBefore, contactBalanceAfter, amount, ' +
    'amountSource: typed | from_applications, invoices: [{invoiceId, invoiceNumber, txnDate, dueDate, total, balanceDue (cent balance), ' +
    'balanceDueExact (stored, 4 places: send it back as expectedBalanceDue), payment, remaining}] (all open invoices, oldest first), ' +
    'totals {amountDue, applied, discountsAndCredits, unapplied}, shortfalls [{invoiceId, amount}], pendingDeposits {count, total} ' +
    '(after saving: this payment counts when depositTo is Payments Clearing), averageDaysToPay (integer days from invoice date to the ' +
    'payment that cleared it, over invoices paid in the 12 months to date; null below 3), problems [{code, invoiceId?}]}. Problem ' +
    'codes: AMOUNT_REQUIRED, APPLICATIONS_EXCEED_AMOUNT, OVERAPPLIED, INVOICE_NOT_OPEN, DUPLICATE_INVOICE, DEPOSIT_ACCOUNT_INVALID, ' +
    'TOO_MANY_APPLICATIONS, PAYMENT_BOUNCED (editing a bounced payment), CREDIT_NOT_AVAILABLE. payment-settle-v1 / payment-discounts-v1: ' +
    'applications[].writeOffAmount / discountAmount and creditApplications [{sourcePaymentId, invoiceId, amount | null (fill)}] as on ' +
    'receive; invoices[] add discount, writeOff, credit, discountPercent, discountDate, discountAvailable (round2(total x percent / 100) ' +
    'half away from zero, capped at the cent balance, on or before the discount date, once per invoice) and suggestDiscount (none typed and ' +
    'payment = cent balance - discountAvailable exactly); totals.writeOffs; overpayment (= unapplied); shortfalls[].withinWriteOffLimit ' +
    '(shortfall <= the company writeOffThreshold; false without one); creditApplications [{sourcePaymentId, invoiceId, amount, ' +
    'balanceDueExact}] (the credits applied, fill rows filled); credits [{sourcePaymentId, date, refNo, remaining}] (the open ' +
    'credits of the client, bounced payments left out); contactBalanceAfter = before - amount - discounts - write-offs (credits are in A/R ' +
    'already). Order per invoice: typed cash, discount and write-off, then credits, then cash fill / auto. editingPaymentId: that payment\'s own live share is added ' +
    'back to its invoices (balanceDueExact = what PUT expects) and invoices it paid in full are listed; contactBalanceBefore leaves it ' +
    'out. Only 400 VALIDATION_ERROR for a malformed body, and 404 for a customer of another company; business problems are in ' +
    'problems[], never 4xx. Money as 2-place strings.',
  body: previewPaymentSchema,
}), async (req, res) => {
  const preview = await paymentService.previewPayment(req.tenantId, req.body, req.companyId);
  res.json(preview);
});

paymentsRouter.post('/:id/apply', closingPasswordLimiter, lockContextMiddleware, idempotent({
  successStatus: 200,
  replay: async (req) => {
    const p = await paymentService.getPayment(req.tenantId, req.params['id']!, req.companyId);
    return { applied: [], remaining: p.unappliedRemaining };
  },
}), validate(applyPaymentCreditSchema), describe({
  summary: 'Apply the credit of a payment to invoices (payment-settle-v1)',
  description: 'Response {applied: [{invoiceId, amount}], remaining}. Applies the unapplied credit of the payment to invoices of the same ' +
    'client on `date`; no GL effect (rows dated appliedDate). A row without amount fills min(credit left, cent balance). The payment is ' +
    'locked, then the invoices. 409 CREDIT_NOT_AVAILABLE {sourcePaymentId, remaining}; 400 OVERAPPLIED; 409 INVOICE_BALANCE_CHANGED ' +
    '(expectedBalanceDue); 409 PAYMENT_BOUNCED; 409 STALE (expectedUpdatedAt); closing date on `date`. Audited. ' + closedPeriodNote,
  body: applyPaymentCreditSchema.extend(closing),
  params: z.object({ id: z.string().uuid() }),
}), async (req, res) => {
  const result = await paymentService.applyCredit(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId);
  res.json(result);
});

paymentsRouter.get('/open-invoices/:customerId', describe({
  summary: 'Open invoices of a customer',
  description: 'Response {invoices: [{id, invoiceNumber, txnDate, dueDate, total, amountPaid, balanceDue (cent balance, 2 places), ' +
    'balanceDueExact (stored, 4 places), invoiceStatus, discountPercent, discountDate, discountAvailable (on ?date=, default today; ' +
    'payment-discounts-v1)}]}: posted, not paid or void, cent balance above 0.00, oldest first. A customer of another company is 404.',
  params: z.object({ customerId: z.string().uuid() }),
  query: z.object({ date: z.string().regex(ISO_DATE).optional() }),
}), async (req, res) => {
  const q = req.query['date'];
  const date = typeof q === 'string' && ISO_DATE.test(q) ? q : undefined;
  const invoices = await paymentService.getOpenInvoicesForCustomer(req.tenantId, req.params['customerId']!, req.companyId, date);
  res.json({ invoices });
});

paymentsRouter.get('/for-invoice/:invoiceId', describe({
  summary: 'Live payments applied to an invoice',
  description: 'Response {payments}: live applications of posted payments. An invoice of another company is 404.',
  params: z.object({ invoiceId: z.string().uuid() }),
}), async (req, res) => {
  const payments = await paymentService.getPaymentsForInvoice(req.tenantId, req.params['invoiceId']!, req.companyId);
  res.json({ payments });
});

// Items waiting in Payments Clearing (U-52), this company only. `?exact=1`
// returns amounts as decimal strings (deposit-grouping-v1). A bounced
// payment is not waiting (U-132).
paymentsRouter.get('/pending-deposits', describe({
  summary: 'Items waiting in Payments Clearing (deposit-grouping-v1 with exact=1)',
  query: z.object({ exact: z.enum(['1', 'true']).optional().describe('amounts as 4-place decimal strings') }),
}), async (req, res) => {
  const exact = req.query['exact'] === '1' || req.query['exact'] === 'true';
  const result = await paymentService.getPendingDeposits(req.tenantId, { companyId: req.companyId, exact });
  res.json(result);
});

paymentsRouter.post('/unapply', closingPasswordLimiter, lockContextMiddleware, idempotent({
  successStatus: 200,
  replay: async () => ({ message: 'Payment unapplied' }),
}), validate(unapplyPaymentSchema), describe({
  summary: 'Take one invoice off a payment',
  description: 'Response {message}. The invoice reopens (status from its cent balance: partial while anything is applied, else ' +
    'viewed / sent / draft); the money stays an A/R credit on the client. The application row is kept, marked set aside, and the ' +
    `change is audited. expectedUpdatedAt (the payment's): mismatch 409 STALE. 409 PAYMENT_BOUNCED for a bounced payment; 404 when ` +
    `the payment has no live application to the invoice. Closed period on the payment's date. ${closedPeriodNote}`,
  body: unapplyPaymentSchema.extend(closing),
}), async (req, res) => {
  await paymentService.unapplyPayment(req.tenantId, req.body.paymentId, req.body.invoiceId, {
    expectedUpdatedAt: req.body.expectedUpdatedAt, companyId: req.companyId, userId: req.userId,
  });
  res.json({ message: 'Payment unapplied' });
});

paymentsRouter.put('/:id', closingPasswordLimiter, lockContextMiddleware, idempotent({
  successStatus: 200,
  replay: async (req) => ({ payment: await paymentService.getPayment(req.tenantId, req.params['id']!, req.companyId) }),
}), validate(updateCustomerPaymentSchema), describe({
  summary: 'Edit a customer payment (receive-payment-v1)',
  description: 'Response {payment: PaymentRecord}. One database transaction: the closing date is checked for the old and the new ' +
    'date, the old applications are set aside and their invoices restored, the header and lines rewritten, the new applications ' +
    'validated and written. expectedBalanceDue is the invoice\'s balance with this payment\'s own share added back (POST ' +
    '/payments/preview with editingPaymentId returns it). expectedUpdatedAt: mismatch 409 STALE. A deposited payment takes memo and ' +
    'refNo only: any other change is 409 TXN_DEPOSITED {depositIds}. A bounced payment is 409 PAYMENT_BOUNCED. ' +
    `${exactRules} ${receiveErrors} ${closedPeriodNote}`,
  body: updateCustomerPaymentSchema.extend(closing),
  params: z.object({ id: z.string().uuid() }),
}), async (req, res) => {
  const payment = await paymentService.updatePayment(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId);
  res.json({ payment });
});

paymentsRouter.post('/:id/void', closingPasswordLimiter, lockContextMiddleware, idempotent({
  successStatus: 200,
  replay: async () => ({ voided: true }),
}), validate(voidPaymentSchema), describe({
  summary: 'Void a customer payment',
  description: 'Response {voided: true}. The invoices it paid reopen (every void path does this, /transactions/:id/void too); its ' +
    'applications are kept, marked set aside. expectedUpdatedAt: mismatch 409 STALE. 409 TXN_DEPOSITED {depositIds} while a posted ' +
    'deposit holds it; 409 PAYMENT_BOUNCED while its bounce is live; 409 PAYMENT_REFUNDED while a refund of its credit is live (Q-P21j); ' +
    'credits applied inside it are set aside too; 400 when the reconciliation it is cleared in is complete. ' +
    `Closed period on the payment's date. ${closedPeriodNote}`,
  body: voidPaymentSchema.extend(closing),
  params: z.object({ id: z.string().uuid() }),
}), async (req, res) => {
  await paymentService.voidPayment(req.tenantId, req.params['id']!, req.body.reason, req.userId, {
    expectedUpdatedAt: req.body.expectedUpdatedAt, companyId: req.companyId,
  });
  res.json({ voided: true });
});

paymentsRouter.post('/:id/bounce', closingPasswordLimiter, lockContextMiddleware, idempotent({
  successStatus: 201,
  replay: async (req, entity) => paymentService.bounceResult(req.tenantId, entity!.id, req.companyId),
}), validate(bouncePaymentSchema), describe({
  summary: 'Record a bounced payment (payment-bounce-v1)',
  description: 'Response 201 {returnId, feeId?, heldIn: {accountId, kind: bank | payments_clearing}, reopened: [{invoiceId, ' +
    'balanceDue}]}. One database transaction posts a returned_payment ("Bounced payment") dated `date`: Cr the account holding the ' +
    'money (its live deposit\'s bank, else the bank it went to, else Payments Clearing, which takes it off the pending deposits), Dr A/R ' +
    'for the customer; every live application is restored onto its invoice and marked reversed; the payment has no credit left and ' +
    'can\'t be deposited, applied, edited or bounced again. No deposit is voided and nothing dated earlier changes, so only `date` meets ' +
    'the closing date. bankFeeAmount posts an expense (Dr bankFeeAccountId, default the company setting nsfBankFeeAccountId; Cr the ' +
    'bank holding the money, or bankFeeBankAccountId when that is Payments Clearing) in the same transaction, source_txn_id = the ' +
    'bounce. A fee charged to the customer is a separate POST /invoices. Voiding the returned_payment (POST /transactions/:id/void) ' +
    're-applies what it reversed: 409 INVOICE_VOIDED / INVOICE_BALANCE_CHANGED when it no longer can; the fee is left to void ' +
    'separately. Errors: 409 PAYMENT_BOUNCED (a live bounce exists), 409 STALE (expectedUpdatedAt), 400 BOUNCE_DATE_INVALID (before ' +
    'the payment\'s or its deposit\'s date), 400 FEE_ACCOUNT_REQUIRED, 400 FEE_ACCOUNT_INVALID (A/R, A/P, Payments Clearing, Customer ' +
    `Deposits, the account holding the money, inactive or another company's), 400 FEE_BANK_REQUIRED. ${closedPeriodNote} ` +
    'Replay (Idempotency-Key) rebuilds the response from the returned_payment.',
  body: bouncePaymentSchema.extend(closing),
  params: z.object({ id: z.string().uuid() }),
}), async (req, res) => {
  const result = await paymentService.bouncePayment(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId);
  res.status(201).json(result);
});

paymentsRouter.get('/:id', describe({
  summary: 'Get a customer payment (receive-payment-v1)',
  description: `Response {payment: PaymentRecord}. A payment of another company is 404. ${paymentRecordNote}`,
  params: z.object({ id: z.string().uuid() }),
}), async (req, res) => {
  const payment = await paymentService.getPaymentRecord(db, req.tenantId, req.params['id']!, req.companyId);
  res.json({ payment });
});
