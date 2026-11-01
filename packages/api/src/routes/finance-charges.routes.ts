// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { closingPasswordLimiter } from '../middleware/closing-password-limiter.js';
import { lockContextMiddleware } from '../services/lock-context.js';
import { idempotent } from '../middleware/idempotent.js';
import * as fc from '../services/finance-charge.service.js';

/**
 * Finance charges (U-141; finance-charges-v1, idempotency-finance-charges-v1).
 * Under the Sales `invoices` resource: an assessment posts invoices.
 * Settings live on GET/PUT /company/settings (financeCharge*).
 */
export const financeChargesRouter = Router();
financeChargesRouter.use(authenticate);
financeChargesRouter.use(companyContext);
financeChargesRouter.use(requireResource('invoices'));

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date YYYY-MM-DD');
const wholeCents = z.string().regex(/^\d{1,15}(\.\d{1,2}0{0,2})?$/, 'an amount with at most 2 decimal places');
const formula = 'Formula (Q-P22g): period = the assessment date d\'s month; base = each open invoice\'s cent open as of d (finance-charge ' +
  'invoices only with financeChargeOnFinanceCharges); t = its latest live charged-through date; days = d - max(dueDate, t), <= 0 charges ' +
  'nothing; with no t the invoice is chargeable only when d - dueDate > graceDays; amount = round2(open x rate / 100 x days / 365) half up; ' +
  'client charge = Σ, raised to the minimum by one adjustment line when 0 < Σ < minimum. Clients in credit (skippedReason in_credit) or ' +
  'inactive are skipped; a client with open credits is unticked with hasOpenCredits (Q-P22s).';

const previewSchema = z.object({ assessmentDate: isoDate, contactIds: z.array(z.string().uuid()).max(5000).optional() });
financeChargesRouter.post('/preview', validate(previewSchema), describe({
  summary: 'Preview finance charges; posts nothing (finance-charges-v1)',
  description: 'Response {period, settings, rows: [{contactId, name, overdueBalance, charge, sources: [{invoiceId, number, dueDate, open, ' +
    'fromDate, days, amount}], minimumAdjustment?, alreadyAssessed?: {invoiceId, number}, skippedReason?, hasOpenCredits?, ticked}], ' +
    `totals: {count, charge} (ticked rows), problems: [{code: RATE_NOT_SET | INCOME_ACCOUNT_NOT_SET}]}. ${formula} 400 VALIDATION_ERROR only.`,
  body: previewSchema,
}), async (req, res) => {
  res.json(await fc.previewFinanceCharges(req.tenantId, req.companyId, req.body));
});

const assessSchema = z.object({
  assessmentDate: isoDate,
  contacts: z.array(z.object({ contactId: z.string().uuid(), expectedCharge: wholeCents })).min(1),
});
financeChargesRouter.post('/assess', closingPasswordLimiter, lockContextMiddleware, idempotent({
  successStatus: 201,
  replay: async (req, entity) => fc.runResult(req.tenantId, entity!.id, req.companyId),
}), validate(assessSchema), describe({
  summary: 'Assess finance charges (finance-charges-v1)',
  description: 'Response 201 {runId, period, invoices: [{contactId, invoiceId, number, total}]}. All or nothing in one database transaction: ' +
    'the clients\' invoices are locked, the charges recomputed and compared with expectedCharge exactly (409 FINANCE_CHARGE_CHANGED ' +
    '{contactId, charge}); one live assessment per client and month (409 FINANCE_CHARGE_ASSESSED {contactIds}); one finance-charge invoice ' +
    'per client with a charge (dated and due on the assessment date, numbered from the invoice counter, one line per source invoice plus ' +
    'the minimum adjustment, non-taxable, printLater from settings). 400 FINANCE_CHARGE_NOT_SET_UP (no rate or income account); 400 ' +
    'TOO_MANY_CONTACTS (over 500). The closing date meets the assessment date (423 / 403 / 429; closingPassword). Idempotency-Key: the ' +
    `run is the stored entity; a replay rebuilds the response. Voiding a finance-charge invoice frees its month and days. ${formula}`,
  body: assessSchema.extend({ closingPassword: z.string().optional(), overrideConfirmed: z.boolean().optional() }),
}), async (req, res) => {
  res.status(201).json(await fc.assessFinanceCharges(req.tenantId, req.companyId, req.body, req.userId));
});

financeChargesRouter.get('/', describe({
  summary: 'Finance-charge assessments (finance-charges-v1)',
  description: 'Response {data: [{assessmentId, runId, contactId, period, date, invoiceId, number, total, voided}]}, newest first; period=YYYY-MM filters.',
  query: z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }),
}), async (req, res) => {
  const p = typeof req.query['period'] === 'string' && /^\d{4}-\d{2}$/.test(req.query['period']) ? req.query['period'] : undefined;
  res.json(await fc.listAssessments(req.tenantId, req.companyId, p));
});
