// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router, type Request } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { idempotent } from '../middleware/idempotent.js';
import * as st from '../services/sales-tax.service.js';
import * as report from '../services/sales-tax-report.service.js';
import * as pay from '../services/sales-tax-pay.service.js';
import * as exemptions from '../services/tax-exemptions.service.js';
import { closingPasswordLimiter } from '../middleware/closing-password-limiter.js';
import { lockContextMiddleware } from '../services/lock-context.js';

/**
 * Sales tax (U-147; sales-tax-setup-v1, idempotency-sales-tax-v1). One mount
 * for setup and, in later rows, owed / Pay Sales Tax / exemptions. Records
 * of another company are 404. Writes take Idempotency-Key; PUTs take
 * expectedUpdatedAt (409 STALE). Deactivate, never delete.
 */
export const salesTaxRouter = Router();
salesTaxRouter.use(authenticate);
salesTaxRouter.use(companyContext);
salesTaxRouter.use(requireResource('sales_tax'));

const idParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({ includeInactive: z.enum(['true', 'false']).optional() });
const inactive = (req: Request) => req.query['includeInactive'] === 'true';
const id = (req: Request) => req.params['id']!;
const expectedUpdatedAt = z.string().datetime({ offset: true }).optional();
const rateNote = 'Rates are fractions written as strings with at most 6 places ("0.088750" = 8.875 %), 0 <= rate < 1; numbers are refused (400 VALIDATION_ERROR).';

// ── Agencies ──────────────────────────────────────────────────────

const agencyShape = '{id, vendorId, vendorName, isActive, updatedAt}';
const agencyBody = z.object({ vendorId: z.string().uuid() });

salesTaxRouter.get('/agencies', describe({
  summary: 'List sales tax agencies (sales-tax-setup-v1)',
  description: `Response {data: [${agencyShape}]} by vendor name; active only unless includeInactive=true. An agency is a vendor of the company that sales tax is paid to.`,
  query: listQuery,
}), async (req, res) => {
  res.json(await st.listAgencies(req.tenantId, req.companyId, inactive(req)));
});

salesTaxRouter.get('/agencies/:id', describe({ summary: 'Get a sales tax agency', description: `Response ${agencyShape}; 404 for another company's.`, params: idParams }),
  async (req, res) => { res.json(await st.getAgency(req.tenantId, req.companyId, id(req))); });

salesTaxRouter.post('/agencies', idempotent({ successStatus: 201, replay: async (req, e) => st.getAgency(req.tenantId, req.companyId, e!.id) }),
  validate(agencyBody), describe({
    summary: 'Create a sales tax agency',
    description: `Response 201 ${agencyShape}. vendorId: a vendor (or both) contact of this company, else 400 VALIDATION_ERROR; one agency per vendor (409 AGENCY_EXISTS). Idempotency-Key.`,
    body: agencyBody,
  }), async (req, res) => {
    res.status(201).json(await st.createAgency(req.tenantId, req.companyId, req.body, req.userId));
  });

const agencyPut = agencyBody.extend({ expectedUpdatedAt });
salesTaxRouter.put('/agencies/:id', idempotent({ successStatus: 200, replay: async (req) => st.getAgency(req.tenantId, req.companyId, id(req)) }),
  validate(agencyPut), describe({
    summary: 'Change a sales tax agency\'s vendor',
    description: `Response ${agencyShape}. 404; 409 AGENCY_EXISTS, STALE (expectedUpdatedAt differs). Idempotency-Key.`,
    body: agencyPut, params: idParams,
  }), async (req, res) => {
    res.json(await st.updateAgency(req.tenantId, req.companyId, id(req), req.body, req.userId));
  });

for (const [path, active] of [['deactivate', false], ['reactivate', true]] as const) {
  salesTaxRouter.post(`/agencies/:id/${path}`, idempotent({ successStatus: 200, replay: async (req) => st.getAgency(req.tenantId, req.companyId, id(req)) }), describe({
    summary: `${active ? 'Reactivate' : 'Deactivate'} a sales tax agency`,
    description: `Response ${agencyShape}. ${active ? '' : '409 AGENCY_IN_USE while an active sales tax item is paid to it. '}404. Idempotency-Key.`,
    params: idParams,
  }), async (req, res) => {
    res.json(await st.setAgencyActive(req.tenantId, req.companyId, id(req), active, req.userId));
  });
}

// ── Items and groups ──────────────────────────────────────────────

