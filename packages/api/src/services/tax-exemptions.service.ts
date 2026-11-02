// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Exemption certificates (U-151, tax-exemptions-v1). A client's resale or
 * exemption certificate: number (at most 50), state, expiry (none = does not
 * expire), an attachment of the same company filed on the same client, a
 * note. Deactivated, never deleted. Previews of a client whose tax code is
 * not taxable warn (Q-P23n): EXEMPTION_MISSING (no active certificate),
 * EXEMPTION_EXPIRED (every active one expired before the document date),
 * EXEMPTION_EXPIRING (the best one expires within 30 days). Audit rows and
 * logs carry ids only, never certificate numbers.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../db/index.js';
import { attachments, contacts, contactTaxExemptions, salesTaxCodes } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { claimIdempotency, recordIdempotentEntity } from './idempotency.service.js';

export const EXPIRING_DAYS = 30;
type Row = typeof contactTaxExemptions.$inferSelect;

export interface ExemptionInput {
  contactId: string;
  number: string;
  state?: string | null;
  expiresOn?: string | null;
  attachmentId?: string | null;
  note?: string | null;
}

const notFound = () => AppError.notFound('Exemption certificate not found');

function out(r: Row) {
  return {
    id: r.id, contactId: r.contactId, number: r.number, state: r.state ?? null, expiresOn: r.expiresOn ?? null,
    attachmentId: r.attachmentId ?? null, note: r.note ?? null, isActive: r.isActive, updatedAt: r.updatedAt.toISOString(),
  };
}

async function assertClient(executor: DbOrTx, tenantId: string, companyId: string, contactId: string) {
  const [c] = await executor.select().from(contacts).where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId))).limit(1);
  if (!c || (c.companyId !== null && c.companyId !== companyId) || !['customer', 'both'].includes(c.contactType)) {
    throw AppError.badRequest('Choose a client of this company.', 'VALIDATION_ERROR', { field: 'contactId' });
  }
}

/** The attachment must be a file of this company filed on this client. */
async function assertAttachment(executor: DbOrTx, tenantId: string, companyId: string, contactId: string, attachmentId: string | null | undefined) {
  if (!attachmentId) return;
  const [a] = await executor.select().from(attachments).where(and(eq(attachments.tenantId, tenantId), eq(attachments.id, attachmentId))).limit(1);
  if (!a || (a.companyId !== null && a.companyId !== companyId) || a.attachableType !== 'contact' || a.attachableId !== contactId) {
    throw AppError.badRequest('Attach a file of this client.', 'VALIDATION_ERROR', { field: 'attachmentId' });
  }
}

function clean(input: Partial<ExemptionInput>) {
  const number = input.number?.trim();
  if (input.number !== undefined && (!number || number.length > 50)) {
    throw AppError.badRequest('The certificate number is 1 to 50 characters.', 'VALIDATION_ERROR', { field: 'number' });
  }
  return number;
}

async function load(executor: DbOrTx, tenantId: string, companyId: string, id: string, lock = false): Promise<Row> {
  const q = executor.select().from(contactTaxExemptions)
    .where(and(eq(contactTaxExemptions.tenantId, tenantId), eq(contactTaxExemptions.companyId, companyId), eq(contactTaxExemptions.id, id))).limit(1);
  const [r] = lock ? await q.for('update') : await q;
  if (!r) throw notFound();
  return r;
}

export async function listExemptions(tenantId: string, companyId: string, opts: { contactId?: string; includeInactive?: boolean } = {}) {
  const rows = await db.select().from(contactTaxExemptions).where(and(
    eq(contactTaxExemptions.tenantId, tenantId), eq(contactTaxExemptions.companyId, companyId),
    opts.contactId ? eq(contactTaxExemptions.contactId, opts.contactId) : undefined,
    opts.includeInactive ? undefined : eq(contactTaxExemptions.isActive, true),
  )).orderBy(asc(contactTaxExemptions.expiresOn), asc(contactTaxExemptions.createdAt));
  return { data: rows.map(out) };
}

export async function getExemption(tenantId: string, companyId: string, id: string) {
  return out(await load(db, tenantId, companyId, id));
}

export async function createExemption(tenantId: string, companyId: string, input: ExemptionInput, userId?: string) {
  const number = clean(input)!;
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    await assertClient(tx, tenantId, companyId, input.contactId);
    await assertAttachment(tx, tenantId, companyId, input.contactId, input.attachmentId);
    const [r] = await tx.insert(contactTaxExemptions).values({
      tenantId, companyId, contactId: input.contactId, number, state: input.state?.trim() || null, expiresOn: input.expiresOn ?? null,
      attachmentId: input.attachmentId ?? null, note: input.note ?? null,
    }).returning();
    await recordIdempotentEntity(tx, 'tax_exemption', r!.id);
    await auditLog(tenantId, 'create', 'tax_exemption', r!.id, null, { contactId: r!.contactId, expiresOn: r!.expiresOn, attachmentId: r!.attachmentId }, userId, tx);
    return out(r!);
  });
}

