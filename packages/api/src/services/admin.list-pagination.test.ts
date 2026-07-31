// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// listTenants / listAllUsers paging + search. The unpaged call has to keep
// returning every row — the tenant-picker dropdowns (new user, feature flags,
// COA templates, Plaid mapping) still call GET /admin/tenants with no params.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users } from '../db/schema/index.js';
import * as admin from './admin.service.js';

// Unique token so the assertions ignore whatever else lives in the shared DB.
const token = `pagelist${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

let tenantIds: string[] = [];
let userIds: string[] = [];

beforeAll(async () => {
  for (let i = 0; i < 3; i++) {
    const [t] = await db.insert(tenants)
      .values({ name: `${token} Tenant ${i}`, slug: `${token}-tenant-${i}` })
      .returning();
    tenantIds.push(t!.id);
  }
  for (let i = 0; i < 3; i++) {
    const [u] = await db.insert(users).values({
      tenantId: tenantIds[0]!,
      email: `${token}-${i}@example.com`,
      passwordHash: 'x'.repeat(60),
      role: 'owner',
      displayName: `${token} User ${i}`,
      // Middle user inactive so the derived tenant isActive flag is exercised.
      isActive: i !== 1,
    }).returning();
    userIds.push(u!.id);
  }
});

afterAll(async () => {
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
  if (tenantIds.length) await db.delete(tenants).where(inArray(tenants.id, tenantIds));
  tenantIds = [];
  userIds = [];
});

describe('listTenants', () => {
  it('returns every row when no limit is supplied', async () => {
    const { tenants: rows, total } = await admin.listTenants();
    expect(rows.length).toBe(total);
    expect(rows.filter((t) => t.slug.startsWith(token)).length).toBe(3);
  });

  it('filters by name or slug and reports the matching total', async () => {
    const { tenants: rows, total } = await admin.listTenants({ search: token });
    expect(total).toBe(3);
    expect(rows.length).toBe(3);

    const bySlug = await admin.listTenants({ search: `${token}-tenant-1` });
    expect(bySlug.total).toBe(1);
  });

  it('pages with limit/offset while total stays the full match count', async () => {
    const first = await admin.listTenants({ search: token, limit: 2, offset: 0 });
    expect(first.tenants.length).toBe(2);
    expect(first.total).toBe(3);

    const second = await admin.listTenants({ search: token, limit: 2, offset: 2 });
    expect(second.tenants.length).toBe(1);
    expect(second.total).toBe(3);

    // The two pages together cover the match set exactly once.
    const seen = new Set([...first.tenants, ...second.tenants].map((t) => t.id));
    expect(seen.size).toBe(3);
  });

  it('derives isActive from whether any user in the tenant can still sign in', async () => {
    const { tenants: rows } = await admin.listTenants({ search: token });
    const withUsers = rows.find((t) => t.id === tenantIds[0])!;
    const empty = rows.find((t) => t.id === tenantIds[1])!;
    expect(withUsers.isActive).toBe(true);
    expect(withUsers.userCount).toBe(3);
    expect(empty.isActive).toBe(false);

    await db.update(users).set({ isActive: false }).where(eq(users.tenantId, tenantIds[0]!));
    const after = await admin.listTenants({ search: token });
    expect(after.tenants.find((t) => t.id === tenantIds[0])!.isActive).toBe(false);
    await db.update(users).set({ isActive: true }).where(eq(users.id, userIds[0]!));
  });
});

describe('listTenants paging with tied created_at', () => {
  // Tenants created in the same transaction (seeds, bulk client import) share
  // a created_at. Without an id tiebreaker in the ORDER BY, Postgres is free
  // to order the tie differently per query, so LIMIT/OFFSET pages could repeat
  // one row and skip another.
  const tiedToken = `${token}tied`;
  const tiedIds: string[] = [];

  beforeAll(async () => {
    const createdAt = new Date('2026-05-05T12:00:00.000Z');
    for (let i = 0; i < 6; i++) {
      const [t] = await db.insert(tenants)
        .values({ name: `${tiedToken} Tenant ${i}`, slug: `${tiedToken}-tenant-${i}`, createdAt })
        .returning();
      tiedIds.push(t!.id);
    }
  });

  afterAll(async () => {
    if (tiedIds.length) await db.delete(tenants).where(inArray(tenants.id, tiedIds));
  });

  it('walks every row exactly once across pages', async () => {
    const seen: string[] = [];
    for (let offset = 0; offset < 6; offset += 2) {
      const page = await admin.listTenants({ search: tiedToken, limit: 2, offset });
      expect(page.total).toBe(6);
      seen.push(...page.tenants.map((t) => t.id));
    }
    expect(seen.length).toBe(6);
    expect(new Set(seen).size).toBe(6);
  });
});

describe('listAllUsers', () => {
  it('searches email, display name and tenant name', async () => {
    const byEmail = await admin.listAllUsers({ search: `${token}-1@example.com` });
    expect(byEmail.total).toBe(1);

    const byDisplayName = await admin.listAllUsers({ search: `${token} User` });
    expect(byDisplayName.total).toBe(3);

    // Tenant name match — all three seeded users live in the first tenant.
    const byTenant = await admin.listAllUsers({ search: `${token} Tenant 0` });
    expect(byTenant.total).toBe(3);
  });

  it('pages with limit/offset while total stays the full match count', async () => {
    const first = await admin.listAllUsers({ search: `${token}-`, limit: 2, offset: 0 });
    expect(first.users.length).toBe(2);
    expect(first.total).toBe(3);

    const second = await admin.listAllUsers({ search: `${token}-`, limit: 2, offset: 2 });
    expect(second.users.length).toBe(1);
    expect(second.total).toBe(3);

    const seen = new Set([...first.users, ...second.users].map((u) => u.id));
    expect(seen.size).toBe(3);
  });

  it('returns every row when no limit is supplied', async () => {
    const { users: rows, total } = await admin.listAllUsers();
    expect(rows.length).toBe(total);
    expect(rows.filter((u) => u.email.startsWith(token)).length).toBe(3);
  });
});
