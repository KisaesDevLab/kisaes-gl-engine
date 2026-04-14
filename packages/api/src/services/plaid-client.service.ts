import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { plaidConfig } from '../db/schema/index.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import { AppError } from '../utils/errors.js';

// ─── Config Management ─────────────────────────────────────────

async function getOrCreateConfig() {
  let config = await db.query.plaidConfig.findFirst();
  if (!config) {
    const [created] = await db.insert(plaidConfig).values({}).returning();
    config = created!;
  }
  return config;
}

export async function getConfig() {
  const config = await getOrCreateConfig();
  return {
    environment: config.environment as 'sandbox' | 'production',
    hasClientId: !!config.clientIdEncrypted,
    hasSandboxSecret: !!config.secretSandboxEncrypted,
    hasProductionSecret: !!config.secretProductionEncrypted,
    webhookUrl: config.webhookUrl,
    defaultProducts: (config.defaultProducts || 'transactions').split(',').filter(Boolean),
    defaultCountryCodes: (config.defaultCountryCodes || 'US').split(',').filter(Boolean),
    defaultLanguage: config.defaultLanguage || 'en',
    maxHistoricalDays: config.maxHistoricalDays || 90,
    isActive: config.isActive ?? true,
  };
}

export async function updateConfig(input: {
  environment?: string;
  clientId?: string;
  secretSandbox?: string;
  secretProduction?: string;
  webhookUrl?: string;
  defaultProducts?: string[];
  defaultCountryCodes?: string[];
  defaultLanguage?: string;
  maxHistoricalDays?: number;
  isActive?: boolean;
}, userId?: string) {
  const config = await getOrCreateConfig();
  const updates: any = { updatedAt: new Date() };

  if (input.environment !== undefined) updates.environment = input.environment;
  if (input.clientId !== undefined) updates.clientIdEncrypted = input.clientId ? encrypt(input.clientId) : null;
  if (input.secretSandbox !== undefined) updates.secretSandboxEncrypted = input.secretSandbox ? encrypt(input.secretSandbox) : null;
  if (input.secretProduction !== undefined) updates.secretProductionEncrypted = input.secretProduction ? encrypt(input.secretProduction) : null;
  if (input.webhookUrl !== undefined) updates.webhookUrl = input.webhookUrl || null;
  if (input.defaultProducts) updates.defaultProducts = input.defaultProducts.join(',');
  if (input.defaultCountryCodes) updates.defaultCountryCodes = input.defaultCountryCodes.join(',');
  if (input.defaultLanguage !== undefined) updates.defaultLanguage = input.defaultLanguage;
  if (input.maxHistoricalDays !== undefined) updates.maxHistoricalDays = input.maxHistoricalDays;
  if (input.isActive !== undefined) updates.isActive = input.isActive;
  if (userId) { updates.configuredBy = userId; updates.configuredAt = new Date(); }

  await db.update(plaidConfig).set(updates).where(eq(plaidConfig.id, config.id));
  return getConfig();
}

// ─── Plaid API Client ──────────────────────────────────────────

export async function getClient(): Promise<PlaidApi> {
  const config = await getOrCreateConfig();
  if (!config.clientIdEncrypted) throw AppError.badRequest('Plaid Client ID not configured');

  const clientId = decrypt(config.clientIdEncrypted);
  const env = config.environment || 'sandbox';

  let secret: string;
  if (env === 'production') {
    if (!config.secretProductionEncrypted) throw AppError.badRequest('Plaid Production Secret not configured');
    secret = decrypt(config.secretProductionEncrypted);
  } else {
    if (!config.secretSandboxEncrypted) throw AppError.badRequest('Plaid Sandbox Secret not configured');
    secret = decrypt(config.secretSandboxEncrypted);
  }

  const plaidConfig = new Configuration({
    basePath: env === 'production' ? PlaidEnvironments['production'] : PlaidEnvironments['sandbox'],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': clientId,
        'PLAID-SECRET': secret,
      },
    },
  });

  return new PlaidApi(plaidConfig);
}

// ─── Plaid API Methods ─────────────────────────────────────────

export async function createLinkToken(tenantId: string, userId: string) {
  const client = await getClient();
  const config = await getConfig();

  const products = config.defaultProducts.map((p) => p as Products);
  const countryCodes = config.defaultCountryCodes.map((c) => c as CountryCode);

  const response = await client.linkTokenCreate({
    user: { client_user_id: userId },
    client_name: 'Vibe MyBooks',
    products,
    country_codes: countryCodes,
    language: config.defaultLanguage,
    webhook: config.webhookUrl || undefined,
    transactions: { days_requested: config.maxHistoricalDays },
  });

  return response.data.link_token;
}

