// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { issueDownloadToken } from '../utils/download-token.js';

export const downloadsRouter = Router();

// The web client calls this right before window.open for a PDF export. The
// returned token is valid for ~60s. It is a signed, stateless token (any API
// process can verify it), so it is NOT single-use: it can be replayed within
// that window (utils/download-token.ts), and it only works for GET/HEAD.
//
// U-90 review L1: with X-Company-Id (or ?_company=), the company is checked
// like every company-scoped router (in this tenant, user not excluded; 403
// otherwise) before it goes into the token; at redemption the token's
// company wins over any header. Without one, the token carries no company
// and the route it is used on resolves its default company then.
downloadsRouter.post('/token', authenticate, async (req, res) => {
  const requested = (req.headers['x-company-id'] as string | undefined)
    || (req.query['_company'] as string | undefined);
  // companyContext throws (403) for a company the user may not open.
  if (requested) await companyContext(req, res, () => {});
  const result = issueDownloadToken({
    userId: req.userId,
    tenantId: req.tenantId,
    userRole: req.userRole,
    isSuperAdmin: req.isSuperAdmin,
    companyId: requested ? req.companyId : null,
  });
  res.json(result);
});
