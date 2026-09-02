// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import multer from 'multer';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  createFirmTaxCodeSchema, updateFirmTaxCodeSchema,
  upsertTaxProfileSchema, createActivityUnitSchema, updateActivityUnitSchema, mapTagSchema,
  createAjeSchema, createTaxEntrySchema,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { requireResource } from '../middleware/permission.js';
import { validate } from '../middleware/validate.js';
import { expensiveOpLimiter } from '../middleware/expensive-op-limiter.js';
import * as featureFlags from '../services/feature-flags.service.js';
import { AppError } from '../utils/errors.js';
import { verifyAttachmentContent } from './attachments.routes.js';
import * as firmCodesService from '../services/tb/firm-tax-codes.service.js';
import * as taxProfileService from '../services/tb/tax-profile.service.js';
import * as seedService from '../services/tb/tax-code-seed.service.js';
import * as unitsService from '../services/tb/activity-units.service.js';
import * as balanceEngine from '../services/tb/balance-engine.service.js';
import * as ajeService from '../services/tb/aje.service.js';
import * as attachmentService from '../services/attachment.service.js';
import * as assignmentsService from '../services/tb/assignments.service.js';
import * as diagnosticsService from '../services/tb/diagnostics.service.js';
import * as signoffsService from '../services/tb/signoffs.service.js';
import * as aiTaxAssign from '../services/tb/ai-tax-assign.service.js';
import * as groupingsService from '../services/tb/groupings.service.js';
import * as taxEntriesService from '../services/tb/tax-entries.service.js';
import * as m1Service from '../services/tb/m1.service.js';
import * as exportsService from '../services/tb/exports.service.js';
import * as rowAttachmentsService from '../services/tb/row-attachments.service.js';
import { db } from '../db/index.js';
import { companies, companyTaxProfiles, tbStatus } from '../db/schema/index.js';
import { and, eq, sql } from 'drizzle-orm';
import { auditLog as auditLogFn } from '../middleware/audit.js';

// Trial Balance module router (docs/tb/BUILD_PLAN.md). Firm-side only:
// client-type users get a 404 (surface hidden, same pattern as
// portal-reports.routes.ts), portal contacts never reach /api/v1 at all.
// Company scope = the plan's "entity" (CLAUDE.md rule TB2).
export const tbRouter = Router();
tbRouter.use(authenticate);
tbRouter.use((req, _res, next) => {
  if (req.userType === 'client') {
    next(AppError.notFound('Feature not available'));
    return;
  }
  next();
});
// Server-side flag gate (not just hidden nav): with TRIAL_BALANCE_V1
// off, the whole module API is absent — including AJE posting, which
// is closing-date-exempt and must not be reachable early.
tbRouter.use(async (req, _res, next) => {
  try {
    if (!(await featureFlags.isEnabled(req.tenantId, 'TRIAL_BALANCE_V1'))) {
      next(AppError.notFound('Feature not available'));
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
});
tbRouter.use(companyContext);
tbRouter.use(requireResource('trial_balance'));
// expensiveOpLimiter is applied PER-ROUTE to the heavy computes below —
// router-wide it throttled ordinary page loads (a workpaper screen
// fires ~8 cheap reads alongside the one expensive compute).

// Firm-admin gate (plan 13.1): closing date, seed pinning, and custom
// codes are owner-level acts. Bookkeeper/accountant staff do TB work but
// don't reshape the firm's code library.
function requireFirmAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.isSuperAdmin || req.userRole === 'owner') {
    next();
    return;
  }
  next(AppError.forbidden('Firm administrator access required', 'TB_FIRM_ADMIN_REQUIRED'));
}

// ── Firm custom tax codes (Phase 2.4, rule TB8) ────────────────────

tbRouter.get('/firm-codes', async (req, res) => {
  const includeInactive = req.query['includeInactive'] === 'true';
  const result = await firmCodesService.listFirmCodes(req.tenantId, includeInactive);
  res.json(result);
});

tbRouter.post('/firm-codes', requireFirmAdmin, validate(createFirmTaxCodeSchema), async (req, res) => {
  const code = await firmCodesService.createFirmCode(req.tenantId, req.body, req.userId);
  res.status(201).json({ code });
});

tbRouter.put('/firm-codes/:id', requireFirmAdmin, validate(updateFirmTaxCodeSchema), async (req, res) => {
  const code = await firmCodesService.updateFirmCode(req.tenantId, String(req.params['id']), req.body, req.userId);
  res.json({ code });
});

tbRouter.delete('/firm-codes/:id', requireFirmAdmin, async (req, res) => {
  const code = await firmCodesService.deactivateFirmCode(req.tenantId, String(req.params['id']), req.userId);
  res.json({ code });
});

// Staff-readable seed-version list (the profile screen's pinning
// selector). Import/browse stay super-admin on /admin/tb.
tbRouter.get('/seed-versions', async (_req, res) => {
  const versions = await seedService.listVersions();
  res.json({ versions });
});

