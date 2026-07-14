// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';
import { summaryLine } from './present.js';

// `duplicate_entity_names` — two active contacts whose names collapse
// to the same string once case, punctuation, and whitespace are
// stripped ("ABC Corp." vs "abc corp"). Duplicate vendors split the
// payment history, which quietly breaks 1099 totals and every
// history-based check. Exact-normalized matching keeps precision high;
// fuzzy matching is deliberately out (false duplicates are worse than
// missed ones here).
export const handler: CheckHandler = async (tenantId, companyId): Promise<FindingDraft[]> => {
  // Tenant-wide contacts (NULL company) participate in every
  // company-scoped run — a duplicate across scopes is still a duplicate.
  const companyClause = companyId
    ? sql`AND (c1.company_id = ${companyId} OR c1.company_id IS NULL)
         AND (c2.company_id = ${companyId} OR c2.company_id IS NULL)`
    : sql``;

  const result = await db.execute<{
    a_id: string; b_id: string; a_name: string; b_name: string;
    a_type: string; b_type: string;
  }>(sql`
    SELECT c1.id AS a_id, c2.id AS b_id,
      c1.display_name AS a_name, c2.display_name AS b_name,
      c1.contact_type AS a_type, c2.contact_type AS b_type
    FROM contacts c1
    JOIN contacts c2 ON c2.tenant_id = c1.tenant_id
      AND c2.id > c1.id
      AND lower(regexp_replace(c1.display_name, '[^a-zA-Z0-9]', '', 'g'))
        = lower(regexp_replace(c2.display_name, '[^a-zA-Z0-9]', '', 'g'))
    WHERE c1.tenant_id = ${tenantId}
      ${companyClause}
      AND c1.is_active = TRUE
      AND c2.is_active = TRUE
      AND length(regexp_replace(c1.display_name, '[^a-zA-Z0-9]', '', 'g')) >= 3
    LIMIT 200
  `);

  return (result.rows as Array<{
    a_id: string; b_id: string; a_name: string; b_name: string;
    a_type: string; b_type: string;
  }>).map((r) => ({
    checkKey: 'duplicate_entity_names',
    vendorId: r.a_type !== 'customer' ? r.a_id : null,
    payload: {
      summary: summaryLine(`"${r.a_name}"`, `"${r.b_name}"`, 'possible duplicates'),
      nameA: r.a_name,
      nameB: r.b_name,
      typeA: r.a_type,
      typeB: r.b_type,
      reason: `"${r.a_name}" and "${r.b_name}" are the same name apart from punctuation or capitalization — likely the same ${r.a_type === r.b_type ? r.a_type : 'contact'} entered twice.`,
      suggestion: 'Pick one as the primary, reassign the other’s transactions to it, and deactivate the duplicate. Split histories understate what you’ve really paid a vendor — including for 1099 purposes — and hide duplicate charges.',
      contactIdA: r.a_id,
      contactIdB: r.b_id,
      dedupe_key: `pair:${r.a_id}:${r.b_id}`,
    },
  }));
};
