// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Desktop feature profile — the single source of truth for what the
 * engine leaves out when CL_MODE=desktop:
 *
 *   - DESKTOP_UNMOUNTED: route families that are not mounted. They are
 *     online-only, browser-facing, or belong to the server appliance. A
 *     request under one of these prefixes gets a JSON 404 with code
 *     NOT_AVAILABLE_IN_DESKTOP (mounted right after the desktop gate, so it
 *     wins over any broader router mounted later).
 *   - DESKTOP_SCHEDULERS: which background schedulers index.ts starts.
 *
 * app.ts mounts every listed family through serverOnly(), which refuses
 * prefixes missing from the table, so the table and the mounts cannot
 * drift apart. The server appliance mounts and starts everything, exactly
 * as before. docs/DESKTOP.md mirrors these tables.
 */

import type { Express, RequestHandler, Response } from 'express';
import { isDesktop } from './profile.js';

export interface UnmountedFamily {
  prefix: string;
  /** Sub-paths that stay available (relative to prefix). */
  except?: readonly string[];
  reason: string;
}

export const DESKTOP_UNMOUNTED: readonly UnmountedFamily[] = [
  { prefix: '/api/v1/stripe', reason: 'Stripe webhooks (online payments)' },
  { prefix: '/api/v1/plaid', reason: 'Plaid bank feeds and their webhooks (online)' },
  { prefix: '/api/sms/inbound', reason: 'inbound SMS webhooks (online)' },
  {
    prefix: '/api/setup',
    except: ['/status'],
    reason: 'appliance setup wizard; the desktop app uses /api/v1/desktop/initialize',
  },
  { prefix: '/api/v1/public/invoices', reason: 'public invoice payment links' },
  { prefix: '/api/reports/public', reason: 'public report share links' },
  { prefix: '/api/portal', reason: 'client portal' },
  { prefix: '/api/w9', reason: 'public W-9 links' },
  { prefix: '/api/bank-connect', reason: 'public bank-connect links' },
  { prefix: '/api/peer/pm', reason: 'Vibe Practice Management peer API' },
  { prefix: '/mcp', reason: 'MCP server' },
  { prefix: '/oauth', reason: 'OAuth provider for third-party apps' },
  { prefix: '/api/v1/share', reason: 'peer screen share (needs Redis)' },
  { prefix: '/api/v1/admin/tailscale', reason: 'Tailscale remote access' },
  { prefix: '/api/v1/remote-backup', reason: 'cloud backup targets; the desktop app owns backups' },
  { prefix: '/api/v1/settings/storage', reason: 'cloud file storage providers' },
  { prefix: '/api/docs', reason: 'Swagger UI' },
];

export const DESKTOP_SCHEDULERS = {
  recurring: true,
  fingerprint: true,
  aiRetention: true,
  // The desktop app owns backups and their verification.
  backup: false,
  backupVerifier: false,
  // Server appliance only (tunnel health, screen share).
  cloudflaredAlerter: false,
  shareSweeper: false,
  // Portal document requests and reminders: the portal is not mounted and
  // the scheduler sends outbound email/SMS to portal contacts.
  recurringDocRequests: false,
} as const;

export type SchedulerName = keyof typeof DESKTOP_SCHEDULERS;

/** Whether a scheduler starts in this process (always true on the server). */
export function schedulerEnabled(name: SchedulerName): boolean {
  return !isDesktop() || DESKTOP_SCHEDULERS[name];
}

function notAvailable(res: Response, f: Pick<UnmountedFamily, 'reason'>): void {
  res.status(404).json({
    error: {
      message: `Not available in the desktop edition (${f.reason}).`,
      code: 'NOT_AVAILABLE_IN_DESKTOP',
    },
  });
}

/**
 * Route-level refusal for single routes inside a mounted family: desktop
 * answers 404 NOT_AVAILABLE_IN_DESKTOP, the server passes straight through.
 */
export function notInDesktop(reason: string): RequestHandler {
  return function clNotInDesktop(_req, res, next) {
    if (isDesktop()) notAvailable(res, { reason });
    else next();
  };
}

/** The listed family a mount path belongs to (the prefix itself or below it). */
export function familyOf(mountPath: string): UnmountedFamily | undefined {
  return DESKTOP_UNMOUNTED.find((x) => mountPath === x.prefix || mountPath.startsWith(`${x.prefix}/`));
}

function family(mountPath: string): UnmountedFamily {
  const f = familyOf(mountPath);
  if (!f) throw new Error(`serverOnly(${mountPath}): not under any DESKTOP_UNMOUNTED prefix`);
  return f;
}

/**
 * Mount helper for route families that desktop mode leaves out. On the
 * server it is exactly `app.use(prefix, ...handlers)` (or `app.post`).
 */
export function serverOnly(app: Express) {
  return {
    use(prefix: string, ...handlers: Array<RequestHandler | RequestHandler[]>): void {
      const f = family(prefix);
      if (!isDesktop()) {
        app.use(prefix, ...handlers);
      } else if (prefix === f.prefix && f.except && f.except.length > 0) {
        // Only the excepted sub-paths reach the router.
        const allow: RequestHandler = (req, res, next) => {
          if (f.except!.includes(req.path)) next();
          else notAvailable(res, f);
        };
        app.use(prefix, allow, ...handlers);
      }
    },
    post(prefix: string, ...handlers: RequestHandler[]): void {
      family(prefix);
      if (!isDesktop()) app.post(prefix, ...handlers);
    },
  };
}

/** Desktop only: JSON 404 NOT_AVAILABLE_IN_DESKTOP for every left-out family. */
export function mountDesktopUnavailable(app: Express): void {
  for (const f of DESKTOP_UNMOUNTED) {
    app.use(f.prefix, (req, res, next) => {
      if (f.except?.includes(req.path)) {
        next();
        return;
      }
      notAvailable(res, f);
    });
  }
}
