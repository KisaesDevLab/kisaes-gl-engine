// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// POST /api/v1/reports/ask — ask a question about the books (U-206,
// reports-ask-v1; ClientLedger P28 PR-G). The AI picks a catalog report and
// its options; the engine never returns a figure here. See
// services/report-ask.service.ts for the rules.
//
// Mounted at /api/v1/reports ahead of the reports router. Needs report
// access ('reports' read). Not keyed (no Idempotency-Key): it changes no
// books, and a retry asks again.

import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { expensiveOpLimiter } from '../middleware/expensive-op-limiter.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import * as reportAsk from '../services/report-ask.service.js';

export const reportAskRouter = Router();

const tokenSchema = z.string().regex(reportAsk.ASK_TOKEN_RE);
const L = reportAsk.ASK_LIMITS;

export const askRequestSchema = z.object({
  question: z.string().trim().min(1).max(L.questionChars),
  reports: z.array(z.object({
    key: tokenSchema.describe('the catalog report key, /^[a-z0-9_]{1,64}$/'),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(300).optional(),
    params: z.array(z.enum(reportAsk.ASK_PARAMS)).max(reportAsk.ASK_PARAMS.length).default([])
      .describe('the options the report takes: range (from/to), as_of, basis, accounts, contacts, tags'),
    columns: z.array(tokenSchema).max(L.choices).optional().describe('the column choices the report offers'),
    extras: z.array(tokenSchema).max(L.choices).optional().describe('the extras the report offers (e.g. pct_of_income, ytd)'),
  }).strict()).min(1).max(L.reports)
    .refine((rs) => new Set(rs.map((r) => r.key)).size === rs.length, 'report keys must be unique'),
  datePresets: z.array(tokenSchema).max(L.presets).default([]).describe('the client\'s date preset keys; the client resolves them (fiscal, 4-4-5)'),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('the client\'s local date for relative questions; default the server\'s UTC date'),
}).strict();

const RESPONSE_DOC = '`{reportKey, dates: {preset} | {from, to} | {asOf} | null, basis: accrual | cash | null, columns: <choice> | null, extras[], filters: {accountIds[], contactIds[], tagIds[]}, unresolved: [{kind: account | contact | tag, text}], reader: self_hosted | cloud, provider, model}`';

reportAskRouter.post('/ask',
  authenticate, companyContext, requirePermission('reports', 'read'), expensiveOpLimiter,
  describe({
    summary: 'Ask a question: map it to a catalog report (reports-ask-v1)',
    description: 'The company\'s AI provider maps a plain-language question to ONE report of the catalog the client sends, with its options; ' +
      'the client then runs the report and the engine computes every figure. The model sees the question, the catalog, today\'s date and ' +
      'names from the books (active accounts, active tags, contacts the question names); never an amount. ' +
      `Response ${RESPONSE_DOC}: only tokens the client sent, ISO dates, and ids the engine resolved from names (the model never gives an id). ` +
      'An unresolved name is returned only when it is text from the question with no digit. There is no amount filter. ' +
      'Errors: 403 AI_CONSENT_REQUIRED {reason, task: report_summary} (AI off, the company not opted in, a stale disclosure, or the ' +
      'report_summary task off; no provider call); 422 ASK_UNMAPPED {field, reason} (no report fits, a key, preset, column or extra that ' +
      'was not sent, a bad date, an option the report does not take, an amount filter, a number or an id, an invented name, a reply that ' +
      'is not JSON); 503 AI_UNAVAILABLE {provider, reason: no_provider | function_disabled | offline | provider_error}.',
  }),
  validate(askRequestSchema),
  async (req, res) => {
    const body = askRequestSchema.parse(req.body);
    res.json(await reportAsk.ask(req.tenantId, req.companyId, body));
  });
