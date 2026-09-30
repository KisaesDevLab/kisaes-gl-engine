// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Report-ready financial statements (FINANCIAL_STATEMENTS_V1). Mounted
// inside the TB router at /api/v1/tb/fs, so it inherits authentication,
// the client-user 404, the TRIAL_BALANCE_V1 gate, companyContext and the
// trial_balance resource check (rule TB13); this router adds its own flag
// gate. Library mutations (letterhead, letters, presets, templates) are
// owner-level, matching firm custom codes.

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  fsCashFlowOverridesSchema, fsCreateReportSchema, fsDraftOverridesSchema, fsFinalizeSchema, fsLayoutTemplateSchema,
  fsLetterheadSchema, fsLetterSchema, fsPublishSchema, fsStylePresetSchema, fsUpdateCompanyLayoutSchema, fsUpdateReportSchema,
  FS_ENTITY_KINDS,
} from '@kis-books/shared';
import { and, eq } from 'drizzle-orm';
import { validate } from '../middleware/validate.js';
import { expensiveOpLimiter } from '../middleware/expensive-op-limiter.js';
import * as featureFlags from '../services/feature-flags.service.js';
import { AppError } from '../utils/errors.js';
import { db } from '../db/index.js';
import { fsCashFlowOverrides } from '../db/schema/index.js';
import { auditLog } from '../middleware/audit.js';
import * as library from '../services/tb/fs/fs-library.service.js';
import * as reports from '../services/tb/fs/fs-reports.service.js';
import * as issuance from '../services/tb/fs/fs-issuance.service.js';
import { listFsAccounts } from '../services/tb/fs/fs-source.service.js';

export const fsRouter = Router();

fsRouter.use(async (req, _res, next) => {
  try {
    if (!(await featureFlags.isEnabled(req.tenantId, 'FINANCIAL_STATEMENTS_V1'))) {
      next(AppError.notFound('Feature not available'));
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
});

function requireOwner(req: Request, _res: Response, next: NextFunction) {
  if (req.isSuperAdmin || req.userRole === 'owner') {
    next();
    return;
  }
  next(AppError.forbidden('Firm administrator access required', 'TB_FIRM_ADMIN_REQUIRED'));
}

const id = (req: Request, key = 'id') => String(req.params[key]);
const versionNo = (req: Request) => {
  const n = Number(req.params['versionNo']);
  if (!Number.isInteger(n) || n < 1) throw AppError.badRequest('Invalid version');
  return n;
};

// ── Library ─────────────────────────────────────────────────────────

fsRouter.get('/library', async (req, res) => {
  res.json(await library.getLibrary(req.tenantId));
});

fsRouter.put('/library/letterhead', requireOwner, validate(fsLetterheadSchema), async (req, res) => {
  res.json({ letterhead: await library.upsertLetterhead(req.tenantId, req.body, req.userId) });
});

fsRouter.post('/library/letters', requireOwner, validate(fsLetterSchema), async (req, res) => {
  res.status(201).json({ letter: await library.createLetter(req.tenantId, req.body, req.userId) });
});
fsRouter.put('/library/letters/:id', requireOwner, validate(fsLetterSchema.partial()), async (req, res) => {
  res.json({ letter: await library.updateLetter(req.tenantId, id(req), req.body, req.userId) });
});
fsRouter.delete('/library/letters/:id', requireOwner, async (req, res) => {
  await library.deleteLetter(req.tenantId, id(req), req.userId);
  res.status(204).end();
});

fsRouter.post('/library/presets', requireOwner, validate(fsStylePresetSchema), async (req, res) => {
  res.status(201).json({ preset: await library.createPreset(req.tenantId, req.body, req.userId) });
});
fsRouter.put('/library/presets/:id', requireOwner, validate(fsStylePresetSchema.partial()), async (req, res) => {
  res.json({ preset: await library.updatePreset(req.tenantId, id(req), req.body, req.userId) });
});
fsRouter.delete('/library/presets/:id', requireOwner, async (req, res) => {
  await library.deletePreset(req.tenantId, id(req), req.userId);
  res.status(204).end();
});

fsRouter.post('/library/templates', requireOwner, validate(fsLayoutTemplateSchema), async (req, res) => {
  res.status(201).json({ template: await library.createTemplate(req.tenantId, req.body, req.userId) });
});
fsRouter.put('/library/templates/:id', requireOwner, validate(fsLayoutTemplateSchema.partial()), async (req, res) => {
  res.json({ template: await library.updateTemplate(req.tenantId, id(req), req.body, req.userId) });
});
fsRouter.delete('/library/templates/:id', requireOwner, async (req, res) => {
  await library.deleteTemplate(req.tenantId, id(req), req.userId);
  res.status(204).end();
});

// ── Company layouts ─────────────────────────────────────────────────

fsRouter.get('/layouts', async (req, res) => {
  res.json({ layouts: await reports.listLayouts(req.tenantId, req.companyId!) });
});

fsRouter.get('/layouts/:id', async (req, res) => {
  const row = await reports.getLayout(req.tenantId, req.companyId!, id(req));
  res.json({ layout: { id: row.id, name: row.name, layout: row.layoutJson, style: row.styleJson, updatedAt: row.updatedAt } });
});

fsRouter.post('/layouts/bind-preview', validate(z.object({ templateId: z.string().uuid().nullable() })), async (req, res) => {
  res.json(await reports.bindPreview(req.tenantId, req.companyId!, req.body.templateId, req.userId));
});

fsRouter.patch('/layouts/:id', validate(fsUpdateCompanyLayoutSchema), async (req, res) => {
  const row = await reports.updateLayout(req.tenantId, req.companyId!, id(req), req.body, req.userId);
  res.json({ layout: { id: row.id, name: row.name, layout: row.layoutJson, style: row.styleJson, updatedAt: row.updatedAt } });
});

fsRouter.post('/layouts/:id/save-as-template', requireOwner, validate(z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullable().optional(),
  entityKind: z.enum([...FS_ENTITY_KINDS, 'any']).optional(),
})), async (req, res) => {
  res.status(201).json({ template: await reports.saveLayoutAsTemplate(req.tenantId, req.companyId!, id(req), req.body, req.userId) });
});

