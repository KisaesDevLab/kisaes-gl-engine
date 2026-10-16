// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// utils/offline.ts: OfflineUnavailableError, ensureOnline per CL_OFFLINE
// setting, the probe budget and caches, error classification, and the
// error-handler mapping. Probes only ever target loopback test servers,
// an `.invalid` name (RFC 6761: never resolves) and a non-routable
// address, so the file needs no internet.

import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import { loadDesktopProfile, _resetDesktopProfileForTests } from '../desktop/profile.js';
import {
  OfflineUnavailableError,
  PROBE_BUDGET_MS,
  _resetConnectivityForTests,
  classifyNetworkError,
  connectivityState,
  ensureOnline,
  _probe,
  isOfflineUnavailable,
  targetFromUrl,
} from './offline.js';
import { errorHandler } from '../middleware/error-handler.js';

function desktop(offline?: 'auto' | 'on' | 'off') {
  loadDesktopProfile({
    CL_MODE: 'desktop',
    CL_TOKEN: 'o'.repeat(48),
    CL_BIND: '127.0.0.1:0',
    CL_DATA_DIR: path.join(os.tmpdir(), 'cl-offline-test'),
    ...(offline ? { CL_OFFLINE: offline } : {}),
  });
}

// Loopback targets are never probed, so the probe tests need a reachable
// non-loopback address: this machine's own LAN address (a server bound to
// 0.0.0.0 answers on it; nothing leaves the machine).
function lanAddress(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}
const LAN = lanAddress();

