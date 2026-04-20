// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// CLOUDFLARE_TUNNEL_PLAN Phase 8 — tunnel health monitoring.
//
// cloudflared exposes a Prometheus endpoint at `/metrics` when started
// with `--metrics 0.0.0.0:2000` (see docker-compose.yml). We scrape it
// here rather than going through the CF dashboard so the admin widget
// works without any API tokens and stays responsive during a CF edge
// outage — if the tunnel is disconnected, cloudflared is still running
// locally and can still tell us so.
//
// We deliberately parse a small subset of the metrics text (counters /
// gauges we actually display) instead of pulling in a full Prometheus
// parser. The format is stable: `name{labels} value` per line, `#` is
// a comment. If cloudflared ever rotates metric names across versions
// the admin widget simply shows "unknown" fields — never crashes —
// until someone updates this list.

export interface CloudflaredStatus {
  /** Reachable: whether the /metrics endpoint responded at all. */
  reachable: boolean;
  /** Connector-level health flag cloudflared emits as `cloudflared_tunnel_ha_connections`. */
  activeConnections: number;
  /** True when the connector has at least one healthy edge connection. */
  connected: boolean;
  /** Cumulative successful edge connections since start. */
  totalConnections: number;
  /** Cumulative reconnect events since start — useful signal of instability. */
  totalReconnects: number;
  /** Timestamp this snapshot was taken (ISO). */
  checkedAt: string;
  /** When the metric was last observed healthy. Null until the first success. */
  lastHealthyAt: string | null;
  /** Error message when reachable=false. */
  error?: string;
}

const DEFAULT_METRICS_URL = 'http://cloudflared:2000/metrics';
const SCRAPE_TIMEOUT_MS = 2000;

// Last observed healthy timestamp, persisted in-memory. The widget
// uses it to show "last handshake" even during a brief outage, without
// adding a DB table for something that's fundamentally ephemeral.
let lastHealthy: string | null = null;

/**
 * Very small Prom text parser — handles `name value` and `name{...} value`
 * lines, skips comments and blanks. Returns undefined when the metric is
 * missing; callers treat that as 0 or "unknown".
 */
function parseMetric(text: string, name: string): number | undefined {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // Match `name` or `name{…}` followed by whitespace and a number.
    if (!line.startsWith(name)) continue;
    const after = line.slice(name.length);
    if (after.length && after[0] !== ' ' && after[0] !== '\t' && after[0] !== '{') continue;
    const parts = line.split(/\s+/);
    const last = parts[parts.length - 1];
    if (!last) continue;
    const value = Number(last);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

export function parseCloudflaredMetrics(text: string): Omit<CloudflaredStatus, 'reachable' | 'checkedAt' | 'lastHealthyAt'> {
  // Names follow cloudflared's current Prometheus namespace. When the
  // upstream metric name doesn't exist (older build), we fall back to
  // 0 and the connected flag is derived from whichever counter is
  // present.
  const active = parseMetric(text, 'cloudflared_tunnel_ha_connections') ?? 0;
  const total = parseMetric(text, 'cloudflared_tunnel_total_connections')
    ?? parseMetric(text, 'cloudflared_tunnel_server_locations') // pre-2024 build
    ?? 0;
  const reconnects = parseMetric(text, 'cloudflared_tunnel_tunnel_register_failures')
    ?? parseMetric(text, 'cloudflared_tunnel_connection_errors')
    ?? 0;
  return {
    activeConnections: active,
    connected: active > 0,
    totalConnections: total,
    totalReconnects: reconnects,
  };
}

/**
 * Fetch and parse cloudflared's metrics endpoint. Set
 * `CLOUDFLARED_METRICS_URL` to override the default of
 * `http://cloudflared:2000/metrics` (matches the service name on the
 * Compose network when the `tunnel` profile is enabled).
 *
 * Returns `reachable: false` with an error message when the endpoint
 * is unreachable — the admin UI renders that as "tunnel sidecar is
 * not running" rather than as a silent zero.
 */
export async function getCloudflaredStatus(): Promise<CloudflaredStatus> {
  const url = process.env['CLOUDFLARED_METRICS_URL'] || DEFAULT_METRICS_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);
  const checkedAt = new Date().toISOString();
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      return {
        reachable: false, activeConnections: 0, connected: false,
        totalConnections: 0, totalReconnects: 0, checkedAt,
        lastHealthyAt: lastHealthy,
        error: `cloudflared /metrics returned ${res.status}`,
      };
    }
    const text = await res.text();
    const parsed = parseCloudflaredMetrics(text);
    if (parsed.connected) lastHealthy = checkedAt;
    return { reachable: true, checkedAt, lastHealthyAt: lastHealthy, ...parsed };
  } catch (err) {
    const msg = err instanceof Error
      ? (err.name === 'AbortError' ? 'cloudflared /metrics timed out' : err.message)
      : 'unknown error';
    return {
      reachable: false, activeConnections: 0, connected: false,
      totalConnections: 0, totalReconnects: 0, checkedAt,
      lastHealthyAt: lastHealthy,
      error: msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Test hook — callers can reset the module-level `lastHealthy` cache
// between tests without exposing it more broadly.
export const __internal = {
  resetLastHealthy() { lastHealthy = null; },
  setLastHealthy(value: string | null) { lastHealthy = value; },
};
