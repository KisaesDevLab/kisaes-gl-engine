// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { FindingDraft } from '@kis-books/shared';
import type { CheckHandler } from './index.js';

// `closed_period_posting` — STUB. The codebase doesn't yet
// have a "close lock date" concept (system_settings or
// tenants.practice_settings would be the natural home). This
// handler returns no findings until that feature ships; the
// registry seeds the row so the dashboard can list it as a
// known check, even if it never fires today.
//
// When close-lock lands, replace this body with a SQL query
// like:
//   SELECT id, txn_date FROM transactions
//   WHERE tenant_id = $1
//     AND txn_date <  (SELECT close_lock_date FROM tenant_practice_settings WHERE ...)
//     AND created_at >= (SELECT close_lock_date FROM ...)
export const handler: CheckHandler = async (_tenantId, _companyId): Promise<FindingDraft[]> => {
  return [];
};
