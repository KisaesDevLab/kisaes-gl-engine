// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import * as remSvc from '../services/portal-reminders.service.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 13.5 — open + click
// tracking endpoints. Public (no auth) so the email pixel and link
// wrapper can be hit from anywhere. Returns a 1x1 GIF for the pixel
// and a 302 for the click.

export const portalTrackingRouter = Router();

const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

portalTrackingRouter.get('/track/:sendId/open.gif', async (req, res) => {
  try {
    await remSvc.recordOpen(req.params['sendId']!);
  } catch {
    // Swallow — we always serve the pixel so a stuck DB never breaks the
    // email render. The send row may simply be unknown (legacy/replay).
  }
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store');
  res.send(TRANSPARENT_GIF);
});

portalTrackingRouter.get('/track/:sendId/click', async (req, res) => {
  const to = (req.query['to'] as string | undefined) ?? '';
  try {
    await remSvc.recordClick(req.params['sendId']!);
  } catch {
    // see open.gif handler — fall through to redirect
  }
  // Open redirect protection: only allow targets whose origin matches
  // the firm's configured PORTAL_BASE_URL. Anything else (different
  // host, missing scheme, javascript:, data:) is rejected so a
  // tampered link can't turn our domain into a phishing redirector.
  const allowedBase = process.env['PORTAL_BASE_URL'] || 'http://localhost:5173';
  let allowedOrigin: string;
  try {
    allowedOrigin = new URL(allowedBase).origin;
  } catch {
    res.status(500).send('Tracking misconfigured');
    return;
  }
  let target: URL;
  try {
    target = new URL(to);
  } catch {
    res.status(400).send('Invalid redirect target');
    return;
  }
  if (target.origin !== allowedOrigin) {
    res.status(400).send('Invalid redirect target');
    return;
  }
  res.redirect(302, target.toString());
});
