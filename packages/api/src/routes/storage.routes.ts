import { Router } from 'express';
import crypto from 'crypto';
import { eq, and } from 'drizzle-orm';
import { authenticate } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { storageProviders } from '../db/schema/index.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import { getProviderForTenant, invalidateProviderCache } from '../services/storage/storage-provider.factory.js';
import * as migrationService from '../services/storage-migration.service.js';

export const storageRouter = Router();
storageRouter.use(authenticate);

// In-memory OAuth state store. The /connect/:provider route mints a random
// state bound to (tenantId, userId, provider) and includes it in the
// provider redirect. On /callback/:provider we consume the state and
// require the callback's tenantId/userId/provider to match. Without this,
// an attacker-initiated OAuth flow (attacker's browser starts it, tricks
// the victim into clicking the callback URL) would let the attacker's
// tokens be written into the victim's storage provider record.
interface OAuthState {
  tenantId: string;
  userId: string;
  provider: string;
  expiresAt: number;
}
const oauthStateStore = new Map<string, OAuthState>();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function issueOAuthState(tenantId: string, userId: string, provider: string): string {
  const now = Date.now();
  // opportunistic sweep
  for (const [k, v] of oauthStateStore.entries()) if (now > v.expiresAt) oauthStateStore.delete(k);
  const state = crypto.randomBytes(32).toString('base64url');
  oauthStateStore.set(state, { tenantId, userId, provider, expiresAt: now + OAUTH_STATE_TTL_MS });
  return state;
}

function consumeOAuthState(state: string, tenantId: string, userId: string, provider: string): boolean {
  const entry = oauthStateStore.get(state);
  oauthStateStore.delete(state);
  if (!entry || Date.now() > entry.expiresAt) return false;
  return entry.tenantId === tenantId && entry.userId === userId && entry.provider === provider;
}

// ─── Helper: get tenant's provider record ──────────────────────

async function getTenantProviderRecord(tenantId: string, provider: string) {
  return db.query.storageProviders.findFirst({
    where: and(eq(storageProviders.tenantId, tenantId), eq(storageProviders.provider, provider)),
  });
}

// ─── Get current storage config ────────────────────────────────

storageRouter.get('/', async (req, res) => {
  const providers = await db.select().from(storageProviders).where(eq(storageProviders.tenantId, req.tenantId));
  const activeProvider = providers.find((p) => p.isActive) || { provider: 'local', isActive: true, healthStatus: 'healthy' };

  // All providers always available — each tenant configures their own credentials
  const available = ['local', 'dropbox', 'google_drive', 'onedrive', 's3'];

  // Build per-provider status: has the tenant saved OAuth app credentials?
  const providerStatus: Record<string, { configured: boolean; connected: boolean }> = {
    local: { configured: true, connected: true },
    s3: { configured: true, connected: false },
    dropbox: { configured: false, connected: false },
    google_drive: { configured: false, connected: false },
    onedrive: { configured: false, connected: false },
  };

  for (const p of providers) {
    const config = (p.config || {}) as Record<string, any>;
    const hasOAuthTokens = !!p.accessTokenEncrypted;

    if (p.provider === 's3') {
      providerStatus['s3'] = { configured: true, connected: !!config['bucket'] };
    } else if (p.provider === 'dropbox') {
      providerStatus['dropbox'] = { configured: !!config['app_key'], connected: hasOAuthTokens };
    } else if (p.provider === 'google_drive') {
      providerStatus['google_drive'] = { configured: !!config['client_id'], connected: hasOAuthTokens };
    } else if (p.provider === 'onedrive') {
      providerStatus['onedrive'] = { configured: !!config['client_id'], connected: hasOAuthTokens };
    }
  }

  res.json({
    active: { ...activeProvider, accessTokenEncrypted: undefined, refreshTokenEncrypted: undefined },
    providers: providers.map((p) => ({ ...p, accessTokenEncrypted: undefined, refreshTokenEncrypted: undefined })),
    available,
    providerStatus,
  });
});

// ─── Configure OAuth app credentials (per-tenant) ─────────────
// Tenants save their own OAuth app key/secret before connecting.
// This creates/updates a storageProviders record with the app credentials
// stored (encrypted) in the config JSONB column.

