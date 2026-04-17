// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { issueDownloadToken } from '../utils/download-token.js';

export const downloadsRouter = Router();

// The web client calls this right before window.open for a PDF export. The
// returned token is valid for ~60s and single-use, so even if it leaks into
// browser history or a proxy log it's useless on replay.
downloadsRouter.post('/token', authenticate, (req, res) => {
  const result = issueDownloadToken({
    userId: req.userId,
    tenantId: req.tenantId,
    userRole: req.userRole,
    isSuperAdmin: req.isSuperAdmin,
    companyId: (req.headers['x-company-id'] as string | undefined) || null,
  });
  res.json(result);
});
