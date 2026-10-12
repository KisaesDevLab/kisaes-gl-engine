// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Per-firm Tax Estimator settings (MODULE.md D4/D10/D17): safe-harbor default, disclaimer, portal default,
// taxpayer visibility switch (restrict_taxpayers_to_linked_tenants, default ON).
import { eq } from 'drizzle-orm';
import { DEFAULT_DISCLAIMER_TEXT, type FirmSettingsDTO, type UpsertFirmSettingsInput, type SafeHarborOverride, type PortalShows } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { taxEstFirmSettings } from '../../db/schema/tax-estimator-years.js';
import { AppError } from '../../utils/errors.js';
import type { FirmScope } from './firm-scope.service.js';
import { auditYears, type Actor } from './year-access.js';

type Row = typeof taxEstFirmSettings.$inferSelect;

function toDTO(firmId: string, r: Row | undefined): FirmSettingsDTO {
  return {
    firmId,
    safeHarborDefault: (r?.safeHarborDefault ?? 'lesser_of') as SafeHarborOverride,
    disclaimerText: r?.disclaimerText ?? null,
    effectiveDisclaimerText: r?.disclaimerText?.trim() ? r.disclaimerText : DEFAULT_DISCLAIMER_TEXT,
    portalShows: (r?.portalShows ?? 'live') as PortalShows,
    restrictTaxpayersToLinkedTenants: r ? r.restrictTaxpayersToLinkedTenants : true,
    updatedAt: r?.updatedAt ? r.updatedAt.toISOString() : null,
  };
}

/** Defaults apply when the firm has never saved settings. */
export async function getFirmSettings(scope: FirmScope): Promise<FirmSettingsDTO> {
  const [row] = await db.select().from(taxEstFirmSettings).where(eq(taxEstFirmSettings.firmId, scope.firmId));
  return toDTO(scope.firmId, row);
}

/** firm_admin ONLY (a firm_staff caller gets 403 TE_FIRM_ADMIN_REQUIRED). */
export async function upsertFirmSettings(scope: FirmScope, actor: Actor, input: UpsertFirmSettingsInput): Promise<FirmSettingsDTO> {
  if (scope.firmRole !== 'firm_admin') {
    throw AppError.forbidden('Firm administrator required', 'TE_FIRM_ADMIN_REQUIRED');
  }
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(taxEstFirmSettings).where(eq(taxEstFirmSettings.firmId, scope.firmId)).for('update');
    const values = {
      safeHarborDefault: input.safeHarborDefault ?? before?.safeHarborDefault ?? 'lesser_of',
      disclaimerText: input.disclaimerText === undefined ? (before?.disclaimerText ?? null) : input.disclaimerText,
      portalShows: input.portalShows ?? before?.portalShows ?? 'live',
      restrictTaxpayersToLinkedTenants: input.restrictTaxpayersToLinkedTenants ?? before?.restrictTaxpayersToLinkedTenants ?? true,
      updatedBy: actor.userId,
      updatedAt: new Date(),
    };
    const [row] = await tx.insert(taxEstFirmSettings).values({ firmId: scope.firmId, ...values })
      .onConflictDoUpdate({ target: taxEstFirmSettings.firmId, set: values }).returning();
    await auditYears(scope, actor, before ? 'update' : 'create', 'tax_est_firm_settings', scope.firmId,
      before ? toDTO(scope.firmId, before) : null, toDTO(scope.firmId, row), tx);
    // D17: the visibility switch gets its own metadata-only row, so who widened or narrowed
    // staff visibility (and when) is one audit query away.
    const was = before ? before.restrictTaxpayersToLinkedTenants : true;
    if (row && row.restrictTaxpayersToLinkedTenants !== was) {
      await auditYears(scope, actor, 'update', 'tax_est_visibility_switch', scope.firmId,
        { restrictTaxpayersToLinkedTenants: was }, { restrictTaxpayersToLinkedTenants: row.restrictTaxpayersToLinkedTenants }, tx);
    }
    return toDTO(scope.firmId, row);
  });
}
