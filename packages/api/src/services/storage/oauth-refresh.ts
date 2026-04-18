// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { storageProviders } from '../../db/schema/index.js';
import { encrypt, decrypt } from '../../utils/encryption.js';

// Google / Microsoft access tokens expire in ~1 hour. Dropbox short-lived
// tokens also expire. Without a refresh path the storage backend starts
// returning 401 after one hour and stays broken until the admin manually
// reconnects. This module takes care of the exchange.

export type OAuthProvider = 'google_drive' | 'dropbox' | 'onedrive';

interface RefreshResult {
  accessToken: string;
  refreshToken?: string; // provider may or may not rotate
  expiresInSec: number;
}

async function refreshDropbox(appKey: string, appSecret: string, refreshToken: string): Promise<RefreshResult> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: appKey,
    client_secret: appSecret,
  });
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Dropbox refresh failed: HTTP ${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_in?: number };
  return { accessToken: data.access_token, expiresInSec: data.expires_in ?? 14400 };
}

async function refreshGoogle(clientId: string, clientSecret: string, refreshToken: string): Promise<RefreshResult> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Google refresh failed: HTTP ${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_in?: number };
  return { accessToken: data.access_token, expiresInSec: data.expires_in ?? 3600 };
}

async function refreshMicrosoft(clientId: string, clientSecret: string, msTenantId: string, refreshToken: string): Promise<RefreshResult> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'Files.ReadWrite User.Read offline_access',
  });
  const res = await fetch(`https://login.microsoftonline.com/${msTenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`OneDrive refresh failed: HTTP ${res.status}`);
  const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token, // Microsoft may rotate
    expiresInSec: data.expires_in ?? 3600,
  };
}

/**
 * Given the storage_providers row for a tenant, ensure the cached access
 * token is valid for at least the next 60 seconds. If it isn't, exchange the
 * refresh token for a new access token and persist it.
 *
 * Returns the current access token (after any refresh). Callers should use
 * the returned value, not the row they passed in, because the row's
 * accessTokenEncrypted may have been rewritten.
 */
export async function ensureFreshAccessToken(
  tenantId: string,
  provider: OAuthProvider,
  row: {
    id: string;
    accessTokenEncrypted: string | null;
    refreshTokenEncrypted: string | null;
    tokenExpiresAt: Date | null;
    // Drizzle types the jsonb column as `unknown`. Accept that and cast
    // inside; at this point callers have no structured view either.
    config: unknown;
  },
): Promise<string> {
  if (!row.accessTokenEncrypted) {
    throw new Error(`No access token stored for ${provider}`);
  }
  const accessToken = decrypt(row.accessTokenEncrypted);
  const expiresAt = row.tokenExpiresAt instanceof Date ? row.tokenExpiresAt.getTime() : 0;
  const needsRefresh = !expiresAt || expiresAt - Date.now() < 60_000; // <60s left

  if (!needsRefresh) return accessToken;
  if (!row.refreshTokenEncrypted) {
    // No refresh token — return whatever we have and let the API call
    // surface the 401. The operator will have to reconnect manually.
    return accessToken;
  }

  const refreshToken = decrypt(row.refreshTokenEncrypted);
  const cfg = (row.config ?? {}) as Record<string, any>;

  let result: RefreshResult;
  try {
    if (provider === 'dropbox') {
      const appKey = cfg['app_key'];
      const appSecret = cfg['app_secret_encrypted'] ? decrypt(cfg['app_secret_encrypted']) : '';
      if (!appKey || !appSecret) throw new Error('Dropbox app credentials missing');
      result = await refreshDropbox(appKey, appSecret, refreshToken);
    } else if (provider === 'google_drive') {
      const clientId = cfg['client_id'];
      const clientSecret = cfg['client_secret_encrypted'] ? decrypt(cfg['client_secret_encrypted']) : '';
      if (!clientId || !clientSecret) throw new Error('Google Drive credentials missing');
      result = await refreshGoogle(clientId, clientSecret, refreshToken);
    } else {
      const clientId = cfg['client_id'];
      const clientSecret = cfg['client_secret_encrypted'] ? decrypt(cfg['client_secret_encrypted']) : '';
      const msTenantId = cfg['ms_tenant_id'] || 'common';
      if (!clientId || !clientSecret) throw new Error('OneDrive credentials missing');
      result = await refreshMicrosoft(clientId, clientSecret, msTenantId, refreshToken);
    }
  } catch (err) {
    console.error(`[oauth-refresh] ${provider} tenant=${tenantId} failed:`, err);
    // On refresh failure return the stale token — the caller's next request
    // may still work (if the provider hasn't expired the token yet), and if
    // it doesn't the 401 surfaces via the normal error path.
    return accessToken;
  }

  const patch: {
    accessTokenEncrypted: string;
    tokenExpiresAt: Date;
    updatedAt: Date;
    refreshTokenEncrypted?: string;
  } = {
    accessTokenEncrypted: encrypt(result.accessToken),
    tokenExpiresAt: new Date(Date.now() + result.expiresInSec * 1000),
    updatedAt: new Date(),
  };
  if (result.refreshToken) {
    patch.refreshTokenEncrypted = encrypt(result.refreshToken);
  }
  await db.update(storageProviders).set(patch).where(eq(storageProviders.id, row.id));
  return result.accessToken;
}
