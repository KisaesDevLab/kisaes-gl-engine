// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router, type Request, type Response, type NextFunction } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { can } from '@kis-books/shared';
import { createAccountSchema, updateAccountSchema, accountFiltersSchema, mergeAccountsSchema, bulkUpdateAccountsSchema, importAccountsSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource, resolvePermissionsForRequest } from '../middleware/permission.js';
import { db } from '../db/index.js';
import { firms, firmUsers, tenantFirmAssignments } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import * as accountsService from '../services/accounts.service.js';
import * as registerService from '../services/register.service.js';
import { parseLimit, parseOffset } from '../utils/pagination.js';

export const accountsRouter = Router();
accountsRouter.use(authenticate);

// Creating an account (the "+ Add" in every account dropdown) is open to
// the firm that keeps these books, whatever the member's role — firm staff
// set up categories on the fly while entering work. Everyone else needs
// the Chart of Accounts write permission, as for every other mutation.
async function canCreateAccount(req: Request, _res: Response, next: NextFunction) {
  if (req.isSuperAdmin) return next();
  if (can(await resolvePermissionsForRequest(req), 'accounts', 'update')) return next();
  const [member] = await db
    .select({ id: firmUsers.id })
    .from(firmUsers)
    .innerJoin(firms, eq(firms.id, firmUsers.firmId))
    .innerJoin(tenantFirmAssignments, eq(tenantFirmAssignments.firmId, firmUsers.firmId))
    .where(and(
      eq(firmUsers.userId, req.userId),
      eq(firmUsers.isActive, true),
      eq(firms.isActive, true),
      eq(tenantFirmAssignments.tenantId, req.tenantId),
      eq(tenantFirmAssignments.isActive, true),
    ))
    .limit(1);
  if (member) return next();
  throw AppError.forbidden('You do not have permission for this feature', 'PERMISSION_DENIED');
}

// Registered before the router-wide guard so a firm member without the
// accounts permission still reaches the create handler.
accountsRouter.post('/', canCreateAccount, validate(createAccountSchema), async (req, res) => {
  const account = await accountsService.create(req.tenantId, req.body, req.userId);
  res.status(201).json({ account });
});

accountsRouter.use(requireResource('accounts'));

accountsRouter.get('/', async (req, res) => {
  const filters = accountFiltersSchema.parse(req.query);
  const result = await accountsService.list(req.tenantId, filters);
  res.json(result);
});

accountsRouter.get('/export', async (req, res) => {
  const csv = await accountsService.exportToCsv(req.tenantId);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="chart-of-accounts.csv"');
  res.send(csv);
});

accountsRouter.post('/import', validate(importAccountsSchema), async (req, res) => {
  const result = await accountsService.importFromCsv(req.tenantId, req.body, req.userId);
  res.status(201).json(result);
});

accountsRouter.post('/merge', validate(mergeAccountsSchema), async (req, res) => {
  const result = await accountsService.merge(req.tenantId, req.body.sourceId, req.body.targetId, req.userId);
  res.json({ account: result });
});

// Bulk inline edit (COA Bulk Edit table). Registered before the
// parameterized routes below so "bulk" is never captured as an :id.
accountsRouter.put('/bulk', validate(bulkUpdateAccountsSchema), async (req, res) => {
  const updated = await accountsService.bulkUpdate(req.tenantId, req.body, req.userId);
  res.json({ updated: updated.length, accounts: updated });
});

accountsRouter.get('/:id', async (req, res) => {
  const account = await accountsService.getById(req.tenantId, req.params['id']!);
  res.json({ account });
});

accountsRouter.put('/:id', validate(updateAccountSchema), async (req, res) => {
  const account = await accountsService.update(req.tenantId, req.params['id']!, req.body, req.userId);
  res.json({ account });
});

accountsRouter.delete('/:id', async (req, res) => {
  const account = await accountsService.deactivate(req.tenantId, req.params['id']!, req.userId);
  res.json({ account });
});

accountsRouter.get('/:id/ledger', async (req, res) => {
  const result = await accountsService.getAccountLedger(req.tenantId, req.params['id']!, {
    limit: parseLimit(req.query['limit']),
    offset: parseOffset(req.query['offset']),
  });
  res.json(result);
});

// Money filter values stay as strings end-to-end so we never lose
// precision through a JS-number round-trip against the decimal(19,4)
// column. The pattern below tolerates `123`, `123.45`, `123.4567`,
// and rejects anything else (incl. exponent / signs / NaN tricks).
const MONEY_FILTER_RE = /^\d+(\.\d{1,4})?$/;
function safeMoneyFilter(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  return MONEY_FILTER_RE.test(raw) ? raw : undefined;
}

// `?exact=1` / `?exact=true` (capability register-exact-v1): money as
// decimal strings. Anything else keeps the historical JSON numbers.
function exactRequested(raw: unknown): boolean {
  return raw === '1' || raw === 'true';
}

// OpenAPI documentation for the register routes (U-04 describe()).
const registerMoney = z.union([z.number(), z.string()])
  .describe('JSON number by default; a decimal string with four decimals when exact=1');