const itemShape = '{id, kind: item|group, name, description, rate (6 places; a group: the sum of its members), agencyId, agencyName, '
  + 'members? [{id, name, rate, agencyId, isActive}] (groups), legacyRate (a legacy item: the stored line rate it stands for, else null), isActive, inUse, updatedAt}';
const itemRules = 'One sales tax per document (Q-P23d): an item, or a group of 1-10 items charged together; tax = round2(taxable base x combined rate) once, '
  + 'allocated to the members by largest remainder. A legacy item (made for a rate saved on documents before sales tax setup, or sent by a line taxRate) '
  + 'has no agency until one is set; its rate can\'t change. A changed rate or agency applies to documents saved from now on (Q-P23v).';
const itemCreate = z.object({
  kind: z.enum(['item', 'group']).default('item'),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  rate: z.string().optional(),
  agencyId: z.string().uuid().optional(),
  memberIds: z.array(z.string().uuid()).optional(),
});
const itemUpdate = z.object({
  kind: z.enum(['item', 'group']).optional(),
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  rate: z.string().optional(),
  agencyId: z.string().uuid().nullable().optional(),
  memberIds: z.array(z.string().uuid()).optional(),
  expectedUpdatedAt,
});

salesTaxRouter.get('/items', describe({
  summary: 'List sales tax items and groups (sales-tax-setup-v1)',
  description: `Response {data: [${itemShape}]}, items then groups by name; active only unless includeInactive=true. ${itemRules}`,
  query: listQuery,
}), async (req, res) => {
  res.json(await st.listItems(req.tenantId, req.companyId, inactive(req)));
});

salesTaxRouter.get('/items/:id', describe({ summary: 'Get a sales tax item or group', description: `Response ${itemShape}; 404 for another company's.`, params: idParams }),
  async (req, res) => { res.json(await st.getItem(req.tenantId, req.companyId, id(req))); });

salesTaxRouter.post('/items', idempotent({ successStatus: 201, replay: async (req, e) => st.getItem(req.tenantId, req.companyId, e!.id) }),
  validate(itemCreate), describe({
    summary: 'Create a sales tax item or group',
    description: `Response 201 ${itemShape}. An item needs rate and agencyId (400 AGENCY_REQUIRED; an inactive or other company's agency is 400 VALIDATION_ERROR); `
      + 'a group needs memberIds: 1-10 different (400 GROUP_SIZE) active items of this company, not groups (400 GROUP_MEMBER_NOT_ITEM), and no rate or agencyId. '
      + `Names are unique, case-insensitive (409 NAME_IN_USE). ${rateNote} Idempotency-Key. ${itemRules}`,
    body: itemCreate,
  }), async (req, res) => {
    res.status(201).json(await st.createItem(req.tenantId, req.companyId, req.body, req.userId));
  });

salesTaxRouter.put('/items/:id', idempotent({ successStatus: 200, replay: async (req) => st.getItem(req.tenantId, req.companyId, id(req)) }),
  validate(itemUpdate), describe({
    summary: 'Edit a sales tax item or group',
    description: `Response ${itemShape}. Omitted fields keep their values; memberIds sent replaces a group's members. The kind can't change; a legacy item's rate `
      + `can't change (400 VALIDATION_ERROR); a legacy item may get or lose an agency. 404; 409 NAME_IN_USE, STALE. ${rateNote} Idempotency-Key. ${itemRules}`,
    body: itemUpdate, params: idParams,
  }), async (req, res) => {
    res.json(await st.updateItem(req.tenantId, req.companyId, id(req), req.body, req.userId));
  });

for (const [path, active] of [['deactivate', false], ['reactivate', true]] as const) {
  salesTaxRouter.post(`/items/:id/${path}`, idempotent({ successStatus: 200, replay: async (req) => st.getItem(req.tenantId, req.companyId, id(req)) }), describe({
    summary: `${active ? 'Reactivate' : 'Deactivate'} a sales tax item or group`,
    description: `Response ${itemShape}. ${active ? 'A group whose members are not all active is 400 GROUP_MEMBER_NOT_ITEM. '
      : '409 ITEM_IN_GROUP {groups} while an active group contains the item. An inactive item can\'t be chosen for a new document (TAX_ITEM_INACTIVE); saved documents keep it. '}404. Idempotency-Key.`,
    params: idParams,
  }), async (req, res) => {
    res.json(await st.setItemActive(req.tenantId, req.companyId, id(req), active, req.userId));
  });
}

// ── Codes ─────────────────────────────────────────────────────────