// ── AJEs (Phase 5, D10/D17, rule TB3) ──────────────────────────────
// Firm-only by router construction; independent of the closing date
// (ledger exempts txn_type 'aje').

tbRouter.get('/ajes', async (req, res) => {
  const limit = Math.min(Number(req.query['limit']) || 50, 500);
  const offset = Number(req.query['offset']) || 0;
  const result = await ajeService.listAjes(req.tenantId, req.companyId!, {
    fiscalYear: req.query['fiscalYear'] ? Number(req.query['fiscalYear']) : undefined,
    includeVoid: req.query['includeVoid'] === 'true',
    limit,
    offset,
  });
  res.json({ ...result, limit, offset });
});

tbRouter.post('/ajes', validate(createAjeSchema), async (req, res) => {
  const aje = await ajeService.createAje(req.tenantId, req.companyId!, req.body, req.userId);
  if (req.body.draftAttachmentId) {
    await attachmentService.reassignDraftAttachments(req.tenantId, req.body.draftAttachmentId, 'journal_entry', aje.id);
  }
  res.status(201).json({ aje });
});

tbRouter.put('/ajes/:id', validate(createAjeSchema), async (req, res) => {
  const aje = await ajeService.updateAje(req.tenantId, req.companyId!, String(req.params['id']), req.body, req.userId);
  res.json({ aje });
});

tbRouter.post('/ajes/:id/void', async (req, res) => {
  const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim() : null;
  if (!reason) throw AppError.badRequest('Void reason is required');
  const aje = await ajeService.voidAje(req.tenantId, req.companyId!, String(req.params['id']), reason, req.userId);
  res.json({ aje });
});

tbRouter.post('/ajes/:id/reverse', async (req, res) => {
  const aje = await ajeService.reverseAje(req.tenantId, req.companyId!, String(req.params['id']), req.userId);
  res.status(201).json({ aje });
});

tbRouter.post('/ajes/:id/duplicate', async (req, res) => {
  const aje = await ajeService.duplicateAje(req.tenantId, req.companyId!, String(req.params['id']), req.userId);
  res.status(201).json({ aje });
});

// ── Balance engine (Phase 4, ADR-TB-01) ────────────────────────────

const workpaperQuerySchema = z.object({
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  basis: z.enum(['accrual', 'cash']).default('accrual'),
  taxYear: z.coerce.number().int().min(2000).max(2100).optional(),
  // TB-by-tag view (rule TB7 transaction-level semantics).
  tagId: z.string().uuid().optional(),
});

tbRouter.get('/workpaper', expensiveOpLimiter, async (req, res) => {
  const q = workpaperQuerySchema.parse(req.query);
  const workpaper = await balanceEngine.computeWorkpaper(req.tenantId, req.companyId!, {
    periodEnd: q.periodEnd,
    basis: q.basis,
    taxYear: q.taxYear,
    tagId: q.tagId ?? null,
  });
  res.json({ workpaper });
});

tbRouter.get('/assignments', async (req, res) => {
  const assignments = await balanceEngine.listAssignments(req.tenantId, req.companyId!);
  res.json({ assignments });
});

// Cheap change probe (ADR-TB-06 fallback poll + staleness banners).
tbRouter.get('/version', async (req, res) => {
  const glVersionStamp = await balanceEngine.getGlVersionStamp(req.tenantId, req.companyId!);
  res.json({ glVersionStamp });
});

// ── Assignments & available codes (Phase 6.2 / 6C.1) ───────────────

// THE filtered code surface (ADR-TB-02). Pickers and the AI assignment
// service consume this — never the raw seed table.
tbRouter.get('/tax-codes/available', async (req, res) => {
  const result = await assignmentsService.listAvailableCodes(req.tenantId, req.companyId!);
  res.json(result);
});

const setAssignmentSchema = z.object({
  accountId: z.string().uuid(),
  activityUnitId: z.string().uuid().nullable().optional(),
  seedCode: z.string().max(50).nullable().optional(),
  seedActivityType: z.string().max(20).nullable().optional(),
  firmCodeId: z.string().uuid().nullable().optional(),
  activityUnitType: z.string().max(20).optional(),
  effectiveTaxYear: z.coerce.number().int().optional(),
  // 'ai' when the user ACCEPTS an AI suggestion (6C.4) — acceptance is
  // always an explicit user act; the server never auto-commits.
  source: z.enum(['manual', 'ai']).optional().default('manual'),
  aiConfidence: z.coerce.number().int().min(0).max(100).nullable().optional(),
});

tbRouter.put('/assignments', validate(setAssignmentSchema), async (req, res) => {
  const assignment = await assignmentsService.setAssignment(req.tenantId, req.companyId!, req.body, req.userId);
  res.json({ assignment });
});

