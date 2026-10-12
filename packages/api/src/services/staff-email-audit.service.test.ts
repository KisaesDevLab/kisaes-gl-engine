// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

// Every staff-facing sender goes through system-email; stub the transport so
// "sent" is deterministic and we can see exactly who each email went to.
const sent: Array<{ to: string; subject: string }> = [];
let failFor: string | null = null;
vi.mock('./system-email.service.js', async (orig) => {
  const real = await orig<typeof import('./system-email.service.js')>();
  return {
    ...real,
    isConfigured: vi.fn(async () => true),
    isSmtpConfigured: vi.fn(async () => true),
    sendActionEmail: vi.fn(async (p: { to: string; subject: string }) => {
      if (failFor && p.to === failFor) throw new Error('smtp 550');
      sent.push({ to: p.to, subject: p.subject });
    }),
  };
});

import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, companies, portalContacts, portalReceipts,
  documentRequests, recurringDocumentRequests, auditLog,
} from '../db/schema/index.js';
import { recordStaffEmail } from './staff-email-audit.service.js';
import { notifyStaffOfSubmission } from './recurring-doc-request.service.js';
import { notifyStaffOfSuggestions } from './client-suggestion-review.service.js';
import { notifyStaffOfPortalBillUpload } from './bill-capture.service.js';

interface StaffEmailRow {
  kind: string; subject: string; recipientUserIds: string[]; recipientCount: number;
  tenantId: string; sourceEntityType: string | null; sourceEntityId: string | null;
}

