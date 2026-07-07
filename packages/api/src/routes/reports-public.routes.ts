// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { AppError } from '../utils/errors.js';
import * as reportsSvc from '../services/portal-reports.service.js';

// Anonymous share-link viewer for published financial reports. NO auth:
// the 160-bit share token in the URL is the bearer credential. Mounted
// at /api/reports/public. Mirrors the public-invoice router shape
// (public-invoice.routes.ts) — same tight rate limit, same "resolve only
// the published record" contract. Archived/draft tokens 404 (the gate
// lives in the service).
export const publicReportsRouter = Router();

// Tight rate limit — these endpoints are unauthenticated bearer-token
// surfaces, so we keep distributed brute-force against the 160-bit share
// token well below the already-infeasible threshold. Matches the public
// invoice router (10/min per IP).
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many requests. Please try again later.' } },
});
publicReportsRouter.use(publicLimiter);

// GET /api/reports/public/:token — render payload for the public page.
// Resolves ONLY published instances; anything else 404s.
publicReportsRouter.get('/:token', async (req, res) => {
  const token = req.params['token'] || '';
  const report = await reportsSvc.getPublishedReportByShareToken(token);
  res.json({ report });
});

// GET /api/reports/public/:token/pdf — stream the stored PDF artifact.
// Same published-only gate; 404 when no PDF is on file.
publicReportsRouter.get('/:token/pdf', async (req, res) => {
  const token = req.params['token'] || '';
  const pdf = await reportsSvc.downloadPublishedReportPdfByShareToken(token);
  if (!pdf) throw AppError.notFound('No PDF on file for this report');
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${pdf.filename}"`);
  res.send(pdf.buffer);
});