tbRouter.delete('/assignments/:accountId', async (req, res) => {
  const unitId = typeof req.query['activityUnitId'] === 'string' ? req.query['activityUnitId'] : null;
  await assignmentsService.clearAssignment(req.tenantId, req.companyId!, String(req.params['accountId']), unitId, req.userId);
  res.status(204).end();
});

tbRouter.post('/assignments/bulk', validate(z.object({ assignments: z.array(setAssignmentSchema).max(500) })), async (req, res) => {
  const results = await assignmentsService.bulkAssign(
    req.tenantId, req.companyId!,
    (req.body.assignments as assignmentsService.SetAssignmentInput[]).map((a) => ({ ...a, source: 'manual' as const })),
    req.userId,
  );
  res.json({ results });
});

// ── AI assignment + diagnostics (Phase 6C — advisory) ──────────────

// Batched: each call analyzes a capped slice of the unassigned
// accounts and reports `remaining`; the panel loops, passing the
// already-analyzed ids back via excludeAccountIds.
const aiSuggestSchema = z.object({
  excludeAccountIds: z.array(z.string().uuid()).max(20000).optional(),
});

tbRouter.post('/ai/suggest-assignments', expensiveOpLimiter, async (req, res) => {
  const q = workpaperQuerySchema.parse(req.body);
  const extra = aiSuggestSchema.parse({ excludeAccountIds: (req.body as Record<string, unknown>)['excludeAccountIds'] });
  const result = await aiTaxAssign.suggestAssignments(req.tenantId, req.companyId!, {
    periodEnd: q.periodEnd, basis: q.basis, excludeAccountIds: extra.excludeAccountIds,
  });
  res.json(result);
});

tbRouter.post('/ai/diagnostics', expensiveOpLimiter, async (req, res) => {
  const q = workpaperQuerySchema.parse(req.body);
  const result = await aiTaxAssign.aiDiagnostics(req.tenantId, req.companyId!, {
    periodEnd: q.periodEnd, basis: q.basis,
  });
  res.json(result);
});

// ── Diagnostics (Phase 6.4 — authoritative for export gating) ──────

tbRouter.get('/diagnostics', expensiveOpLimiter, async (req, res) => {
  const q = workpaperQuerySchema.parse(req.query);
  const result = await diagnosticsService.runDiagnostics(req.tenantId, req.companyId!, {
    periodEnd: q.periodEnd, basis: q.basis, taxYear: q.taxYear,
  });
  res.json(result);
});

// ── Workflow status (Phase 6.6; 'complete' gate hardens in 7.8) ────

tbRouter.get('/status', async (req, res) => {
  const taxYear = Number(req.query['taxYear']) || new Date().getUTCFullYear();
  const [status] = await db.select().from(tbStatus)
    .where(and(eq(tbStatus.tenantId, req.tenantId), eq(tbStatus.companyId, req.companyId!), eq(tbStatus.taxYear, taxYear)))
    .limit(1);
  res.json({ status: status ?? { workflowState: 'open', taxYear } });
});

const statusSchema = z.object({
  taxYear: z.coerce.number().int().min(2000).max(2100),
  workflowState: z.enum(['open', 'in_review', 'complete']),
  // Firm-admin gate override (7.8) — must be IN the schema or
  // validate() strips it before the handler can read it.
  overrideConfirmed: z.boolean().optional(),
});

tbRouter.put('/status', validate(statusSchema), async (req, res) => {
  const { taxYear, workflowState, overrideConfirmed } = req.body as { taxYear: number; workflowState: 'open' | 'in_review' | 'complete'; overrideConfirmed?: boolean };
  if (workflowState === 'complete') {
    // 7.8: completion requires reviewer sign-off on every grouping;
    // only a FIRM ADMIN may override, and the override is audited.
    const gate = await signoffsService.checkCompletionGate(req.tenantId, req.companyId!, taxYear);
    const isFirmAdmin = req.isSuperAdmin || req.userRole === 'owner';
    if (!gate.ok) {
      if (!(overrideConfirmed && isFirmAdmin)) {
        throw AppError.unprocessableEntity(gate.reason ?? 'Reviewer sign-offs incomplete', 'TB_STATUS_GATE', { missing: gate.missing, canOverride: isFirmAdmin });
      }
      await auditLogFn(req.tenantId, 'override', 'tb_status_gate_override', req.companyId!,
        { missing: gate.missing }, { taxYear, workflowState }, req.userId);
    }
  }
  // Atomic upsert on (company, taxYear) — the select-then-insert form
  // raced to a unique-violation 500.
  const upsert = await db.execute(sql`
    INSERT INTO tb_status (tenant_id, company_id, tax_year, workflow_state, completed_by, completed_at, updated_at)
    VALUES (${req.tenantId}, ${req.companyId}, ${taxYear}, ${workflowState},
      ${workflowState === 'complete' ? req.userId ?? null : null},
      ${workflowState === 'complete' ? new Date() : null}, now())
    ON CONFLICT (company_id, tax_year)
    DO UPDATE SET workflow_state = EXCLUDED.workflow_state,
      completed_by = EXCLUDED.completed_by,
      completed_at = EXCLUDED.completed_at,
      updated_at = now()
    RETURNING *
  `);
  res.json({ status: upsert.rows[0] });
});

