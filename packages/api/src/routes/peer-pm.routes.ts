// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Vibe Practice Management peer API — mounted at /api/peer/pm
// (docs/vibe-pm-integration.md). PM's server presents a short-lived
// signed token; a pm_client_id claim selects the linked MyBooks client,
// and the EXISTING portal routers then run for that client's portal
// contact exactly as they would for a cookie session. Nothing here is
// reachable until a firm admin registers PM's key and staff link a
// client.
//
// Stack, in order:
//   Cache-Control: no-store  → per-IP pre-auth limiter → peerAuth →
//   per-contact limiter → (link-scoped routes) requirePeerLink +
//   peerCompanyScope → the portal router.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { AppError } from '../utils/errors.js';
import { getRateLimitStore } from '../utils/rate-limit-store.js';
import { peerAuth, requirePeerLink, peerCompanyScope, portalLimiterKey } from '../middleware/peer-auth.js';
import * as firmsService from '../services/firms.service.js';
import * as peerPortal from '../services/peer-portal.service.js';
import { portalQuestionsPublicRouter } from './portal-questions-public.routes.js';
import { portalFinancialsPublicRouter } from './portal-financials-public.routes.js';
import { portalReceiptsPublicRouter } from './portal-receipts-public.routes.js';
import { portalDocumentRequestsPublicRouter } from './portal-document-requests-public.routes.js';
import { portalBankRepairPublicRouter } from './portal-bank-repair-public.routes.js';
import { portalBankingPublicRouter } from './portal-banking-public.routes.js';
import { portalCategorizePublicRouter } from './portal-categorize-public.routes.js';
import { portalBillsPublicRouter } from './portal-bills-public.routes.js';

export const peerPmRouter = Router();

peerPmRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});

// Pre-auth: the /api/ global limiter skips /peer/, so this is the only
// per-IP bound on unauthenticated probes.
peerPmRouter.use(rateLimit({
  windowMs: 60_000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  store: getRateLimitStore('peer-ip'),
  message: { error: { message: 'Too many requests', code: 'RATE_LIMIT' } },
  skip: () => process.env['NODE_ENV'] === 'test',
}));

peerPmRouter.use(peerAuth);

// Post-auth: PM is one IP for every client, so bound per firm+contact.
peerPmRouter.use(rateLimit({
  windowMs: 60_000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  store: getRateLimitStore('peer-contact'),
  keyGenerator: (req) => (req.peer ? `peer:${req.peer.firmId}:${req.peerClaims?.pm_client_id ?? '-'}` : portalLimiterKey(req)),
  message: { error: { message: 'Too many requests', code: 'RATE_LIMIT' } },
  skip: () => process.env['NODE_ENV'] === 'test',
}));

// GET /api/peer/pm/health — token round-trip check; no link needed.
peerPmRouter.get('/health', async (req, res) => {
  const firm = await firmsService.getById(req.peer!.firmId);
  res.json({ ok: true, issuer: req.peer!.issuer, firm: { id: firm.id, name: firm.name } });
});

// GET /api/peer/pm/links — every PM client the firm has linked.
peerPmRouter.get('/links', async (req, res) => {
  const links = await peerPortal.listLinksForFirm(req.peer!.firmId);
  res.json({ links });
});

// GET /api/peer/pm/portal/context — who the token acts as + what it may do.
peerPmRouter.get('/portal/context', requirePeerLink, async (req, res) => {
  res.json(await peerPortal.buildPortalContext(req.peerLink!));
});

// Everything under /portal/* is the existing portal API for the link.
peerPmRouter.use('/portal', requirePeerLink, peerCompanyScope);
peerPmRouter.use('/portal/questions', portalQuestionsPublicRouter);
peerPmRouter.use('/portal/financials', portalFinancialsPublicRouter);
peerPmRouter.use('/portal/receipts', portalReceiptsPublicRouter);
peerPmRouter.use('/portal/document-requests', portalDocumentRequestsPublicRouter);
// Repair first — its paths live under /banking/connections.
peerPmRouter.use('/portal/banking/connections', portalBankRepairPublicRouter);
peerPmRouter.use('/portal/banking', portalBankingPublicRouter);
peerPmRouter.use('/portal/categorize', portalCategorizePublicRouter);
peerPmRouter.use('/portal/bills', portalBillsPublicRouter);

peerPmRouter.use((_req, _res, next) => {
  next(AppError.notFound('Unknown peer endpoint'));
});
