// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// CLOUDFLARE_TUNNEL_PLAN Phase 8 — tunnel-down alerter.
//
// Polls cloudflared's /metrics endpoint. Once the tunnel has been
// disconnected for longer than CLOUDFLARED_ALERT_THRESHOLD_MS
// (default 2 minutes), we write a single audit-log row and log a
// structured warning. The row carries `kind: tunnel_alert` so a
// future in-app notification sink can pick it up without scraping
// the entire audit stream.
//
// "Sidecar not running" (reachable=false with no token configured)
// is the expected state on LAN-only installs and is NOT alerted on —
// we treat it as "tunnel feature disabled" rather than "tunnel is
// broken". The alert fires only after the tunnel has previously been
// connected and then went down.

import { getCloudflaredStatus } from './status.service.js';
import { auditLog } from '../../middleware/audit.js';
import { withSchedulerLock } from '../../utils/scheduler-lock.js';

const POLL_INTERVAL_MS = 30_000;
const DEFAULT_THRESHOLD_MS = 2 * 60 * 1000;
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

interface AlerterState {
  // Has the tunnel ever been seen in the `connected` state since the
  // process started? Determines whether `reachable=false` becomes a
  // real alert or is ignored as "tunnel not in use".
  everConnected: boolean;
  // When the most recent disconnected observation started; null when
  // we last observed a healthy state.
  disconnectedSince: number | null;
  // Timestamp of the most recent alert we fired; guards against
  // re-firing on every poll while still disconnected.
  lastAlertAt: number | null;
}

const state: AlerterState = {
  everConnected: false,
  disconnectedSince: null,
  lastAlertAt: null,
};

function thresholdMs(): number {
  const raw = process.env['CLOUDFLARED_ALERT_THRESHOLD_MS'];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_THRESHOLD_MS;
}

/**
 * Run one poll cycle. Exported so tests (and the worker boot path)
 * can drive ticks deterministically.
 */
export async function pollOnce(now: number = Date.now()): Promise<{ alerted: boolean; reason?: string }> {
  return (await withSchedulerLock('cloudflared-alerter', async () => {
    const status = await getCloudflaredStatus();

    if (status.reachable && status.connected) {
      state.everConnected = true;
      state.disconnectedSince = null;
      state.lastAlertAt = null;
      return { alerted: false };
    }

    // Sidecar unreachable + we've never observed a healthy tunnel in
    // this process → treat as "tunnel not configured", not an alert.
    if (!state.everConnected) return { alerted: false };

    // Healthy previously, unhealthy now. Record the start of the
    // disconnect window if we haven't already.
    if (state.disconnectedSince === null) state.disconnectedSince = now;

    const downFor = now - state.disconnectedSince;
    if (downFor < thresholdMs()) return { alerted: false };

    // Re-alert on sustained outage no more often than once per hour so
    // operators see a fresh reminder without being spammed.
    if (state.lastAlertAt && now - state.lastAlertAt < 60 * 60 * 1000) {
      return { alerted: false };
    }

    const reason = !status.reachable
      ? (status.error || 'sidecar unreachable')
      : 'zero active connections';
    console.warn(`[cloudflared-alerter] Tunnel down for ${Math.floor(downFor / 1000)}s — ${reason}`);
    await auditLog(
      SYSTEM_TENANT_ID,
      'update',
      'tunnel_alert',
      'cloudflared',
      null,
      { downForSeconds: Math.floor(downFor / 1000), reason, lastHealthyAt: status.lastHealthyAt },
    );
    state.lastAlertAt = now;
    return { alerted: true, reason };
  })) ?? { alerted: false };
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Kick off the alerter loop. Idempotent — calling again after start
 * is a no-op. Call stopCloudflaredAlerter() on shutdown.
 */
export function startCloudflaredAlerter(): void {
  if (timer) return;
  // First tick on a short delay so the worker's boot log stays
  // uncluttered, then every POLL_INTERVAL_MS after that.
  const initial = setTimeout(() => { void pollOnce(); }, 5_000);
  initial.unref?.();
  timer = setInterval(() => { void pollOnce(); }, POLL_INTERVAL_MS);
  timer.unref?.();
  console.log('[cloudflared-alerter] Started (poll every 30s, alert after 2min disconnected)');
}

export function stopCloudflaredAlerter(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

// Test hooks — state is process-global, so vitest needs a way to
// reset it between tests.
export const __internal = {
  reset() { state.everConnected = false; state.disconnectedSince = null; state.lastAlertAt = null; },
  setEverConnected(v: boolean) { state.everConnected = v; },
  snapshot() { return { ...state }; },
};