// ── Live change stream (Phase 6B.4, ADR-TB-06) ─────────────────────
// SSE emitting glVersionStamp bumps. Poll-based over the stamp table
// (1.5s — the stamp read is a two-row indexed lookup), mirroring the
// ai.routes SSE conventions: no-transform disables compression
// buffering, heartbeats keep proxies open, 30-min ceiling.

tbRouter.get('/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(': connected\n\n');

  const tenantId = req.tenantId;
  const companyId = req.companyId!;
  let last = await balanceEngine.getGlVersionStamp(tenantId, companyId);
  res.write(`event: stamp\ndata: ${JSON.stringify({ glVersionStamp: last })}\n\n`);

  let closed = false;
  const started = Date.now();
  const MAX_MS = 30 * 60 * 1000;
  const poll = setInterval(async () => {
    if (closed) return;
    try {
      const current = await balanceEngine.getGlVersionStamp(tenantId, companyId);
      if (closed) return;
      if (current !== last) {
        last = current;
        res.write(`event: stamp\ndata: ${JSON.stringify({ glVersionStamp: current })}\n\n`);
      }
      if (Date.now() - started > MAX_MS) {
        res.write('event: close\ndata: {}\n\n');
        cleanup();
        res.end();
      }
    } catch {
      // Transient DB hiccup — keep the stream; the next tick retries.
    }
  }, 1500);
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': hb\n\n');
  }, 15000);
  const cleanup = () => {
    closed = true;
    clearInterval(poll);
    clearInterval(heartbeat);
  };
  req.on('close', cleanup);
});

// ── Vendor exports (Phase 11) ──────────────────────────────────────

const exportQuerySchema = z.object({
  taxYear: z.coerce.number().int().min(2000).max(2100),
  basis: z.enum(['accrual', 'cash']).default('accrual'),
  software: z.enum(['ultratax', 'lacerte', 'cch', 'gosystem', 'generic', 'workingtb']),
  // Working TB only — the workpaper screen's Download passes its
  // period end, tag filter, activity view ('' | 'tags' | unit id)
  // and toolbar filters so the workbook matches the screen.
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  tagId: z.string().uuid().optional(),
  view: z.object({
    activityView: z.union([z.literal(''), z.literal('tags'), z.string().uuid()]).optional(),
    accountType: z.string().max(40).optional(),
    search: z.string().max(200).optional(),
    nonZeroOnly: z.boolean().optional(),
  }).optional(),
});

tbRouter.get('/exports/validate', expensiveOpLimiter, async (req, res) => {
  const q = exportQuerySchema.parse(req.query);
  const { validation, dataset } = await exportsService.validateForExport(req.tenantId, req.companyId!, q);
  // The consolidation panel needs the line detail: key, amounts,
  // member accounts, and current consolidation state.
  res.json({
    validation,
    lineCount: dataset.lines.length,
    glVersionStamp: dataset.glVersionStamp,
    lines: dataset.lines.map((l) => ({
      key: l.key,
      code: l.code,
      description: l.description,
      accountCount: l.accounts.length,
      bookAmount: l.bookAmount,
      taxAmount: l.amount,
      consolidated: l.consolidated,
      accounts: l.accounts.map((a) => ({ accountNumber: a.accountNumber, name: a.name, amount: a.amount })),
    })),
  });
});

// ── Consolidation options (Vibe TB parity) ─────────────────────────
// Per-entity: { [datasetLineKey]: { exportCode, description } }. A
// consolidated code exports as ONE line under the custom export code.

const consolidationPrefsSchema = z.object({
  prefs: z.record(
    z.string().max(160),
    z.object({
      exportCode: z.string().min(1).max(50),
      description: z.string().max(200).default(''),
    }),
  ).refine((r) => Object.keys(r).length <= 500, 'Too many consolidation entries'),
});

tbRouter.get('/exports/consolidation', async (req, res) => {
  const [profile] = await db.select({ prefs: companyTaxProfiles.consolidationPrefs }).from(companyTaxProfiles)
    .where(and(eq(companyTaxProfiles.tenantId, req.tenantId), eq(companyTaxProfiles.companyId, req.companyId!)))
    .limit(1);
  res.json({ prefs: profile?.prefs ?? {} });
});

