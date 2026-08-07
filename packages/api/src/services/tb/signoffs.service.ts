// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Leadsheet sign-off workflow (Phase 7.6–7.8, D18). Phase 6 lands the
// completion gate consumed by PUT /tb/status; the sign-off CRUD and
// staleness detection arrive with the groupings/leadsheets phase.

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { tbGroupings, tbLeadsheetSignoffs } from '../../db/schema/index.js';

export interface CompletionGate {
  ok: boolean;
  reason?: string;
  missing: string[];
}

// tb_status → 'complete' requires every grouping reviewer-signed (7.8).
// With no groupings defined the gate passes trivially.
export async function checkCompletionGate(tenantId: string, companyId: string, taxYear: number): Promise<CompletionGate> {
  const groupings = await db.select({ id: tbGroupings.id, name: tbGroupings.name }).from(tbGroupings)
    .where(and(eq(tbGroupings.tenantId, tenantId), eq(tbGroupings.companyId, companyId)));
  if (groupings.length === 0) return { ok: true, missing: [] };

  const signoffs = await db.select().from(tbLeadsheetSignoffs)
    .where(and(
      eq(tbLeadsheetSignoffs.companyId, companyId),
      eq(tbLeadsheetSignoffs.taxYear, taxYear),
      eq(tbLeadsheetSignoffs.role, 'reviewer'),
      isNull(tbLeadsheetSignoffs.invalidatedAt),
    ));
  const signed = new Set(signoffs.map((s) => s.groupingId));
  const missing = groupings.filter((g) => !signed.has(g.id)).map((g) => g.name);
  if (missing.length > 0) {
    return { ok: false, reason: `Reviewer sign-off missing on: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`, missing };
  }
  return { ok: true, missing: [] };
}
