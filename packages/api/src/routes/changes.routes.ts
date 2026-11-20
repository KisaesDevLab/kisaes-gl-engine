// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * GET /api/v1/changes (U-294, changes-v1): the desktop change feed. Desktop
 * mode only (the server appliance answers 404); open to LAN workstations.
 */

import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { describe } from '../middleware/describe.js';
import { desktopOnly } from '../desktop/features.js';
import { hiddenAccountIdsFor } from '../services/visibility.js';
import { readChanges } from '../services/change-feed.service.js';

export const changesRouter = Router();
changesRouter.use(desktopOnly());
changesRouter.use(authenticate);
changesRouter.use(companyContext);

const query = z.object({ cursor: z.string().max(80).optional() });

changesRouter.get('/', describe({
  summary: 'Records changed since the cursor (changes-v1, desktop)',
  description: 'Response `{cursor, feedEpoch, reset, changes: [{kind (table), id, op: upsert | delete | left}]}`. No cursor, '
    + 'another epoch (restore, archive import, engine upgrade), a cursor older than 7 days or more than 1000 changes: '
    + '`reset: true` and no changes (reload everything, then poll with the new cursor). Ids and kinds only. `left`: the '
    + 'record moved out of your view (a hidden account).',
  query,
}), async (req, res) => {
  const q = query.parse(req.query);
  res.setHeader('Cache-Control', 'no-store');
  res.json(await readChanges(req.tenantId, q.cursor, await hiddenAccountIdsFor(req)));
});