tbRouter.put('/exports/consolidation', validate(consolidationPrefsSchema), async (req, res) => {
  const [before] = await db.select().from(companyTaxProfiles)
    .where(and(eq(companyTaxProfiles.tenantId, req.tenantId), eq(companyTaxProfiles.companyId, req.companyId!)))
    .limit(1);
  if (!before) throw AppError.unprocessableEntity('Set the company tax profile (return form) first', 'TB_NOT_ASSIGNABLE');
  const [row] = await db.update(companyTaxProfiles)
    .set({ consolidationPrefs: req.body.prefs, updatedAt: new Date() })
    .where(eq(companyTaxProfiles.id, before.id)).returning();
  await auditLogFn(req.tenantId, 'update', 'tb_consolidation_prefs', before.id,
    { prefs: before.consolidationPrefs }, { prefs: row!.consolidationPrefs }, req.userId);
  res.json({ prefs: row!.consolidationPrefs });
});

tbRouter.post('/exports', expensiveOpLimiter, validate(exportQuerySchema.extend({ overrideConfirmed: z.boolean().optional() })), async (req, res) => {
  const record = await exportsService.generateExport(req.tenantId, req.companyId!, {
    ...req.body,
    isFirmAdmin: req.isSuperAdmin || req.userRole === 'owner',
  }, req.userId);
  res.status(201).json({ export: record });
});

tbRouter.get('/exports', async (req, res) => {
  const taxYear = req.query['taxYear'] ? Number(req.query['taxYear']) : undefined;
  const exports = await exportsService.listExports(req.tenantId, req.companyId!, taxYear);
  const glVersionStamp = await balanceEngine.getGlVersionStamp(req.tenantId, req.companyId!);
  res.json({ exports, glVersionStamp });
});

