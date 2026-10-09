// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { portalAuthenticate, refuseDuringPreview } from '../middleware/portal-auth.js';
import { AppError } from '../utils/errors.js';
import * as svc from '../services/recurring-doc-request.service.js';
import * as flags from '../services/feature-flags.service.js';

// RECURRING_DOC_REQUESTS_V1 — portal-side list of outstanding doc
// requests for the signed-in contact. Used by the PortalDashboardPage
// "Documents requested" panel; the upload affordance posts back to
// /api/portal/receipts/upload with documentRequestId in the form data.

export const portalDocumentRequestsPublicRouter = Router();
portalDocumentRequestsPublicRouter.use(portalAuthenticate);

portalDocumentRequestsPublicRouter.get('/', async (req, res) => {
  if (!req.portalContact) throw AppError.unauthorized('No portal session');

  // Same gate as the practice routes — if the firm hasn't enabled the
  // feature, the portal hides the panel rather than show an empty
  // list (the panel decides what to render based on the response).
  const enabled = await flags.isEnabled(req.portalContact.tenantId, 'RECURRING_DOC_REQUESTS_V1');
  if (!enabled) {
    res.json({ items: [], featureEnabled: false });
    return;
  }

  const items = await svc.listForPortalContact(
    req.portalContact.tenantId,
    req.portalContact.contactId,
    // Peer (Vibe PM) requests see only the linked company's requests.
    req.peerLink?.companyId,
  );
  res.json({ items, featureEnabled: true });
});

// "I'm done" — the contact has uploaded every file for this request.
portalDocumentRequestsPublicRouter.post('/:id/complete', async (req, res) => {
  if (!req.portalContact) throw AppError.unauthorized('No portal session');
  refuseDuringPreview(req);
  const id = req.params['id'] ?? '';
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw AppError.badRequest('Invalid id');
  const result = await svc.completeByContact(
    req.portalContact.tenantId, req.portalContact.contactId, id, req.peerLink?.companyId,
  );
  res.json(result);
});
