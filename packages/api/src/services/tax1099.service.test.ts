// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Tax1099 e-filing: firm-level encrypted settings + the submitter rule
// (super-admin / firm_admin / accountant only) + end-to-end submission
// with the HTTP adapter mocked.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

vi.mock('./tax1099-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tax1099-client.js')>();
  return {
    ...actual,
    createSession: vi.fn(async () => ({ token: 'tok', baseUrl: 'https://mock' })),
    submitForms: vi.fn(async () => ({ referenceId: 'TEST-REF-1', raw: {} })),
    checkStatus: vi.fn(async () => ({ status: 'accepted', message: 'Accepted by IRS', raw: {} })),
  };
});

import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, auditLog, contacts,
  transactions, journalLines, tags, transactionTags,
  firms, firmUsers, tenantFirmAssignments, firmIntegrations,
  annual1099Filings,
} from '../db/schema/index.js';
import { vendor1099AccountMappings } from '../db/schema/portal-1099.js';
import * as ledger from './ledger.service.js';
import * as firmIntSvc from './firm-integrations.service.js';
import * as tax1099 from './tax1099.service.js';
import * as client from './tax1099-client.js';

let tenantId: string;
let firmId: string;

async function cleanDb() {
  await db.delete(annual1099Filings);
  await db.delete(vendor1099AccountMappings);
  await db.delete(firmIntegrations);
  await db.delete(tenantFirmAssignments);
  await db.delete(firmUsers);
  await db.delete(firms);
  await db.delete(transactionTags);
  await db.delete(tags);
  await db.delete(journalLines);
  await db.delete(transactions);
  await db.delete(auditLog);
  await db.delete(contacts);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
}

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb();
  const [t] = await db.insert(tenants).values({ name: 'T99', slug: `t99-${Date.now()}` }).returning();
  tenantId = t!.id;
  const [f] = await db.insert(firms).values({ name: 'CPA Firm', slug: `cpa-${Date.now()}` }).returning();
  firmId = f!.id;
  await db.insert(tenantFirmAssignments).values({ tenantId, firmId, isActive: true });
  await db.insert(companies).values({
    tenantId, businessName: 'Payer Co', legalName: 'Payer Co LLC', ein: '12-3456789',
    addressLine1: '1 Main St', city: 'Monett', state: 'MO', zip: '65708',
    entityType: 'sole_prop', setupComplete: true,
  });
});

afterEach(async () => {
  await cleanDb();
});

async function configureIntegration() {
  await firmIntSvc.saveTax1099Settings(firmId, {
    isEnabled: true, environment: 'sandbox',
    apiKey: 'key-123', username: 'user@firm.com', password: 'pw-123',
  });
}

describe('firm-level settings', () => {
  it('stores credentials encrypted, exposes has* only, honors the 3-state sentinel', async () => {
    await configureIntegration();
    const view = await firmIntSvc.getTax1099Settings(firmId);
    expect(view.hasApiKey).toBe(true);
    expect(view.hasPassword).toBe(true);
    expect((view as any).apiKey).toBeUndefined(); // never returned

    // Ciphertext at rest, not plaintext.
    const [row] = await db.select().from(firmIntegrations).where(eq(firmIntegrations.firmId, firmId));
    expect(row!.apiKeyEncrypted).not.toContain('key-123');

    // '' keeps; null clears.
    await firmIntSvc.saveTax1099Settings(firmId, { apiKey: '' });
    expect((await firmIntSvc.getTax1099Settings(firmId)).hasApiKey).toBe(true);
    await firmIntSvc.saveTax1099Settings(firmId, { apiKey: null });
    expect((await firmIntSvc.getTax1099Settings(firmId)).hasApiKey).toBe(false);

    // Decryption round-trip for the client.
    await firmIntSvc.saveTax1099Settings(firmId, { apiKey: 'key-456' });
    const creds = await firmIntSvc.getTax1099Credentials(firmId);
    expect(creds.apiKey).toBe('key-456');
    expect(creds.username).toBe('user@firm.com');
  });
});

