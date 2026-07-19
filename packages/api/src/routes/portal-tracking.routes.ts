// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

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

// Open-redirect protection for the click wrapper. The allowed origin
// must mirror portalLinkBase() in portal-reminders.service.ts exactly —
// PORTAL_BASE_URL, else PUBLIC_URL, else the dev default — because the
// `to` target is built from that same base. Checking PORTAL_BASE_URL
// alone (the original code) meant appliances configured only via
// PUBLIC_URL rejected every link in their own reminder emails with
// "Invalid redirect target". Exported for tests.
export function resolveRedirectTarget(to: string): URL | null {
  const allowedBase =
    process.env['PORTAL_BASE_URL'] || process.env['PUBLIC_URL'] || 'http://localhost:5173';
  let allowedOrigin: string;
  try {
    allowedOrigin = new URL(allowedBase).origin;
  } catch {
    return null;
  }
  let target: URL;
  try {
    target = new URL(to);
  } catch {
    return null;
  }
  // Opaque origins compare equal to each other ('null' === 'null').
  // A scheme-less base like PUBLIC_URL=localhost:5173 parses as scheme
  // "localhost:" with origin 'null' — and so does every javascript:/
  // data:/custom-protocol target, which would then pass the equality
  // check. Opaque on either side means no match, ever.
  if (allowedOrigin === 'null' || target.origin === 'null') return null;
  return target.origin === allowedOrigin ? target : null;
}

portalTrackingRouter.get('/track/:sendId/click', async (req, res) => {
  const to = (req.query['to'] as string | undefined) ?? '';
  try {
    await remSvc.recordClick(req.params['sendId']!);
  } catch {
    // see open.gif handler — fall through to redirect
  }
  // Anything not on the portal's own origin (different host, missing
  // scheme, javascript:, data:) is rejected so a tampered link can't
  // turn our domain into a phishing redirector.
  const target = resolveRedirectTarget(to);
  if (!target) {
    res.status(400).send('Invalid redirect target');
    return;
  }
  res.redirect(302, target.toString());
});
