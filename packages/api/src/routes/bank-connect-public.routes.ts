// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Public bank-connect invite endpoints (W-9 pattern). Mounted at
// /api/bank-connect/* — no auth beyond the invite token in the URL;
// everything (tenant, inviting user) is derived server-side from the
// token. Rate-limited to deter brute-forcing tokens, with a stricter
// limiter on the Plaid-touching endpoints (each link-token mint and
// exchange is a real Plaid API call).

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { validate } from '../middleware/validate.js';
import { getRateLimitStore } from '../utils/rate-limit-store.js';
import * as svc from '../services/bank-connect-invite.service.js';

export const bankConnectPublicRouter = Router();

const baseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: getRateLimitStore('bank-connect-public'),
  message: { error: { message: 'Too many requests' } },
});
const plaidLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: getRateLimitStore('bank-connect-plaid'),
  message: { error: { message: 'Too many requests' } },
});

bankConnectPublicRouter.use(baseLimiter);

bankConnectPublicRouter.get('/:token', async (req, res) => {
  const invite = await svc.loadInviteByToken(req.params['token']!);
  res.json({ invite });
});

bankConnectPublicRouter.post('/:token/link-token', plaidLimiter, async (req, res) => {
  const result = await svc.createLinkTokenForInvite(req.params['token']!);
  res.json(result);
});

const exchangeSchema = z.object({
  publicToken: z.string().min(10).max(500),
  institutionId: z.string().max(100).optional(),
  institutionName: z.string().max(255).optional(),
  accounts: z.array(z.unknown()).max(50).optional(),
  linkSessionId: z.string().max(100).optional(),
});

bankConnectPublicRouter.post('/:token/exchange', plaidLimiter, validate(exchangeSchema), async (req, res) => {
  const body = req.body as z.infer<typeof exchangeSchema>;
  const result = await svc.completeInviteConnection(req.params['token']!, body.publicToken, {
    institutionId: body.institutionId,
    institutionName: body.institutionName,
    accounts: body.accounts,
    linkSessionId: body.linkSessionId,
  });
  res.status(201).json(result);
});