storageRouter.post('/configure/:provider', async (req, res) => {
  const provider = req.params['provider']!;

  if (provider === 's3') {
    // S3 has its own flow below — redirect there for backwards compat
    return configureS3(req, res);
  }

  let configToStore: Record<string, string> = {};

  switch (provider) {
    case 'dropbox': {
      const { appKey, appSecret } = req.body;
      if (!appKey || !appSecret) { res.status(400).json({ error: { message: 'appKey and appSecret are required' } }); return; }
      configToStore = { app_key: appKey, app_secret_encrypted: encrypt(appSecret) };
      break;
    }
    case 'google_drive': {
      const { clientId, clientSecret } = req.body;
      if (!clientId || !clientSecret) { res.status(400).json({ error: { message: 'clientId and clientSecret are required' } }); return; }
      configToStore = { client_id: clientId, client_secret_encrypted: encrypt(clientSecret) };
      break;
    }
    case 'onedrive': {
      const { clientId, clientSecret, tenantId } = req.body;
      if (!clientId || !clientSecret) { res.status(400).json({ error: { message: 'clientId and clientSecret are required' } }); return; }
      configToStore = { client_id: clientId, client_secret_encrypted: encrypt(clientSecret), ms_tenant_id: tenantId || 'common' };
      break;
    }
    default:
      res.status(400).json({ error: { message: `Unknown provider: ${provider}` } });
      return;
  }

  const existing = await getTenantProviderRecord(req.tenantId, provider);

  if (existing) {
    // Merge new app credentials into existing config (preserves OAuth tokens if already connected)
    const merged = { ...((existing.config || {}) as Record<string, any>), ...configToStore };
    await db.update(storageProviders).set({ config: merged, updatedAt: new Date() }).where(eq(storageProviders.id, existing.id));
  } else {
    await db.insert(storageProviders).values({
      tenantId: req.tenantId,
      provider,
      isActive: false,
      config: configToStore,
      healthStatus: 'unknown',
      displayName: provider.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      connectedBy: req.userId,
    });
  }

  res.json({ configured: true, provider });
});

// ─── OAuth initiation — redirect to provider ──────────────────

storageRouter.get('/connect/:provider', async (req, res) => {
  const provider = req.params['provider']!;
  const callbackUrl = `${req.protocol}://${req.get('host')}/api/v1/settings/storage/callback/${provider}`;

  // Read this tenant's OAuth app credentials from their storageProviders record
  const record = await getTenantProviderRecord(req.tenantId, provider);
  const config = (record?.config || {}) as Record<string, any>;
  const state = issueOAuthState(req.tenantId, req.userId, provider);

  switch (provider) {
    case 'dropbox': {
      const appKey = config['app_key'];
      if (!appKey) { res.status(400).json({ error: { message: 'Dropbox app credentials not configured. Please configure them first.' } }); return; }
      res.redirect(`https://www.dropbox.com/oauth2/authorize?client_id=${appKey}&response_type=code&redirect_uri=${encodeURIComponent(callbackUrl)}&token_access_type=offline&state=${encodeURIComponent(state)}`);
      break;
    }
    case 'google_drive': {
      const clientId = config['client_id'];
      if (!clientId) { res.status(400).json({ error: { message: 'Google Drive credentials not configured. Please configure them first.' } }); return; }
      res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=https://www.googleapis.com/auth/drive.file&access_type=offline&prompt=consent&state=${encodeURIComponent(state)}`);
      break;
    }
    case 'onedrive': {
      const clientId = config['client_id'];
      const msTenantId = config['ms_tenant_id'] || 'common';
      if (!clientId) { res.status(400).json({ error: { message: 'OneDrive credentials not configured. Please configure them first.' } }); return; }
      res.redirect(`https://login.microsoftonline.com/${msTenantId}/oauth2/v2.0/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=Files.ReadWrite%20User.Read%20offline_access&state=${encodeURIComponent(state)}`);
      break;
    }
    default:
      res.status(400).json({ error: { message: `Unknown provider: ${provider}` } });
  }
});

// ─── OAuth callback ───────────────────────────────────────────

