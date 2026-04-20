// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pollOnce, __internal } from './alert.service.js';
import { __internal as statusInternal } from './status.service.js';

// Stub the two collaborators so the alerter runs without live Redis /
// real audit writes. The scheduler lock is still real — it uses a
// Postgres advisory lock which is harmless to acquire in tests.
vi.mock('../../middleware/audit.js', () => ({
  auditLog: vi.fn(async () => undefined),
}));

describe('cloudflared-alerter pollOnce', () => {
  beforeEach(() => {
    __internal.reset();
    statusInternal.resetLastHealthy();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not alert when cloudflared is healthy', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('cloudflared_tunnel_ha_connections 4\n', { status: 200 }),
    );
    const out = await pollOnce();
    expect(out.alerted).toBe(false);
    expect(__internal.snapshot().everConnected).toBe(true);
  });

  it('does not alert on "sidecar not running" when the tunnel has never come up (LAN-only install)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const out = await pollOnce();
    expect(out.alerted).toBe(false);
  });

  it('does not alert on a brief disconnect under the threshold', async () => {
    // Go healthy → unhealthy within a few seconds.
    __internal.setEverConnected(true);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('cloudflared_tunnel_ha_connections 0\n', { status: 200 }),
    );
    // disconnect first observed at t=0, poll at t=60s (under 2min default)
    const out1 = await pollOnce(0);
    expect(out1.alerted).toBe(false);
    const out2 = await pollOnce(60 * 1000);
    expect(out2.alerted).toBe(false);
  });

  it('alerts when the disconnect has persisted past the threshold', async () => {
    __internal.setEverConnected(true);
    // Response bodies are single-use — mockImplementation returns a
    // fresh Response per call instead of a single shared instance.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(
      new Response('cloudflared_tunnel_ha_connections 0\n', { status: 200 }),
    ));
    // disconnect seen at t=0
    await pollOnce(0);
    // 2min 1s later — crosses the default 2min threshold
    const out = await pollOnce(2 * 60 * 1000 + 1000);
    expect(out.alerted).toBe(true);
    expect(out.reason).toBe('zero active connections');
  });

  it('does not re-alert on every subsequent poll while still disconnected', async () => {
    __internal.setEverConnected(true);
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(
      new Response('cloudflared_tunnel_ha_connections 0\n', { status: 200 }),
    ));
    await pollOnce(0);
    await pollOnce(2 * 60 * 1000 + 1000); // alert fires
    const second = await pollOnce(2 * 60 * 1000 + 2000);
    expect(second.alerted).toBe(false);
  });

  it('resets the window when the tunnel recovers and alerts anew on a later outage', async () => {
    __internal.setEverConnected(true);
    const disconnected = new Response('cloudflared_tunnel_ha_connections 0\n', { status: 200 });
    const connected = new Response('cloudflared_tunnel_ha_connections 4\n', { status: 200 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    fetchSpy.mockResolvedValueOnce(disconnected.clone());
    await pollOnce(0);
    fetchSpy.mockResolvedValueOnce(disconnected.clone());
    const fired = await pollOnce(2 * 60 * 1000 + 1000);
    expect(fired.alerted).toBe(true);

    fetchSpy.mockResolvedValueOnce(connected.clone());
    const recovered = await pollOnce(3 * 60 * 1000);
    expect(recovered.alerted).toBe(false);
    // State should be clean for the next cycle.
    expect(__internal.snapshot().disconnectedSince).toBeNull();
  });
});
