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
 *   - DESKTOP_SCHEDULERS: which background schedulers index.ts and the
 *     in-process worker (queue/in-process-worker.ts) start.
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
  // Appliance recovery file, installation id and sentinel: they write or
  // rotate boot secrets on disk. The desktop app keeps secrets in the OS
  // keychain and owns install identity (services also refuse the writes).
  { prefix: '/api/v1/admin/security', reason: 'appliance recovery key, recovery file and installation id' },
  { prefix: '/api/v1/admin/updates', reason: 'GitHub release check; the desktop app has its own update check' },
  { prefix: '/api/v1/remote-backup', reason: 'cloud backup targets; the desktop app owns backups' },
  {
    prefix: '/api/v1/backup',
    except: ['/passphrase-strength'],
    reason: 'the desktop app owns backups (company backups are tenant archives)',
  },
  { prefix: '/api/v1/tenant-export', reason: '.vmx export and import; the desktop app uses tenant archives' },
  { prefix: '/api/v1/settings/storage', reason: 'cloud file storage providers' },
  { prefix: '/api/docs', reason: 'Swagger UI' },
  { prefix: '/api/v1/auth/magic-link', reason: 'email magic-link sign-in' },
  { prefix: '/api/v1/firms', reason: 'accounting-firm management (no firms on desktop)' },
  { prefix: '/api/v1/firm-invites', reason: 'accounting-firm invitations' },
  { prefix: '/api/v1/practice/portal', reason: 'client portal contacts, questions and reminders' },
  // Single routes inside the admin router (mounted in both modes): online
  // services and appliance infrastructure. No own mount; the 404 handler
  // above answers before the admin router sees them.
  { prefix: '/api/v1/admin/plaid', reason: 'Plaid configuration, connections and webhooks (online)' },
  { prefix: '/api/v1/admin/backup/remote-config', reason: 'cloud backup targets' },
  { prefix: '/api/v1/admin/backup/remote-test', reason: 'cloud backup targets' },
  { prefix: '/api/v1/admin/backup/remote-connect', reason: 'cloud backup OAuth' },
  { prefix: '/api/v1/admin/backup/remote-callback', reason: 'cloud backup OAuth' },
  { prefix: '/api/v1/admin/storage/system-config', reason: 'cloud file storage providers' },
  { prefix: '/api/v1/admin/storage/system-test', reason: 'cloud file storage providers' },
  { prefix: '/api/v1/admin/storage/system-migrate', reason: 'cloud file storage providers' },
  { prefix: '/api/v1/admin/updates/check', reason: 'online update check; the desktop app has its own' },
  { prefix: '/api/v1/admin/tunnel-config', reason: 'Cloudflare Tunnel' },
  { prefix: '/api/v1/admin/cloudflared', reason: 'Cloudflare Tunnel' },
  { prefix: '/api/v1/admin/mcp', reason: 'MCP server' },
  { prefix: '/api/v1/admin/tfa/sms-test', reason: 'SMS sending (online)' },
  { prefix: '/api/v1/admin/create-client', reason: 'practice client creation (no firms on desktop)' },
];

/**
 * Every other mount in app.ts, reviewed for desktop mode and kept there.
 * desktop/app-gate.test.ts enumerates the real route table in both modes
 * and fails on any mount that is in neither this list nor
 * DESKTOP_UNMOUNTED, so a new route family has to be classified here (or
 * left out above) before it ships. Paths are matched exactly.
 */
