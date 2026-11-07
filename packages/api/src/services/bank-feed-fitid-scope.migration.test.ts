// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-163: migration 0262 scopes the bank transaction id to the bank
// connection. It rolls back (keeping the oldest row of a tenant-wide
// duplicate id, the others lose the id) and re-applies cleanly; applying
// it twice is a no-op. The forward file is applied again at the end so the
// rest of the suite sees the schema.

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog, bankConnections, bankFeedItems,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

async function run(file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await db.execute(sql.raw(body));
  }
}

async function indexes(): Promise<string[]> {
  const r = await db.execute(sql`SELECT indexname FROM pg_indexes WHERE tablename = 'bank_feed_items' ORDER BY indexname`);
  return (r.rows as Array<{ indexname: string }>).map((x) => x.indexname);
}

let tenantId = '';
let userId = '';

afterAll(async () => {
  if (!(await indexes()).includes('uq_bfi_connection_provider_txn')) await run('0262_bank_feed_fitid_scope.sql');
  if (!tenantId) return;
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

async function twoConnections(): Promise<[string, string]> {
  const { user } = await authService.register({
    email: `fitid-mig-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123', displayName: 'FITID Migration', companyName: 'FITID Migration Co',
  });
  tenantId = user.tenantId;
  userId = user.id;
  const [a, b] = await db.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'asset')));
  const [ca] = await db.insert(bankConnections).values({ tenantId, accountId: a!.id, provider: 'manual' }).returning();
  const [cb] = await db.insert(bankConnections).values({ tenantId, accountId: b!.id, provider: 'manual' }).returning();
  return [ca!.id, cb!.id];
}

function item(connectionId: string, fitid: string | null, createdAt: Date) {
  return {
    tenantId, bankConnectionId: connectionId, providerTransactionId: fitid,
    feedDate: '2026-11-01', amount: '1.0000', originalDescription: 'X', description: 'X', createdAt,
  };
}

describe('migration 0262 bank_feed_items provider id scope', () => {
  it('is additive and leaves the expected indexes', async () => {
    const fwd = readFileSync(path.join(MIGRATIONS, '0262_bank_feed_fitid_scope.sql'), 'utf8');
    expect(fwd).not.toMatch(/drop\s+(table|column|constraint)/i);
    expect(fwd).not.toMatch(/rename/i);
    const idx = await indexes();
    expect(idx).toContain('uq_bfi_connection_provider_txn');
    expect(idx).toContain('idx_bfi_tenant_provider_txn');
    expect(idx).not.toContain('idx_bfi_provider_txn');
  });

  it('a provider id is unique per connection, not per tenant; rows without one are not constrained', async () => {
    const [a, b] = await twoConnections();
    const t0 = new Date('2026-11-01T00:00:00Z');
    await db.insert(bankFeedItems).values(item(a, 'F-1', t0));
    await db.insert(bankFeedItems).values(item(b, 'F-1', new Date(t0.getTime() + 1000)));
    await expect(db.insert(bankFeedItems).values(item(a, 'F-1', t0))).rejects.toThrow();
    await db.insert(bankFeedItems).values(item(a, null, t0));
    await db.insert(bankFeedItems).values(item(a, null, t0));
  });

  it('rolls back (the later duplicate loses its id) and re-applies; twice is a no-op', async () => {
    await run('0262_bank_feed_fitid_scope.rollback.sql');
    const idx = await indexes();
    expect(idx).toContain('idx_bfi_provider_txn');
    expect(idx).not.toContain('uq_bfi_connection_provider_txn');
    const rows = await db.select().from(bankFeedItems)
      .where(and(eq(bankFeedItems.tenantId, tenantId), sql`${bankFeedItems.originalDescription} = 'X'`));
    const withId = rows.filter((r) => r.providerTransactionId === 'F-1');
    expect(withId).toHaveLength(1);
    // The oldest row keeps the id.
    expect(withId[0]!.createdAt!.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(rows).toHaveLength(4);

    await run('0262_bank_feed_fitid_scope.sql');
    await run('0262_bank_feed_fitid_scope.sql');
    const after = await indexes();
    expect(after).toContain('uq_bfi_connection_provider_txn');
    expect(after).toContain('idx_bfi_tenant_provider_txn');
    expect(after).not.toContain('idx_bfi_provider_txn');
  });
});