const codeShape = '{id, code (at most 8 characters), name, taxable, isSystem, isActive, updatedAt}';
const codeRules = 'Every company has the system codes Tax (taxable) and Non (non-taxable). A line\'s code (Q-P23k): the line\'s, else the client\'s '
  + 'non-taxable code, else the item\'s code, else the item\'s taxable flag. Non-taxable lines are reported by code.';
const codeCreate = z.object({ code: z.string().trim().min(1).max(8), name: z.string().trim().min(1).max(100), taxable: z.boolean() });
const codeUpdate = z.object({
  code: z.string().trim().min(1).max(8).optional(), name: z.string().trim().min(1).max(100).optional(), taxable: z.boolean().optional(), expectedUpdatedAt,
});

salesTaxRouter.get('/codes', describe({
  summary: 'List sales tax codes (sales-tax-setup-v1)',
  description: `Response {data: [${codeShape}]}, system codes first; active only unless includeInactive=true. ${codeRules}`,
  query: listQuery,
}), async (req, res) => {
  res.json(await st.listCodes(req.tenantId, req.companyId, inactive(req)));
});

salesTaxRouter.get('/codes/:id', describe({ summary: 'Get a sales tax code', description: `Response ${codeShape}; 404 for another company's.`, params: idParams }),
  async (req, res) => { res.json(await st.getCode(req.tenantId, req.companyId, id(req))); });

salesTaxRouter.post('/codes', idempotent({ successStatus: 201, replay: async (req, e) => st.getCode(req.tenantId, req.companyId, e!.id) }),
  validate(codeCreate), describe({
    summary: 'Create a sales tax code',
    description: `Response 201 ${codeShape}. Codes are unique, case-insensitive (409 CODE_IN_USE). Idempotency-Key. ${codeRules}`,
    body: codeCreate,
  }), async (req, res) => {
    res.status(201).json(await st.createCode(req.tenantId, req.companyId, req.body, req.userId));
  });

salesTaxRouter.put('/codes/:id', idempotent({ successStatus: 200, replay: async (req) => st.getCode(req.tenantId, req.companyId, id(req)) }),
  validate(codeUpdate), describe({
    summary: 'Edit a sales tax code',
    description: `Response ${codeShape}. A system code's code and taxable flag can't change (409 SYSTEM_CODE); its name can. 404; 409 CODE_IN_USE, STALE. Idempotency-Key.`,
    body: codeUpdate, params: idParams,
  }), async (req, res) => {
    res.json(await st.updateCode(req.tenantId, req.companyId, id(req), req.body, req.userId));
  });

for (const [path, active] of [['deactivate', false], ['reactivate', true]] as const) {
  salesTaxRouter.post(`/codes/:id/${path}`, idempotent({ successStatus: 200, replay: async (req) => st.getCode(req.tenantId, req.companyId, id(req)) }), describe({
    summary: `${active ? 'Reactivate' : 'Deactivate'} a sales tax code`,
    description: `Response ${codeShape}. ${active ? '' : 'A system code is 409 SYSTEM_CODE. '}404. Idempotency-Key.`,
    params: idParams,
  }), async (req, res) => {
    res.json(await st.setCodeActive(req.tenantId, req.companyId, id(req), active, req.userId));
  });
}

// ── Owed and the cash-basis diagnostic (U-149, U-152) ────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date YYYY-MM-DD');
const basisEnum = z.enum(['accrual', 'cash']);
const owedQuery = z.object({
  asOf: isoDate.optional(), as_of: isoDate.optional(),
  basis: basisEnum.optional(),
  agencyId: z.string().uuid().optional(), agency_id: z.string().uuid().optional(),
});
const owedShape = '{asOf, basis, agencyId, agencies: [{agencyId, name, items: [{taxItemId, name, owed}], total}], unassigned, total}';

salesTaxRouter.get('/owed', describe({
  summary: 'Sales tax owed as of a date (sales-tax-liability-v2)',
  description: `Response ${owedShape}; amounts are 2-place strings. Per agency and tax item: the tax rows counted on the basis ` +
    '(default the company\'s sales tax basis) dated on or before asOf (collected, SSUTA discounts; bad debts and recoveries on accrual only) ' +
    '+ every live adjustment - every live paid and opening payment line, whatever their date (a payment made after asOf still counts, so ' +
    'tax is never paid twice). Rows written before their item had an agency count under the item\'s agency. Unassigned: tax on Sales Tax ' +
    'Payable with no tax item. asOf (or as_of) is required; agencyId (or agency_id) filters; another company\'s agency is 404.',
  query: owedQuery,
}), async (req, res) => {
  const q = owedQuery.safeParse(req.query);
  const asOf = q.success ? q.data.asOf ?? q.data.as_of : undefined;
  if (!q.success || !asOf) { res.status(400).json({ error: { message: 'asOf is required (YYYY-MM-DD)', code: 'VALIDATION_ERROR' } }); return; }
  res.json(await report.salesTaxOwed(req.tenantId, req.companyId, asOf, {
    basis: q.data.basis ?? null, agencyId: q.data.agencyId ?? q.data.agency_id ?? null,
  }));
});