// Account + leadsheet lists for the schedule editor / cash-flow panel.
fsRouter.get('/accounts', async (req, res) => {
  res.json({ accounts: await listFsAccounts(req.tenantId, req.companyId!) });
});

// ── Cash-flow classification overrides ──────────────────────────────

fsRouter.get('/cash-flow-overrides', async (req, res) => {
  const rows = await db.select().from(fsCashFlowOverrides)
    .where(and(eq(fsCashFlowOverrides.tenantId, req.tenantId), eq(fsCashFlowOverrides.companyId, req.companyId!)));
  res.json({ overrides: rows.map((r) => ({ accountId: r.accountId, groupingId: r.groupingId, classification: r.classification })) });
});

fsRouter.put('/cash-flow-overrides', validate(fsCashFlowOverridesSchema), async (req, res) => {
  const tenantId = req.tenantId;
  const companyId = req.companyId!;
  const input = req.body as z.infer<typeof fsCashFlowOverridesSchema>;
  await db.transaction(async (tx) => {
    for (const o of input.overrides) {
      const target = o.accountId
        ? eq(fsCashFlowOverrides.accountId, o.accountId)
        : eq(fsCashFlowOverrides.groupingId, o.groupingId!);
      await tx.delete(fsCashFlowOverrides).where(and(eq(fsCashFlowOverrides.tenantId, tenantId), eq(fsCashFlowOverrides.companyId, companyId), target));
      if (o.classification) {
        await tx.insert(fsCashFlowOverrides).values({
          tenantId, companyId, accountId: o.accountId ?? null, groupingId: o.groupingId ?? null,
          classification: o.classification, updatedBy: req.userId ?? null,
        });
      }
    }
    await auditLog(tenantId, 'update', 'fs_cash_flow_overrides', companyId, null, input, req.userId, tx);
  });
  res.status(204).end();
});

// ── Reports ─────────────────────────────────────────────────────────

fsRouter.get('/reports', async (req, res) => {
  const limit = Math.min(Number(req.query['limit']) || 50, 200);
  const offset = Math.max(Number(req.query['offset']) || 0, 0);
  const result = await reports.listReports(req.tenantId, req.companyId!, { limit, offset });
  res.json({ ...result, limit, offset });
});

fsRouter.post('/reports', validate(fsCreateReportSchema), async (req, res) => {
  const row = await reports.createReport(req.tenantId, req.companyId!, req.body, req.userId);
  res.status(201).json({ report: { id: row.id } });
});

