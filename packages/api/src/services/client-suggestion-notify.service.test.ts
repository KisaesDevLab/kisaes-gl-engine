// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Per-client notify list for the "client categorized N transactions" email
// (migration 0203). Empty list = no email; only listed users; access and
// staff type re-checked at send time; the team path follows the same list.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

const sent: string[] = [];
vi.mock('./system-email.service.js', async (orig) => {
  const real = await orig<typeof import('./system-email.service.js')>();
  return {
    ...real,
    isConfigured: vi.fn(async () => true),
    isSmtpConfigured: vi.fn(async () => true),
    sendActionEmail: vi.fn(async (p: { to: string }) => { sent.push(p.to); }),
  };
});

import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, companies, portalContacts, auditLog, suggestionNotifySettings,
} from '../db/schema/index.js';
import {
  notifyStaffOfSuggestions, getSuggestionNotifyList, setSuggestionNotifyList,
} from './client-suggestion-review.service.js';

describe('client-suggestion notify list', () => {
  const stamp = Date.now();
  let tenantId = '';
  let otherTenantId = '';
  let companyId = '';
  let contactId = '';
  const u: Record<string, { id: string; email: string }> = {};

  beforeAll(async () => {
    const [t] = await db.insert(tenants).values({ name: 'CSN Client', slug: `test-csn-${stamp}` }).returning();
    tenantId = t!.id;
    const [o] = await db.insert(tenants).values({ name: 'CSN Other', slug: `test-csn-o-${stamp}` }).returning();
    otherTenantId = o!.id;
    const mk = async (key: string, opts: { role?: string; userType?: 'staff' | 'client'; access?: boolean; home?: string } = {}) => {
      const email = `csn-${key}-${stamp}@example.com`;
      const [row] = await db.insert(users).values({
        tenantId: opts.home ?? tenantId, email, passwordHash: 'x', role: opts.role ?? 'accountant',
        userType: opts.userType ?? 'staff', displayName: key,
      }).returning();
      if (opts.access !== false) {
        await db.insert(userTenantAccess).values({ userId: row!.id, tenantId, role: opts.role ?? 'accountant', isActive: true });
      }
      u[key] = { id: row!.id, email };
    };
    await mk('kurt', { role: 'owner' });
    await mk('dawn');
    await mk('gary');
    await mk('client', { userType: 'client', role: 'readonly' });
    await mk('outsider', { access: false, home: otherTenantId });
    const [co] = await db.insert(companies).values({ tenantId, businessName: 'CSN Co' }).returning();
    companyId = co!.id;
    const [c] = await db.insert(portalContacts).values({
      tenantId, email: `csn-contact-${stamp}@example.com`, firstName: 'Irene',
    }).returning();
    contactId = c!.id;
  });

  afterAll(async () => {
    for (const id of [tenantId, otherTenantId]) {
      if (!id) continue;
      await db.delete(auditLog).where(eq(auditLog.tenantId, id));
      await db.delete(portalContacts).where(eq(portalContacts.tenantId, id));
      await db.delete(companies).where(eq(companies.tenantId, id));
      await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, id));
      await db.delete(users).where(eq(users.tenantId, id));
      await db.delete(tenants).where(eq(tenants.id, id));
    }
  });

  beforeEach(async () => {
    sent.length = 0;
    await db.delete(suggestionNotifySettings).where(eq(suggestionNotifySettings.tenantId, tenantId));
    await db.update(userTenantAccess).set({ isActive: true }).where(eq(userTenantAccess.tenantId, tenantId));
  });

  it('a client with no list (the default for existing clients) sends no email', async () => {
    expect(await getSuggestionNotifyList(tenantId)).toEqual([]);
    const out = await notifyStaffOfSuggestions(tenantId, companyId, { contactId }, 4);
    expect(out).toEqual({ sent: 0, skipped: 'no_recipients' });
    expect(sent).toEqual([]);
    // An explicitly emptied list behaves the same.
    await setSuggestionNotifyList(tenantId, [], u['kurt']!.id);
    expect(await notifyStaffOfSuggestions(tenantId, companyId, { contactId }, 4)).toEqual({ sent: 0, skipped: 'no_recipients' });
    expect(sent).toEqual([]);
  });

  it('emails only the listed users — never the other reviewers', async () => {
    await setSuggestionNotifyList(tenantId, [u['kurt']!.id], u['kurt']!.id);
    const out = await notifyStaffOfSuggestions(tenantId, companyId, { contactId }, 2);
    expect(out).toEqual({ sent: 1, skipped: null });
    expect(sent).toEqual([u['kurt']!.email]);
  });

  it('skips a listed user whose access was removed after the list was saved', async () => {
    await setSuggestionNotifyList(tenantId, [u['kurt']!.id, u['dawn']!.id], u['kurt']!.id);
    await db.update(userTenantAccess).set({ isActive: false })
      .where(and(eq(userTenantAccess.tenantId, tenantId), eq(userTenantAccess.userId, u['dawn']!.id)));
    const out = await notifyStaffOfSuggestions(tenantId, companyId, { contactId }, 1);
    expect(out.sent).toBe(1);
    expect(sent).toEqual([u['kurt']!.email]);
    // Nobody left → no email at all.
    await db.update(userTenantAccess).set({ isActive: false })
      .where(and(eq(userTenantAccess.tenantId, tenantId), eq(userTenantAccess.userId, u['kurt']!.id)));
    sent.length = 0;
    expect(await notifyStaffOfSuggestions(tenantId, companyId, { contactId }, 1))
      .toEqual({ sent: 0, skipped: 'no_eligible_recipients' });
    expect(sent).toEqual([]);
  });

  it('the team-member path follows the same list and never mails the submitter', async () => {
    await setSuggestionNotifyList(tenantId, [u['kurt']!.id, u['gary']!.id], u['kurt']!.id);
    const out = await notifyStaffOfSuggestions(tenantId, companyId, { userId: u['gary']!.id }, 3);
    expect(out.sent).toBe(1);
    expect(sent).toEqual([u['kurt']!.email]);
  });

  it('saving validates (active staff with access only), de-duplicates and audits the change', async () => {
    await expect(setSuggestionNotifyList(tenantId, [u['client']!.id], u['kurt']!.id)).rejects.toThrow(/active staff/i);
    await expect(setSuggestionNotifyList(tenantId, [u['outsider']!.id], u['kurt']!.id)).rejects.toThrow(/active staff/i);
    expect(await getSuggestionNotifyList(tenantId)).toEqual([]);

    await setSuggestionNotifyList(tenantId, [u['dawn']!.id, u['dawn']!.id], u['kurt']!.id);
    expect(await getSuggestionNotifyList(tenantId)).toEqual([u['dawn']!.id]);
    await setSuggestionNotifyList(tenantId, [u['gary']!.id], u['kurt']!.id);
    expect(await getSuggestionNotifyList(tenantId)).toEqual([u['gary']!.id]);

    const audits = await db.select().from(auditLog).where(and(
      eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'suggestion_notify_settings'),
    )).orderBy(auditLog.id);
    const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as { notifyUserIds: string[] } | null;
    expect(audits.length).toBeGreaterThanOrEqual(2);
    const last = audits.at(-1)!;
    expect(last.action).toBe('update');
    expect(last.userId).toBe(u['kurt']!.id);
    expect(parse(last.beforeData)).toEqual({ notifyUserIds: [u['dawn']!.id] });
    expect(parse(last.afterData)).toEqual({ notifyUserIds: [u['gary']!.id] });
  });
});
