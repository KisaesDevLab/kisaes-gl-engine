// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Firm-level integration credentials (first provider: tax1099.com).
// Follows the plaid_config idiom: credentials are AES-GCM encrypted at
// rest; reads expose has* booleans only; writes use the 3-state
// sentinel (null = clear, '' / undefined = keep, value = set).

import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { firmIntegrations } from '../db/schema/index.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import { auditLog } from '../middleware/audit.js';
import { AppError } from '../utils/errors.js';
import type { Tax1099Credentials } from './tax1099-client.js';
import { assertExternalUrlSafe } from '../utils/url-safety.js';

/**
 * A firm admin may point the Tax1099 client at a non-default base URL
 * (sandbox/staging). The api fetches it server-side with the firm's
 * credentials, so it must be a public https origin — never loopback,
 * RFC-1918, link-local or metadata (SSRF + credential exfil otherwise).
 */
export function validateBaseUrlOverride(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  let u: URL;
  try { u = new URL(value); } catch { throw AppError.badRequest('Tax1099 base URL is not a valid URL', 'TAX1099_BASE_URL_INVALID'); }
  if (u.protocol !== 'https:') throw AppError.badRequest('Tax1099 base URL must use https', 'TAX1099_BASE_URL_INVALID');
  try { assertExternalUrlSafe(value, 'Tax1099 base URL'); } catch (err) { throw AppError.badRequest((err as Error).message, 'TAX1099_BASE_URL_INVALID'); }
  return u.origin + u.pathname.replace(/\/+$/, '');
}

export const TAX1099_PROVIDER = 'tax1099';

export interface Tax1099SettingsView {
  provider: 'tax1099';
  isEnabled: boolean;
  environment: 'sandbox' | 'production';
  baseUrlOverride: string | null;
  hasApiKey: boolean;
  hasUsername: boolean;
  hasPassword: boolean;
  updatedAt: string | null;
}

export interface Tax1099SettingsInput {
  isEnabled?: boolean;
  environment?: 'sandbox' | 'production';
  baseUrlOverride?: string | null;
  // 3-state: null clears, ''/undefined keeps, non-empty sets (encrypted)
  apiKey?: string | null;
  username?: string | null;
  password?: string | null;
}

async function getRow(firmId: string) {
  const [row] = await db.select().from(firmIntegrations)
    .where(and(eq(firmIntegrations.firmId, firmId), eq(firmIntegrations.provider, TAX1099_PROVIDER)))
    .limit(1);
  return row ?? null;
}

export async function getTax1099Settings(firmId: string): Promise<Tax1099SettingsView> {
  const row = await getRow(firmId);
  return {
    provider: 'tax1099',
    isEnabled: row?.isEnabled ?? false,
    environment: (row?.environment as 'sandbox' | 'production') ?? 'sandbox',
    baseUrlOverride: row?.baseUrlOverride ?? null,
    hasApiKey: !!row?.apiKeyEncrypted,
    hasUsername: !!row?.usernameEncrypted,
    hasPassword: !!row?.passwordEncrypted,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

// 3-state credential sentinel resolution.
function resolveSecret(input: string | null | undefined, existing: string | null): string | null {
  if (input === null) return null;                  // explicit clear
  if (input === undefined || input === '') return existing; // keep
  return encrypt(input);                            // set
}

export async function saveTax1099Settings(
  firmId: string,
  input: Tax1099SettingsInput,
  actingUserId?: string,
): Promise<Tax1099SettingsView> {
  const existing = await getRow(firmId);
  const values = {
    firmId,
    provider: TAX1099_PROVIDER,
    apiKeyEncrypted: resolveSecret(input.apiKey, existing?.apiKeyEncrypted ?? null),
    usernameEncrypted: resolveSecret(input.username, existing?.usernameEncrypted ?? null),
    passwordEncrypted: resolveSecret(input.password, existing?.passwordEncrypted ?? null),
    environment: input.environment ?? (existing?.environment as 'sandbox' | 'production') ?? 'sandbox',
    baseUrlOverride: input.baseUrlOverride !== undefined ? validateBaseUrlOverride(input.baseUrlOverride) : existing?.baseUrlOverride ?? null,
    isEnabled: input.isEnabled ?? existing?.isEnabled ?? false,
    updatedByUserId: actingUserId ?? null,
    updatedAt: new Date(),
  };
  await db.insert(firmIntegrations)
    .values(values)
    .onConflictDoUpdate({
      target: [firmIntegrations.firmId, firmIntegrations.provider],
      set: { ...values },
    });
  // Audit under a synthetic tenant-less scope isn't possible — firms
  // span tenants. Record the mutation with the firmId as entity and no
  // secrets in the payload.
  await auditLog(firmId, 'update', 'firm_integration_tax1099', firmId,
    null,
    { isEnabled: values.isEnabled, environment: values.environment, changedSecrets: {
      apiKey: input.apiKey !== undefined && input.apiKey !== '',
      username: input.username !== undefined && input.username !== '',
      password: input.password !== undefined && input.password !== '',
    } },
    actingUserId);
  return getTax1099Settings(firmId);
}

/** Decrypted credentials for the API client. Internal use only. */
export async function getTax1099Credentials(firmId: string): Promise<Tax1099Credentials> {
  const row = await getRow(firmId);
  if (!row || !row.isEnabled) {
    throw AppError.badRequest('Tax1099 e-filing is not enabled for this firm. A firm admin can configure it in Firm Settings.', 'TAX1099_NOT_CONFIGURED');
  }
  if (!row.apiKeyEncrypted || !row.usernameEncrypted || !row.passwordEncrypted) {
    throw AppError.badRequest('Tax1099 credentials are incomplete. A firm admin must set the API key, username, and password.', 'TAX1099_NOT_CONFIGURED');
  }
  return {
    apiKey: decrypt(row.apiKeyEncrypted),
    username: decrypt(row.usernameEncrypted),
    password: decrypt(row.passwordEncrypted),
    environment: (row.environment as 'sandbox' | 'production') ?? 'sandbox',
    baseUrlOverride: row.baseUrlOverride,
  };
}
