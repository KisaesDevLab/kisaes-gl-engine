// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Adding a portal contact whose email is already on file in the tenant.
// The email is unique per tenant, deleted contacts included, so a deleted
// contact is restored with what was entered; a live one is refused with its
// id/status/name unless the caller asks to add the companies to it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditLog, companies, portalContactCompanies, portalContacts, tenants } from '../db/schema/index.js';
import { createContact, getContact, setCompanyAssignments, softDeleteContact } from './portal-contact.service.js';

let tenantId = '';
let coA = '';
let coB = '';
const uniq = () => Date.now() + '-' + Math.random().toString(36).slice(2, 7);

beforeEach(async () => {
  const [t] = await db.insert(tenants).values({ name: 'Dup email', slug: `dup-email-${uniq()}` }).returning();
  tenantId = t!.id;
  const [a] = await db.insert(companies).values({ tenantId, businessName: 'Alpha Co' }).returning();
  const [b] = await db.insert(companies).values({ tenantId, businessName: 'Beta Co' }).returning();
  coA = a!.id;
  coB = b!.id;
});

afterEach(async () => {
  const rows = await db.select({ id: portalContacts.id }).from(portalContacts).where(eq(portalContacts.tenantId, tenantId));
  for (const r of rows) await db.delete(portalContactCompanies).where(eq(portalContactCompanies.contactId, r.id));
  await db.delete(portalContacts).where(eq(portalContacts.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

describe('createContact with an email already on file', () => {
  it('refuses a live contact with its id, status and name', async () => {
    const email = `live-${uniq()}@ex.com`;
    const first = await createContact(tenantId, { email, firstName: 'Kurt', lastName: 'Krueger', companies: [{ companyId: coA }] });
    expect(first.outcome).toBe('created');
    await expect(createContact(tenantId, { email: email.toUpperCase(), companies: [{ companyId: coB }] }))
      .rejects.toMatchObject({ code: 'DUPLICATE_EMAIL', details: { contactId: first.id, status: 'active', name: 'Kurt Krueger' } });
  });

  it('adds only the new companies to a live contact on request, keeping current access', async () => {
    const email = `merge-${uniq()}@ex.com`;
    const first = await createContact(tenantId, { email, companies: [{ companyId: coA }] });
    await setCompanyAssignments(tenantId, first.id, [{ companyId: coA, financialsAccess: true }]);

    const merged = await createContact(tenantId, {
      email, phone: '4175550100', firstName: 'Kurt',
      companies: [{ companyId: coA }, { companyId: coB, role: 'bookkeeper_liaison' }], mergeIntoExisting: true,
    });
    expect(merged).toEqual({ id: first.id, outcome: 'merged' });
    const got = await getContact(tenantId, first.id);
    const byCo = new Map(got.companies.map((c) => [c.companyId, c]));
    expect(byCo.get(coA)!.financialsAccess).toBe(true); // unchanged
    expect(byCo.get(coB)!.role).toBe('bookkeeper_liaison'); // added
    expect(got.phone).toBe('4175550100'); // filled in, was empty
    expect(got.firstName).toBe('Kurt');
  });

  it('restores a deleted contact with the details entered and fresh company access', async () => {
    const email = `gone-${uniq()}@ex.com`;
    const first = await createContact(tenantId, { email, firstName: 'Old', companies: [{ companyId: coA, financialsAccess: true }] });
    await softDeleteContact(tenantId, first.id);

    const again = await createContact(tenantId, { email, firstName: 'Kurt', phone: '4175550100', companies: [{ companyId: coB }] });
    expect(again).toEqual({ id: first.id, outcome: 'restored' });
    const got = await getContact(tenantId, first.id);
    expect(got.status).toBe('active');
    expect(got.firstName).toBe('Kurt');
    expect(got.companies.map((c) => c.companyId)).toEqual([coB]);
  });
});