export const DESKTOP_KEPT: readonly string[] = [
  // Global middleware scopes (limiter, staff IP allowlist, cache headers, JSON 404).
  '/api', '/api/v1',
  // Probes and browser plumbing.
  '/health', '/api/health', '/api/v1/health', '/ping', '/api/ping', '/api/v1/ping', '/api/v1/csp-report',
  // Desktop-only first run and info (mounted in desktop mode only).
  '/api/v1/desktop',
  // Tenant lifecycle and archives (U-05): every mode.
  '/api/v1/tenants', '/api/v1/tenant-archives',
  // Sign-in, users, tenants.
  '/api/v1/auth', '/api/v1/auth/methods', '/api/v1/auth/passkeys', '/api/v1/users/me/tfa',
  '/api/v1/users/me/login-preference', '/api/v1/api-keys', '/api/v1/tenant-settings', '/api/v1/company',
  '/api/v1/coa-templates/options', '/api/v1/fs-fonts',
  // Books.
  '/api/v1/accounts', '/api/v1/contacts', '/api/v1/transactions', '/api/v1/journal-entries', '/api/v1/invoices', '/api/v1/bills',
  '/api/v1/bill-captures', '/api/v1/document-drafts', '/api/v1/vendor-layout-templates', '/api/v1/document-reading', '/api/v1/vendor-credits', '/api/v1/bill-payments', '/api/v1/payment-terms', '/api/v1/estimates', '/api/v1/tags',
  '/api/v1/reports', '/api/v1/banking', '/api/v1/dashboard', '/api/v1/ledger-version', '/api/v1/attachments',
  '/api/v1/recurring', '/api/v1/templates', '/api/v1/batch', '/api/v1/daily-sales', '/api/v1/je-templates', '/api/v1/items', '/api/v1/price-levels', '/api/v1/billable-costs',
  '/api/v1/payments', '/api/v1/customer-refunds', '/api/v1/credit-memos', '/api/v1/customer-statement-runs', '/api/v1/customer-statements', '/api/v1/finance-charges', '/api/v1/sales-receipts', '/api/v1/checks', '/api/v1/check-signatures', '/api/v1/duplicates', '/api/v1/budgets',
  '/api/v1/document-numbers', '/api/v1/forms',
  '/api/v1/export', '/api/v1/downloads', '/api/v1/audit-log', '/api/v1/payroll-import', '/api/v1/imports',
  '/api/v1/extractions', '/api/v1/knowledge', '/api/v1/feature-flags', '/api/v1/tb', '/api/v1/tax-estimator',
  // AI with the owner's own key or a local model (online only when configured).
  '/api/v1/ai', '/api/v1/chat',
  // Administration (online/appliance-only admin routes are unmounted above).
  '/api/v1/admin', '/api/v1/admin/tb', '/api/v1/admin/tax-parameters', '/api/v1/admin/tax-state-rules',
  '/api/v1/admin/tax-param-ai-checks', '/api/v1/admin/feature-flags',
  // Practice tools that work on the local books.
  '/api/v1/practice', '/api/v1/practice/uncategorized', '/api/v1/practice/classification',
  '/api/v1/practice/settings', '/api/v1/practice/conditional-rules', '/api/v1/practice/client-rules-overview', '/api/v1/practice/checks',
  '/api/v1/practice/accruals', '/api/v1/practice/1099', '/api/v1/practice/reports', '/api/v1/practice/receipts',
  // Public API v2 (API-key callers; still behind the launch token on desktop).
  '/api/v2',
];

export const DESKTOP_SCHEDULERS = {
  // The desktop app drives the recurring run itself (POST
  // /api/v1/recurring/run-due on open, at local midnight and hourly), so the
  // owner sees every automatic entry; the server's hourly tick calls the
  // same idempotent run (U-63). The session prune it carried runs alone.
  recurring: false,
  sessionPrune: true,
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
  // Worker-only schedulers: on the server only the worker container starts
  // them; on desktop the in-process worker does. Database only (the sweep
  // deletes expired pack files through the local storage provider).
  balanceValidation: true,
  reportPackSweep: true,
  classificationStateBackfill: true,
  tagBackfill: true,
  // Online bank feeds (Plaid is not mounted) and portal outreach.
  plaidSync: false,
  portalRecurring: false,
  portalReminders: false,
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