salesTaxRouter.get('/diagnostics/cash-basis', describe({
  summary: 'What the cash-basis corrections move in closed periods (cash-basis-spf-v1, Q-P23z)',
  description: 'Response {companyId, closingDate, unappliedReceipts, customerDeposits, writeOffs, billDiscounts}, each {count, amount} ' +
    '(2-place string), dated on or before the company\'s closing date (all zero without one). Cash-basis reports (U-152) now show ' +
    'unapplied payments and Customer Deposits lines as Unapplied receipts income, leave write-offs out and net bill discounts; posted ' +
    'transactions do not change, but cash-basis reports of those closed periods do. Read only.',
}), async (req, res) => {
  res.json(await report.cashBasisSpfDiagnostic(req.tenantId, req.companyId));
});

// ── Pay Sales Tax (U-150, sales-tax-pay-v1, idempotency-sales-tax-pay-v1) ──

const cents = z.string().regex(/^-?\d{1,13}(\.\d{1,2})?$/, 'an amount with at most 2 decimal places');
const payBody = z.object({
  agencyId: z.string().uuid(), throughDate: isoDate, date: isoDate, bankAccountId: z.string().uuid(),
  method: z.enum(['check', 'electronic']),
  lines: z.array(z.object({ taxItemId: z.string().uuid(), amount: cents.nullable().optional(), expectedOwed: cents.optional() })).max(200).optional(),
  adjustments: z.array(z.object({ taxItemId: z.string().uuid(), accountId: z.string().uuid(), amount: cents, reason: z.string().trim().min(1).max(255) })).max(200).optional(),
  printLater: z.boolean().optional(), checkNumber: z.number().int().positive().max(2147483647).optional(), memo: z.string().max(1000).optional(),
  expectedOwed: cents.optional(),
});
const payPreviewShape = '{agencyId, throughDate, basis, lines: [{taxItemId, name, owed, adjustment, amount, expectedOwed}], owed, expectedOwed (= owed: send it ' +
  'back unchanged as the POST body expectedOwed), total, problems: [{code, message, details?}]}';
const payRules = 'Owed per tax item of the agency = its tax rows counted on the company basis dated on or before throughDate + every live ' +
  'adjustment - every live paid and opening line, whatever their date (S1). lines omitted: every item at owed + its adjustments; sent: ' +
  'those items at those amounts, a line with amount null or absent at owed + its adjustments (computed by the engine; when paying, under ' +
  'the agency lock), so preview and pay agree on untyped lines. adjustments: amount signed (negative lowers what is paid, e.g. a timely-filing discount), on an income ' +
  'or expense account (400 ADJUSTMENT_ACCOUNT_INVALID), with a reason. A tax item not paid to the agency is 400 TAX_ITEM_NOT_FOR_AGENCY.';

salesTaxRouter.post('/payments/preview', validate(payBody), describe({
  summary: 'Preview a sales tax payment (sales-tax-pay-v1)',
  description: `Response ${payPreviewShape}; posts nothing. ${payRules} Problems (warnings): AMOUNT_MORE_THAN_OWED, LEGACY_UNASSIGNED ` +
    '(tax with no agency yet), NO_VENDOR_ADDRESS (method check and the agency vendor has no billing address).',
  body: payBody,
}), async (req, res) => {
  res.json(await pay.previewPayment(req.tenantId, req.companyId, req.body));
});

