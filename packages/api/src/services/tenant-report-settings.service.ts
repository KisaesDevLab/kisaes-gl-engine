import { eq } from 'drizzle-orm';
import {
  resolvePLLabels,
  type PLSectionLabels,
  type TenantReportSettings,
  type UpdateTenantReportSettingsInput,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { tenants } from '../db/schema/index.js';

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

/**
 * Replace-semantics update. When `plLabels` is present in the input, it
 * REPLACES the stored object entirely — including clearing fields that
 * were previously customized but aren't in the new payload. This matches
 * the Settings UI, which sends only the fields still differing from
 * defaults so the "Reset to defaults" flow actually reverts. An absent
 * `plLabels` key (vs. an empty object) leaves existing labels untouched.
 */
export async function updateSettings(
  tenantId: string,
  input: UpdateTenantReportSettingsInput,
): Promise<TenantReportSettings> {
  const existing = await getSettings(tenantId);
  const next: TenantReportSettings = {
    ...existing,
    ...(input.plLabels !== undefined ? { plLabels: input.plLabels } : {}),
  };
  await db.update(tenants).set({ reportSettings: next }).where(eq(tenants.id, tenantId));
  return next;
}