export async function updateExemption(
  tenantId: string, companyId: string, id: string, input: Partial<ExemptionInput> & { expectedUpdatedAt?: string }, userId?: string,
) {
  const number = clean(input);
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const before = await load(tx, tenantId, companyId, id, true);
    if (input.expectedUpdatedAt && new Date(input.expectedUpdatedAt).getTime() !== before.updatedAt.getTime()) {
      throw AppError.conflict('This certificate changed since you opened it.', 'STALE');
    }
    if (input.contactId && input.contactId !== before.contactId) await assertClient(tx, tenantId, companyId, input.contactId);
    const contactId = input.contactId ?? before.contactId;
    const attachmentId = input.attachmentId === undefined ? before.attachmentId : input.attachmentId;
    await assertAttachment(tx, tenantId, companyId, contactId, attachmentId);
    const [r] = await tx.update(contactTaxExemptions).set({
      contactId, number: number ?? before.number,
      state: input.state === undefined ? before.state : input.state?.trim() || null,
      expiresOn: input.expiresOn === undefined ? before.expiresOn : input.expiresOn,
      attachmentId, note: input.note === undefined ? before.note : input.note, updatedAt: new Date(),
    }).where(and(eq(contactTaxExemptions.tenantId, tenantId), eq(contactTaxExemptions.id, id))).returning();
    await recordIdempotentEntity(tx, 'tax_exemption', id);
    await auditLog(tenantId, 'update', 'tax_exemption', id, { contactId: before.contactId, expiresOn: before.expiresOn },
      { contactId: r!.contactId, expiresOn: r!.expiresOn, attachmentId: r!.attachmentId }, userId, tx);
    return out(r!);
  });
}

export async function setExemptionActive(tenantId: string, companyId: string, id: string, active: boolean, userId?: string) {
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    await load(tx, tenantId, companyId, id, true);
    const [r] = await tx.update(contactTaxExemptions).set({ isActive: active, updatedAt: new Date() })
      .where(and(eq(contactTaxExemptions.tenantId, tenantId), eq(contactTaxExemptions.id, id))).returning();
    await recordIdempotentEntity(tx, 'tax_exemption', id);
    await auditLog(tenantId, 'update', 'tax_exemption', id, { isActive: !active }, { isActive: active }, userId, tx);
    return out(r!);
  });
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Preview warnings for a client on a document dated `date` (Q-P23n): only
 * when the client's tax code is not taxable. [] otherwise.
 */
export async function exemptionWarnings(
  executor: DbOrTx, tenantId: string, companyId: string | null | undefined,
  customer: { id: string; taxCodeId?: string | null } | null | undefined, date: string,
): Promise<Array<{ code: string; message: string; details?: Record<string, unknown> }>> {
  if (!customer?.taxCodeId || !companyId) return [];
  const [code] = await executor.select({ taxable: salesTaxCodes.taxable }).from(salesTaxCodes)
    .where(and(eq(salesTaxCodes.tenantId, tenantId), eq(salesTaxCodes.id, customer.taxCodeId))).limit(1);
  if (!code || code.taxable) return [];
  const certs = await executor.select().from(contactTaxExemptions).where(and(eq(contactTaxExemptions.tenantId, tenantId),
    eq(contactTaxExemptions.companyId, companyId), eq(contactTaxExemptions.contactId, customer.id), eq(contactTaxExemptions.isActive, true)));
  if (certs.length === 0) return [{ code: 'EXEMPTION_MISSING', message: 'This client is not taxed but has no exemption certificate on file.' }];
  // The certificate that lasts longest (no expiry first).
  const best = certs.sort((a, b) => (b.expiresOn ?? '9999-12-31').localeCompare(a.expiresOn ?? '9999-12-31'))[0]!;
  if (!best.expiresOn) return [];
  if (best.expiresOn < date) {
    return [{ code: 'EXEMPTION_EXPIRED', message: 'This client\'s exemption certificate has expired.', details: { exemptionId: best.id, expiresOn: best.expiresOn } }];
  }
  const left = daysBetween(date, best.expiresOn);
  if (left <= EXPIRING_DAYS) {
    return [{ code: 'EXEMPTION_EXPIRING', message: `This client's exemption certificate expires in ${left} days.`, details: { exemptionId: best.id, expiresOn: best.expiresOn, daysLeft: left } }];
  }
  return [];
}

/**
 * GET /reports/exemptions-expiring: active certificates expired as of asOf
 * or expiring within `within` days, by expiry. A client with a later
 * certificate that is current is left out.
 */
export async function exemptionsExpiring(tenantId: string, companyId: string, asOf: string, within: number) {
  const r = await db.execute(sql`
    SELECT e.id, e.contact_id, c.display_name, e.number, e.state, to_char(e.expires_on, 'YYYY-MM-DD') AS expires_on
    FROM contact_tax_exemptions e
    JOIN contacts c ON c.id = e.contact_id AND c.tenant_id = e.tenant_id
    WHERE e.tenant_id = ${tenantId} AND e.company_id = ${companyId} AND e.is_active = true AND e.expires_on IS NOT NULL
      AND e.expires_on <= (${asOf}::date + ${within}::int)
      AND NOT EXISTS (
        SELECT 1 FROM contact_tax_exemptions l WHERE l.tenant_id = e.tenant_id AND l.company_id = e.company_id AND l.contact_id = e.contact_id
          AND l.is_active = true AND l.id <> e.id AND (l.expires_on IS NULL OR l.expires_on > (${asOf}::date + ${within}::int))
      )
    ORDER BY e.expires_on, c.display_name`);
  return {
    title: 'Exemption certificates expiring', asOf, within,
    data: (r.rows as Array<Record<string, any>>).map((x) => ({
      exemptionId: x['id'], contactId: x['contact_id'], contactName: x['display_name'], number: x['number'], state: x['state'],
      expiresOn: x['expires_on'], status: x['expires_on'] < asOf ? 'expired' : 'expiring', daysLeft: daysBetween(asOf, x['expires_on']),
    })),
  };
}
