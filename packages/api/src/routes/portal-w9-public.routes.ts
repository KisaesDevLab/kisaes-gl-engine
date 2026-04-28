// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { validate } from '../middleware/validate.js';
import { getRateLimitStore } from '../utils/rate-limit-store.js';
import * as svc from '../services/portal-1099.service.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 15.2 — public W-9 form
// endpoints. Mounted at /api/w9/* — no auth beyond the magic-link
// token in the URL. Rate-limited to deter brute-forcing tokens.

export const portalW9PublicRouter = Router();

const w9Limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: getRateLimitStore('w9-public'),
  message: { error: { message: 'Too many requests' } },
});

portalW9PublicRouter.use(w9Limiter);

portalW9PublicRouter.get('/:token', async (req, res) => {
  const data = await svc.loadW9ByToken(req.params['token']!);
  res.json({ request: data });
});

const completeSchema = z.object({
  token: z.string().min(16).max(200),
  legalName: z.string().min(1).max(255),
  businessName: z.string().max(255).optional(),
  taxClassification: z.string().min(1).max(80),
  exemptPayeeCode: z.string().max(10).optional(),
  address: z.object({
    line1: z.string().min(1).max(255),
    city: z.string().min(1).max(100),
    state: z.string().min(2).max(50),
    zip: z.string().min(3).max(20),
  }),
  tin: z.string().min(9).max(20),
  tinType: z.enum(['SSN', 'EIN']),
  backupWithholding: z.boolean(),
  signatureName: z.string().min(1).max(255),
  consent: z.literal(true),
});

portalW9PublicRouter.post('/complete', validate(completeSchema), async (req, res) => {
  const result = await svc.completeW9({
    ...(req.body as z.infer<typeof completeSchema>),
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  });
  res.status(201).json(result);
});