fsRouter.get('/reports/:id', async (req, res) => {
  res.json(await reports.getReport(req.tenantId, req.companyId!, id(req)));
});

fsRouter.patch('/reports/:id', validate(fsUpdateReportSchema), async (req, res) => {
  await reports.updateReport(req.tenantId, req.companyId!, id(req), req.body, req.userId);
  res.json(await reports.getReport(req.tenantId, req.companyId!, id(req)));
});

fsRouter.delete('/reports/:id', async (req, res) => {
  await reports.archiveReport(req.tenantId, req.companyId!, id(req), req.userId);
  res.status(204).end();
});

fsRouter.post('/reports/:id/roll-forward', validate(z.object({
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  name: z.string().trim().min(1).max(200).optional(),
})), async (req, res) => {
  const row = await reports.rollForward(req.tenantId, req.companyId!, id(req), req.body, req.userId);
  res.status(201).json({ report: { id: row.id } });
});

// Engine input + resolved front matter for the browser's live preview
// (the browser runs the same computeFsReport + renderer).
fsRouter.post('/reports/:id/preview-data', expensiveOpLimiter, validate(fsDraftOverridesSchema), async (req, res) => {
  res.json(await reports.previewData(req.tenantId, req.companyId!, id(req), req.body));
});

// Authoritative server compute (checks panel, finalize gate).
fsRouter.post('/reports/:id/compute', expensiveOpLimiter, validate(fsDraftOverridesSchema), async (req, res) => {
  const { model } = await reports.computeDraft(req.tenantId, req.companyId!, id(req), req.body);
  res.json({ model });
});

function sendFile(res: Response, file: { buffer: Buffer; fileName: string; mimeType: string }, inline: boolean) {
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${file.fileName.replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(file.buffer);
}

// Exact PDF proof of an unsaved draft.
fsRouter.post('/reports/:id/preview.pdf', expensiveOpLimiter, validate(fsDraftOverridesSchema), async (req, res) => {
  const file = await issuance.exportReport(req.tenantId, req.companyId!, id(req), 'pdf', null, req.body);
  sendFile(res, file, true);
});

fsRouter.get('/reports/:id/export', expensiveOpLimiter, async (req, res) => {
  const format = String(req.query['format'] ?? 'pdf');
  if (format !== 'pdf' && format !== 'docx' && format !== 'xlsx') throw AppError.badRequest('format must be pdf, docx or xlsx');
  const v = req.query['version'] ? Number(req.query['version']) : null;
  if (v !== null && (!Number.isInteger(v) || v < 1)) throw AppError.badRequest('Invalid version');
  const file = await issuance.exportReport(req.tenantId, req.companyId!, id(req), format, v);
  await auditLog(req.tenantId, 'download', 'fs_report_export', id(req), null, { format, version: v }, req.userId);
  sendFile(res, file, false);
});

// ── Issuance ────────────────────────────────────────────────────────

fsRouter.post('/reports/:id/finalize', expensiveOpLimiter, validate(fsFinalizeSchema), async (req, res) => {
  const result = await issuance.finalize(req.tenantId, req.companyId!, id(req), req.body, req.userId);
  res.json(result);
});

fsRouter.post('/reports/:id/reopen', async (req, res) => {
  await issuance.reopen(req.tenantId, req.companyId!, id(req), req.userId);
  res.status(204).end();
});

fsRouter.get('/reports/:id/versions', async (req, res) => {
  res.json({ versions: await issuance.listVersions(req.tenantId, req.companyId!, id(req)) });
});

fsRouter.get('/reports/:id/versions/:versionNo', async (req, res) => {
  res.json(await issuance.versionDetail(req.tenantId, req.companyId!, id(req), versionNo(req)));
});

fsRouter.get('/reports/:id/versions/:versionNo/impact', expensiveOpLimiter, async (req, res) => {
  res.json(await issuance.impact(req.tenantId, req.companyId!, id(req), versionNo(req)));
});

fsRouter.post('/reports/:id/versions/:versionNo/publish', validate(fsPublishSchema), async (req, res) => {
  res.json(await issuance.publish(req.tenantId, req.companyId!, id(req), versionNo(req), req.body, req.userId));
});

fsRouter.post('/reports/:id/versions/:versionNo/unpublish', async (req, res) => {
  await issuance.unpublish(req.tenantId, req.companyId!, id(req), versionNo(req), req.userId);
  res.status(204).end();
});
