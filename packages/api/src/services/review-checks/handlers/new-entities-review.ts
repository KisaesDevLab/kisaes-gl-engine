// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler, CheckParams } from './index.js';
import { summaryLine } from './present.js';

// `new_entities_review` — vendors, customers, and accounts created in
// the close period. Reviewing "what's new" is a standard close habit:
// a new vendor might be a typo-duplicate of an existing one, a new
// account might fragment the chart, and each is easiest to fix while
// it has little history. Outside a close period, falls back to the
// last 30 days.
export const handler: CheckHandler = async (tenantId, companyId, params: CheckParams): Promise<FindingDraft[]> => {
  const start = params.periodStart ?? null;
  const end = params.periodEnd ?? null;
  const rangeClause = (col: string) =>
    start && end
      ? sql`AND ${sql.raw(col)} >= ${start} AND ${sql.raw(col)} < ${end}`
      : sql`AND ${sql.raw(col)} >= now() - INTERVAL '30 days'`;

  // Contacts and accounts may be tenant-wide (NULL company) — a
  // company-scoped run must still review those.
  const companyContactClause = companyId
    ? sql`AND (c.company_id = ${companyId} OR c.company_id IS NULL)`
    : sql``;
  const companyAccountClause = companyId
    ? sql`AND (a.company_id = ${companyId} OR a.company_id IS NULL)`
    : sql``;

  const contacts = await db.execute<{ id: string; display_name: string; contact_type: string; created_at: string }>(sql`
    SELECT c.id, c.display_name, c.contact_type, c.created_at
    FROM contacts c
    WHERE c.tenant_id = ${tenantId}
      ${companyContactClause}
      AND c.is_active = TRUE
      ${rangeClause('c.created_at')}
    LIMIT 200
  `);

  const accounts = await db.execute<{ id: string; name: string; account_type: string; created_at: string }>(sql`
    SELECT a.id, a.name, a.account_type, a.created_at
    FROM accounts a
    WHERE a.tenant_id = ${tenantId}
      ${companyAccountClause}
      AND a.is_active = TRUE
      AND COALESCE(a.is_system, FALSE) = FALSE
      ${rangeClause('a.created_at')}
    LIMIT 200
  `);

  const drafts: FindingDraft[] = [];
  for (const r of contacts.rows as Array<{ id: string; display_name: string; contact_type: string; created_at: string }>) {
    drafts.push({
      checkKey: 'new_entities_review',
      vendorId: r.contact_type !== 'customer' ? r.id : null,
      payload: {
        summary: summaryLine(`New ${r.contact_type}`, r.display_name, String(r.created_at).slice(0, 10)),
        entityType: r.contact_type,
        entityName: r.display_name,
        createdAt: r.created_at,
        reason: `"${r.display_name}" was added as a ${r.contact_type} this period.`,
        suggestion: 'Confirm this isn’t a near-duplicate of an existing name (which splits the payment history), that the type (vendor/customer) is right, and — for vendors you’ll pay over $600 — that a W-9 is on the way.',
        dedupe_key: `contact:${r.id}`,
      },
    });
  }
  for (const r of accounts.rows as Array<{ id: string; name: string; account_type: string; created_at: string }>) {
    drafts.push({
      checkKey: 'new_entities_review',
      payload: {
        summary: summaryLine('New account', r.name, r.account_type, String(r.created_at).slice(0, 10)),
        entityType: 'account',
        entityName: r.name,
        accountType: r.account_type,
        createdAt: r.created_at,
        reason: `Account "${r.name}" (${r.account_type}) was added to the chart of accounts this period.`,
        suggestion: 'Confirm the chart really needed a new account — near-duplicates fragment reports. Check the type and detail type are right, and whether it belongs under a parent account.',
        dedupe_key: `account:${r.id}`,
      },
    });
  }
  return drafts;
};
