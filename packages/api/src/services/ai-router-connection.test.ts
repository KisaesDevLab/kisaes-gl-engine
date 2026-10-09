// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Router connection configured from Admin -> AI (migration 0198): saved
// URL + token override VIBE_AI_ROUTER_URL / VIBE_AI_TOKEN; clearing falls
// back to env; the token is stored encrypted and never returned.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../db/index.js';
import { aiConfig } from '../db/schema/index.js';
import * as aiConfigService from './ai-config.service.js';
import { changeRequiresReconsent, type DataFlowSnapshot } from './ai-consent.service.js';
import {
  routerAvailable, routerConnection, routerProvider, setRouterConnectionOverride,
} from './ai-providers/vibe-router.provider.js';

const ENV_KEYS = ['VIBE_AI_MODE', 'VIBE_AI_ROUTER_URL', 'VIBE_AI_TOKEN'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  setRouterConnectionOverride(null, null);
  await db.delete(aiConfig);
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  setRouterConnectionOverride(null, null);
  await db.delete(aiConfig);
});

describe('router connection precedence', () => {
  it('saved settings override env, and clearing them falls back to env', () => {
    process.env['VIBE_AI_ROUTER_URL'] = 'http://env-router:8220';
    process.env['VIBE_AI_TOKEN'] = 'env-tok';
    expect(routerConnection()).toMatchObject({ url: 'http://env-router:8220', source: 'env' });

    const before = routerProvider();
    setRouterConnectionOverride('http://192.168.1.50:8220', 'ui-tok');
    expect(routerConnection()).toEqual({ url: 'http://192.168.1.50:8220', token: 'ui-tok', source: 'settings' });
    expect(routerProvider()).not.toBe(before); // client rebuilt for the new server

    setRouterConnectionOverride(null, null);
    expect(routerConnection()?.source).toBe('env');
  });

  it('a URL without a token is not a connection', () => {
    setRouterConnectionOverride('http://192.168.1.50:8220', null);
    expect(routerAvailable()).toBe(false);
  });
});

describe('updateConfig router connection', () => {
  it('saves URL + encrypted token, reports the source, never returns the token, and can turn the router on', async () => {
    const cfg = await aiConfigService.updateConfig({
      routerUrl: 'http://192.168.1.50:8220/', routerToken: 'secret-app-token', routerEnabled: true,
    });
    expect(cfg.router.available).toBe(true);
    expect(cfg.router.enabled).toBe(true);
    expect(cfg.router.connectionSource).toBe('settings');
    expect(cfg.router.url).toBe('http://192.168.1.50:8220');
    expect(cfg.router.hasSavedToken).toBe(true);
    expect(JSON.stringify(cfg)).not.toContain('secret-app-token');

    const [row] = await db.select().from(aiConfig);
    expect(row!.routerTokenEncrypted).toBeTruthy();
    expect(row!.routerTokenEncrypted).not.toContain('secret-app-token');

    // Changing only the URL keeps the saved token.
    const moved = await aiConfigService.updateConfig({ routerUrl: 'http://192.168.1.60:8220' });
    expect(moved.router.url).toBe('http://192.168.1.60:8220');
    expect(moved.router.hasSavedToken).toBe(true);
  });

  it('clearing the URL clears the saved connection', async () => {
    await aiConfigService.updateConfig({ routerUrl: 'http://192.168.1.50:8220', routerToken: 'tok' });
    const cleared = await aiConfigService.updateConfig({ routerUrl: '' });
    expect(cleared.router.available).toBe(false);
    expect(cleared.router.hasSavedToken).toBe(false);
    expect(cleared.router.connectionSource).toBeNull();
  });

  it('rejects a non-http URL', async () => {
    await expect(aiConfigService.updateConfig({ routerUrl: 'ftp://192.168.1.50', routerToken: 'tok' }))
      .rejects.toThrow(/http/);
  });

  it('refuses to turn the router on with no connection', async () => {
    await expect(aiConfigService.updateConfig({ routerEnabled: true })).rejects.toThrow(/not connected/);
  });

  it('a fresh config load picks up the saved connection (api/worker restart)', async () => {
    await aiConfigService.updateConfig({ routerUrl: 'http://192.168.1.50:8220', routerToken: 'tok' });
    setRouterConnectionOverride(null, null);
    expect(routerAvailable()).toBe(false);
    await aiConfigService.getRawConfig();
    expect(routerConnection()).toMatchObject({ url: 'http://192.168.1.50:8220', source: 'settings' });
  });
});

describe('consent', () => {
  const base: DataFlowSnapshot = {
    isEnabled: true, categorizationProvider: 'anthropic', ocrProvider: null,
    documentClassificationProvider: null, chatProvider: null,
    piiProtectionLevel: 'standard', cloudVisionEnabled: false,
    routedFeatures: ['mybooks_chat'], routerDestination: 'http://192.168.1.50:8220',
  };
  it('moving routed features to a different router server requires re-consent', () => {
    expect(changeRequiresReconsent(base, { ...base, routerDestination: 'http://192.168.1.60:8220' }))
      .toBe('router_destination_changed');
    expect(changeRequiresReconsent(base, { ...base })).toBeNull();
  });
});