async function listening(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((s) => s.destroy());
  await new Promise<void>((r) => server.listen(0, '0.0.0.0', r));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function closedPort(): Promise<number> {
  const s = await listening();
  await s.close();
  return s.port;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; err: unknown }> {
  const t0 = Date.now();
  try {
    await fn();
    return { ms: Date.now() - t0, err: null };
  } catch (err) {
    return { ms: Date.now() - t0, err };
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  _resetConnectivityForTests();
  _resetDesktopProfileForTests();
});

describe('OfflineUnavailableError', () => {
  it('is a 503 AppError with code OFFLINE_UNAVAILABLE and the feature', () => {
    const e = new OfflineUnavailableError('ai:anthropic');
    expect(e.statusCode).toBe(503);
    expect(e.code).toBe('OFFLINE_UNAVAILABLE');
    expect(e.feature).toBe('ai:anthropic');
    expect(e.message).toMatch(/internet connection/);
    expect(isOfflineUnavailable(e)).toBe(true);
    expect(isOfflineUnavailable(new Error('x'))).toBe(false);
  });

  it('the error handler returns 503 {error:{code, message, feature}}', () => {
    let status = 0;
    let body: unknown = null;
    const res = {
      status(s: number) { status = s; return this; },
      json(b: unknown) { body = b; return this; },
    } as unknown as Response;
    errorHandler(new OfflineUnavailableError('smtp'), {} as Request, res, () => undefined);
    expect(status).toBe(503);
    expect(body).toEqual({
      error: {
        code: 'OFFLINE_UNAVAILABLE',
        message: 'Sending email needs an internet connection. Check your connection and try again.',
        feature: 'smtp',
      },
    });
  });
});

describe('server mode (CL_MODE unset): everything is a no-op', () => {
  it('ensureOnline never probes, classify passes errors through, state stays null', async () => {
    loadDesktopProfile({});
    const spy = vi.spyOn(net, 'connect');
    await ensureOnline('smtp', { host: 'cl-offline.invalid', port: 25 });
    expect(spy).not.toHaveBeenCalled();
    const enotfound = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    expect(classifyNetworkError(enotfound, 'smtp')).toBeNull();
    expect(connectivityState()).toEqual({ online: null, lastOnlineCheck: null });
  });
});

describe('CL_OFFLINE=on', () => {
  it('fails immediately and never opens a socket', async () => {
    desktop('on');
    const spy = vi.spyOn(net, 'connect');
    const { ms, err } = await timed(() => ensureOnline('ai:anthropic', { host: 'api.anthropic.com', port: 443 }));
    expect(err).toBeInstanceOf(OfflineUnavailableError);
    expect(ms).toBeLessThan(100);
    expect(spy).not.toHaveBeenCalled();
    expect(connectivityState()).toEqual({ online: false, lastOnlineCheck: null });
  });
});

describe('CL_OFFLINE=off on desktop', () => {
  it('does not probe', async () => {
    desktop('off');
    const spy = vi.spyOn(net, 'connect');
    await ensureOnline('smtp', { host: 'cl-offline.invalid', port: 25 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('CL_OFFLINE=auto (desktop default)', () => {
  it('fresh state is null until the first probe', () => {
    desktop();
    expect(connectivityState()).toEqual({ online: null, lastOnlineCheck: null });
  });

  it.skipIf(!LAN)('reachable host: passes, records online, caches the success', async () => {
    desktop();
    const s = await listening();
    try {
      const spy = vi.spyOn(net, 'connect');
      await ensureOnline('smtp', { host: LAN!, port: s.port });
      const st = connectivityState();
      expect(st.online).toBe(true);
      expect(typeof st.lastOnlineCheck).toBe('string');
      await ensureOnline('smtp', { host: LAN!, port: s.port });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await s.close();
    }
  });

  it('unresolvable host: OfflineUnavailable within 2 s, state offline', async () => {
    desktop();
    const { ms, err } = await timed(() => ensureOnline('ai:anthropic', { host: 'cl-offline.invalid', port: 443 }));
    expect(err).toBeInstanceOf(OfflineUnavailableError);
    expect(ms).toBeLessThan(2_000);
    const st = connectivityState();
    expect(st.online).toBe(false);
    expect(st.lastOnlineCheck).not.toBeNull();
  });

  it('blackholed host (connect hangs): fails at the probe budget, < 2 s', async () => {
    desktop();
    const { ms, err } = await timed(() => ensureOnline('ai:openai', { host: '10.255.255.1', port: 443 }));
    expect(err).toBeInstanceOf(OfflineUnavailableError);
    expect(ms).toBeLessThan(2_000);
    expect(ms).toBeLessThanOrEqual(PROBE_BUDGET_MS + 500);
  });

  it('a failed probe is cached briefly so a retry does not pay the budget twice', async () => {
    desktop();
    const target = { host: 'smtp.cl-offline.invalid', port: 587 };
    await expect(ensureOnline('smtp', target)).rejects.toBeInstanceOf(OfflineUnavailableError);
    const spy = vi.spyOn(net, 'connect');
    const { ms, err } = await timed(() => ensureOnline('smtp', target));
    expect(err).toBeInstanceOf(OfflineUnavailableError);
    expect(ms).toBeLessThan(50);
    expect(spy).not.toHaveBeenCalled();
  });

  it.skipIf(!LAN)('concurrent callers share one probe', async () => {
    desktop();
    const s = await listening();
    try {
      const spy = vi.spyOn(net, 'connect');
      await Promise.all([1, 2, 3].map(() => ensureOnline('smtp', { host: LAN!, port: s.port })));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await s.close();
    }
  });
});

describe('loopback targets (local services) are never "offline"', () => {
  it('ensureOnline does not probe or record a loopback target, even with CL_OFFLINE=on', async () => {
    for (const mode of ['auto', 'on'] as const) {
      desktop(mode);
      const spy = vi.spyOn(net, 'connect');
      const port = await closedPort();
      for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1', '127.8.9.10']) {
        await ensureOnline('smtp', { host, port });
      }
      expect(spy).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      _resetDesktopProfileForTests();
    }
    desktop();
    expect(connectivityState()).toEqual({ online: null, lastOnlineCheck: null });
  });

  it('a probe refused on loopback is inconclusive: no offline state, no failure cache', async () => {
    desktop();
    const port = await closedPort();
    // A name that resolves to this machine reaches the probe; model it with
    // the probe directly (loopback literals are skipped before probing).
    expect(await _probe({ host: '127.0.0.1', port })).toBe('inconclusive');
    expect(await _probe({ host: 'cl-offline.invalid', port: 443 })).toBe('offline');
    expect(connectivityState()).toEqual({ online: null, lastOnlineCheck: null });
  });
});

describe('classifyNetworkError (desktop, auto)', () => {
  it('maps no-network codes anywhere in the cause chain', () => {
    desktop();
    const inner = Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), { code: 'ENOTFOUND' });
    const fetchErr = new TypeError('fetch failed', { cause: inner });
    const sdkErr = Object.assign(new Error('Connection error.'), { cause: fetchErr });
    const out = classifyNetworkError(sdkErr, 'ai:anthropic');
    expect(out).toBeInstanceOf(OfflineUnavailableError);
    expect(out!.feature).toBe('ai:anthropic');
    expect(connectivityState().online).toBe(false);
  });

  it('maps happy-eyeballs AggregateErrors and connect timeouts', () => {
    desktop();
    const agg = Object.assign(new AggregateError([
      Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' }),
    ]), { code: 'ETIMEDOUT' });
    expect(classifyNetworkError(agg, 'smtp')).toBeInstanceOf(OfflineUnavailableError);
    const undici = Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
    expect(classifyNetworkError(undici, 'smtp')).toBeInstanceOf(OfflineUnavailableError);
  });

  it('a refused loopback connection (local service down) is not "offline"', () => {
    desktop();
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
      code: 'ECONNREFUSED',
      address: '127.0.0.1',
    });
    expect(classifyNetworkError(refused, 'ai:ollama')).toBeNull();
    const remote = Object.assign(new Error('connect ECONNREFUSED 203.0.113.9:587'), {
      code: 'ECONNREFUSED',
      address: '203.0.113.9',
    });
    expect(classifyNetworkError(remote, 'smtp')).toBeInstanceOf(OfflineUnavailableError);
  });

  it('other errors pass through', () => {
    desktop();
    expect(classifyNetworkError(Object.assign(new Error('401'), { status: 401 }), 'ai:openai')).toBeNull();
    expect(classifyNetworkError('string', 'smtp')).toBeNull();
    expect(connectivityState().online).toBeNull();
  });
});

describe('targetFromUrl', () => {
  it('derives host and default ports', () => {
    expect(targetFromUrl('https://api.anthropic.com')).toEqual({ host: 'api.anthropic.com', port: 443 });
    expect(targetFromUrl('http://localhost:11434/v1')).toEqual({ host: 'localhost', port: 11434 });
    expect(targetFromUrl('http://[::1]:8080')).toEqual({ host: '::1', port: 8080 });
    expect(targetFromUrl('http://example.test')).toEqual({ host: 'example.test', port: 80 });
  });
});
