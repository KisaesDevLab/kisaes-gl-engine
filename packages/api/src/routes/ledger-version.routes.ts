// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// GET /api/v1/ledger-version — "has anything in the books changed?"
//
// The whole point is that this is cheap enough to ask on a timer. It returns
// one integer and reads two indexed rows, so a client can poll it and refetch
// its actual lists only when the number moves, instead of re-running those
// lists on a schedule and paying for the answer every time.
//
// No resource permission beyond a signed-in session with company context: the
// response carries no business data, only a counter. It is deliberately NOT on
// the Trial Balance router, which already streams this same stamp — that
// router is gated behind the TB feature flag and TB permissions, and every
// user needs this one.

import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { getLedgerVersion } from '../services/ledger-version.service.js';

export const ledgerVersionRouter = Router();

ledgerVersionRouter.use(authenticate);
ledgerVersionRouter.use(companyContext);

ledgerVersionRouter.get('/', async (req, res) => {
  const stamp = await getLedgerVersion(req.tenantId, req.companyId);
  res.json({ stamp });
});
