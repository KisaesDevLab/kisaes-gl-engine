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