salesTaxRouter.post('/payments', closingPasswordLimiter, lockContextMiddleware,
  idempotent({ successStatus: 201, replay: async (req, e) => paymentReplay(req, e!.id) }), validate(payBody), describe({
    summary: 'Pay sales tax to an agency (sales-tax-pay-v1)',
    description: 'Response 201 {id, number, checkNumber, printStatus, total}. Posts a sales_tax_payment: per tax item Dr Sales Tax Payable ' +
      '(amount - adjustment; a credit when negative), each adjustment on its account (negative = credit), Cr bankAccountId for the total; ' +
      `zero lines left out. ${payRules} expectedOwed (required): the owed total of the payment's lines as previewed (and lines[].expectedOwed ` +
      'per item when sent); checked under a lock on the agency, else 409 SALES_TAX_OWED_CHANGED {owed, lines}. 400 VALIDATION_ERROR, ' +
      'PAYMENT_TOTAL_NOT_POSITIVE, CHECK_NO_OR_PRINT_LATER (printLater with a checkNumber; a check with no checkNumber is printed later); 409 CHECK_NUMBER_IN_USE, ' +
      'RETRY. printLater queues the check (GET /checks/print-queue). A date on or before the closing date needs closingPassword. ' +
      'Idempotency-Key: a replay returns the same payment. No edit: void with POST /transactions/:id/void (owed comes back, the check ' +
      'leaves the queue).',
    body: payBody.extend({ closingPassword: z.string().optional(), overrideConfirmed: z.boolean().optional() }),
  }), async (req, res) => {
    res.status(201).json(await pay.paySalesTax(req.tenantId, req.companyId, req.body, req.userId));
  });

async function paymentReplay(req: Request, txnId: string) {
  const p = await pay.getPayment(req.tenantId, req.companyId, txnId);
  return { id: p.id, number: p.number, checkNumber: p.checkNumber, printStatus: p.printStatus, total: p.total };
}

const paymentShape = '{id, date, number, status, agencyId, throughDate, method, linked, bankAccountId, total, checkNumber, printStatus, ' +
  'lines: [{taxItemId, name, kind: paid|adjustment, amount, accountId, reason}], stubLines: [{label, amount}]}';
const paymentsListQuery = z.object({ start_date: isoDate.optional(), end_date: isoDate.optional(), agency_id: z.string().uuid().optional() });
salesTaxRouter.get('/payments', describe({
  summary: 'List sales tax payments (sales-tax-pay-v1)',
  description: 'Response as GET /reports/sales-tax-payments: {data: [{transactionId, date, txnType, number, agencyId, agencyName, total, paid, ' +
    'adjustments, linked}]} by date. Query start_date, end_date (default this year), agency_id.',
  query: paymentsListQuery,
}), async (req, res) => {
  const q = paymentsListQuery.parse(req.query);
  const today = new Date().toISOString().split('T')[0]!;
  res.json(await report.buildSalesTaxPaymentsV2(req.tenantId, q.start_date ?? `${today.slice(0, 4)}-01-01`, q.end_date ?? today, req.companyId, q.agency_id ?? null));
});

const linkBody = z.object({
  transactionId: z.string().uuid(), agencyId: z.string().uuid(),
  lines: z.array(z.object({ taxItemId: z.string().uuid(), amount: cents })).min(1).max(200),
});
salesTaxRouter.post('/payments/link', closingPasswordLimiter, lockContextMiddleware,
  idempotent({ successStatus: 201, replay: async (req, e) => {
    const p = await pay.getPayment(req.tenantId, req.companyId, e!.id);
    return { transactionId: p.id, agencyId: p.agencyId, total: pay.sumAmounts(p.lines.filter((l) => l.kind === 'paid').map((l) => l.amount)) };
  } }), validate(linkBody), describe({
    summary: 'Match a payment already made to an agency (sales-tax-pay-v1)',
    description: 'Response 201 {transactionId, agencyId, total}. A posted check or journal entry of the company that debited Sales Tax ' +
      'Payable becomes a payment to the agency: paid lines per tax item (no new GL). 400 NOT_STP_PAYMENT, LINK_TOTAL_MISMATCH (the lines ' +
      'must add up to its net Sales Tax Payable debit), TAX_ITEM_NOT_FOR_AGENCY; 409 ALREADY_LINKED; 404 for another company\'s. A ' +
      'transaction dated on or before the closing date needs closingPassword. Idempotency-Key. Undo: POST /sales-tax/payments/:id/unlink. ' +
      'While linked, an edit of the transaction (PUT /transactions/:id, /checks/:id) that moves its date or changes its Sales Tax Payable ' +
      'debit is 409 SALES_TAX_LINKED (unlink first); a bulk category or account move skips it (reason sales_tax_linked).',
    body: linkBody.extend({ closingPassword: z.string().optional(), overrideConfirmed: z.boolean().optional() }),
  }), async (req, res) => {
    res.status(201).json(await pay.linkPayment(req.tenantId, req.companyId, req.body, req.userId));
  });