tbRouter.get('/exports/:id/download', async (req, res) => {
  const { record, buffer } = await exportsService.downloadExport(req.tenantId, req.companyId!, String(req.params['id']));
  res.setHeader('Content-Type', record.fileName.endsWith('.xlsx')
    ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${record.fileName}"`);
  res.send(buffer);
});

// ── Closing date (Phase 10, ADR-TB-04 / rule TB5) ──────────────────
// companies.lock_date IS the closing date; enforcement lives at the
// ledger choke point. These routes manage it (firm-admin) and surface
// closed-period drift for the workpaper banner.

tbRouter.get('/closing-date', async (req, res) => {
  const [row] = await db.select({
    lockDate: companies.lockDate,
    setBy: companies.lockDateSetBy,
    setAt: companies.lockDateSetAt,
  }).from(companies)
    .where(and(eq(companies.tenantId, req.tenantId), eq(companies.id, req.companyId!)))
    .limit(1);
  if (!row) throw AppError.notFound('Company not found');
  res.json({ closingDate: row.lockDate, setBy: row.setBy, setAt: row.setAt });
});

tbRouter.put('/closing-date', requireFirmAdmin, validate(z.object({
  closingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
})), async (req, res) => {
  const [before] = await db.select({ lockDate: companies.lockDate }).from(companies)
    .where(and(eq(companies.tenantId, req.tenantId), eq(companies.id, req.companyId!)))
    .limit(1);
  if (!before) throw AppError.notFound('Company not found');
  const closingDate = req.body.closingDate as string | null;
  const [after] = await db.update(companies).set({
    lockDate: closingDate,
    lockDateSetBy: req.userId ?? null,
    lockDateSetAt: new Date(),
  }).where(and(eq(companies.tenantId, req.tenantId), eq(companies.id, req.companyId!)))
    .returning({ lockDate: companies.lockDate });
  await auditLogFn(req.tenantId, 'update', 'closing_date', req.companyId!,
    { closingDate: before.lockDate }, { closingDate }, req.userId);
  res.json({ closingDate: after?.lockDate ?? null });
});

// 10.5: transactions dated inside the closed period but created/changed
// after it was closed — the "closed period modified since close" list.
tbRouter.get('/closed-period-changes', async (req, res) => {
  const [company] = await db.select({
    lockDate: companies.lockDate,
    setAt: companies.lockDateSetAt,
  }).from(companies)
    .where(and(eq(companies.tenantId, req.tenantId), eq(companies.id, req.companyId!)))
    .limit(1);
  if (!company?.lockDate || !company.setAt) {
    res.json({ closingDate: company?.lockDate ?? null, changes: [], total: 0 });
    return;
  }
  const rows = await db.execute(sql`
    SELECT id, txn_type, txn_date, memo, total, updated_at, created_at
    FROM transactions
    WHERE tenant_id = ${req.tenantId}
      AND (company_id = ${req.companyId} OR company_id IS NULL)
      AND txn_date <= ${company.lockDate}
      AND GREATEST(created_at, COALESCE(updated_at, created_at)) > ${company.setAt}
    ORDER BY txn_date DESC
    LIMIT 50
  `);
  const countRes = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM transactions
    WHERE tenant_id = ${req.tenantId}
      AND (company_id = ${req.companyId} OR company_id IS NULL)
      AND txn_date <= ${company.lockDate}
      AND GREATEST(created_at, COALESCE(updated_at, created_at)) > ${company.setAt}
  `);
  res.json({
    closingDate: company.lockDate,
    closedAt: company.setAt,
    changes: rows.rows,
    total: (countRes.rows as Array<{ n: number }>)[0]?.n ?? 0,
  });
});

// ── Schedule M-1 / M-2 previews (Phase 9) ──────────────────────────

const mQuerySchema = z.object({
  taxYear: z.coerce.number().int().min(2000).max(2100),
  basis: z.enum(['accrual', 'cash']).default('accrual'),
});

tbRouter.get('/m1', expensiveOpLimiter, async (req, res) => {
  const q = mQuerySchema.parse(req.query);
  const m1 = await m1Service.buildM1(req.tenantId, req.companyId!, q);
  res.json({ m1 });
});

tbRouter.get('/m2', expensiveOpLimiter, async (req, res) => {
  const q = mQuerySchema.parse(req.query);
  const m2 = await m1Service.buildM2(req.tenantId, req.companyId!, q);
  res.json({ m2 });
});

tbRouter.get('/equity-roles', async (req, res) => {
  const roles = await m1Service.getEquityRoles(req.tenantId, req.companyId!);
  res.json({ roles });
});

tbRouter.put('/equity-roles', validate(z.object({
  roles: z.record(z.string().uuid(), z.enum(['retained', 'distributions', 'contributions', 'other'])),
})), async (req, res) => {
  await m1Service.setEquityRoles(req.tenantId, req.companyId!, req.body.roles, req.userId);
  res.json({ roles: req.body.roles });
});

// ── Tax RJEs (Phase 8, ADR-TB-03 — never touch the GL) ─────────────

tbRouter.get('/tax-entries', async (req, res) => {
  const taxYear = Number(req.query['taxYear']) || new Date().getUTCFullYear();
  const result = await taxEntriesService.listTaxEntries(req.tenantId, req.companyId!, taxYear);
  res.json(result);
});

tbRouter.post('/tax-entries', validate(createTaxEntrySchema), async (req, res) => {
  const entry = await taxEntriesService.createTaxEntry(req.tenantId, req.companyId!, req.body, req.userId);
  if (req.body.draftAttachmentId) {
    await attachmentService.reassignDraftAttachments(req.tenantId, req.body.draftAttachmentId, 'tb_tax_entry', entry.id);
  }
  res.status(201).json({ entry });
});

tbRouter.put('/tax-entries/:id', validate(createTaxEntrySchema), async (req, res) => {
  const entry = await taxEntriesService.updateTaxEntry(req.tenantId, req.companyId!, String(req.params['id']), req.body, req.userId);
  res.json({ entry });
});

tbRouter.delete('/tax-entries/:id', async (req, res) => {
  await taxEntriesService.deleteTaxEntry(req.tenantId, req.companyId!, String(req.params['id']), req.userId);
  res.status(204).end();
});

// ── Groupings / leadsheets / tickmarks / notes / sign-offs (Phase 7) ─

tbRouter.get('/groupings', async (req, res) => {
  const result = await groupingsService.listGroupings(req.tenantId, req.companyId!);
  res.json(result);
});

tbRouter.post('/groupings/seed-defaults', async (req, res) => {
  const result = await groupingsService.seedDefaultGroupings(req.tenantId, req.companyId!, req.userId);
  res.json(result);
});

const groupingSchema = z.object({
  name: z.string().min(1).max(200),
  leadsheetCode: z.string().max(10).nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  sortOrder: z.coerce.number().int().optional(),
});

tbRouter.post('/groupings', validate(groupingSchema), async (req, res) => {
  const grouping = await groupingsService.createGrouping(req.tenantId, req.companyId!, req.body, req.userId);
  res.status(201).json({ grouping });
});

tbRouter.put('/groupings/:id', validate(groupingSchema.partial()), async (req, res) => {
  const grouping = await groupingsService.updateGrouping(req.tenantId, req.companyId!, String(req.params['id']), req.body, req.userId);
  res.json({ grouping });
});

tbRouter.delete('/groupings/:id', async (req, res) => {
  await groupingsService.deleteGrouping(req.tenantId, req.companyId!, String(req.params['id']), req.userId);
  res.status(204).end();
});

tbRouter.put('/groupings/membership/:accountId', validate(z.object({ groupingId: z.string().uuid().nullable() })), async (req, res) => {
  await groupingsService.setAccountGrouping(req.tenantId, req.companyId!, String(req.params['accountId']), req.body.groupingId, req.userId);
  res.status(204).end();
});

tbRouter.get('/grouping-accounts', async (req, res) => {
  const accountsList = await groupingsService.listAccountsForGrouping(req.tenantId, req.companyId!);
  res.json({ accounts: accountsList });
});

// Tickmark library (tenant-level) + per-cell applications.
tbRouter.get('/tickmarks', async (req, res) => {
  const tickmarks = await groupingsService.listTickmarks(req.tenantId);
  res.json({ tickmarks });
});

tbRouter.post('/tickmarks/seed-defaults', async (req, res) => {
  const result = await groupingsService.seedStandardTickmarks(req.tenantId, req.userId);
  res.json(result);
});

const tickmarkSchema = z.object({
  id: z.string().uuid().optional(),
  symbol: z.string().min(1).max(8),
  description: z.string().min(1).max(300),
  color: z.string().max(20).nullable().optional(),
  sortOrder: z.coerce.number().int().optional(),
});

tbRouter.post('/tickmarks', validate(tickmarkSchema), async (req, res) => {
  const tickmark = await groupingsService.saveTickmark(req.tenantId, req.body, req.userId);
  res.status(201).json({ tickmark });
});

tbRouter.delete('/tickmarks/:id', async (req, res) => {
  await groupingsService.deleteTickmark(req.tenantId, String(req.params['id']), req.userId);
  res.status(204).end();
});

tbRouter.get('/tickmark-applications', async (req, res) => {
  const taxYear = Number(req.query['taxYear']) || new Date().getUTCFullYear();
  const applications = await groupingsService.listTickmarkApplications(req.tenantId, req.companyId!, taxYear);
  res.json({ applications });
});

tbRouter.post('/tickmark-applications', validate(z.object({
  taxYear: z.coerce.number().int(),
  accountId: z.string().uuid(),
  column: z.enum(['unadjusted', 'aje', 'adjusted', 'tax_rje', 'tax']),
  tickmarkId: z.string().uuid(),
  note: z.string().max(1000).nullable().optional(),
})), async (req, res) => {
  const application = await groupingsService.applyTickmark(req.tenantId, req.companyId!, req.body, req.userId);
  res.status(201).json({ application });
});

tbRouter.delete('/tickmark-applications/:id', async (req, res) => {
  await groupingsService.removeTickmarkApplication(req.tenantId, req.companyId!, String(req.params['id']));
  res.status(204).end();
});

// Notes.
tbRouter.get('/notes', async (req, res) => {
  const taxYear = Number(req.query['taxYear']) || new Date().getUTCFullYear();
  const notes = await groupingsService.listNotes(req.tenantId, req.companyId!, taxYear);
  res.json({ notes });
});

tbRouter.post('/notes', validate(z.object({
  taxYear: z.coerce.number().int(),
  accountId: z.string().uuid().nullable().optional(),
  body: z.string().min(1).max(5000),
})), async (req, res) => {
  const note = await groupingsService.createNote(req.tenantId, req.companyId!, req.body, req.userId);
  res.status(201).json({ note });
});

tbRouter.post('/notes/:id/resolve', validate(z.object({ resolved: z.boolean() })), async (req, res) => {
  const note = await groupingsService.resolveNote(req.tenantId, req.companyId!, String(req.params['id']), req.body.resolved, req.userId);
  res.json({ note });
});

tbRouter.delete('/notes/:id', async (req, res) => {
  await groupingsService.deleteNote(req.tenantId, req.companyId!, String(req.params['id']));
  res.status(204).end();
});

// Sign-offs (7.6/7.7).
tbRouter.get('/signoffs', async (req, res) => {
  const taxYear = Number(req.query['taxYear']) || new Date().getUTCFullYear();
  const result = await signoffsService.listSignoffs(req.tenantId, req.companyId!, taxYear);
  res.json(result);
});

tbRouter.post('/signoffs', validate(z.object({
  taxYear: z.coerce.number().int(),
  groupingId: z.string().uuid(),
  role: z.enum(['preparer', 'reviewer']),
})), async (req, res) => {
  const signoff = await signoffsService.sign(req.tenantId, req.companyId!, req.body, req.userId!);
  res.status(201).json({ signoff });
});

tbRouter.delete('/signoffs/:id', async (req, res) => {
  await signoffsService.unsign(req.tenantId, req.companyId!, String(req.params['id']), req.userId!);
  res.status(204).end();
});

// ── Leadsheet row attachments (ref-coded PDFs + tickmark stamps) ───

const rowAttachUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      cb(new Error('Only PDF files can be attached to leadsheet rows'));
      return;
    }
    cb(null, true);
  },
});

// Multer failures surface as 400s with the reason, not unhandled 500s.
function rowAttachFile(req: Request, res: Response, next: NextFunction) {
  rowAttachUpload.single('file')(req, res, (err: unknown) => {
    if (err) {
      next(AppError.badRequest(err instanceof Error ? err.message : 'File upload rejected'));
      return;
    }
    next();
  });
}

const rowAttachSchema = z.object({
  groupingId: z.string().uuid(),
  accountId: z.string().uuid(),
  taxYear: z.coerce.number().int().min(2000).max(2100),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

tbRouter.post('/row-attachments', rowAttachFile, async (req, res) => {
  if (!req.file) throw AppError.badRequest('No file uploaded');
  verifyAttachmentContent('application/pdf', req.file.buffer);
  const body = rowAttachSchema.parse(req.body);
  const row = await rowAttachmentsService.attachRowPdf(req.tenantId, req.companyId!, {
    ...body,
    filename: req.file.originalname,
    buffer: req.file.buffer,
  }, req.userId);
  res.status(201).json({ attachment: row });
});

tbRouter.get('/row-attachments', async (req, res) => {
  const periodEnd = typeof req.query['periodEnd'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query['periodEnd'])
    ? req.query['periodEnd']
    : `${new Date().getUTCFullYear()}-12-31`;
  const attachments = await rowAttachmentsService.listRowAttachments(req.tenantId, req.companyId!, periodEnd);
  res.json({ attachments });
});

tbRouter.get('/row-attachments/:id/file', async (req, res) => {
  const stamped = req.query['stamped'] !== '0';
  const file = await rowAttachmentsService.renderRowAttachmentPdf(req.tenantId, req.companyId!, String(req.params['id']), stamped);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${file.fileName}"`);
  res.send(file.buffer);
});

