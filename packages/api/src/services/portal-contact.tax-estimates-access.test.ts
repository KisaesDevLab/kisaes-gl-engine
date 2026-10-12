// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Phase 13 (D5): portal_contact_companies.tax_estimates_access round-trips
// through the staff contact admin like financials_access — create, read (also feeds the
// portal /me), and set-company-assignments. R4-08: set-company-assignments deletes and
// re-inserts the rows, but a payload that OMITS the field keeps the stored grant, and a
// new grant needs the Tax Estimator gates (canGrantTaxEstimates) while a revoke does not.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditLog, companies, portalContactCompanies, portalContacts, tenants } from '../db/schema/index.js';
import { createContact, getContact, setCompanyAssignments } from './portal-contact.service.js';

let tenantId = '';
let companyId = '';
const uniq = () => Date.now() + '-' + Math.random().toString(36).slice(2, 7);

beforeEach(async () => {
  const [t] = await db.insert(tenants).values({ name: 'TE access', slug: `te-access-${uniq()}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Access Co' }).returning();
  companyId = c!.id;
});

afterEach(async () => {
  const rows = await db.select({ id: portalContacts.id }).from(portalContacts).where(eq(portalContacts.tenantId, tenantId));
  for (const r of rows) await db.delete(portalContactCompanies).where(eq(portalContactCompanies.contactId, r.id));
  await db.delete(portalContacts).where(eq(portalContacts.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

describe('tax_estimates_access on portal contact assignments', () => {
  it('defaults off, is stored on create, read back, and survives / resets with set-company-assignments', async () => {
    const plain = await createContact(tenantId, { email: `p-${uniq()}@ex.com`, companies: [{ companyId }] }, undefined);
    expect((await getContact(tenantId, plain.id)).companies[0]!.taxEstimatesAccess).toBe(false);

    await expect(createContact(tenantId, { email: `x-${uniq()}@ex.com`, companies: [{ companyId, taxEstimatesAccess: true }] }, undefined))
      .rejects.toMatchObject({ code: 'TE_ACCESS_GRANT_FORBIDDEN' });
    const granted = await createContact(tenantId, { email: `g-${uniq()}@ex.com`, companies: [{ companyId, taxEstimatesAccess: true }] }, undefined, { canGrantTaxEstimates: true });
    expect((await getContact(tenantId, granted.id)).companies[0]!.taxEstimatesAccess).toBe(true);

    await setCompanyAssignments(tenantId, granted.id, [{ companyId, financialsAccess: true, taxEstimatesAccess: true }]);
    expect((await getContact(tenantId, granted.id)).companies[0]).toMatchObject({ financialsAccess: true, taxEstimatesAccess: true });
    // Omitted → kept (R4-08), not silently reset.
    await setCompanyAssignments(tenantId, granted.id, [{ companyId, financialsAccess: true }]);
    expect((await getContact(tenantId, granted.id)).companies[0]!.taxEstimatesAccess).toBe(true);
    // Revoke needs no gate; re-grant does.
    await setCompanyAssignments(tenantId, granted.id, [{ companyId, taxEstimatesAccess: false }]);
    expect((await getContact(tenantId, granted.id)).companies[0]!.taxEstimatesAccess).toBe(false);
    await expect(setCompanyAssignments(tenantId, granted.id, [{ companyId, taxEstimatesAccess: true }]))
      .rejects.toMatchObject({ code: 'TE_ACCESS_GRANT_FORBIDDEN' });
    await setCompanyAssignments(tenantId, granted.id, [{ companyId, taxEstimatesAccess: true }], undefined, { canGrantTaxEstimates: true });
    expect((await getContact(tenantId, granted.id)).companies[0]!.taxEstimatesAccess).toBe(true);
  });
});