describe('submitter rule', () => {
  it('allows accountant, firm_admin, super-admin; denies bookkeeper and owner', async () => {
    const [staff] = await db.insert(users).values({
      tenantId, email: `fa-${Date.now()}@x.com`, passwordHash: 'x', displayName: 'FA', role: 'bookkeeper',
    }).returning();
    await db.insert(firmUsers).values({ firmId, userId: staff!.id, firmRole: 'firm_admin', isActive: true });

    const cases: Array<[tax1099.SubmitterContext, boolean]> = [
      [{ userId: randomUUID(), userRole: 'accountant', isSuperAdmin: false }, true],
      [{ userId: randomUUID(), userRole: 'bookkeeper', isSuperAdmin: true }, true],
      [{ userId: staff!.id, userRole: 'bookkeeper', isSuperAdmin: false }, true], // firm_admin
      [{ userId: randomUUID(), userRole: 'bookkeeper', isSuperAdmin: false }, false],
      [{ userId: randomUUID(), userRole: 'owner', isSuperAdmin: false }, false],
      [{ userId: randomUUID(), userRole: 'readonly', isSuperAdmin: false }, false],
    ];
    for (const [ctx, expected] of cases) {
      const { allowed } = await tax1099.canSubmit(tenantId, ctx);
      expect(allowed, `${ctx.userRole}/${ctx.isSuperAdmin}`).toBe(expected);
    }
  });

  it('submitFilings rejects a disallowed role before any network call', async () => {
    await configureIntegration();
    await expect(tax1099.submitFilings(tenantId,
      { userId: randomUUID(), userRole: 'bookkeeper', isSuperAdmin: false },
      { taxYear: 2026, formType: '1099-NEC' },
    )).rejects.toThrow(/firm admin or an accountant/i);
    expect(client.createSession).not.toHaveBeenCalled();
  });
});

describe('submission end-to-end (client mocked)', () => {
  it('assembles payer + recipients, records the filing, and refreshes status', async () => {
    await configureIntegration();
    // Vendor with TIN + address, an expense account mapped to NEC-1,
    // and $1,200 of posted payments.
    const [checking] = await db.insert(accounts).values({ tenantId, name: 'Checking', accountNumber: '1000', accountType: 'asset', detailType: 'checking' }).returning();
    const [expAcct] = await db.insert(accounts).values({ tenantId, name: 'Contract Labor', accountNumber: '6100', accountType: 'expense' }).returning();
    const [vendor] = await db.insert(contacts).values({
      tenantId, displayName: 'Jane Contractor', contactType: 'vendor',
      is1099Eligible: true, taxId: '123-45-6789',
      billingLine1: '9 Oak Ave', billingCity: 'Monett', billingState: 'MO', billingZip: '65708',
    }).returning();
    await db.insert(vendor1099AccountMappings).values({ tenantId, accountId: expAcct!.id, formBox: 'NEC-1' });
    await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-06-01', memo: 'contract work', contactId: vendor!.id,
      lines: [
        { accountId: expAcct!.id, debit: '1200', credit: '0' },
        { accountId: checking!.id, debit: '0', credit: '1200' },
      ],
    });

    const result = await tax1099.submitFilings(tenantId,
      { userId: vendor!.id /* any uuid */, userRole: 'accountant', isSuperAdmin: false },
      { taxYear: 2026, formType: '1099-NEC' },
    );
    expect(result.providerReference).toBe('TEST-REF-1');
    expect(result.vendorCount).toBe(1);
    expect(result.totalAmount).toBeCloseTo(1200, 2);

    // Adapter got a complete payer + recipient payload.
    const submitArgs = (client.submitForms as any).mock.calls[0][1];
    expect(submitArgs.payer.ein).toBe('12-3456789');
    expect(submitArgs.recipients[0].tin).toBe('123-45-6789');
    expect(submitArgs.recipients[0].boxes['1']).toBeCloseTo(1200, 2);

    // Filing row: tax1099 format, submitted, masked snapshot only.
    const [filing] = await db.select().from(annual1099Filings)
      .where(and(eq(annual1099Filings.tenantId, tenantId), eq(annual1099Filings.id, result.filingId)));
    expect(filing!.exportFormat).toBe('tax1099');
    expect(filing!.submissionStatus).toBe('submitted');
    expect(filing!.providerReference).toBe('TEST-REF-1');
    expect(JSON.stringify(filing!.detailsJson)).not.toContain('123-45-6789');

    // Status refresh maps the provider response onto the row.
    const refreshed = await tax1099.refreshFilingStatus(tenantId, result.filingId);
    expect(refreshed.status).toBe('accepted');
    const [after] = await db.select().from(annual1099Filings)
      .where(eq(annual1099Filings.id, result.filingId));
    expect(after!.submissionStatus).toBe('accepted');
  });
});
