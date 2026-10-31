// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import express, { Router } from 'express';
import { z } from 'zod';
import {
  createInvoiceSchema, recordPaymentSchema, voidTransactionSchema, invoiceListFiltersSchema, recordDocumentSentSchema,
  previewInvoiceSchema, emailInvoiceSchema, invoiceEmailMessageSchema,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { idempotent } from '../middleware/idempotent.js';
import { describe } from '../middleware/describe.js';
import { closingPasswordLimiter } from '../middleware/closing-password-limiter.js';
import { lockContextMiddleware } from '../services/lock-context.js';
import * as invoiceService from '../services/invoice.service.js';
import * as ledger from '../services/ledger.service.js';
import * as pdfService from '../services/pdf.service.js';
import * as emailService from '../services/email.service.js';
import * as invoiceEmail from '../services/invoice-email.service.js';
import { auditLog } from '../middleware/audit.js';
import { AppError } from '../utils/errors.js';

export const invoicesRouter = Router();
invoicesRouter.use(authenticate);
invoicesRouter.use(companyContext);
invoicesRouter.use(requireResource('invoices'));

const idParams = z.object({ id: z.string().uuid() });

// Closed periods (U-124, invoice-edit-v1): an invoice dated on or before the
// closing date (for an edit, the old or the new date) takes closingPassword
// or a staff overrideConfirmed, as POST /transactions does. The limiter must
// see the body before lockContextMiddleware strips the password, and both
// run before the idempotency check and validation (bills.routes.ts order).
const closingPasswordDoc = z.string().optional().describe('closing-date password (closing-password-v1); never stored or echoed');
const closedPeriodNote = 'An invoice dated on or before the closing date (for an edit, the old or the new date) needs closingPassword (or a staff overrideConfirmed): '
  + '423 TB_PERIOD_LOCKED, 403 CLOSING_PASSWORD_INVALID, 429 CLOSING_PASSWORD_RATE_LIMIT; an allowed one writes a closing_date_override audit row (invoice-edit-v1).';
const bodyDoc = createInvoiceSchema.extend({ closingPassword: closingPasswordDoc, overrideConfirmed: z.boolean().optional() });
const voidBodyDoc = voidTransactionSchema.extend({ closingPassword: closingPasswordDoc, overrideConfirmed: z.boolean().optional() });

const moneyRules = 'Money (sales-cents-v1): each line amount is round2(quantity x unitPrice), half away from zero (quantity and unitPrice: decimal strings, at most 4 places, '
  + 'either may be negative); tax is round2(taxable base x rate) once per rate, allocated to the taxable lines by largest remainder so line taxAmounts sum to the tax; '
  + 'a taxable line without taxRate takes the request company\'s default rate; rates are rounded to 4 places. Totals and amounts are stored at 4 places, exact to the cent. '
  + 'Golden cases: packages/shared/fixtures/invoice-golden.json.';
const fieldRules = 'Lines (invoice-fields-v1): itemId (an item of the company) supplies the income account when accountId is omitted and the taxable flag when isTaxable is omitted; '
  + 'serviceDate YYYY-MM-DD. Header: poNumber, customerMessage (printed; memo stays internal), tagIds (header tags), hideZeroLines. '
  + 'Terms (invoice-terms-v1): paymentTerms is a code from GET /payment-terms (custom takes termsDays), omitted the client\'s default, else the company\'s; '
  + 'dueDate sent wins (stored as overridden), else computed. A customer, item or tag of another company is 400 VALIDATION_ERROR.';
const pricingRules = 'Pricing (invoice-pricing-v1, item-kinds-sales-v1, price-levels-v1): quantity omitted is 1; unitPrice omitted takes the client\'s price level '
  + '(a fixed level price for the item, else round2(item price x (1 + level percent / 100)) half away from zero), else the item\'s price, else 400 VALIDATION_ERROR. '
  + 'A discount item\'s line is -round2(group x discountPercent / 100) (discountPercent sent, else the item\'s) or -|unitPrice| (sent, else the item\'s amount), '
  + 'where the group is the signed sum of the lines since the last subtotal line (a discount right under a subtotal takes that subtotal\'s lines); sending both is 400. '
  + 'Discounts are taxable unless isTaxable is false: a taxable discount reduces the taxable base. A subtotal item\'s line shows the sum of the lines since the previous '
  + 'subtotal, is not part of the totals, is never taxed and posts $0. Lines read back with discountPercent and unitPriceSource '
  + '(input | item | price_level | price_level_percent | none). On PUT a line without unitPrice is priced again: send the stored unitPrice to keep it. '
  + 'A PUT on an invoice with discount or subtotal lines that sends no itemId on any line is 409 INVOICE_LINES_MISSING and nothing changes (a client that does not '
  + 'know items would drop them): send every non-A/R, non-tax line back, a discount as {itemId, discountPercent} or {itemId, unitPrice}, a subtotal as {itemId}. '
  + 'Golden cases: packages/shared/fixtures/invoice-golden.json pricingCases.';

const billableRules = 'Billable costs (billable-costs-v1, U-128): a line {billableSourceLineId (GET /billable-costs sourceLineId), accountId (required: the income account the cost credits), '
  + 'markupPercent? (a percent, "10" = 10 %, 0-1000)} bills that cost whole, once, to its own customer (the invoice contactId); itemId, quantity and unitPrice come from the cost '
  + '(400 BILLABLE_FIELDS_READONLY). costAmount = round2(cost), markupAmount = round2(costAmount x markupPercent / 100), none on a negative cost; amount = cost + markup, '
  + 'one visible line, rate = amount / quantity (unitPriceSource billable_cost); isTaxable defaults to true. Journal: a billable_cost line on accountId and, when the markup '
  + 'is not 0, a billable_markup line on the company billableMarkupAccountId (400 MARKUP_ACCOUNT_REQUIRED without one; kept on edit). PUT must re-send every cost the '
  + 'invoice bills or name it in releaseBillableSourceLineIds (409 BILLABLE_LINES_MISSING {sourceLineIds}); a void or delete through any route releases them. '
  + 'Errors: 409 BILLABLE_ALREADY_BILLED (details.conflicts [{sourceLineId, invoiceId?, invoiceNumber?}], named only within the company), 409 BILLABLE_COST_UNAVAILABLE '
  + '(stale id, not billable, source void / deleted / of another company: reload), 400 BILLABLE_CONTACT_MISMATCH, 400 BILLABLE_DUPLICATE_LINE, '
  + '400 BILLABLE_INCOME_ACCOUNT_REQUIRED, 409 INVOICE_TOTAL_BELOW_PAID (an edit below the amount paid), 409 RETRY (deadlock: retry). GET returns billableCosts '
  + '[{sourceLineId, sourceTransactionId, sourceTxnType, sourceNumber, costAmount, markupPercent, markupAmount, amount, displayRate, quantity, incomeAccountId, '
  + 'markupAccountId, costLineId, markupLineId, billed}]; lines carry lineRole and billableSourceLineId. Golden: invoice-golden.json billableCases.';

invoicesRouter.get('/', describe({
  summary: 'List invoices',
  description: 'The transaction list filters, plus sent (invoice-sent-history-v1): "false" keeps the invoices never sent (no send event, no sent date, never marked sent) '
    + 'that are not void, whatever their payment status, so one that is partly paid still shows; "true" keeps the others.',
  query: invoiceListFiltersSchema,
}), async (req, res) => {
  const parsed = invoiceListFiltersSchema.safeParse(req.query);
  if (!parsed.success) throw AppError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid query', 'VALIDATION_ERROR');
  const { sent, ...filters } = parsed.data;
  const result = await ledger.listTransactions(req.tenantId, { ...filters, txnType: 'invoice', ...(sent ? { invoiceSent: sent === 'true' } : {}) }, req.companyId);
  res.json(result);
});

// Idempotency-Key (idempotency-v1, U-18).
invoicesRouter.post('/', closingPasswordLimiter, lockContextMiddleware, idempotent({
  successStatus: 201,
  replay: async (req, entity) => ({ invoice: await invoiceService.getInvoice(req.tenantId, entity!.id, req.companyId) }),
}), validate(createInvoiceSchema), describe({
  summary: 'Create an invoice',
  description: 'Response 201 `{invoice, warnings}` (the invoice as GET /invoices/:id returns it). No txnNumber: the next free number from the company\'s invoice counter '
    + '(numbers a live invoice already holds are skipped; a refused post takes no number). A typed txnNumber already used by '
    + 'an invoice of the company is 409 DOCUMENT_NUMBER_IN_USE (details {txnNumber, transactionId}), or posts with it listed in '
    + '`warnings` when warnOnly is true (document-numbers-v1). An idempotent replay (same Idempotency-Key) returns only '
    + `\`{invoice}\`, without \`warnings\`: treat it as absent-safe. ${closedPeriodNote} ${moneyRules} ${fieldRules} ${pricingRules} ${billableRules}`,
  body: bodyDoc,
}), async (req, res) => {
  // warnings (U-111): duplicate-number warnings of a warnOnly request; [] otherwise.
  const { invoice, warnings } = await invoiceService.createInvoiceWithWarnings(req.tenantId, req.body, req.userId, req.companyId);
  res.status(201).json({ invoice: await invoiceService.getInvoice(req.tenantId, invoice.id, req.companyId), warnings });
});

// Before every /:id route. Posts nothing: no closing-date check, no number,
// no audit row, no Idempotency-Key (U-129).
invoicesRouter.post('/preview', validate(previewInvoiceSchema), describe({
  summary: 'Preview an invoice\'s figures',
  description: 'invoice-pricing-v1: computes the invoice the body would post (POST /invoices; with invoiceId, PUT /invoices/:invoiceId) with the same code, '
    + 'and writes nothing. Response 200 {lines: [{itemId, itemType, quantity, unitPrice, unitPriceSource, discountPercent, amount, isTaxable, taxRate, taxAmount}], '
    + 'subtotal, taxableBase, taxRate (the company default), taxTotal, total, taxGroups [{rate, base, tax}], paymentTerms, dueDate, '
    + 'priceLevel {id, name, percent} | null, contactBalanceBefore, contactBalanceAfter}: amounts are 2-place strings; contactBalanceAfter is the client\'s open '
    + 'balance (contact-balance-v1) plus this total, with invoiceId\'s posted total taken out first. Errors as POST (400 VALIDATION_ERROR); '
    + `invoiceId of another company or not found 404. Billable lines add {billableSourceLineId, costAmount, markupPercent, markupAmount, displayRate, error: {code: BILLABLE_ALREADY_BILLED, invoiceId, invoiceNumber} | null}; nothing is locked or claimed. ${moneyRules} ${pricingRules} ${billableRules}`,
  body: previewInvoiceSchema,
}), async (req, res) => {
  res.json(await invoiceService.previewInvoice(req.tenantId, req.body, req.companyId));
});

invoicesRouter.get('/:id', describe({
  summary: 'Get an invoice',
  description: 'Response {invoice}: the transaction with its lines (serviceDate, itemId, taxRate, taxAmount), poNumber, customerMessage, hideZeroLines, '
    + 'tagIds and sendHistory [{id, method: printed|email|pdf, recipients, sentAt, userId}] oldest first (kept across edits). '
    + 'An invoice of another company is 404; another transaction type is 400.',
  params: idParams,
}), async (req, res) => {
  const invoice = await invoiceService.getInvoice(req.tenantId, req.params['id']!, req.companyId);
  res.json({ invoice });
});

// Idempotency-Key on edit, void and sent (idempotency-invoice-v1): routes
// keyed after idempotency-v1, so under their own capability name. Refusals
// (409 STALE, INVOICE_HAS_PAYMENTS, 423, 403, 400) are never stored.
const keyedInvoiceById = (successStatus: 200 | 201) => idempotent({
  successStatus,
  replay: async (req) => ({ invoice: await invoiceService.getInvoice(req.tenantId, req.params['id']!, req.companyId) }),
});

invoicesRouter.put('/:id', closingPasswordLimiter, lockContextMiddleware, keyedInvoiceById(200), validate(createInvoiceSchema), describe({
  summary: 'Edit an invoice',
  description: 'Response 200 {invoice, warnings} as committed (its updatedAt is the next expectedUpdatedAt). expectedUpdatedAt (invoice-edit-v1): mismatch 409 STALE '
    + '(details.updatedAt), nothing changes. A void or paid invoice is 400; one of another company 404. Terms: an omitted paymentTerms keeps the invoice\'s; the due date '
    + 'is recomputed when the date or the terms change (unless dueDate is sent), else kept. Omitted poNumber, customerMessage, hideZeroLines, internalNotes, tagIds and '
    + `printLater keep their values. ${closedPeriodNote} ${moneyRules} ${fieldRules} ${pricingRules} ${billableRules}`,
  body: bodyDoc,
  params: idParams,
}), async (req, res) => {
  const { invoice, warnings } = await invoiceService.updateInvoiceWithWarnings(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId);
  res.json({ invoice, warnings });
});

invoicesRouter.post('/:id/sent', keyedInvoiceById(200), validate(recordDocumentSentSchema), describe({
  summary: 'Record that an invoice was sent',
  description: 'invoice-sent-history-v1: adds {method: printed|email|pdf, recipients (email only), sentAt (default now)} to the invoice\'s sendHistory. '
    + 'A draft becomes sent (its updatedAt moves); sentAt is kept from the first send. Recipients are stored but never logged or audited. '
    + 'Response 200 {invoice}. Void: 400 INVOICE_VOID; another company: 404.',
  body: recordDocumentSentSchema,
  params: idParams,
}), async (req, res) => {
  const invoice = await invoiceService.recordInvoiceSent(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId);
  res.json({ invoice });
});

// Invoice email and the Outbox (U-127, invoice-email-v1). Idempotency-Key on
// both routes under that capability name (idempotency-invoice-v1 is fixed).
// The email body carries the PDF as base64 (up to 10 MB decoded, about
// 13.4 MB encoded), over the app's 10 MB JSON limit: app.ts mounts
// invoiceEmailJson for this route ahead of the global parser.
export const INVOICE_EMAIL_JSON_LIMIT = '15mb';
const invoiceEmailJsonParser = express.json({ limit: INVOICE_EMAIL_JSON_LIMIT });
const INVOICE_EMAIL_PATH = /^\/api\/v1\/invoices\/[^/]+\/email\/?$/;
/**
 * Mount with app.use(invoiceEmailJson) (no path: not a route family of its
 * own) ahead of the global JSON parser; it parses POST
 * /api/v1/invoices/:id/email only and passes everything else on.
 */
export const invoiceEmailJson: express.RequestHandler = (req, res, next) => {
  if (req.method === 'POST' && INVOICE_EMAIL_PATH.test(req.path)) invoiceEmailJsonParser(req, res, next);
  else next();
};

const emailRules = 'Recipients, subject and body are never logged or audited (audit rows carry counts). '
  + 'Errors: 400 SMTP_NOT_CONFIGURED (no mail server for the company, no From address, or in desktop mode no session password or one given for another server; '
  + 'smtp-session-v1), 400 SMTP_SEND_FAILED (the server refused the message or the login; details.reason auth|send), 503 OFFLINE_UNAVAILABLE (desktop offline), '
  + '400 INVOICE_VOID, 404 (another company).';

invoicesRouter.post('/:id/email', idempotent({
  successStatus: 200,
  replay: async (req) => ({ invoice: await invoiceService.getInvoice(req.tenantId, req.params['id']!, req.companyId) }),
}), validate(emailInvoiceSchema), describe({
  summary: 'Email an invoice through the company mail server (invoice-email-v1)',
  description: 'Sends {to, cc, bcc, subject, body} with the PDF the client made attached (pdfBase64: application/pdf starting %PDF-, at most 10 MB decoded, '
    + 'else 400 ATTACHMENT_TOO_LARGE / VALIDATION_ERROR; pdfFileName e.g. Invoice-1042.pdf). Only when the server accepts it, an "email" send event '
    + '(invoice-sent-history-v1, recipients = to + cc + bcc) is recorded and a draft becomes sent; a failed send records nothing. outboxId (optional): '
    + 'the Outbox message being sent; it is removed in the same commit, and 404 OUTBOX_ITEM_NOT_FOUND (nothing sent) when it is gone. '
    + 'Response 200 {invoice} with its sendHistory. Idempotency-Key: a retry with the key replays and sends nothing more; '
    + 'if the commit fails after the server accepted the message, a retry sends it again. '
    + emailRules,
  body: emailInvoiceSchema,
  params: idParams,
}), async (req, res) => {
  const invoice = await invoiceEmail.emailInvoice(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId);
  res.json({ invoice });
});

export const outboxItemDoc = z.object({
  id: z.string().uuid(),
  transactionId: z.string().uuid(),
  txnNumber: z.string().nullable(),
  txnType: z.string().nullable(),
  txnStatus: z.string().nullable(),
  contactName: z.string().nullable(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
  userId: z.string().uuid().nullable(),
  createdAt: z.string(),
});

invoicesRouter.post('/:id/email-later', idempotent({
  successStatus: 201,
  replay: async (req, entity) => ({ item: await invoiceEmail.getEmailQueueItem(req.tenantId, entity!.id, req.companyId) }),
}), validate(invoiceEmailMessageSchema), describe({
  summary: 'Put an invoice email in the Outbox (invoice-email-v1)',
  description: 'Stores {to, cc, bcc, subject, body} with the company; nothing is sent until the client sends it with POST /invoices/:id/email and outboxId. '
    + 'No PDF is stored: the client makes it when it sends (Q-P20q). Response 201 {item} (as GET /forms/email-queue). '
    + 'Void: 400 INVOICE_VOID; another company: 404. ' + emailRules.split(' Errors:')[0],
  body: invoiceEmailMessageSchema,
  params: idParams,
  response: z.object({ item: outboxItemDoc }),
}), async (req, res) => {
  const item = await invoiceEmail.queueInvoiceEmail(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId);
  res.status(201).json({ item });
});

invoicesRouter.post('/:id/mark-sent', async (req, res) => {
  await invoiceService.markAsSent(req.tenantId, req.params['id']!, req.userId, req.companyId);
  const invoice = await invoiceService.getInvoice(req.tenantId, req.params['id']!, req.companyId);
  res.json({ invoice });
});

invoicesRouter.post('/:id/send', async (req, res) => {
  await invoiceService.sendInvoice(req.tenantId, req.params['id']!, req.userId, req.companyId);
  const invoice = await invoiceService.getInvoice(req.tenantId, req.params['id']!, req.companyId);
  res.json({ invoice });
});

invoicesRouter.post('/:id/payment', validate(recordPaymentSchema), async (req, res) => {
  const payment = await invoiceService.recordPayment(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId);
  res.status(201).json({ payment });
});

invoicesRouter.post('/:id/void', closingPasswordLimiter, lockContextMiddleware, keyedInvoiceById(200), validate(voidTransactionSchema), describe({
  summary: 'Void an invoice',
  description: `Response 200 {invoice}. ${closedPeriodNote} Refused while a live payment or credit is applied: 409 INVOICE_HAS_PAYMENTS (details {payments, credits}). `
    + 'expectedUpdatedAt (invoice-edit-v1): mismatch 409 STALE. An invoice of another company is 404; another transaction type 400.',
  body: voidBodyDoc,
  params: idParams,
}), async (req, res) => {
  await invoiceService.voidInvoice(req.tenantId, req.params['id']!, req.body.reason, req.userId, {
    expectedUpdatedAt: req.body.expectedUpdatedAt, companyId: req.companyId,
  });
  const invoice = await invoiceService.getInvoice(req.tenantId, req.params['id']!, req.companyId);
  res.json({ invoice });
});

invoicesRouter.get('/:id/pdf', async (req, res) => {
  await invoiceService.getInvoice(req.tenantId, req.params['id']!, req.companyId);
  const pdf = await pdfService.generateInvoicePdf(req.tenantId, req.params['id']!);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="invoice-${req.params['id']}.pdf"`);
  res.send(pdf);
});

invoicesRouter.post('/:id/remind', async (req, res) => {
  await invoiceService.getInvoice(req.tenantId, req.params['id']!, req.companyId);
  const { baseUrlFor } = await import('../utils/base-url.js');
  await emailService.sendPaymentReminder(req.tenantId, req.params['id']!, baseUrlFor(req));
  res.json({ message: 'Reminder sent' });
});

invoicesRouter.post('/:id/share-link', async (req, res) => {
  if (req.userRole === 'readonly') {
    res.status(403).json({ error: { message: 'Readonly users cannot generate share links' } });
    return;
  }
  const { baseUrlFor } = await import('../utils/base-url.js');
  const link = await invoiceService.generateShareLink(req.tenantId, req.params['id']!, req.userId, baseUrlFor(req), req.companyId);
  res.json({ link });
});

// Kill an issued public link (see revokePublicToken). Owners/accountants
// only — same gate as minting.
invoicesRouter.delete('/:id/share-link', async (req, res) => {
  if (req.userRole === 'readonly') {
    res.status(403).json({ error: { message: 'Readonly users cannot manage share links' } });
    return;
  }
  await invoiceService.getInvoice(req.tenantId, req.params['id']!, req.companyId);
  const publicInvoice = await import('../services/public-invoice.service.js');
  const result = await publicInvoice.revokePublicToken(req.tenantId, req.params['id']!);
  await auditLog(req.tenantId, 'update', 'invoice', req.params['id']!, null, { action: 'share_link_revoked' }, req.userId);
  res.json(result);
});

invoicesRouter.post('/:id/duplicate', async (req, res) => {
  // warnings: BILLABLE_COPIED_AS_PLAIN when billed costs were copied as plain lines (U-128 S4).
  const { invoice, warnings } = await invoiceService.duplicateInvoiceWithWarnings(req.tenantId, req.params['id']!, req.userId, req.companyId);
  res.status(201).json({ invoice, warnings });
});