describe('staff email audit', () => {
  const stamp = Date.now();
  let tenantId: string;
  let otherTenantId: string;
  let companyId: string;
  let contactId: string;
  let receiptId: string;
  let kurt: { id: string; email: string };
  let dawn: { id: string; email: string };
  let gary: { id: string; email: string };

  async function rows(): Promise<StaffEmailRow[]> {
    const r = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'staff_email')))
      .orderBy(auditLog.id);
    return r.map((x) => {
      const a = x.afterData as unknown;
      return (typeof a === 'string' ? JSON.parse(a) : a) as StaffEmailRow;
    });
  }

  beforeAll(async () => {
    const [t] = await db.insert(tenants).values({ name: 'SEA Client LLC', slug: `test-sea-${stamp}` }).returning();
    tenantId = t!.id;
    const [o] = await db.insert(tenants).values({ name: 'SEA Other', slug: `test-sea-other-${stamp}` }).returning();
    otherTenantId = o!.id;
    const mk = async (name: string, role: 'owner' | 'accountant') => {
      const email = `sea-${name}-${stamp}@example.com`;
      const [u] = await db.insert(users).values({
        tenantId, email, passwordHash: 'x', role, userType: 'staff', displayName: name,
      }).returning();
      await db.insert(userTenantAccess).values({ userId: u!.id, tenantId, role, isActive: true });
      return { id: u!.id, email };
    };
    kurt = await mk('kurt', 'owner');
    dawn = await mk('dawn', 'owner');
    gary = await mk('gary', 'accountant');
    const [co] = await db.insert(companies).values({ tenantId, businessName: 'SEA Co' }).returning();
    companyId = co!.id;
    const [c] = await db.insert(portalContacts).values({
      tenantId, email: `sea-contact-${stamp}@example.com`, firstName: 'Irene', lastName: 'Client',
    }).returning();
    contactId = c!.id;
    const [r] = await db.insert(portalReceipts).values({
      tenantId, companyId, captureSource: 'portal', uploadedBy: contactId, uploadedByType: 'contact',
      storageKey: `test/${stamp}/ar.pdf`, filename: 'ar.pdf',
    }).returning();
    receiptId = r!.id;
  });

  afterAll(async () => {
    for (const id of [tenantId, otherTenantId]) {
      if (!id) continue;
      await db.delete(auditLog).where(eq(auditLog.tenantId, id));
      await db.delete(documentRequests).where(eq(documentRequests.tenantId, id));
      await db.delete(recurringDocumentRequests).where(eq(recurringDocumentRequests.tenantId, id));
      await db.delete(portalReceipts).where(eq(portalReceipts.tenantId, id));
      await db.delete(portalContacts).where(eq(portalContacts.tenantId, id));
      await db.delete(companies).where(eq(companies.tenantId, id));
      await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, id));
      await db.delete(users).where(eq(users.tenantId, id));
      await db.delete(tenants).where(eq(tenants.id, id));
    }
  });

  beforeEach(async () => {
    sent.length = 0;
    failFor = null;
    await db.delete(auditLog).where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'staff_email')));
  });

  describe('recordStaffEmail', () => {
    it('writes one row with user ids only, resolving addresses to ids', async () => {
      await recordStaffEmail({
        tenantId, kind: 'firm_invite', subject: 'S1',
        recipientEmails: [kurt.email.toUpperCase(), 'nobody-' + stamp + '@example.com'],
        sourceEntityType: 'firm_invite', sourceEntityId: '00000000-0000-4000-8000-000000000001',
      });
      const [row, ...rest] = await rows();
      expect(rest).toHaveLength(0);
      expect(row).toEqual({
        kind: 'firm_invite', subject: 'S1', recipientUserIds: [kurt.id], recipientCount: 2,
        tenantId, sourceEntityType: 'firm_invite', sourceEntityId: '00000000-0000-4000-8000-000000000001',
      });
      // Never the addresses themselves.
      expect(JSON.stringify(row)).not.toContain('@example.com');
      const [raw] = await db.select().from(auditLog)
        .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'staff_email')));
      expect(raw!.action).toBe('create');
      expect(raw!.entityId).toBe('00000000-0000-4000-8000-000000000001');
    });

    it('skips empty sends, tolerates non-uuid source ids, and never throws', async () => {
      await recordStaffEmail({ tenantId, kind: 'team_invite', subject: 'none', recipientUserIds: [] });
      expect(await rows()).toHaveLength(0);
      await recordStaffEmail({ tenantId, kind: 'team_invite', subject: 'x', recipientUserIds: [gary.id], sourceEntityId: 'not-a-uuid' });
      expect((await rows())[0]!.sourceEntityId).toBe('not-a-uuid');
      // FK violation on tenant → swallowed.
      await expect(recordStaffEmail({
        tenantId: '00000000-0000-4000-8000-0000000000ff', kind: 'team_invite', subject: 'x', recipientUserIds: [gary.id],
      })).resolves.toBeUndefined();
    });
  });

  describe('doc-request submission notice', () => {
    it('emails only the rule notify list and records exactly those recipients', async () => {
      const [rule] = await db.insert(recurringDocumentRequests).values({
        tenantId, contactId, documentType: 'other', description: 'Month End A/R Report',
        frequency: 'monthly', intervalValue: 1, nextIssueAt: new Date(), notifyUserIds: [kurt.id],
      }).returning();
      const [req] = await db.insert(documentRequests).values({
        tenantId, companyId, contactId, recurringId: rule!.id, documentType: 'other',
        description: 'Month End A/R Report', periodLabel: 'September 2026',
      }).returning();
      const out = await notifyStaffOfSubmission(tenantId, req!.id, receiptId);
      expect(out).toEqual({ sent: 1, skipped: null });
      expect(sent.map((s) => s.to)).toEqual([kurt.email]);
      const [row, ...rest] = await rows();
      expect(rest).toHaveLength(0);
      expect(row).toMatchObject({
        kind: 'doc_request_submission', recipientUserIds: [kurt.id], recipientCount: 1,
        sourceEntityType: 'document_request', sourceEntityId: req!.id,
      });
      expect(row!.subject).toBe(sent[0]!.subject);
    });
  });

  describe('client suggestion notice', () => {
    it('records every reviewer it emailed (self-managed: owners), minus failures', async () => {
      failFor = dawn.email;
      const out = await notifyStaffOfSuggestions(tenantId, companyId, { contactId }, 3);
      expect(out.sent).toBe(1);
      expect(sent.map((s) => s.to)).toEqual([kurt.email]);
      const [row, ...rest] = await rows();
      expect(rest).toHaveLength(0);
      expect(row).toMatchObject({
        kind: 'client_suggestions', recipientUserIds: [kurt.id], recipientCount: 1,
        sourceEntityType: 'portal_contact', sourceEntityId: contactId,
      });
      expect(row!.subject).toBe('SEA Client LLC: Irene Client categorized 3 transactions');
    });
  });

  describe('bill capture upload notice', () => {
    it('records the owners it fell back to', async () => {
      await notifyStaffOfPortalBillUpload({ tenantId, companyId, contactId, fileCount: 2 });
      expect(sent.map((s) => s.to).sort()).toEqual([kurt.email, dawn.email].sort());
      const [row, ...rest] = await rows();
      expect(rest).toHaveLength(0);
      expect(row).toMatchObject({
        kind: 'bill_capture_upload', recipientCount: 2,
        sourceEntityType: 'company', sourceEntityId: companyId,
      });
      expect([...row!.recipientUserIds].sort()).toEqual([kurt.id, dawn.id].sort());
      expect(row!.subject).toBe('2 bills uploaded — SEA Co');
    });
  });

  it('sanity: nothing leaked into another tenant', async () => {
    const n = await db.select({ n: sql<number>`count(*)::int` }).from(auditLog)
      .where(and(eq(auditLog.tenantId, otherTenantId), eq(auditLog.entityType, 'staff_email')));
    expect(n[0]!.n).toBe(0);
  });
});
