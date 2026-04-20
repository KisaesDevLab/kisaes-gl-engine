// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseCloudflaredMetrics,
  getCloudflaredStatus,
  __internal,
} from './status.service.js';

describe('parseCloudflaredMetrics', () => {
  it('reads the connection gauges', () => {
    const text = `# HELP cloudflared_tunnel_ha_connections ...
# TYPE cloudflared_tunnel_ha_connections gauge
cloudflared_tunnel_ha_connections 4
cloudflared_tunnel_total_connections 12
cloudflared_tunnel_tunnel_register_failures 1
`;
    const out = parseCloudflaredMetrics(text);
    expect(out).toEqual({
      activeConnections: 4,
      connected: true,
      totalConnections: 12,
      totalReconnects: 1,
    });
  });

  it('treats zero active connections as disconnected', () => {
    const text = 'cloudflared_tunnel_ha_connections 0\n';
    const out = parseCloudflaredMetrics(text);
    expect(out.connected).toBe(false);
    expect(out.activeConnections).toBe(0);
  });

  it('falls back to pre-2024 metric names when current ones are absent', () => {
    const text = `cloudflared_tunnel_ha_connections 2
cloudflared_tunnel_server_locations 3
cloudflared_tunnel_connection_errors 5
`;
    const out = parseCloudflaredMetrics(text);
    expect(out.totalConnections).toBe(3);
    expect(out.totalReconnects).toBe(5);
  });

  it('returns zero for entirely missing metrics', () => {
    const out = parseCloudflaredMetrics('# nothing here\n');
    expect(out).toEqual({
      activeConnections: 0,
      connected: false,
      totalConnections: 0,
      totalReconnects: 0,
    });
  });
});

describe('getCloudflaredStatus', () => {
  beforeEach(() => {
    __internal.resetLastHealthy();
  });
  afterEach(() => {
    __internal.resetLastHealthy();
    vi.restoreAllMocks();
  });

  it('marks reachable=false with an error when metrics endpoint is down', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const status = await getCloudflaredStatus();
    expect(status.reachable).toBe(false);
    expect(status.error).toContain('ECONNREFUSED');
    expect(status.connected).toBe(false);
  });

  it('marks reachable=false with a useful error on non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 502 }));
    const status = await getCloudflaredStatus();
    expect(status.reachable).toBe(false);
    expect(status.error).toContain('502');
  });

  it('parses a healthy response and records lastHealthyAt', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('cloudflared_tunnel_ha_connections 4\ncloudflared_tunnel_total_connections 7\n', { status: 200 }),
    );
    const status = await getCloudflaredStatus();
    expect(status.reachable).toBe(true);
    expect(status.connected).toBe(true);
    expect(status.activeConnections).toBe(4);
    expect(status.lastHealthyAt).toBe(status.checkedAt);
  });

  it('keeps the previous lastHealthyAt when the next scrape shows disconnected', async () => {
    __internal.setLastHealthy('2026-04-20T12:00:00.000Z');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('cloudflared_tunnel_ha_connections 0\n', { status: 200 }),
    );
    const status = await getCloudflaredStatus();
    expect(status.reachable).toBe(true);
    expect(status.connected).toBe(false);
    expect(status.lastHealthyAt).toBe('2026-04-20T12:00:00.000Z');
  });
});