tbRouter.delete('/row-attachments/:id', async (req, res) => {
  await rowAttachmentsService.removeRowAttachment(req.tenantId, req.companyId!, String(req.params['id']), req.userId);
  res.status(204).end();
});

const annotationSchema = z.object({
  page: z.coerce.number().int().min(1).max(2000),
  xPct: z.coerce.number().min(0).max(1),
  yPct: z.coerce.number().min(0).max(1),
  tickmarkId: z.string().uuid(),
  note: z.string().max(200).nullable().optional(),
});

tbRouter.post('/row-attachments/:id/annotations', validate(annotationSchema), async (req, res) => {
  const annotation = await rowAttachmentsService.addAnnotation(req.tenantId, req.companyId!, String(req.params['id']), req.body, req.userId);
  res.status(201).json({ annotation });
});

tbRouter.delete('/row-attachments/:id/annotations/:annotationId', async (req, res) => {
  await rowAttachmentsService.removeAnnotation(req.tenantId, req.companyId!, String(req.params['id']), String(req.params['annotationId']), req.userId);
  res.status(204).end();
});

// ── Company tax profile (Phase 3.1) ────────────────────────────────

tbRouter.get('/profile', async (req, res) => {
  const result = await taxProfileService.getProfile(req.tenantId, req.companyId!);
  res.json(result);
});

