// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bankConnections, accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

export async function list(tenantId: string) {
  return db.select({
    id: bankConnections.id,
    tenantId: bankConnections.tenantId,
    accountId: bankConnections.accountId,
    accountName: accounts.name,
    provider: bankConnections.provider,
    providerAccountId: bankConnections.providerAccountId,
    providerItemId: bankConnections.providerItemId,
    institutionName: bankConnections.institutionName,
    mask: bankConnections.mask,
    lastSyncAt: bankConnections.lastSyncAt,
    syncStatus: bankConnections.syncStatus,
    errorMessage: bankConnections.errorMessage,
    createdAt: bankConnections.createdAt,
  }).from(bankConnections)
    .leftJoin(accounts, eq(bankConnections.accountId, accounts.id))
    .where(eq(bankConnections.tenantId, tenantId));
}

export async function getById(tenantId: string, id: string) {
  const conn = await db.query.bankConnections.findFirst({
    where: and(eq(bankConnections.tenantId, tenantId), eq(bankConnections.id, id)),
  });
  if (!conn) throw AppError.notFound('Bank connection not found');
  return conn;
}

export async function createLinkToken(tenantId: string) {
  // Plaid stub — returns a mock link token
  return { linkToken: `link-sandbox-${Date.now()}`, expiration: new Date(Date.now() + 3600000).toISOString() };
}

export async function exchangePublicToken(tenantId: string, accountId: string, input: {
  institutionName?: string; mask?: string;
}) {
  const [conn] = await db.insert(bankConnections).values({
    tenantId,
    accountId,
    provider: 'manual',
    institutionName: input.institutionName || null,
    mask: input.mask || null,
    syncStatus: 'active',
  }).returning();

  return conn;
}

export async function createManualConnection(tenantId: string, accountId: string, institutionName: string) {
  const [conn] = await db.insert(bankConnections).values({
    tenantId,
    accountId,
    provider: 'manual',
    institutionName,
    syncStatus: 'active',
  }).returning();
  return conn;
}

/**
 * Find the manual bank connection for an account, creating one if needed. Used
 * by importers (CSV/OFX and AI statement parse) so a statement maps to the
 * chosen GL account without the caller juggling connection ids. Returns the
 * connection's id.
 */
export async function getOrCreateManualConnection(
  tenantId: string,
  accountId: string,
  institutionName: string,
): Promise<{ id: string; accountId: string }> {
  const existing = await list(tenantId);
  const found = existing.find((c) => c.accountId === accountId);
  if (found) return { id: found.id, accountId: found.accountId };
  const created = await createManualConnection(tenantId, accountId, institutionName);
  if (created) return { id: created.id, accountId: created.accountId };
  // Lost a create race — re-read.
  const after = await list(tenantId);
  const reFound = after.find((c) => c.accountId === accountId);
  if (reFound) return { id: reFound.id, accountId: reFound.accountId };
  throw AppError.internal('Failed to create bank connection for account');
}

/**
 * Find-or-create the bank connection that backs a single Plaid account, keyed on
 * the Plaid account id. This is what wires Plaid-synced transactions into the
 * same model as file imports: feed display, categorization, and posting all
 * resolve the bank account through bankConnections.accountId. Returns the id.
 */
export async function getOrCreatePlaidConnection(
  tenantId: string,
  accountId: string,
  plaidAccountId: string,
  opts: { institutionName?: string | null; providerItemId?: string | null; mask?: string | null } = {},
): Promise<string> {
  // Key on the GL account (one plaid connection per mapped bank account) so the
  // live sync and the one-time backfill converge on the same row. provider
  // account/mask are stored for reference only.
  const existing = await db.query.bankConnections.findFirst({
    where: and(
      eq(bankConnections.tenantId, tenantId),
      eq(bankConnections.provider, 'plaid'),
      eq(bankConnections.accountId, accountId),
    ),
  });
  if (existing) return existing.id;
  const [conn] = await db.insert(bankConnections).values({
    tenantId,
    accountId,
    provider: 'plaid',
    providerAccountId: plaidAccountId,
    providerItemId: opts.providerItemId ?? null,
    institutionName: opts.institutionName ?? 'Plaid',
    mask: opts.mask ?? null,
    syncStatus: 'active',
  }).returning();
  return conn!.id;
}

export async function disconnect(tenantId: string, id: string) {
  await db.update(bankConnections)
    .set({ syncStatus: 'disconnected', updatedAt: new Date() })
    .where(and(eq(bankConnections.tenantId, tenantId), eq(bankConnections.id, id)));
}

export async function sync(tenantId: string, connectionId: string) {
  // Plaid sync stub
  await db.update(bankConnections)
    .set({ lastSyncAt: new Date(), updatedAt: new Date() })
    .where(and(eq(bankConnections.tenantId, tenantId), eq(bankConnections.id, connectionId)));
  return { imported: 0 };
}
