// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Bare /portal/login (no ?firm=, no custom domain) resolves the firm
// FROM the email so a contact who just types their address gets a
// sign-in link. resolveActiveContactTenants underpins that path.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, portalContacts } from '../db/schema/index.js';
import { resolveActiveContactTenants } from './portal-auth.service.js';

const uniq = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
const EMAIL = `resolve-${uniq}@example.com`;
const tenantIds: string[] = [];

beforeEach(async () => {
  for (const n of ['A', 'B', 'C']) {
    const [t] = await db.insert(tenants).values({ name: `Resolve ${n}`, slug: `resolve-${n}-${uniq}` }).returning();
    tenantIds.push(t!.id);
  }
  // Active contact in A and B; INACTIVE (deleted) in C.
  await db.insert(portalContacts).values({ tenantId: tenantIds[0]!, email: EMAIL, status: 'active' });
  await db.insert(portalContacts).values({ tenantId: tenantIds[1]!, email: EMAIL, status: 'active' });
  await db.insert(portalContacts).values({ tenantId: tenantIds[2]!, email: EMAIL, status: 'deleted' });
});

afterEach(async () => {
  await db.delete(portalContacts).where(inArray(portalContacts.tenantId, tenantIds));
  await db.delete(tenants).where(inArray(tenants.id, tenantIds));
  tenantIds.length = 0;
});

describe('resolveActiveContactTenants', () => {
  it('returns every tenant where the email is an ACTIVE contact', async () => {
    const got = await resolveActiveContactTenants(EMAIL);
    expect(got.sort()).toEqual([tenantIds[0], tenantIds[1]].sort());
    expect(got).not.toContain(tenantIds[2]); // inactive excluded
  });

  it('is case-insensitive on the email', async () => {
    const got = await resolveActiveContactTenants(EMAIL.toUpperCase());
    expect(got.sort()).toEqual([tenantIds[0], tenantIds[1]].sort());
  });

  it('returns [] for an unknown email (enumeration-safe: caller still answers ok)', async () => {
    expect(await resolveActiveContactTenants(`nobody-${uniq}@example.com`)).toEqual([]);
  });

  it('returns [] for a malformed email', async () => {
    expect(await resolveActiveContactTenants('not-an-email')).toEqual([]);
  });
});