const registerQuery = z.object({
  start_date: z.string().optional().describe('YYYY-MM-DD; default 90 days before today (server UTC)'),
  end_date: z.string().optional().describe('YYYY-MM-DD; default today (server UTC)'),
  txn_type: z.string().optional(),
  payee: z.string().optional(),
  search: z.string().optional(),
  reconciled: z.enum(['all', 'cleared', 'reconciled', 'uncleared']).optional(),
  min_amount: z.string().optional(),
  max_amount: z.string().optional(),
  include_void: z.enum(['true', 'false']).optional(),
  sort_by: z.enum(['date', 'amount', 'type', 'ref_no']).optional(),
  sort_dir: z.enum(['asc', 'desc']).optional(),
  page: z.string().optional(),
  per_page: z.string().optional().describe('at most 200'),
  exact: z.enum(['1', 'true']).optional().describe('money as decimal strings (register-exact-v1)'),
});
const registerResponse = z.object({
  account: z.object({
    id: z.string(), name: z.string(), accountType: z.string(),
    detailType: z.string().nullable(), accountNumber: z.string().nullable(),
  }),
  balanceForward: registerMoney.describe('balance before start_date (posted only, unfiltered)'),
  endingBalance: registerMoney.describe('balance at end_date (posted only, unfiltered)'),
  filtersApplied: z.record(z.unknown()),
  pagination: z.object({ page: z.number(), perPage: z.number(), totalRows: z.number(), totalPages: z.number() }),
  allowedEntryTypes: z.array(z.string()),
  lines: z.array(z.object({
    lineId: z.string(), transactionId: z.string(), txnType: z.string(),
    txnNumber: z.string().nullable(), checkNumber: z.number().nullable(), txnDate: z.string(),
    payeeName: z.string().nullable(), contactId: z.string().nullable(),
    accountName: z.string().nullable(), accountId: z.string().nullable(),
    categoryName: z.string().nullable(), categoryAccountId: z.string().nullable(),
    memo: z.string().nullable(),
    payment: registerMoney.nullable(), deposit: registerMoney.nullable(),
    runningBalance: registerMoney.describe('account balance after this line, independent of filters'),
    reconciliationStatus: z.enum(['cleared', 'reconciled', 'uncleared']),
    hasAttachments: z.boolean(), hasSplits: z.boolean(), isEditable: z.boolean(), status: z.string(),
  })),
});

accountsRouter.get('/:id/register', describe({
  summary: 'Account register',
  query: registerQuery,
  response: registerResponse,
}), async (req, res) => {
  const q = req.query as Record<string, string>;
  // Narrow query-string casts to specific union types so the service
  // gets a typed value instead of an `any`. Invalid strings collapse to
  // undefined (the service treats undefined as "no filter"). The literal
  // sets here must match the registerService.getRegister signature.
  const reconciledOptions = ['all', 'cleared', 'reconciled', 'uncleared'] as const;
  type ReconciledFilter = (typeof reconciledOptions)[number];
  const reconciled: ReconciledFilter | undefined =
    (reconciledOptions as readonly string[]).includes(q['reconciled'] ?? '')
      ? (q['reconciled'] as ReconciledFilter)
      : undefined;
  const sortByOptions = ['type', 'date', 'amount', 'ref_no'] as const;
  type SortBy = (typeof sortByOptions)[number];
  const sortBy: SortBy | undefined = (sortByOptions as readonly string[]).includes(q['sort_by'] ?? '')
    ? (q['sort_by'] as SortBy)
    : undefined;
  const sortDir: 'asc' | 'desc' | undefined =
    q['sort_dir'] === 'asc' || q['sort_dir'] === 'desc' ? q['sort_dir'] : undefined;
  const result = await registerService.getRegister(req.tenantId, req.params['id']!, {
    startDate: q['start_date'],
    endDate: q['end_date'],
    txnType: q['txn_type'],
    payee: q['payee'],
    search: q['search'],
    reconciled,
    minAmount: safeMoneyFilter(q['min_amount']),
    maxAmount: safeMoneyFilter(q['max_amount']),
    includeVoid: q['include_void'] === 'true',
    sortBy,
    sortDir,
    page: q['page'] ? parseInt(q['page']) : undefined,
    perPage: q['per_page'] ? parseInt(q['per_page']) : undefined,
    exact: exactRequested(q['exact']),
  });
  res.json(result);
});

accountsRouter.get('/:id/register/summary', describe({
  summary: 'Account register summary',
  query: z.object({
    exact: z.enum(['1', 'true']).optional().describe('money as decimal strings (register-exact-v1)'),
  }),
  response: z.object({
    currentBalance: registerMoney.describe('the stored account balance'),
    unclearedCount: z.number(),
    lastReconciliationDate: z.string().nullable(),
    transactionsThisPeriod: z.number(),
  }),
}), async (req, res) => {
  const q = req.query as Record<string, string>;
  const result = await registerService.getRegisterSummary(req.tenantId, req.params['id']!, {
    exact: exactRequested(q['exact']),
  });
  res.json(result);
});
