// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { describe } from '../middleware/describe.js';
import * as journalEntryService from '../services/journal-entry.service.js';

// Journal-entry helpers (U-59, je-number-v1). Journal entries themselves are
// created and edited through POST / PUT /transactions (txnType
// 'journal_entry'); this router holds the JE-only reads. Same permission as
// the transactions router.
export const journalEntriesRouter = Router();
journalEntriesRouter.use(authenticate);
journalEntriesRouter.use(companyContext);
journalEntriesRouter.use(requireResource('transactions'));

journalEntriesRouter.get('/next-number', describe({
  summary: 'Suggested next journal entry number (je-number-v1)',
  description: 'The highest all-digit journal entry number in the company plus one, as a string; "1" when there is none. ' +
    'Void and deleted entries count. Numbers are not reserved and duplicates are allowed.',
  response: z.object({ next: z.string() }),
}), async (req, res) => {
  res.json({ next: await journalEntryService.nextJournalEntryNumber(req.tenantId, req.companyId) });
});