salesTaxRouter.post('/payments/:id/unlink', closingPasswordLimiter, lockContextMiddleware,
  idempotent({ successStatus: 200, replay: async (req) => ({ transactionId: id(req), unlinked: 0 }) }), describe({
    summary: 'Unlink a matched payment (sales-tax-pay-v1)',
    description: 'Response {transactionId, unlinked}: drops the paid lines a link wrote (owed comes back). A Pay Sales Tax payment is 400 ' +
      'NOT_LINKED (void it instead); so is a transaction with no link. Closing password on its date. Idempotency-Key.',
    params: idParams,
  }), async (req, res) => {
    res.json(await pay.unlinkPayment(req.tenantId, req.companyId, id(req), req.userId));
  });

const markBody = z.object({ agencyId: z.string().uuid(), throughDate: isoDate, reason: z.string().trim().max(255).optional() });
const markRunShape = '{runId, agencyId, throughDate, reason, lines: [{taxItemId, name, amount}], total, createdAt, undoneAt}';
const runParams = z.object({ runId: z.string().uuid() });
salesTaxRouter.post('/payments/mark-paid-through', closingPasswordLimiter, lockContextMiddleware,
  idempotent({ successStatus: 201, replay: async (req, e) => pay.getMarkPaidRun(req.tenantId, req.companyId, e!.id) }), validate(markBody), describe({
    summary: 'Mark an agency\'s tax paid through a date (sales-tax-pay-v1)',
    description: `Response 201 ${markRunShape}: for tax paid before these books or outside them, an opening line (no GL) per tax item with ` +
      'tax owed through throughDate, for what it owes, so those items owe 0.00 there; an over-paid item (owed below 0.00) keeps its credit. ' +
      'Lines are dated throughDate: on or before the closing date needs closingPassword. Audited. Idempotency-Key: a replay returns the ' +
      'stored run. Undo: POST /sales-tax/payments/mark-paid-through/{runId}/undo.',
    body: markBody.extend({ closingPassword: z.string().optional(), overrideConfirmed: z.boolean().optional() }),
  }), async (req, res) => {
    res.status(201).json(await pay.markPaidThrough(req.tenantId, req.companyId, req.body, req.userId));
  });

salesTaxRouter.post('/payments/mark-paid-through/:runId/undo', closingPasswordLimiter, lockContextMiddleware,
  idempotent({ successStatus: 200, replay: async (req, e) => pay.getMarkPaidRun(req.tenantId, req.companyId, e!.id) }), describe({
    summary: 'Undo a mark paid through (sales-tax-pay-v1)',
    description: `Response ${markRunShape} with undoneAt set: deletes the run's opening lines (owed comes back). Audited. A throughDate on ` +
      'or before the closing date needs closingPassword. 404 for an unknown run or another company\'s; 409 ALREADY_UNDONE. Idempotency-Key.',
    params: runParams,
    body: z.object({ closingPassword: z.string().optional(), overrideConfirmed: z.boolean().optional() }),
  }), async (req, res) => {
    res.json(await pay.undoMarkPaidThrough(req.tenantId, req.companyId, runParams.parse(req.params).runId, req.userId));
  });

const markListQuery = z.object({ agency_id: z.string().uuid().optional(), include_undone: z.enum(['true', 'false']).optional() });
salesTaxRouter.get('/payments/mark-paid-through', describe({
  summary: 'List mark paid through runs (sales-tax-pay-v1)',
  description: `Response {data: [${markRunShape}]}, newest first; undone runs only with include_undone=true. Query agency_id.`,
  query: markListQuery,
}), async (req, res) => {
  const q = markListQuery.parse(req.query);
  res.json(await pay.listMarkPaidRuns(req.tenantId, req.companyId, { agencyId: q.agency_id ?? null, includeUndone: q.include_undone === 'true' }));
});

salesTaxRouter.get('/payments/:id', describe({
  summary: 'Get a sales tax payment (sales-tax-pay-v1)',
  description: `Response ${paymentShape}. linked = a payment made outside Pay Sales Tax and matched to the agency. 404 otherwise or for another company's.`,
  params: idParams,
}), async (req, res) => {
  res.json(await pay.getPayment(req.tenantId, req.companyId, id(req)));
});
// ── Exemption certificates (U-151, tax-exemptions-v1) ─────────────────

