// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { reportInstances, portalContactCompanies } from '../db/schema/index.js';
import { portalAuthenticate } from '../middleware/portal-auth.js';
import { AppError } from '../utils/errors.js';
import * as reportsSvc from '../services/portal-reports.service.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 17.4 — published-reports
// list for the signed-in contact. Mounted at /api/portal/financials.
// Lives in its own router so the URL doesn't collide with the
// /api/portal/questions/:id matcher.

export const portalFinancialsPublicRouter = Router();
portalFinancialsPublicRouter.use(portalAuthenticate);

portalFinancialsPublicRouter.get('/', async (req, res) => {
  if (!req.portalContact) throw AppError.unauthorized('No portal session');
  const companyId = req.query['companyId'] as string | undefined;
  if (!companyId) throw AppError.badRequest('companyId required');
  const reports = await reportsSvc.listPublishedForContact({
    tenantId: req.portalContact.tenantId,
    contactId: req.portalContact.contactId,
    companyId,
  });
  res.json({ reports });
});

// 17.4 — PDF download. Verifies (1) the instance is published, (2)
// belongs to the same tenant, (3) is for a company the contact is
// linked to with financialsAccess=true.
portalFinancialsPublicRouter.get('/:id/download', async (req, res) => {
  if (!req.portalContact) throw AppError.unauthorized('No portal session');
  const instId = req.params['id']!;
  const inst = await db.query.reportInstances.findFirst({
    where: and(
      eq(reportInstances.tenantId, req.portalContact.tenantId),
      eq(reportInstances.id, instId),
    ),
  });
  if (!inst) throw AppError.notFound('Report not found');
  if (inst.status !== 'published') {
    throw AppError.notFound('Report not published');
  }
  const link = await db
    .select()
    .from(portalContactCompanies)
    .where(
      and(
        eq(portalContactCompanies.contactId, req.portalContact.contactId),
        eq(portalContactCompanies.companyId, inst.companyId),
      ),
    )
    .limit(1);
  if (link.length === 0 || !link[0]?.financialsAccess) {
    throw AppError.forbidden('Financial reports are not enabled for your account');
  }

  const pdf = await reportsSvc.downloadInstancePdf(req.portalContact.tenantId, instId);
  if (!pdf) throw AppError.notFound('No PDF on file for this report');
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${pdf.filename}"`);
  res.send(pdf.buffer);
});
