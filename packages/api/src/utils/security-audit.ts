// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Rate-limited audit helper for security-degradation events —
// HIBP / Turnstile / Redis fail-open paths fire on every auth request
// when the upstream is down, so we coalesce them: one audit row per
// (event, reason) pair per window, with a structured console.warn on
// the first suppressed firing so an operator watching logs still sees
// the signal.
//
// The write is best-effort: if the audit insert fails (e.g. DB down
// too), we swallow the error. Losing a degradation alert is strictly
// better than a cascade that rejects the user's login request.

import { auditLog } from '../middleware/audit.js';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

interface WindowState {
  lastLoggedAt: number;
  suppressed: number;
}

const windows = new Map<string, WindowState>();

export interface SecurityEvent {
  /** Identifies the subsystem reporting the event. */
  component: 'hibp' | 'turnstile' | 'rate_limit_redis' | 'staff_ip_allowlist' | 'stripe_ip_allowlist';
  /** Why the fail-open path was taken (e.g., 'timeout', 'network_error'). */
  reason: string;
  /** Freeform payload — included in audit after_data. */
  details?: Record<string, unknown>;
  /** Override the default 15-minute coalescing window. */
  windowMs?: number;
}

/**
 * Record a security-degradation event, coalesced so repeated fire
 * within the same window writes at most one audit row and prints at
 * most one warning to stdout.
 *
 * Safe to call from the hot path — never throws, never awaits the
 * audit write on the caller's critical path (the promise runs in the
 * background).
 */
export function recordSecurityEvent(event: SecurityEvent): void {
  const key = `${event.component}:${event.reason}`;
  const now = Date.now();
  const windowMs = event.windowMs ?? DEFAULT_WINDOW_MS;
  const existing = windows.get(key);

  if (existing && now - existing.lastLoggedAt < windowMs) {
    existing.suppressed += 1;
    return;
  }

  const suppressedCount = existing?.suppressed ?? 0;
  windows.set(key, { lastLoggedAt: now, suppressed: 0 });

  console.warn(
    `[security-degraded] ${event.component} fail-open: ${event.reason}` +
      (suppressedCount > 0 ? ` (${suppressedCount} similar events suppressed in last window)` : ''),
  );

  // Fire-and-forget audit write. Wrapped so a DB error cannot take
  // down the auth request that triggered the log.
  void auditLog(
    SYSTEM_TENANT_ID,
    'update',
    'security_degraded',
    null,
    null,
    {
      component: event.component,
      reason: event.reason,
      suppressedCount,
      windowMs,
      ...(event.details ?? {}),
    },
  ).catch((err) => {
    console.warn('[security-degraded] audit write failed:', err instanceof Error ? err.message : String(err));
  });
}

// Test hook so vitest can reset the window map between cases.
export const __internal = {
  reset(): void { windows.clear(); },
  size(): number { return windows.size; },
};
