// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router, type Request, type Response } from 'express';
import { estimateParamsSchema, computeEstimateSchema, snapshotIdParamsSchema } from '@kis-books/shared';
import { getScope } from '../../middleware/tax-estimator-scope.js';
import * as documents from '../../services/tax-estimator/estimate-documents.service.js';

// Standalone estimate PDF (Phase 11, D15; Phase 13: printed from a snapshot). Mounted by
// tax-estimator.routes.ts AFTER its guard chain (session auth -> client 404 -> flag ->
// tax_estimator resource -> firm scope). Any firm role may download: the estimate is
// computed through the same scoped service as /estimate, so a taxpayer or scenario of
// another firm is a 404 and out-of-scope tenants are left out. Every download FREEZES a
// snapshot (reason 'pdf') and prints it, so the issued document can be reproduced; the
// snapshot id is returned in X-Tax-Estimate-Snapshot-Id. (The snapshot is an audit
// record of what was issued, so firm_readonly downloads create one too.)
export const pdfRouter = Router();

function sendPdf(res: Response, pdf: documents.IssuedPdf) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${pdf.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Tax-Estimate-Snapshot-Id', pdf.snapshotId);
  res.send(Buffer.from(pdf.bytes));
}

const actor = (req: Request) => ({ tenantId: req.tenantId, userId: req.userId });

pdfRouter.post('/taxpayers/:id/years/:taxYear/scenarios/:scenarioId/pdf', async (req, res) => {
  const { id, taxYear, scenarioId } = estimateParamsSchema.parse(req.params);
  const body = computeEstimateSchema.parse(req.body ?? {});
  sendPdf(res, await documents.issueEstimatePdf(getScope(req), actor(req), {
    taxpayerId: id, taxYear, scenarioId, throughMonth: body.throughMonth, reason: 'pdf',
  }));
});

// Re-print an existing snapshot (history list / read-only view). No new snapshot.
pdfRouter.get('/snapshots/:snapshotId/pdf', async (req, res) => {
  const { snapshotId } = snapshotIdParamsSchema.parse(req.params);
  sendPdf(res, await documents.snapshotPdf(getScope(req), snapshotId));
});