// Return form + seed pinning reshape every assignment's validity —
// firm-admin territory (13.1).
tbRouter.put('/profile', requireFirmAdmin, validate(upsertTaxProfileSchema), async (req, res) => {
  const profile = await taxProfileService.upsertProfile(req.tenantId, req.companyId!, req.body, req.userId);
  res.json({ profile });
});

// ── Activity units (Phase 3.2) ─────────────────────────────────────

tbRouter.get('/activity-units', async (req, res) => {
  const units = await unitsService.listUnits(req.tenantId, req.companyId!, req.query['includeArchived'] === 'true');
  res.json({ units });
});

tbRouter.post('/activity-units', validate(createActivityUnitSchema), async (req, res) => {
  const unit = await unitsService.createUnit(req.tenantId, req.companyId!, req.body, req.userId);
  res.status(201).json({ unit });
});

tbRouter.put('/activity-units/:id', validate(updateActivityUnitSchema), async (req, res) => {
  const unit = await unitsService.renameUnit(req.tenantId, req.companyId!, String(req.params['id']), req.body.displayName, req.userId, req.body.instanceNumber);
  res.json({ unit });
});

tbRouter.post('/activity-units/:id/set-default', async (req, res) => {
  const unit = await unitsService.setDefaultUnit(req.tenantId, req.companyId!, String(req.params['id']), req.userId);
  res.json({ unit });
});

tbRouter.delete('/activity-units/:id', async (req, res) => {
  const result = await unitsService.archiveUnit(req.tenantId, req.companyId!, String(req.params['id']), req.userId);
  res.json(result);
});

// ── Tag → activity unit mapping (Phase 3.3) ────────────────────────

tbRouter.get('/tag-mappings', async (req, res) => {
  const result = await unitsService.listTagMappings(req.tenantId, req.companyId!);
  res.json(result);
});

tbRouter.put('/tag-mappings/:tagId', validate(mapTagSchema), async (req, res) => {
  const mapping = await unitsService.mapTag(req.tenantId, req.companyId!, String(req.params['tagId']), req.body.activityUnitId, req.userId);
  res.json({ mapping });
});

tbRouter.delete('/tag-mappings/:tagId', async (req, res) => {
  await unitsService.unmapTag(req.tenantId, req.companyId!, String(req.params['tagId']), req.userId);
  res.status(204).end();
});