const exemptionShape = '{id, contactId, number, state, expiresOn, attachmentId, note, isActive, updatedAt}';
const exemptionCreate = z.object({
  contactId: z.string().uuid(), number: z.string().trim().min(1).max(50), state: z.string().trim().max(20).nullable().optional(),
  expiresOn: isoDate.nullable().optional(), attachmentId: z.string().uuid().nullable().optional(), note: z.string().max(2000).nullable().optional(),
});
const exemptionUpdate = exemptionCreate.partial().extend({ expectedUpdatedAt });
const exemptionRules = 'A client (customer) of this company; number 1-50 characters; expiresOn null = does not expire; attachmentId: a file ' +
  'of this company filed on the same client (attachable_type contact), else 400 VALIDATION_ERROR. Audit rows carry ids, never numbers.';
const exemptionList = z.object({ contactId: z.string().uuid().optional(), includeInactive: z.enum(['true', 'false']).optional() });

salesTaxRouter.get('/exemptions', describe({
  summary: 'List exemption certificates (tax-exemptions-v1)',
  description: `Response {data: [${exemptionShape}]} by expiry; contactId filters; active only unless includeInactive=true.`,
  query: exemptionList,
}), async (req, res) => {
  const q = exemptionList.parse(req.query);
  res.json(await exemptions.listExemptions(req.tenantId, req.companyId, { contactId: q.contactId, includeInactive: q.includeInactive === 'true' }));
});

salesTaxRouter.get('/exemptions/:id', describe({ summary: 'Get an exemption certificate', description: `Response ${exemptionShape}; 404 for another company's.`, params: idParams }),
  async (req, res) => { res.json(await exemptions.getExemption(req.tenantId, req.companyId, id(req))); });

salesTaxRouter.post('/exemptions', idempotent({ successStatus: 201, replay: async (req, e) => exemptions.getExemption(req.tenantId, req.companyId, e!.id) }),
  validate(exemptionCreate), describe({
    summary: 'Add an exemption certificate',
    description: `Response 201 ${exemptionShape}. ${exemptionRules} Idempotency-Key.`,
    body: exemptionCreate,
  }), async (req, res) => {
    res.status(201).json(await exemptions.createExemption(req.tenantId, req.companyId, req.body, req.userId));
  });

salesTaxRouter.put('/exemptions/:id', idempotent({ successStatus: 200, replay: async (req) => exemptions.getExemption(req.tenantId, req.companyId, id(req)) }),
  validate(exemptionUpdate), describe({
    summary: 'Edit an exemption certificate',
    description: `Response ${exemptionShape}. ${exemptionRules} 404; 409 STALE (expectedUpdatedAt differs). Idempotency-Key.`,
    body: exemptionUpdate, params: idParams,
  }), async (req, res) => {
    res.json(await exemptions.updateExemption(req.tenantId, req.companyId, id(req), req.body, req.userId));
  });

for (const [path, active] of [['deactivate', false], ['reactivate', true]] as const) {
  salesTaxRouter.post(`/exemptions/:id/${path}`, idempotent({ successStatus: 200, replay: async (req) => exemptions.getExemption(req.tenantId, req.companyId, id(req)) }), describe({
    summary: `${active ? 'Reactivate' : 'Deactivate'} an exemption certificate`,
    description: `Response ${exemptionShape}. 404. Idempotency-Key.`,
    params: idParams,
  }), async (req, res) => {
    res.json(await exemptions.setExemptionActive(req.tenantId, req.companyId, id(req), active, req.userId));
  });
}
// ── Reports (mounted under /api/v1/reports before the reports router) ─

/**
 * GET /reports/sales-tax-liability and /reports/sales-tax-payments, v2
 * (sales-tax-liability-v2). A `format` export (csv, pdf, …) falls through
 * to the reports router's v1 handlers.
 */
export const salesTaxReportsRouter = Router();
salesTaxReportsRouter.use(authenticate);
salesTaxReportsRouter.use(companyContext);
salesTaxReportsRouter.use(requireResource('reports'));

const liabilityQuery = z.object({
  start_date: isoDate.optional(), end_date: isoDate.optional(), basis: basisEnum.optional(), agency_id: z.string().uuid().optional(),
  format: z.string().optional(),
});
const itemColumns = '{taxItemId, name, rate (6 places), taxableSales, nonTaxable: [{codeId, code, amount}], collected, discounts, badDebts, recoveries, adjustments, paid, owedAtEnd}';
const totalsShape = '{taxableSales, collected, discounts, badDebts, recoveries, adjustments, paid, owedAtEnd}';

