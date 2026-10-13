// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Q51 — what one portal contact may see of the tax estimates shared with them
// (OPEN-QUESTIONS Q51; MODULE.md D5 / D10 amendment).
//
// MODEL. One row per portal contact (tax_est_portal_contact_options, migration 0211); it
// applies to every taxpayer the contact can open. No row = DEFAULT_PORTAL_CONTACT_TAX_OPTIONS,
// exactly the view before Q51. The row carries the contact's tenant so every read and write is
// tenant-scoped.
//
// GRANT / REVOKE (Q41(7), R4-08). Turning a section ON is a grant: it needs the Tax Estimator
// gates (`canGrant`; the tenant route computes it from taxEstimateReportScope, the firm route
// is behind requireTaxEstimatorWrite). Turning a section OFF is a revoke any staff who manage
// the contact may do. Every change writes one `tax_est_portal_options` audit row on the
// CONTACT's tenant with before / after and the granted / revoked keys.
import { and, eq } from 'drizzle-orm';
import {
  DEFAULT_PORTAL_CONTACT_TAX_OPTIONS, mostRestrictivePortalOptions, portalOptionChanges,
  type PortalContactTaxOptionsDTO, type PortalContactTaxOptionsInput,
} from '@kis-books/shared';
import { db, type DbOrTx } from '../../db/index.js';
import { portalContacts } from '../../db/schema/index.js';
import { taxEstPortalContactOptions } from '../../db/schema/tax-estimator-portal.js';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../middleware/audit.js';

type Row = typeof taxEstPortalContactOptions.$inferSelect;

const toDTO = (r: Row | undefined): PortalContactTaxOptionsDTO => (r
  ? { calculationSummary: r.calculationSummary, quarterlyEstimates: r.quarterlyEstimates, paymentsOnRecord: r.paymentsOnRecord, pdfDownload: r.pdfDownload }
  : { ...DEFAULT_PORTAL_CONTACT_TAX_OPTIONS });

export const optionsGrantForbidden = () => AppError.forbidden(
  'Turning on a tax estimate section needs Tax Estimator access for this client (firm staff)', 'TE_ACCESS_GRANT_FORBIDDEN',
);

/** The contact's options (defaults when no row). Tenant-scoped: another tenant's contact reads defaults, never its row. */
export async function optionsForContact(tenantId: string, contactId: string, exec: DbOrTx = db): Promise<PortalContactTaxOptionsDTO> {
  const [row] = await exec.select().from(taxEstPortalContactOptions)
    .where(and(eq(taxEstPortalContactOptions.portalContactId, contactId), eq(taxEstPortalContactOptions.tenantId, tenantId)));
  return toDTO(row);
}

/**
 * Q52: the options one PERSON matched to several contacts of the tenant gets — the most
 * restrictive combination (AND of every switch) of each contact's `optionsForContact`.
 */
export async function mostRestrictiveOptionsForContacts(tenantId: string, contactIds: readonly string[], exec: DbOrTx = db): Promise<PortalContactTaxOptionsDTO> {
  const list = await Promise.all([...new Set(contactIds)].map((id) => optionsForContact(tenantId, id, exec)));
  return mostRestrictivePortalOptions(list);
}

async function contactInTenant(tenantId: string, contactId: string, exec: DbOrTx) {
  const [c] = await exec.select({ id: portalContacts.id, status: portalContacts.status }).from(portalContacts)
    .where(and(eq(portalContacts.id, contactId), eq(portalContacts.tenantId, tenantId)));
  if (!c) throw AppError.notFound('Portal contact not found');
  return c;
}

/** GET (tenant side): the contact must belong to the tenant. */
export async function getContactOptions(tenantId: string, contactId: string): Promise<PortalContactTaxOptionsDTO> {
  await contactInTenant(tenantId, contactId, db);
  return optionsForContact(tenantId, contactId);
}

export interface SetOptionsContext {
  actorUserId?: string;
  /** true = the caller passes the Tax Estimator gates and may turn a section ON. */
  canGrant: boolean;
  /** Where the change came from, for the audit row. */
  via: 'portal_contact' | 'taxpayer';
  taxpayerId?: string;
  firmId?: string;
}

/**
 * Apply a partial change. Absent keys keep their stored value. A grant without `canGrant`
 * is refused as a whole (403 TE_ACCESS_GRANT_FORBIDDEN) — nothing is written.
 */
export async function setContactOptions(
  tenantId: string, contactId: string, input: PortalContactTaxOptionsInput, ctx: SetOptionsContext, exec?: DbOrTx,
): Promise<PortalContactTaxOptionsDTO> {
  const run = async (tx: DbOrTx) => {
    await contactInTenant(tenantId, contactId, tx);
    const [current] = await tx.select().from(taxEstPortalContactOptions)
      .where(and(eq(taxEstPortalContactOptions.portalContactId, contactId), eq(taxEstPortalContactOptions.tenantId, tenantId)))
      .for('update');
    const before = toDTO(current);
    const { merged, granted, revoked } = portalOptionChanges(before, input);
    if (granted.length > 0 && !ctx.canGrant) throw optionsGrantForbidden();
    if (granted.length === 0 && revoked.length === 0) return before;
    await tx.insert(taxEstPortalContactOptions).values({ portalContactId: contactId, tenantId, ...merged, updatedBy: ctx.actorUserId ?? null })
      .onConflictDoUpdate({
        target: taxEstPortalContactOptions.portalContactId,
        set: { ...merged, updatedBy: ctx.actorUserId ?? null, updatedAt: new Date() },
      });
    await auditLog(tenantId, 'update', 'tax_est_portal_options', contactId, before,
      { ...merged, granted, revoked, via: ctx.via, ...(ctx.taxpayerId ? { taxpayerId: ctx.taxpayerId } : {}), ...(ctx.firmId ? { firmId: ctx.firmId } : {}) },
      ctx.actorUserId, tx);
    return merged;
  };
  return exec ? run(exec) : db.transaction(run);
}
