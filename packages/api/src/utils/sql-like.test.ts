// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// M4: model-derived strings interpolated into an ILIKE pattern must have their
// %/_ escaped so a hallucinated "%" vendor can't wildcard-match every contact.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, and, ilike } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, contacts } from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import { escapeLike } from './sql-like.js';

describe('escapeLike — unit', () => {
  it('escapes %, _ and backslash with the default LIKE escape char', () => {
    expect(escapeLike('%')).toBe('\\%');
    expect(escapeLike('_')).toBe('\\_');
    expect(escapeLike('100%_off')).toBe('100\\%\\_off');
    expect(escapeLike('a\\b')).toBe('a\\\\b');
  });
  it('leaves ordinary text untouched', () => {
    expect(escapeLike('Blue Bottle Coffee')).toBe('Blue Bottle Coffee');
  });
});

describe('escapeLike — ILIKE behaviour against Postgres', () => {
  let tenantId: string;

  async function cleanDb() {
    await db.delete(contacts);
    await db.delete(companies);
    await db.delete(sessions);
    await db.delete(users);
    await db.delete(tenants);
  }

  beforeEach(async () => {
    await cleanDb();
    const { user } = await authService.register({
      email: `like-${Date.now()}@example.com`,
      password: 'password123',
      displayName: 'Like Test',
      companyName: 'Like Co',
    });
    tenantId = user.tenantId;
    await db.insert(contacts).values([
      { tenantId, displayName: 'Acme Incorporated', contactType: 'vendor' },
      { tenantId, displayName: 'Beta Supplies LLC', contactType: 'vendor' },
    ]);
  });
  afterEach(async () => { await cleanDb(); });

  it('a bare "%" wildcard-matches every contact WITHOUT escaping (the bug)', async () => {
    const rows = await db.select().from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), ilike(contacts.displayName, '%')));
    expect(rows.length).toBe(2);
  });

  it('the SAME "%" matches NOTHING once escaped (the fix)', async () => {
    const rows = await db.select().from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), ilike(contacts.displayName, escapeLike('%'))));
    expect(rows.length).toBe(0);
  });

  it('an escaped real name still matches case-insensitively', async () => {
    const rows = await db.select().from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), ilike(contacts.displayName, escapeLike('acme incorporated'))));
    expect(rows.length).toBe(1);
    expect(rows[0]!.displayName).toBe('Acme Incorporated');
  });
});
