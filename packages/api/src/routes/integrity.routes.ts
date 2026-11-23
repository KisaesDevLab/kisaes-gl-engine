// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Verify Data (U-12, integrity-v1), mounted at /api/v1/integrity, company-scoped.
 *
 *   POST /checks      {level: quick|full} -> 200 IntegrityRun (synchronous, one snapshot, 120 s budget per run;
 *                     503 INTEGRITY_TIMEOUT past it)
 *   POST /fixes       {runId, findingIds[], expectedLedgerVersion, backupArchiveId?}
 *                     -> 200 {fixed[], skipped[{id, reason}], ledgerVersion}; 409 INTEGRITY_STALE;
 *                     404 INTEGRITY_RUN_UNKNOWN. LAN: host only, under a maintenance hold.
 *   GET  /summary     {lastQuick, lastFull} (any member of the company)
 *   GET  /runs/:id    one stored run
 *
 * Checks, runs and fixes need the company's owner or admin (or a super
 * admin): 403 INTEGRITY_ADMIN_REQUIRED.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { AppError } from '../utils/errors.js';
import { requireMaintenanceInLan } from '../desktop/maintenance.js';
import { fix, getRun, runChecks, summary } from '../services/integrity.service.js';

export const integrityRouter = Router();
integrityRouter.use(authenticate);
integrityRouter.use(companyContext);

function requireIntegrityAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.isSuperAdmin || req.userRole === 'owner' || req.userRole === 'admin') {
    next();
    return;
  }
  throw AppError.forbidden('Only an owner or admin can check or fix the books.', 'INTEGRITY_ADMIN_REQUIRED');
}

function scope(req: Request): { tenantId: string; companyId: string } {
  if (!req.companyId) throw AppError.badRequest('Open a company first.', 'COMPANY_REQUIRED');
  return { tenantId: req.tenantId, companyId: req.companyId };
}

const amounts = z.object({ expectedExact: z.string(), actualExact: z.string(), differenceExact: z.string() });
const finding = z.object({
  id: z.string(),
  code: z.string(),
  severity: z.enum(['error', 'warning']),
  subject: z.object({ type: z.enum(['account', 'transaction', 'document_draft', 'item']), id: z.string().uuid(), label: z.string() }),
  amounts: amounts.optional(),
  fix: z.enum(['recompute_account_balance']).nullable(),
});
const runSchema = z.object({
  id: z.string().uuid(),
  level: z.enum(['quick', 'full']),
  companyId: z.string().uuid(),
  startedAt: z.string(),
  finishedAt: z.string(),
  ledgerVersion: z.string().describe('The company ledger version the checks saw (decimal string); send it back as expectedLedgerVersion.'),
  checks: z.array(z.object({ code: z.string(), status: z.enum(['ok', 'found', 'skipped']), found: z.number().int() })),
  findings: z.array(finding).describe('At most 500; checks[].found stays exact.'),
  truncated: z.boolean(),
});
const runSummary = z.object({
  id: z.string().uuid(), finishedAt: z.string(),
  counts: z.object({ error: z.number().int(), warning: z.number().int() }), fixable: z.number().int(),
}).nullable();

export const checksSchema = z.object({ level: z.enum(['quick', 'full']) });
export const fixesSchema = z.object({
  runId: z.string().uuid(),
  findingIds: z.array(z.string().min(1).max(128)).min(1).max(500),
  expectedLedgerVersion: z.string().regex(/^\d{1,20}$/),
  backupArchiveId: z.string().min(1).max(128).optional(),
});

integrityRouter.post('/checks', requireIntegrityAdmin, validate(checksSchema), describe({
  summary: 'Run the integrity checks of one level for the company and store the run (integrity-v1)',
  tags: ['integrity'],
  response: runSchema,
}), async (req, res) => {
  const body = req.body as z.infer<typeof checksSchema>;
  res.json(await runChecks(scope(req), body.level, req.userId ?? null));
});

integrityRouter.post('/fixes', requireMaintenanceInLan(), requireIntegrityAdmin, validate(fixesSchema), describe({
  summary: 'Fix findings of a stored run (recompute cached account balances); 409 INTEGRITY_STALE when the books moved',
  tags: ['integrity'],
  response: z.object({
    fixed: z.array(z.string()),
    skipped: z.array(z.object({ id: z.string(), reason: z.enum(['NO_LONGER_FOUND', 'NOT_FIXABLE']) })),
    ledgerVersion: z.string(),
  }),
}), async (req, res) => {
  const body = req.body as z.infer<typeof fixesSchema>;
  res.json(await fix(scope(req), body, req.userId ?? null));
});

integrityRouter.get('/summary', describe({
  summary: 'The newest quick and full integrity runs of the company (any member)',
  tags: ['integrity'],
  response: z.object({ lastQuick: runSummary, lastFull: runSummary }),
}), async (req, res) => {
  res.json(await summary(scope(req)));
});

integrityRouter.get('/runs/:id', requireIntegrityAdmin, describe({
  summary: 'One stored integrity run of the company',
  tags: ['integrity'],
  params: z.object({ id: z.string().uuid() }),
  response: runSchema,
}), async (req, res) => {
  const id = req.params['id']!;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(404, 'That check is no longer stored; run it again.', 'INTEGRITY_RUN_UNKNOWN');
  res.json(await getRun(scope(req), id));
});
