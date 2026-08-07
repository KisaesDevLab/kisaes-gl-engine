// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Leadsheet sign-off workflow (Phase 7.6–7.8, D18): preparer signs,
// then reviewer; each sign-off stamps the glVersionStamp so later GL /
// AJE / tax-entry changes flag it "signed before subsequent changes"
// (7.7) with one-click re-sign. tb_status 'complete' requires reviewer
// sign-off on every grouping (7.8; firm-admin override, audited).

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { tbGroupings, tbLeadsheetSignoffs } from '../../db/schema/index.js';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../middleware/audit.js';
import { getGlVersionStamp } from './balance-engine.service.js';

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
      eq(tbLeadsheetSignoffs.tenantId, tenantId),
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

// Live sign-offs for a tax year with staleness computed against the
// CURRENT stamp (7.7). "Stale" = GL/AJE/tax-entry activity after the
// signature. Tax RJEs never touch the GL, so the Phase-8 tax-entry
// service bumps gl_version_stamps itself — that keeps BOTH this
// staleness check and the workpaper cache key exact for RJE edits.
export async function listSignoffs(tenantId: string, companyId: string, taxYear: number) {
  const [signoffs, currentStamp] = await Promise.all([
    db.select().from(tbLeadsheetSignoffs)
      .where(and(
        eq(tbLeadsheetSignoffs.tenantId, tenantId),
        eq(tbLeadsheetSignoffs.companyId, companyId),
        eq(tbLeadsheetSignoffs.taxYear, taxYear),
        isNull(tbLeadsheetSignoffs.invalidatedAt),
      )),
    getGlVersionStamp(tenantId, companyId),
  ]);
  return {
    signoffs: signoffs.map((s) => ({
      ...s,
      stale: Number(s.glVersionStampAtSignoff) < currentStamp,
    })),
    currentStamp,
  };
}

// Sign a grouping. Reviewer requires a live preparer sign-off first
// (7.6). Re-signing invalidates the prior signature of that role (and,
// for a preparer re-sign, the reviewer's too — review must follow prep).
export async function sign(tenantId: string, companyId: string, input: { taxYear: number; groupingId: string; role: 'preparer' | 'reviewer' }, userId: string) {
  const [grouping] = await db.select().from(tbGroupings)
    .where(and(eq(tbGroupings.id, input.groupingId), eq(tbGroupings.tenantId, tenantId), eq(tbGroupings.companyId, companyId)))
    .limit(1);
  if (!grouping) throw AppError.notFound('Grouping not found');

  return db.transaction(async (tx) => {
    const live = await tx.select().from(tbLeadsheetSignoffs)
      .where(and(
        eq(tbLeadsheetSignoffs.groupingId, input.groupingId),
        eq(tbLeadsheetSignoffs.taxYear, input.taxYear),
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
      taxYear: input.taxYear,
      groupingId: input.groupingId,
      role: input.role,
      userId,
      glVersionStampAtSignoff: stamp,
    }).returning();
    if (!row) throw AppError.internal('Sign-off insert failed');
    await auditLog(tenantId, 'signoff', 'tb_leadsheet_signoff', row.id,
      invalidate.length ? { invalidated: invalidate.map((s) => s.id) } : null,
      { groupingId: input.groupingId, role: input.role, taxYear: input.taxYear, stamp },
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