export async function createUpdateLinkToken(tenantId: string, userId: string, accessToken: string) {
  const client = await getClient();
  const config = await getConfig();

  const response = await client.linkTokenCreate({
    user: { client_user_id: userId },
    client_name: 'Vibe MyBooks',
    country_codes: config.defaultCountryCodes.map((c) => c as CountryCode),
    language: config.defaultLanguage,
    access_token: accessToken,
  });

  return response.data.link_token;
}

export async function exchangePublicToken(publicToken: string) {
  const client = await getClient();
  const response = await client.itemPublicTokenExchange({ public_token: publicToken });
  return { accessToken: response.data.access_token, itemId: response.data.item_id };
}

export async function getItem(accessToken: string) {
  const client = await getClient();
  const response = await client.itemGet({ access_token: accessToken });
  return response.data.item;
}

export async function getAccounts(accessToken: string) {
  const client = await getClient();
  const response = await client.accountsGet({ access_token: accessToken });
  return response.data.accounts;
}

export async function syncTransactions(accessToken: string, cursor?: string | null) {
  const client = await getClient();
  const allAdded: any[] = [];
  const allModified: any[] = [];
  const allRemoved: any[] = [];
  let nextCursor = cursor || undefined;
  let hasMore = true;

  while (hasMore) {
    const response = await client.transactionsSync({
      access_token: accessToken,
      cursor: nextCursor,
    });

    allAdded.push(...response.data.added);
    allModified.push(...response.data.modified);
    allRemoved.push(...response.data.removed);
    nextCursor = response.data.next_cursor;
    hasMore = response.data.has_more;
  }

  return { added: allAdded, modified: allModified, removed: allRemoved, nextCursor };
}

export async function getBalances(accessToken: string, accountIds?: string[]) {
  const client = await getClient();
  const response = await client.accountsBalanceGet({
    access_token: accessToken,
    options: accountIds ? { account_ids: accountIds } : undefined,
  });
  return response.data.accounts;
}

export async function removeItem(accessToken: string) {
  const client = await getClient();
  await client.itemRemove({ access_token: accessToken });
}

export async function rotateAccessToken(accessToken: string) {
  const client = await getClient();
  const response = await client.itemAccessTokenInvalidate({ access_token: accessToken });
  return response.data.new_access_token;
}

export async function verifyWebhook(body: string, headers: Record<string, string>): Promise<boolean> {
  // Fails CLOSED on every error path. The earlier version returned true on
  // JWKS fetch failure, missing key, JWT verify failure, or any other
  // exception — which meant a forged request could be accepted just by
  // triggering one of those paths (e.g. DNS-blackholing plaid.com). Webhook
  // authenticity is the only barrier to attacker-forged `TRANSACTIONS` and
  // `ITEM_ERROR` events polluting the ledger, so every branch below has to
  // refuse to verify rather than wave the request through.
  try {
    const plaidVerification = headers['plaid-verification'];
    if (!plaidVerification) return false;

    const crypto = await import('crypto');
    const jwt = await import('jsonwebtoken');

    const decoded = jwt.default.decode(plaidVerification, { complete: true }) as any;
    if (!decoded) return false;

    const kid = decoded.header?.kid;
    if (!kid) return false;

    const jwksRes = await fetch('https://production.plaid.com/webhook_verification_key/get', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: '', secret: '', key_id: kid }),
    });

    if (!jwksRes.ok) {
      console.warn('[Plaid Webhook] Could not fetch verification key — rejecting');
      return false;
    }

    const jwksData = await jwksRes.json() as any;
    const key = jwksData.key;
    if (!key) {
      console.warn('[Plaid Webhook] Verification key missing from JWKS response — rejecting');
      return false;
    }

    const pem = `-----BEGIN PUBLIC KEY-----\n${key.n}\n-----END PUBLIC KEY-----`;
    try {
      const payload = jwt.default.verify(plaidVerification, pem, { algorithms: ['ES256'] }) as any;
      const bodyHash = crypto.default.createHash('sha256').update(body).digest('hex');
      return payload.request_body_sha256 === bodyHash;
    } catch {
      console.warn('[Plaid Webhook] JWT verification failed — rejecting');
      return false;
    }
  } catch (err: any) {
    console.warn('[Plaid Webhook] Verification errored — rejecting:', err?.message);
    return false;
  }
}

export async function testConnection(): Promise<boolean> {
  try {
    const client = await getClient();
    // Create a link token as a connectivity test
    await client.linkTokenCreate({
      user: { client_user_id: 'test' },
      client_name: 'Vibe MyBooks',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
    });
    return true;
  } catch {
    return false;
  }
}