salesTaxReportsRouter.get('/sales-tax-liability', describe({
  summary: 'Sales tax liability by agency and tax item (sales-tax-liability-v2, cash-basis-spf-v1)',
  description: 'Response {title, startDate, endDate, totalSales, totalTax (v1 numbers, accrual document totals), basis, agencyId, ' +
    `agencies: [{agencyId|null, name, items: [${itemColumns}], totals: ${totalsShape}}], totals, total, unassigned, openingPaid, otherEntries, ` +
    'glMovement, roundingDifference, balanceCheck: {stpBalance, owedAtEnd, unassigned, otherEntriesCumulative, openingPaid, ' +
    'roundingDifferenceCumulative}}. New amounts are 2-place strings; roundingDifference 6 places. Query start_date, end_date (default this ' +
    'year to today), basis accrual|cash (default the company\'s sales tax basis), agency_id (another company\'s is 404; the GL fields are ' +
    'null when filtered). Columns are for the range, owedAtEnd cumulative to end_date. collected: accrual = sale rows by date; cash = the ' +
    'running-total share of each payment, credit applied or deposit drawn (cash + discount, never write-offs) on the dates the cash ' +
    'ledger uses, credit memo refunds, and sales receipts and daily sales on their date. discounts on both bases; badDebts and recoveries ' +
    'accrual only (0.00 on cash). total = collected + discounts + badDebts + recoveries. glMovement = the Sales Tax Payable movement on ' +
    'the basis = Σ columns + unassigned + otherEntries + roundingDifference (cash: exact shares - rounded shares). stpBalance = owedAtEnd + ' +
    'openingPaid + unassigned + otherEntriesCumulative + roundingDifferenceCumulative.',
  query: liabilityQuery,
}), async (req, res, next) => {
  const q = liabilityQuery.safeParse(req.query);
  if (!q.success) { res.status(400).json({ error: { message: q.error.issues[0]?.message ?? 'invalid query', code: 'VALIDATION_ERROR' } }); return; }
  if (q.data.format && q.data.format !== 'json') { next(); return; }
  const today = new Date().toISOString().split('T')[0]!;
  res.json(await report.buildSalesTaxLiabilityV2(req.tenantId, q.data.start_date ?? `${today.slice(0, 4)}-01-01`, q.data.end_date ?? today,
    req.companyId, { basis: q.data.basis ?? null, agencyId: q.data.agency_id ?? null }));
});

const paymentsQuery = z.object({ start_date: isoDate.optional(), end_date: isoDate.optional(), agency_id: z.string().uuid().optional(), format: z.string().optional() });
salesTaxReportsRouter.get('/sales-tax-payments', describe({
  summary: 'Sales tax payments (sales-tax-liability-v2)',
  description: 'Response {title, startDate, endDate, data: [{transactionId, date, txn_date, txnType, number, agencyId, agencyName, total, ' +
    'paid, adjustments, linked}]}: Pay Sales Tax payments and payments linked to an agency (linked = true), by date; amounts are 2-place ' +
    'strings. Query start_date, end_date, agency_id.',
  query: paymentsQuery,
}), async (req, res, next) => {
  const q = paymentsQuery.safeParse(req.query);
  if (!q.success) { res.status(400).json({ error: { message: q.error.issues[0]?.message ?? 'invalid query', code: 'VALIDATION_ERROR' } }); return; }
  if (q.data.format && q.data.format !== 'json') { next(); return; }
  const today = new Date().toISOString().split('T')[0]!;
  res.json(await report.buildSalesTaxPaymentsV2(req.tenantId, q.data.start_date ?? `${today.slice(0, 4)}-01-01`, q.data.end_date ?? today,
    req.companyId, q.data.agency_id ?? null));
});

const expiringQuery = z.object({ asOf: isoDate.optional(), within: z.coerce.number().int().min(0).max(3650).optional() });
salesTaxReportsRouter.get('/exemptions-expiring', describe({
  summary: 'Exemption certificates expired or expiring (tax-exemptions-v1)',
  description: 'Response {title, asOf, within, data: [{exemptionId, contactId, contactName, number, state, expiresOn, status: expired|expiring, ' +
    'daysLeft}]}: active certificates that expired by asOf or expire within `within` days (default 60) of it, by expiry; a client with a ' +
    'certificate that stays current past that is left out. asOf default today.',
  query: expiringQuery,
}), async (req, res) => {
  const q = expiringQuery.safeParse(req.query);
  if (!q.success) { res.status(400).json({ error: { message: q.error.issues[0]?.message ?? 'invalid query', code: 'VALIDATION_ERROR' } }); return; }
  res.json(await exemptions.exemptionsExpiring(req.tenantId, req.companyId, q.data.asOf ?? new Date().toISOString().split('T')[0]!, q.data.within ?? 60));
});