storageRouter.get('/callback/:provider', async (req, res) => {
  const provider = req.params['provider']!;
  const code = req.query['code'] as string;
  const state = req.query['state'] as string | undefined;
  const appUrl = process.env['CORS_ORIGIN'] || 'http://localhost:5173';
  const callbackUrl = `${req.protocol}://${req.get('host')}/api/v1/settings/storage/callback/${provider}`;

  if (!code) { res.redirect(`${appUrl}/settings/storage?error=no_code`); return; }
  if (!state || !consumeOAuthState(state, req.tenantId, req.userId, provider)) {
    // Either the state is missing (CSRF-style attack where a different
    // user's browser completes an attacker-initiated OAuth flow) or it
    // doesn't match the tenant+user+provider that minted it.
    res.redirect(`${appUrl}/settings/storage?error=invalid_state`);
    return;
  }

  try {
    // Read this tenant's OAuth app credentials
    const record = await getTenantProviderRecord(req.tenantId, provider);
    const provConfig = (record?.config || {}) as Record<string, any>;

    let accessToken = '';
    let refreshToken = '';
    let expiresIn = 3600;
    let extraConfig: Record<string, any> = {};

    switch (provider) {
      case 'dropbox': {
        const appKey = provConfig['app_key'];
        const appSecret = provConfig['app_secret_encrypted'] ? decrypt(provConfig['app_secret_encrypted']) : '';
        if (!appKey || !appSecret) { res.redirect(`${appUrl}/settings/storage?error=provider_not_configured`); return; }

        const tokenRes = await fetch('https://api.dropboxapi.com/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `code=${code}&grant_type=authorization_code&redirect_uri=${encodeURIComponent(callbackUrl)}&client_id=${appKey}&client_secret=${appSecret}`,
        });
        const data = await tokenRes.json() as any;
        accessToken = data.access_token;
        refreshToken = data.refresh_token || '';
        extraConfig = { root_folder: '/Vibe MyBooks', account_id: data.account_id };
        break;
      }
      case 'google_drive': {
        const clientId = provConfig['client_id'];
        const clientSecret = provConfig['client_secret_encrypted'] ? decrypt(provConfig['client_secret_encrypted']) : '';
        if (!clientId || !clientSecret) { res.redirect(`${appUrl}/settings/storage?error=provider_not_configured`); return; }

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `code=${code}&grant_type=authorization_code&redirect_uri=${encodeURIComponent(callbackUrl)}&client_id=${clientId}&client_secret=${clientSecret}`,
        });
        const data = await tokenRes.json() as any;
        accessToken = data.access_token;
        refreshToken = data.refresh_token || '';
        expiresIn = data.expires_in || 3600;
        extraConfig = { folder_id: 'root' };
        break;
      }
      case 'onedrive': {
        const clientId = provConfig['client_id'];
        const clientSecret = provConfig['client_secret_encrypted'] ? decrypt(provConfig['client_secret_encrypted']) : '';
        const msTenantId = provConfig['ms_tenant_id'] || 'common';
        if (!clientId || !clientSecret) { res.redirect(`${appUrl}/settings/storage?error=provider_not_configured`); return; }

        const tokenRes = await fetch(`https://login.microsoftonline.com/${msTenantId}/oauth2/v2.0/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `code=${code}&grant_type=authorization_code&redirect_uri=${encodeURIComponent(callbackUrl)}&client_id=${clientId}&client_secret=${clientSecret}&scope=Files.ReadWrite%20User.Read%20offline_access`,
        });
        const data = await tokenRes.json() as any;
        accessToken = data.access_token;
        refreshToken = data.refresh_token || '';
        expiresIn = data.expires_in || 3600;
        extraConfig = { drive_id: 'me', folder_id: 'root' };
        break;
      }
    }

    // Merge OAuth tokens + extra config into existing record (preserving app credentials)
    const mergedConfig = { ...provConfig, ...extraConfig };

    if (record) {
      await db.update(storageProviders).set({
        accessTokenEncrypted: encrypt(accessToken),
        refreshTokenEncrypted: refreshToken ? encrypt(refreshToken) : null,
        tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
        config: mergedConfig,
        healthStatus: 'healthy',
        updatedAt: new Date(),
      }).where(eq(storageProviders.id, record.id));
    } else {
      await db.insert(storageProviders).values({
        tenantId: req.tenantId,
        provider,
        isActive: false,
        accessTokenEncrypted: encrypt(accessToken),
        refreshTokenEncrypted: refreshToken ? encrypt(refreshToken) : null,
        tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
        config: mergedConfig,
        healthStatus: 'healthy',
        displayName: provider.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        connectedBy: req.userId,
      });
    }

    invalidateProviderCache(req.tenantId);
    res.redirect(`${appUrl}/settings/storage?connected=${provider}`);
  } catch (err: any) {
    res.redirect(`${appUrl}/settings/storage?error=${encodeURIComponent(err.message)}`);
  }
});

// ─── S3 configuration (no OAuth) ──────────────────────────────

async function configureS3(req: any, res: any) {
  const { bucket, region, endpoint, accessKeyId, secretAccessKey, prefix } = req.body;

  // Test connection
  try {
    const { S3Provider } = await import('../services/storage/s3.provider.js');
    const provider = new S3Provider({ bucket, region, endpoint, accessKeyId, secretAccessKey, prefix });
    const health = await provider.checkHealth();
    if (health.status === 'error') { res.status(400).json({ error: { message: `S3 connection failed: ${health.error}` } }); return; }
  } catch (err: any) {
    res.status(400).json({ error: { message: err.message } }); return;
  }

  const config = { bucket, region, endpoint, accessKeyId, secretAccessKey: encrypt(secretAccessKey), prefix };

  const existing = await getTenantProviderRecord(req.tenantId, 's3');

  if (existing) {
    await db.update(storageProviders).set({ config, healthStatus: 'healthy', updatedAt: new Date() }).where(eq(storageProviders.id, existing.id));
  } else {
    await db.insert(storageProviders).values({
      tenantId: req.tenantId, provider: 's3', isActive: false, config,
      healthStatus: 'healthy', displayName: 'S3 Storage', connectedBy: req.userId,
    });
  }

  invalidateProviderCache(req.tenantId);
  res.json({ connected: true });
}

storageRouter.post('/configure/s3', configureS3);

// ─── Set active provider ──────────────────────────────────────

storageRouter.post('/activate', async (req, res) => {
  const { provider } = req.body;
  // Deactivate all
  await db.update(storageProviders).set({ isActive: false }).where(eq(storageProviders.tenantId, req.tenantId));

  if (provider === 'local') {
    invalidateProviderCache(req.tenantId);
    res.json({ activated: 'local' });
    return;
  }

  const record = await getTenantProviderRecord(req.tenantId, provider);
  if (!record) { res.status(400).json({ error: { message: 'Provider not connected' } }); return; }

  await db.update(storageProviders).set({ isActive: true }).where(eq(storageProviders.id, record.id));
  invalidateProviderCache(req.tenantId);
  res.json({ activated: provider });
});

// ─── Disconnect provider ──────────────────────────────────────

storageRouter.post('/disconnect/:provider', async (req, res) => {
  const provider = req.params['provider']!;
  await db.delete(storageProviders).where(and(eq(storageProviders.tenantId, req.tenantId), eq(storageProviders.provider, provider)));
  invalidateProviderCache(req.tenantId);
  res.json({ disconnected: provider });
});

// ─── Health check ─────────────────────────────────────────────

storageRouter.post('/health-check', async (req, res) => {
  const provider = await getProviderForTenant(req.tenantId);
  const health = await provider.checkHealth();

  const record = await db.query.storageProviders.findFirst({
    where: and(eq(storageProviders.tenantId, req.tenantId), eq(storageProviders.isActive, true)),
  });
  if (record) {
    await db.update(storageProviders).set({
      lastHealthCheckAt: new Date(), healthStatus: health.status, healthError: health.error || null,
    }).where(eq(storageProviders.id, record.id));
  }

  res.json(health);
});

// ─── Storage usage ────────────────────────────────────────────

storageRouter.get('/usage', async (req, res) => {
  const provider = await getProviderForTenant(req.tenantId);
  const usage = await provider.getUsage();
  res.json(usage);
});

// ─── Migration ────────────────────────────────────────────────

storageRouter.post('/migrate', async (req, res) => {
  const { fromProvider, toProvider } = req.body;
  const migration = await migrationService.startMigration(req.tenantId, fromProvider, toProvider);
  migrationService.processMigration(migration!.id).catch((err) => console.error('[Migration] Error:', err.message));
  res.json(migration);
});

storageRouter.get('/migrate/status', async (req, res) => {
  const status = await migrationService.getMigrationStatus(req.tenantId);
  res.json(status || { status: 'none' });
});

storageRouter.post('/migrate/cancel', async (req, res) => {
  const status = await migrationService.getMigrationStatus(req.tenantId);
  if (status?.id) await migrationService.cancelMigration(status.id);
  res.json({ cancelled: true });
});
