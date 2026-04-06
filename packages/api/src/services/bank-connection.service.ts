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
