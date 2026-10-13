// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Leadsheet sign-off workflow (Phase 7.6–7.8, D18): preparer signs,
// then reviewer; each sign-off stamps the glVersionStamp so later GL /
// AJE / tax-entry changes flag it "signed before subsequent changes"
// (7.7) with one-click re-sign. tb_status 'complete' requires reviewer
// sign-off on every grouping (7.8; firm-admin override, audited).
// Sign-offs are PERIOD-END scoped (migration 0208): one live sign-off per
// (grouping, period end, role); signing 08/31 never satisfies 07/31.

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { tbGroupings, tbLeadsheetSignoffs, users } from '../../db/schema/index.js';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../middleware/audit.js';
import { getGlVersionStamp } from './balance-engine.service.js';
import { resolvePeriodScope } from './period-scope.js';

export interface CompletionGate {
  ok: boolean;
  reason?: string;
  missing: string[];
}

// tb_status → 'complete' requires every grouping reviewer-signed (7.8).
// With no groupings defined the gate passes trivially. tb_status is per
// TAX YEAR, so the caller passes the tax year's fiscal-year-end period:
// interim (e.g. 07/31) sign-offs do not complete the year.
export async function checkCompletionGate(tenantId: string, companyId: string, periodEnd: string): Promise<CompletionGate> {
  const groupings = await db.select({ id: tbGroupings.id, name: tbGroupings.name }).from(tbGroupings)
    .where(and(eq(tbGroupings.tenantId, tenantId), eq(tbGroupings.companyId, companyId)));
  if (groupings.length === 0) return { ok: true, missing: [] };

  const signoffs = await db.select().from(tbLeadsheetSignoffs)
    .where(and(
      eq(tbLeadsheetSignoffs.tenantId, tenantId),
      eq(tbLeadsheetSignoffs.companyId, companyId),
      eq(tbLeadsheetSignoffs.periodEnd, periodEnd),
      eq(tbLeadsheetSignoffs.role, 'reviewer'),
      isNull(tbLeadsheetSignoffs.invalidatedAt),
    ));
  const signed = new Set(signoffs.map((s) => s.groupingId));
  const missing = groupings.filter((g) => !signed.has(g.id)).map((g) => g.name);
  if (missing.length > 0) {
    return { ok: false, reason: `Reviewer sign-off (period end ${periodEnd}) missing on: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`, missing };
  }
  return { ok: true, missing: [] };
}

// Live sign-offs for a period end with staleness computed against the
// CURRENT stamp (7.7). "Stale" = GL/AJE/tax-entry activity after the
// signature. Tax RJEs never touch the GL, so the Phase-8 tax-entry
// service bumps gl_version_stamps itself — that keeps BOTH this
// staleness check and the workpaper cache key exact for RJE edits.
export async function listSignoffs(tenantId: string, companyId: string, periodEnd: string) {
  const [signoffs, currentStamp] = await Promise.all([
    db.select({ s: tbLeadsheetSignoffs, signedByName: users.displayName })
      .from(tbLeadsheetSignoffs)
      .leftJoin(users, eq(tbLeadsheetSignoffs.userId, users.id))
      .where(and(
        eq(tbLeadsheetSignoffs.tenantId, tenantId),
        eq(tbLeadsheetSignoffs.companyId, companyId),
        eq(tbLeadsheetSignoffs.periodEnd, periodEnd),
        isNull(tbLeadsheetSignoffs.invalidatedAt),
      )),
    getGlVersionStamp(tenantId, companyId),
  ]);
  return {
    signoffs: signoffs.map(({ s, signedByName }) => ({
      ...s,
      signedByName: signedByName ?? null,
      stale: Number(s.glVersionStampAtSignoff) < currentStamp,
    })),
    currentStamp,
  };
}

// Sign a grouping. Reviewer requires a live preparer sign-off first
// (7.6). Re-signing invalidates the prior signature of that role (and,
// for a preparer re-sign, the reviewer's too — review must follow prep).
export async function sign(tenantId: string, companyId: string, input: { periodEnd: string; groupingId: string; role: 'preparer' | 'reviewer' }, userId: string) {
  const scope = await resolvePeriodScope(tenantId, companyId, { periodEnd: input.periodEnd });
  const [grouping] = await db.select().from(tbGroupings)
    .where(and(eq(tbGroupings.id, input.groupingId), eq(tbGroupings.tenantId, tenantId), eq(tbGroupings.companyId, companyId)))
    .limit(1);
  if (!grouping) throw AppError.notFound('Grouping not found');

  return db.transaction(async (tx) => {
    const live = await tx.select().from(tbLeadsheetSignoffs)
      .where(and(
        eq(tbLeadsheetSignoffs.tenantId, tenantId),
        eq(tbLeadsheetSignoffs.groupingId, input.groupingId),
        eq(tbLeadsheetSignoffs.periodEnd, scope.periodEnd),
        isNull(tbLeadsheetSignoffs.invalidatedAt),
      ));
    if (input.role === 'reviewer' && !live.some((s) => s.role === 'preparer')) {
      throw AppError.unprocessableEntity('Preparer must sign off before the reviewer', 'TB_SIGNOFF_ORDER');
    }
    const invalidate = live.filter((s) =>
      s.role === input.role || (input.role === 'preparer' && s.role === 'reviewer'));
    for (const s of invalidate) {
      await tx.update(tbLeadsheetSignoffs).set({ invalidatedAt: new Date() })
        .where(eq(tbLeadsheetSignoffs.id, s.id));
    }
    const stamp = await getGlVersionStamp(tenantId, companyId);
    const [row] = await tx.insert(tbLeadsheetSignoffs).values({
      tenantId, companyId,
      taxYear: scope.taxYear,
      periodEnd: scope.periodEnd,
      groupingId: input.groupingId,
      role: input.role,
      userId,
      glVersionStampAtSignoff: stamp,
    }).returning();
    if (!row) throw AppError.internal('Sign-off insert failed');
    await auditLog(tenantId, 'signoff', 'tb_leadsheet_signoff', row.id,
      invalidate.length ? { invalidated: invalidate.map((s) => s.id) } : null,
      { groupingId: input.groupingId, role: input.role, periodEnd: scope.periodEnd, taxYear: scope.taxYear, stamp },
      userId, tx);
    return row;
  });
}

export async function unsign(tenantId: string, companyId: string, signoffId: string, userId: string) {
  const [before] = await db.select().from(tbLeadsheetSignoffs)
    .where(and(
      eq(tbLeadsheetSignoffs.id, signoffId),
      eq(tbLeadsheetSignoffs.tenantId, tenantId),
      eq(tbLeadsheetSignoffs.companyId, companyId),
    )).limit(1);
  if (!before) throw AppError.notFound('Sign-off not found');
  const [after] = await db.update(tbLeadsheetSignoffs).set({ invalidatedAt: new Date() })
    .where(eq(tbLeadsheetSignoffs.id, signoffId)).returning();
  await auditLog(tenantId, 'signoff', 'tb_leadsheet_signoff', signoffId, before, after ?? null, userId);
}
