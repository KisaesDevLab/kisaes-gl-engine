// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Sensitive accounts (U-33), capability sensitive-accounts-doors-v1: which
// routes the engine still refuses (403 SENSITIVE_HIDDEN) for this viewer, so
// a client can hide those doors instead of offering them and failing. The
// rule is the engine's own (services/visibility.ts refuseUnconvertedReport):
// a request is refused when `hidesSensitive` is true, its path (lower case,
// no trailing slash) lies under one of `refusePrefixes`, and no `converted`
// entry matches its method (HEAD counts as GET) and path (`:x` matches one
// segment). Nothing hidden from the viewer: hidesSensitive false and both
// lists empty.

import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { describe } from '../middleware/describe.js';
import { CONVERTED, REFUSE_PREFIXES, hiddenAccountIdsFor } from '../services/visibility.js';

export const sensitiveDoorsRouter = Router();
sensitiveDoorsRouter.use(authenticate);

sensitiveDoorsRouter.get('/', describe({
  summary: 'Routes still refused for this viewer because of sensitive accounts (sensitive-accounts-doors-v1)',
  description: 'Response `{hidesSensitive: boolean, refusePrefixes: string[], converted: [{method, path}]}`. A request is refused '
    + '(403 SENSITIVE_HIDDEN) when hidesSensitive is true, its lower-cased path lies under a refusePrefixes entry and no converted '
    + 'entry matches its method (HEAD = GET) and path (`:x` matches one segment). Nothing hidden: false and empty lists. Any signed-in user.',
}), async (req, res) => {
  const hidden = await hiddenAccountIdsFor(req);
  if (hidden.length === 0) {
    res.json({ hidesSensitive: false, refusePrefixes: [], converted: [] });
    return;
  }
  res.json({
    hidesSensitive: true,
    refusePrefixes: [...REFUSE_PREFIXES],
    converted: CONVERTED.map((c) => ({ method: c.method, path: c.path })),
  });
});
