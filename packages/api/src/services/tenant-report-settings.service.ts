// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq } from 'drizzle-orm';
import {
  resolvePLLabels,
  resolveBSLabels,
  resolveCFLabels,
  type PLSectionLabels,
  type BSSectionLabels,
  type CFSectionLabels,
  type TenantReportSettings,
  type UpdateTenantReportSettingsInput,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { tenants } from '../db/schema/index.js';
import { auditLog } from '../middleware/audit.js';

export async function getSettings(tenantId: string): Promise<TenantReportSettings> {
  const [row] = await db
    .select({ reportSettings: tenants.reportSettings })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return (row?.reportSettings as TenantReportSettings) ?? {};
}

export async function getPLLabels(tenantId: string): Promise<PLSectionLabels> {
  const settings = await getSettings(tenantId);
  return resolvePLLabels(settings.plLabels);
}

export async function getBSLabels(tenantId: string): Promise<BSSectionLabels> {
  const settings = await getSettings(tenantId);
  return resolveBSLabels(settings.bsLabels);
}

export async function getCFLabels(tenantId: string): Promise<CFSectionLabels> {
  const settings = await getSettings(tenantId);
  return resolveCFLabels(settings.cfLabels);
}

export async function getReportFooter(tenantId: string): Promise<string> {
  const settings = await getSettings(tenantId);
  return (settings.reportFooter ?? '').trim();
}

/**
 * Replace-semantics update. Each label group (plLabels/bsLabels/cfLabels)
 * is REPLACED entirely when present in the input — including clearing
 * previously-customized fields not in the new payload — so the Settings
 * UI's "Reset to defaults" flow actually reverts. An absent key vs. an
 * empty object leaves existing labels untouched. reportFooter follows
 * the same rule: present-but-empty clears, absent leaves alone.
 */
export async function updateSettings(
  tenantId: string,
  input: UpdateTenantReportSettingsInput,
  userId?: string,
): Promise<TenantReportSettings> {
  const existing = await getSettings(tenantId);
  const next: TenantReportSettings = {
    ...existing,
    ...(input.plLabels !== undefined ? { plLabels: input.plLabels } : {}),
    ...(input.bsLabels !== undefined ? { bsLabels: input.bsLabels } : {}),
    ...(input.cfLabels !== undefined ? { cfLabels: input.cfLabels } : {}),
    ...(input.reportFooter !== undefined ? { reportFooter: input.reportFooter } : {}),
  };
  await db.update(tenants).set({ reportSettings: next }).where(eq(tenants.id, tenantId));
  await auditLog(tenantId, 'update', 'tenant_report_settings', tenantId, existing, next, userId);
  return next;
}
