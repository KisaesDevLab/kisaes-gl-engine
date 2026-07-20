// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as adminService from '../services/admin.service.js';
import * as authService from '../services/auth.service.js';
import { testSmtpConnection, withSetupLock } from '../services/setup.service.js';
import * as tfaConfigService from '../services/tfa-config.service.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import * as coaTemplatesService from '../services/coa-templates.service.js';
import * as reportLetterService from '../services/report-letter.service.js';
import { createReportLetterSchema, updateReportLetterSchema } from '@kis-books/shared';
import { db } from '../db/index.js';
import {
  generateRecoveryKey,
  parseRecoveryKey,
} from '../services/recovery-key.service.js';
import {
  writeRecoveryFile,
  readRecoveryFile,
  recoveryFileExists,
  deleteRecoveryFile,
  sourceRecoveryFileExists,
} from '../services/env-recovery.service.js';
import { recoverCredentialEncryption } from '../services/credential-reencrypt.service.js';
import {
  createSentinel,
  readSentinelHeader,
  sentinelExists,
  deleteSentinel,
  SentinelError,
} from '../services/sentinel.service.js';
import { ensureHostId } from '../services/host-id.service.js';
import { getSetting, setSetting } from '../services/admin.service.js';
import { SystemSettingsKeys } from '../constants/system-settings-keys.js';
import { sentinelAudit } from '../startup/sentinel-audit.js';
import { env } from '../config/env.js';
import { issueOAuthState, verifyOAuthState } from '../utils/oauth-state.js';
import {
  createCoaTemplateSchema,
  updateCoaTemplateSchema,
  cloneCoaTemplateFromTenantSchema,
  importCoaTemplateSchema,
  adminResetPasswordSchema,
  adminToggleTenantAccessSchema,
  adminGrantTenantAccessSchema,
  adminDesignateRetainedEarningsSchema,
  adminSetRoleSchema,
  adminCompanyAccessSchema,
  adminSmtpSettingsSchema,
  adminSmtpTestSchema,
  adminApplicationSettingsSchema,
  adminTfaConfigSchema,
  adminTfaSmsTestSchema,
  adminCreateClientSchema,
  adminCreateUserSchema,
  adminMcpConfigSchema,
  adminPlaidConfigSchema,
  adminAssignSystemAccountSchema,
} from '@kis-books/shared';
import { eq } from 'drizzle-orm';
import { tailscaleRouter } from './tailscale.routes.js';

export const adminRouter = Router();
adminRouter.use(authenticate);
adminRouter.use(requireSuperAdmin);

// Step-up auth limiter. Destructive security endpoints (rotate installation
// ID, regenerate recovery key, refresh recovery file, delete recovery file)
// all require the admin's current password in the body. Without a dedicated
// limiter a compromised super-admin session could brute-force the password
// under the permissive global 200/min limit. Keyed by userId because the
// attacker has the session, not necessarily the same IP as the legit admin.
const stepUpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => (req as any).userId || req.ip || 'anonymous',
  message: { error: { message: 'Too many step-up attempts, please wait a minute', code: 'STEP_UP_RATE_LIMIT' } },
  standardHeaders: true,
  legacyHeaders: false,
});

// Tailscale remote-access management (super-admin only, already gated above).
adminRouter.use('/tailscale', tailscaleRouter);

// Prometheus-format metrics endpoint. Mounted under the admin router
// (rather than top-level /metrics) so it inherits:
//   - authenticate + requireSuperAdmin (this router's guards)
//   - the global rate limiter (/api/...)
//   - the staff-IP allowlist when enforced (/api/v1/...)
// Scheduler counters and per-tenant activity can reveal firm behaviour
// if exposed broadly, so the triple gate is deliberate. Prometheus
// operators point their scrape config at /api/v1/admin/metrics and
// configure it with a super-admin bearer token.
adminRouter.get('/metrics', async (_req, res) => {
  const { renderMetrics } = await import('../utils/metrics.js');
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(renderMetrics());
});

// ─── Cloudflare Tunnel Status (Phase 8) ────────────────────────
// Super-admin only. Returns a snapshot of the cloudflared sidecar's
// Prometheus metrics so the admin UI can render "tunnel connected —
// N connections" without anyone needing a Cloudflare dashboard
// session. Safe against a disconnected or absent cloudflared: the
// service returns `reachable: false` rather than throwing, so the
// response is always 200 + useful even during an outage.
adminRouter.get('/cloudflared/status', async (_req, res) => {
  const { getCloudflaredStatus } = await import('../services/cloudflared/status.service.js');
  const status = await getCloudflaredStatus();
  res.json(status);
});

// ─── Tunnel / Turnstile reconfigure (Phase 9) ──────────────────
// Read current state + rotate Turnstile keys without editing .env +
// restarting. Tunnel token rotation is NOT exposed here — the
// cloudflared sidecar reads its token at container start and can't
// hot-swap; rotating the tunnel requires restarting that sidecar
// with a new token, which is an ops action (documented in
// docs/firm-cloudflare-setup.md Part G). This endpoint surfaces
// everything an admin CAN change live, and flags what they can't.
adminRouter.get('/tunnel-config', async (_req, res) => {
  const { getCloudflaredStatus } = await import('../services/cloudflared/status.service.js');
  const [tunnelStatus, siteKey, secretKey] = await Promise.all([
    getCloudflaredStatus(),
    adminService.getSetting(SystemSettingsKeys.TURNSTILE_SITE_KEY),
    adminService.getSetting(SystemSettingsKeys.TURNSTILE_SECRET_KEY),
  ]);
  const envSiteKey = process.env['TURNSTILE_SITE_KEY'] || null;
  const envSecretKey = process.env['TURNSTILE_SECRET_KEY'] || null;
  res.json({
    tunnel: tunnelStatus,
    // Expose the site key (public) so the admin can copy / verify it;
    // NEVER expose the secret — only whether one is configured.
    turnstileSiteKey: siteKey ?? envSiteKey,
    turnstileSecretConfigured: !!(secretKey ?? envSecretKey),
    // Tell the UI where each current value is coming from so the
    // operator knows whether an admin-panel rotation will override
    // a .env value or write the first one.
    turnstileSiteKeySource: siteKey ? 'database' : envSiteKey ? 'env' : 'unset',
    turnstileSecretSource: secretKey ? 'database' : envSecretKey ? 'env' : 'unset',
  });
});

adminRouter.put('/tunnel-config', async (req, res) => {
  const siteKey = typeof req.body?.turnstileSiteKey === 'string' ? req.body.turnstileSiteKey.trim() : null;
  const secretKey = typeof req.body?.turnstileSecretKey === 'string' ? req.body.turnstileSecretKey.trim() : null;
  if (siteKey !== null) {
    await adminService.setSetting(SystemSettingsKeys.TURNSTILE_SITE_KEY, siteKey);
  }
  // Empty string in secretKey means "leave unchanged" so the UI can
  // send the site key without the operator re-entering the secret.
  if (secretKey) {
    await adminService.setSetting(SystemSettingsKeys.TURNSTILE_SECRET_KEY, secretKey);
  }
  // Bust the in-memory cache so the very next auth request sees the
  // new secret. See utils/turnstile.ts.
  const { invalidateTurnstileSecretCache } = await import('../utils/turnstile.js');
  invalidateTurnstileSecretCache();
  res.json({ saved: true });
});

// ─── Public sign-up toggle ─────────────────────────────────────
// Super-admin-only switch that controls whether anyone-on-the-internet
// can hit POST /api/v1/auth/register and create a new tenant. Default
// is enabled (the app shipped with open registration); this exists for
// firms that want to lock the door once their users are provisioned.
//
// The setting is consumed in two places:
//   - `getAuthMethods()` exposes it on /api/v1/auth/methods so the
//     LoginPage hides the "Sign up" link
//   - `requireRegistrationEnabled` in routes/auth.routes.ts enforces
//     the 403 server-side, which is the actual security boundary
adminRouter.get('/registration-config', async (_req, res) => {
  const value = await adminService.getSetting(SystemSettingsKeys.REGISTRATION_ENABLED);
  // Absent row → default ON, matching the existing open-registration
  // behavior. Only the literal `'false'` string disables it.
  res.json({ registrationEnabled: value !== 'false' });
});

adminRouter.put('/registration-config', async (req, res) => {
  const enabled = req.body?.registrationEnabled;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({
      error: {
        message: 'registrationEnabled must be a boolean.',
        code: 'BAD_REQUEST',
      },
    });
    return;
  }
  await adminService.setSetting(
    SystemSettingsKeys.REGISTRATION_ENABLED,
    enabled ? 'true' : 'false',
  );
  res.json({ saved: true, registrationEnabled: enabled });
});

// ─── Self-service tenant creation config ───────────────────────
// Mirrors registration-config: instance toggle + per-user cap for
// POST /auth/create-tenant ("New Business (separate books)").

adminRouter.get('/tenant-creation-config', async (_req, res) => {
  const enabled = await adminService.getSetting(SystemSettingsKeys.SELF_SERVICE_TENANT_CREATION);
  const limitRaw = await adminService.getSetting(SystemSettingsKeys.SELF_SERVICE_TENANT_LIMIT);
  const parsed = Number.parseInt(limitRaw ?? '', 10);
  res.json({
    // Default OFF — only the literal 'true' enables (new capability).
    selfServiceTenantCreation: enabled === 'true',
    selfServiceTenantLimit: Number.isFinite(parsed) && parsed >= 0 ? parsed : 3,
  });
});

adminRouter.put('/tenant-creation-config', async (req, res) => {
  const enabled = req.body?.selfServiceTenantCreation;
  const limit = req.body?.selfServiceTenantLimit;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: 'selfServiceTenantCreation must be a boolean.', code: 'BAD_REQUEST' } });
    return;
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0 || limit > 1000)) {
    res.status(400).json({ error: { message: 'selfServiceTenantLimit must be an integer between 0 (unlimited) and 1000.', code: 'BAD_REQUEST' } });
    return;
  }
  await adminService.setSetting(SystemSettingsKeys.SELF_SERVICE_TENANT_CREATION, enabled ? 'true' : 'false');
  if (limit !== undefined) {
    await adminService.setSetting(SystemSettingsKeys.SELF_SERVICE_TENANT_LIMIT, String(limit));
  }
  res.json({ saved: true, selfServiceTenantCreation: enabled, ...(limit !== undefined ? { selfServiceTenantLimit: limit } : {}) });
});

// ─── Staff IP Allowlist (Phase 6) ──────────────────────────────
// Super-admin only. The allowlist is ignored at request time unless
// STAFF_IP_ALLOWLIST_ENFORCED=1 — CRUD works either way so operators
// can populate and test the list before flipping enforcement on.
adminRouter.get('/ip-allowlist', async (_req, res) => {
  const { listEntries } = await import('../services/staff-ip-allowlist.service.js');
  const entries = await listEntries();
  res.json({
    enforced: process.env['STAFF_IP_ALLOWLIST_ENFORCED'] === '1',
    entries,
  });
});

adminRouter.post('/ip-allowlist', async (req, res) => {
  const { addEntry, invalidateCache } = await import('../services/staff-ip-allowlist.service.js');
  const entry = await addEntry({
    cidr: String(req.body?.cidr || ''),
    description: req.body?.description ?? null,
    createdBy: req.userId,
  });
  invalidateCache();
  res.status(201).json(entry);
});

adminRouter.delete('/ip-allowlist/:id', async (req, res) => {
  const { removeEntry, invalidateCache } = await import('../services/staff-ip-allowlist.service.js');
  await removeEntry(req.params['id']!);
  invalidateCache();
  res.json({ deleted: true });
});

// ─── System Stats ────────────────────────────────────────────────

adminRouter.get('/stats', async (req, res) => {
  const stats = await adminService.getSystemStats();
  res.json(stats);
});

// Build-plan Phase 3 — manually re-trigger the chunked split-level
// tag backfill. Safe to call anytime; the advisory lock prevents
// concurrent runs and the sweep is a no-op once no untagged-but-
// transaction-tagged journal_lines remain.
adminRouter.post('/tags/backfill-sweep', async (_req, res) => {
  const { runChunkedTagBackfill } = await import('../services/tags/backfill-sweep.service.js');
  const result = await runChunkedTagBackfill();
  res.json(result);
});

adminRouter.get('/settings', async (req, res) => {
  const settings = await adminService.getGlobalSettings();
  const appSettings = await adminService.getApplicationSettings();
  res.json({ ...settings, ...appSettings });
});

adminRouter.put('/settings/smtp', validate(adminSmtpSettingsSchema), async (req, res) => {
  await adminService.saveSmtpSettings(req.body);
  res.json({ message: 'SMTP settings saved' });
});

adminRouter.put('/settings/application', validate(adminApplicationSettingsSchema), async (req, res) => {
  await adminService.saveApplicationSettings(req.body);
  res.json({ message: 'Application settings saved' });
});

// ─── Tenant Management ──────────────────────────────────────────

adminRouter.get('/tenants', async (req, res) => {
  const tenants = await adminService.listTenants();
  res.json({ tenants });
});

adminRouter.get('/tenants/:id', async (req, res) => {
  const detail = await adminService.getTenantDetail(req.params['id']!);
  res.json(detail);
});

// System Retained Earnings — the current designation + equity accounts to pick
// from, and a POST to (re)designate one when the system RE account was deleted.
adminRouter.get('/tenants/:id/retained-earnings', async (req, res) => {
  res.json(await adminService.getRetainedEarningsInfo(req.params['id']!));
});

adminRouter.post('/tenants/:id/retained-earnings', validate(adminDesignateRetainedEarningsSchema), async (req, res) => {
  res.json(await adminService.designateRetainedEarnings(req.params['id']!, req.body.accountId, req.userId));
});

// System Accounts — every system role the ledger resolves via
// accounts.system_tag (AR, AP, sales tax, payments clearing, …), with the
// currently-assigned account (or null), duplicate/type-mismatch flags, and
// the tenant's account list for the assignment picker. PUT re-points a role
// at an existing account (move semantics — the tag is cleared from any other
// account atomically) or clears the mapping with accountId: null.
adminRouter.get('/tenants/:id/system-accounts', async (req, res) => {
  res.json(await adminService.getSystemAccountsInfo(req.params['id']!));
});

adminRouter.put('/tenants/:id/system-accounts/:tag', validate(adminAssignSystemAccountSchema), async (req, res) => {
  res.json(await adminService.assignSystemAccount(req.params['id']!, req.params['tag']!, req.body.accountId, req.userId));
});

adminRouter.post('/tenants/:id/disable', async (req, res) => {
  await adminService.disableTenant(req.params['id']!, req.userId);
  res.json({ message: 'Tenant disabled' });
});

adminRouter.post('/tenants/:id/enable', async (req, res) => {
  await adminService.enableTenant(req.params['id']!, req.userId);
  res.json({ message: 'Tenant enabled' });
});

// Hard-delete a tenant and all its scoped data. Destructive and
// irreversible — see deleteTenant() in admin.service.ts for the full
// safety logic. Requires super admin (already enforced by the
// requireSuperAdmin middleware applied to the whole router).
adminRouter.delete('/tenants/:id', async (req, res) => {
  const result = await adminService.deleteTenant(req.params['id']!, req.userId);
  res.json({ message: 'Tenant deleted', ...result });
});

// Delete a tenant's entire chart of accounts — only when it has no
// transactions yet (see deleteChartOfAccounts). Lets an operator fix a
// wrong COA template on a fresh tenant, then re-seed. Super-admin gated
// by the router-level requireSuperAdmin.
adminRouter.delete('/tenants/:id/chart-of-accounts', async (req, res) => {
  const result = await adminService.deleteChartOfAccounts(req.params['id']!, req.userId);
  res.json({ message: 'Chart of accounts deleted', ...result });
});

// Delete every transaction for a tenant (books reset) — keeps COA,
// contacts, companies, users, settings; resets bank-feed matches and
// account balances. Destructive; type-to-confirm in the UI.
adminRouter.delete('/tenants/:id/transactions', async (req, res) => {
  const result = await adminService.deleteAllTransactions(req.params['id']!, req.userId);
  res.json({ message: 'All transactions deleted', ...result });
});

// Hard-delete a single company (and all its company-scoped data) from a
// tenant. Irreversible; the tenant and its other companies are untouched.
adminRouter.delete('/tenants/:id/companies/:companyId', async (req, res) => {
  const result = await adminService.deleteCompany(req.params['id']!, req.params['companyId']!, req.userId);
  res.json({ message: 'Company deleted', ...result });
});

// Purge a tenant's payroll import history (record-only — posted journal
// entries are left in the ledger).
adminRouter.delete('/tenants/:id/payroll-import-history', async (req, res) => {
  const result = await adminService.deletePayrollImportHistory(req.params['id']!, req.userId);
  res.json({ message: 'Payroll import history deleted', ...result });
});

// Preview what a date-range transaction delete would remove — read-only
// count used by the confirm dialog. Same super-admin gate as the delete.
adminRouter.get('/tenants/:id/transactions-range-count', async (req, res) => {
  const { z } = await import('zod');
  const { startDate, endDate } = z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).parse(req.query);
  const result = await adminService.previewTransactionsInDateRange(req.params['id']!, startDate, endDate);
  res.json(result);
});

// Delete a tenant's transactions dated in [startDate, endDate] — a
// surgical, date-scoped books edit. Also purges bank-feed items by
// feed_date and DELETES reconciliations whose statement_date falls in
// range; account balances are recomputed from surviving lines.
// Destructive; type-to-confirm + preview in the UI.
adminRouter.post('/tenants/:id/delete-transactions-range', async (req, res) => {
  const { z } = await import('zod');
  const { startDate, endDate } = z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be YYYY-MM-DD'),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate must be YYYY-MM-DD'),
  }).parse(req.body);
  const result = await adminService.deleteTransactionsInDateRange(req.params['id']!, startDate, endDate, req.userId);
  res.json({ message: 'Transactions in date range deleted', ...result });
});

// Apply a COA template to a tenant with an EMPTY chart of accounts
// (delete-COA first if a wrong template was seeded).
adminRouter.post('/tenants/:id/apply-coa-template', async (req, res) => {
  const { z } = await import('zod');
  const { templateSlug } = z.object({ templateSlug: z.string().min(1).max(100) }).parse(req.body);
  const result = await adminService.applyCoaTemplate(req.params['id']!, templateSlug, req.userId);
  res.status(201).json({ message: 'Chart of accounts template applied', ...result });
});

// ─── User Management ────────────────────────────────────────────

adminRouter.get('/users', async (req, res) => {
  const users = await adminService.listAllUsers();
  res.json({ users });
});

adminRouter.post('/users/create', validate(adminCreateUserSchema), async (req, res) => {
  const { email: rawEmail, password, displayName, tenantId, role } = req.body;
  // Normalize to lowercase; users.email is treated case-insensitively
  // elsewhere in the auth path, so storing mixed-case here would create a
  // row that no normal login flow can find.
  const email = rawEmail.trim().toLowerCase();

  const { users, tenants, userTenantAccess } = await import('../db/schema/index.js');
  const { eq } = await import('drizzle-orm');
  const { env } = await import('../config/env.js');

  // Pre-flight checks: cheap reads outside the transaction so we return the
  // user-friendly 409 / 404 quickly. The transaction below *re-checks*
  // uniqueness (via the unique constraint on users.email) so a concurrent
  // insert can't produce a duplicate, and rolls back both inserts together
  // on failure.
  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (existing) {
    res.status(409).json({ error: { message: 'A user with this email already exists' } });
    return;
  }

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) {
    res.status(404).json({ error: { message: 'Tenant not found' } });
    return;
  }

  const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);

  try {
    const user = await db.transaction(async (tx) => {
      const [u] = await tx.insert(users).values({
        tenantId,
        email,
        passwordHash,
        displayName: displayName || null,
        role,
      }).returning();
      if (!u) throw new Error('user insert returned no row');
      await tx.insert(userTenantAccess).values({
        userId: u.id,
        tenantId,
        role,
      }).onConflictDoNothing();
      return u;
    });

    // Welcome email with the credentials the admin just set. Fire-and-
    // forget — the admin already has the password to hand off manually
    // if SMTP is down, so a send failure must not fail the create.
    const { sendAccountCreatedEmail } = await import('../services/system-email.service.js');
    sendAccountCreatedEmail(user.email, tenant.name, password).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`[admin.routes] account-created email to ${user.email} failed:`, err?.message ?? err);
    });

    res.status(201).json({ user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role } });
  } catch (err: any) {
    // Unique-constraint violation on users.email — race with another
    // concurrent create. Map to 409 so the client sees the same shape as
    // the pre-flight check.
    if (err?.code === '23505' || /unique/i.test(err?.message || '')) {
      res.status(409).json({ error: { message: 'A user with this email already exists' } });
      return;
    }
    throw err;
  }
});

adminRouter.post('/users/:id/reset-password', validate(adminResetPasswordSchema), async (req, res) => {
  await adminService.resetUserPassword(req.params['id']!, req.body.password, req.userId);
  res.json({ message: 'Password reset' });
});

// Admin-required lockout unlock — CLOUDFLARE_TUNNEL_PLAN Phase 3.
// Auto-unlock-after-15-min was removed because it gave credential-
// stuffing attackers a cheap oracle. A locked account now requires
// an explicit admin action to reset the failed-attempts counter.
adminRouter.post('/users/:id/unlock', async (req, res) => {
  const result = await adminService.unlockUser(req.params['id']!, req.userId);
  res.json(result);
});

// Manual backup verification trigger. The worker runs this monthly
// automatically; super-admins can also kick it off on demand after
// restoring from disaster to confirm the new backups are readable.
// Runs synchronously — expect 1–5s per backup file. Uses the same
// advisory lock as the scheduler so a manual click during a worker
// tick returns 409 instead of doing duplicate I/O and duplicate
// audit-log entries.
adminRouter.post('/backup-verify', async (_req, res) => {
  const { verifyLatestBackups } = await import('../services/backup-verify.service.js');
  const { withSchedulerLock } = await import('../utils/scheduler-lock.js');
  const summary = await withSchedulerLock('backup-verifier', verifyLatestBackups);
  if (summary === null) {
    res.status(409).json({
      error: { message: 'A backup verification is already running. Try again in a minute.', code: 'VERIFY_IN_PROGRESS' },
    });
    return;
  }
  res.json(summary);
});

// Backup run history — the persisted backup_runs log (one row per backup
// execution, scheduled or manual, with per-destination outcomes and
// verifier results). Newest first; filterable by status/kind. The summary
// block powers the at-a-glance health header in the admin UI: last
// success per kind + consecutive-failure streaks.
adminRouter.get('/backup/runs', async (req, res) => {
  const {
    listBackupRuns, backupRunsSummary,
    BACKUP_RUN_KINDS, BACKUP_RUN_STATUSES,
  } = await import('../services/backup-run-log.service.js');

  const limitRaw = parseInt(String(req.query['limit'] ?? '50'), 10);
  const offsetRaw = parseInt(String(req.query['offset'] ?? '0'), 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), 200);
  const offset = Math.max(Number.isFinite(offsetRaw) ? offsetRaw : 0, 0);

  const statusParam = typeof req.query['status'] === 'string' ? req.query['status'] : undefined;
  const kindParam = typeof req.query['kind'] === 'string' ? req.query['kind'] : undefined;
  if (statusParam && !(BACKUP_RUN_STATUSES as string[]).includes(statusParam)) {
    res.status(400).json({ error: { message: `status must be one of: ${BACKUP_RUN_STATUSES.join(', ')}` } });
    return;
  }
  if (kindParam && !(BACKUP_RUN_KINDS as string[]).includes(kindParam)) {
    res.status(400).json({ error: { message: `kind must be one of: ${BACKUP_RUN_KINDS.join(', ')}` } });
    return;
  }

  const [{ runs, total }, summary] = await Promise.all([
    listBackupRuns({
      limit,
      offset,
      status: statusParam as (typeof BACKUP_RUN_STATUSES)[number] | undefined,
      kind: kindParam as (typeof BACKUP_RUN_KINDS)[number] | undefined,
    }),
    backupRunsSummary(),
  ]);
  res.json({ runs, total, limit, offset, summary });
});

// GitHub release check — read-only, cached 5 min. Does NOT apply any
// update; it only tells the operator whether a newer image exists on
// GHCR so they can bump VIBE_MYBOOKS_TAG and pull on their schedule.
// ?force=1 bypasses the cache for operators who just finished a release
// and want to confirm the stamp shows up.
adminRouter.get('/updates/check', async (req, res) => {
  const { checkForUpdate } = await import('../services/updates.service.js');
  const force = req.query['force'] === '1' || req.query['force'] === 'true';
  const result = await checkForUpdate(force);
  res.json(result);
});

adminRouter.post('/users/:id/toggle-active', async (req, res) => {
  const result = await adminService.toggleUserActive(req.params['id']!, req.userId);
  res.json(result);
});

adminRouter.post('/users/:id/toggle-super-admin', async (req, res) => {
  const result = await adminService.toggleSuperAdmin(req.params['id']!, req.userId);
  res.json(result);
});

adminRouter.post('/users/:id/toggle-tenant-access', validate(adminToggleTenantAccessSchema), async (req, res) => {
  const result = await adminService.toggleTenantAccess(req.params['id']!, req.body.tenantId, req.userId);
  res.json(result);
});

// Every tenant a user can reach (active or revoked) — the admin "manage a
// user's tenant access" view.
adminRouter.get('/users/:id/tenant-access', async (req, res) => {
  const access = await adminService.listUserTenantAccess(req.params['id']!);
  res.json({ access });
});

// Grant (or reactivate) a user's access to a tenant with a role. Backs both
// the tenant-detail "add firm user" flow and the user "add tenant" flow.
adminRouter.post('/users/:id/grant-tenant-access', validate(adminGrantTenantAccessSchema), async (req, res) => {
  const result = await adminService.grantTenantAccess(req.params['id']!, req.body.tenantId, req.body.role, req.userId);
  res.json(result);
});

// Firm-member users (across all firms) — candidate list for adding a firm
// user to a tenant.
adminRouter.get('/firm-users', async (_req, res) => {
  const users = await adminService.listFirmUsers();
  res.json({ users });
});

adminRouter.post('/users/:id/set-role', validate(adminSetRoleSchema), async (req, res) => {
  await adminService.setUserRole(req.params['id']!, req.body.role, req.userId);
  res.json({ message: 'Role updated', role: req.body.role });
});

// ─── Accountant Company Access ─────────────────────────────────

adminRouter.get('/users/:id/company-access', async (req, res) => {
  const access = await adminService.getAccountantCompanyAccess(req.params['id']!);
  res.json(access);
});

adminRouter.post('/users/:id/exclude-company', validate(adminCompanyAccessSchema), async (req, res) => {
  await adminService.excludeCompanyFromAccountant(req.params['id']!, req.body.companyId, req.userId);
  res.json({ message: 'Company excluded' });
});

adminRouter.post('/users/:id/include-company', validate(adminCompanyAccessSchema), async (req, res) => {
  await adminService.includeCompanyForAccountant(req.params['id']!, req.body.companyId, req.userId);
  res.json({ message: 'Company included' });
});

// ─── SMTP Test ─────────────────────────────────────────────────

adminRouter.post('/test-smtp', validate(adminSmtpTestSchema), async (req, res) => {
  const result = await testSmtpConnection(req.body, req.body.testEmail);
  res.json(result);
});

// ─── 2FA Configuration ──────────────────────────────────────────

adminRouter.get('/tfa/config', async (req, res) => {
  const config = await tfaConfigService.getConfig();
  res.json(config);
});

adminRouter.put('/tfa/config', validate(adminTfaConfigSchema), async (req, res) => {
  const config = await tfaConfigService.updateConfig(req.body, req.userId);
  res.json(config);
});

adminRouter.post('/tfa/sms-test', validate(adminTfaSmsTestSchema), async (req, res) => {
  const { phoneNumber } = req.body;
  const { getSmsProvider } = await import('../services/sms-providers/index.js');
  const config = await tfaConfigService.getRawConfig();
  const provider = getSmsProvider(config);
  const result = await provider.sendCode(phoneNumber, '123456', 'Vibe MyBooks (Test)');
  if (result.success) {
    res.json({ success: true, message: `Test SMS sent to ${phoneNumber} via ${provider.name}` });
  } else {
    res.status(400).json({ error: { message: result.error || 'SMS send failed' } });
  }
});

adminRouter.get('/tfa/stats', async (req, res) => {
  const stats = await tfaConfigService.getTfaStats();
  res.json(stats);
});

// ─── Create Client Tenant ───────────────────────────────────────

adminRouter.post('/create-client', validate(adminCreateClientSchema), async (req, res) => {
  const result = await authService.createClientTenant(req.userId, req.body);
  res.status(201).json(result);
});

// ─── Impersonation ──────────────────────────────────────────────

// ─── MCP Configuration ─────────────────────────────────────────

adminRouter.get('/mcp/config', async (req, res) => {
  const { db: database } = await import('../db/index.js');
  const { mcpConfig } = await import('../db/schema/index.js');
  let config = await database.query.mcpConfig.findFirst();
  if (!config) { const [c] = await database.insert(mcpConfig).values({}).returning(); config = c; }
  res.json(config);
});

adminRouter.put('/mcp/config', validate(adminMcpConfigSchema), async (req, res) => {
  const { db: database } = await import('../db/index.js');
  const { mcpConfig } = await import('../db/schema/index.js');
  let config = await database.query.mcpConfig.findFirst();
  if (!config) { const [c] = await database.insert(mcpConfig).values({}).returning(); config = c; }
  const updates: any = { updatedAt: new Date(), configuredBy: req.userId, configuredAt: new Date() };
  for (const key of ['isEnabled', 'maxKeysPerUser', 'systemRateLimitPerMinute', 'oauthEnabled', 'requireKeyExpiration', 'maxKeyLifetimeDays']) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (req.body.allowedScopes) updates.allowedScopes = Array.isArray(req.body.allowedScopes) ? req.body.allowedScopes.join(',') : req.body.allowedScopes;
  await database.update(mcpConfig).set(updates).where(eq(mcpConfig.id, config!.id));
  res.json(await database.query.mcpConfig.findFirst());
});

adminRouter.get('/mcp/log', async (req, res) => {
  const { db: database } = await import('../db/index.js');
  const { mcpRequestLog } = await import('../db/schema/index.js');
  const { desc } = await import('drizzle-orm');
  const logs = await database.select().from(mcpRequestLog).orderBy(desc(mcpRequestLog.createdAt)).limit(100);
  res.json({ logs });
});

adminRouter.post('/impersonate/:userId', async (req, res) => {
  const result = await adminService.impersonateUser(req.userId, req.params['userId']!);
  res.json(result);
});

// ─── Plaid Configuration ───────────────────────────────────────

adminRouter.get('/plaid/config', async (req, res) => {
  const { getConfig } = await import('../services/plaid-client.service.js');
  const config = await getConfig();
  res.json(config);
});

adminRouter.put('/plaid/config', validate(adminPlaidConfigSchema), async (req, res) => {
  const { updateConfig } = await import('../services/plaid-client.service.js');
  const config = await updateConfig(req.body, req.userId);
  res.json(config);
});

adminRouter.post('/plaid/test', async (req, res) => {
  const { testConnection } = await import('../services/plaid-client.service.js');
  const ok = await testConnection();
  res.json({ success: ok, message: ok ? 'Plaid connection successful' : 'Plaid connection failed' });
});

adminRouter.get('/plaid/connections', async (req, res) => {
  const { plaidItems, plaidAccounts, plaidAccountMappings, accounts, tenants } = await import('../db/schema/index.js');
  const { sql: sqlTag, inArray, eq: eqOp } = await import('drizzle-orm');
  const { db: database } = await import('../db/index.js');
  const items = await database.select().from(plaidItems).where(sqlTag`removed_at IS NULL`);
  const result = [];
  for (const item of items) {
    const accts = await database.select().from(plaidAccounts).where(eq(plaidAccounts.plaidItemId, item.id));
    const acctIds = accts.map((a) => a.id);
    // Plaid items/accounts are system-scoped (no tenant_id). The tenant
    // association lives on plaid_account_mappings — join it (with the tenant
    // name and mapped GL account) so the monitor can show which tenant each
    // account feeds and a correct per-connection "mapped" count.
    const maps = acctIds.length
      ? await database.select({
          plaidAccountId: plaidAccountMappings.plaidAccountId,
          tenantId: plaidAccountMappings.tenantId,
          tenantName: tenants.name,
          mappedAccountId: plaidAccountMappings.mappedAccountId,
          coaName: accounts.name,
          coaNumber: accounts.accountNumber,
          syncEnabled: plaidAccountMappings.isSyncEnabled,
          mappedByName: plaidAccountMappings.mappedByName,
        })
        .from(plaidAccountMappings)
        .leftJoin(tenants, eqOp(tenants.id, plaidAccountMappings.tenantId))
        .leftJoin(accounts, eqOp(accounts.id, plaidAccountMappings.mappedAccountId))
        .where(inArray(plaidAccountMappings.plaidAccountId, acctIds))
      : [];
    const byAcct = new Map(maps.map((m) => [m.plaidAccountId, m]));
    const enriched = accts.map((a) => {
      const m = byAcct.get(a.id);
      return {
        id: a.id,
        name: a.name,
        mask: a.mask,
        accountType: a.accountType,
        isActive: a.isActive,
        isMapped: !!m,
        tenantId: m?.tenantId ?? null,
        tenantName: m?.tenantName ?? null,
        mappedAccountId: m?.mappedAccountId ?? null,
        mappedAccountName: m ? `${m.coaNumber ? m.coaNumber + ' · ' : ''}${m.coaName ?? ''}`.trim() : null,
        syncEnabled: m?.syncEnabled ?? null,
      };
    });
    const mappedTenantNames = [...new Set(enriched.filter((a) => a.tenantName).map((a) => a.tenantName as string))];
    result.push({ ...item, accessTokenEncrypted: undefined, accounts: enriched, mappedTenantNames });
  }
  res.json({ connections: result });
});

// Tenants list for the mapping picker (id + name only).
adminRouter.get('/plaid/tenants', async (_req, res) => {
  const list = await adminService.listTenants();
  res.json({ tenants: list.map((t) => ({ id: t.id, name: t.name })) });
});

// Mappable GL accounts (bank / credit card / current asset-liability) for a
// chosen tenant, so an admin can pick the destination account when mapping.
adminRouter.get('/plaid/tenant-accounts', async (req, res) => {
  const tenantId = req.query['tenantId'] as string | undefined;
  if (!tenantId) { res.status(400).json({ error: { message: 'tenantId is required' } }); return; }
  const { accounts } = await import('../db/schema/index.js');
  const { and: andOp, eq: eqOp, inArray } = await import('drizzle-orm');
  const { db: database } = await import('../db/index.js');
  const rows = await database.select({
    id: accounts.id, name: accounts.name, accountNumber: accounts.accountNumber, detailType: accounts.detailType,
  }).from(accounts).where(andOp(
    eqOp(accounts.tenantId, tenantId),
    eqOp(accounts.isActive, true),
    inArray(accounts.detailType, ['bank', 'credit_card', 'other_current_asset', 'other_current_liability']),
  ));
  res.json({ accounts: rows });
});

// Map a Plaid account into a tenant's GL account (super-admin, cross-tenant).
// Reuses the same service the per-tenant banking flow uses, so the one
// bank-account → one company invariant and attribution are preserved.
adminRouter.post('/plaid/accounts/:plaidAccountId/map', async (req, res) => {
  const plaidMapping = await import('../services/plaid-mapping.service.js');
  const { tenantId, coaAccountId, syncStartDate } = req.body as { tenantId?: string; coaAccountId?: string; syncStartDate?: string | null };
  if (!tenantId || !coaAccountId) { res.status(400).json({ error: { message: 'tenantId and coaAccountId are required' } }); return; }
  const mapping = await plaidMapping.assignAccountToCompany(req.params['plaidAccountId']!, tenantId, coaAccountId, syncStartDate ?? null, req.userId);
  res.status(201).json(mapping);
});

// Unmap a Plaid account from a tenant.
adminRouter.post('/plaid/accounts/:plaidAccountId/unmap', async (req, res) => {
  const plaidMapping = await import('../services/plaid-mapping.service.js');
  const { tenantId } = req.body as { tenantId?: string };
  if (!tenantId) { res.status(400).json({ error: { message: 'tenantId is required' } }); return; }
  const result = await plaidMapping.unmapAccount(req.params['plaidAccountId']!, tenantId);
  res.json(result);
});

// Force-remove: local-only deletion for connections whose access token can't
// be used (e.g. cross-host restore with a different ENCRYPTION_KEY blocks the
// normal Plaid-first delete forever). Tries Plaid best-effort; proceeds
// locally regardless. Super-admin (router-wide requireSuperAdmin).
adminRouter.delete('/plaid/connections/:id/force', async (req, res) => {
  const plaidConnection = await import('../services/plaid-connection.service.js');
  const result = await plaidConnection.forceRemoveConnection(req.params['id']!, req.userId);
  res.json({ removed: true, ...result });
});

adminRouter.get('/plaid/stats', async (req, res) => {
  const { plaidItems, plaidAccounts } = await import('../db/schema/index.js');
  const { sql: sqlTag } = await import('drizzle-orm');
  const { db: database } = await import('../db/index.js');
  const stats = await database.execute(sqlTag`
    SELECT
      COUNT(*) FILTER (WHERE removed_at IS NULL) as total_items,
      COUNT(*) FILTER (WHERE item_status = 'active' AND removed_at IS NULL) as active_items,
      COUNT(*) FILTER (WHERE item_status IN ('login_required','pending_disconnect','error') AND removed_at IS NULL) as needs_attention
    FROM plaid_items
  `);
  const acctStats = await database.execute(sqlTag`
    SELECT COUNT(*) as total,
      (SELECT COUNT(*) FROM plaid_account_mappings) as mapped
    FROM plaid_accounts WHERE is_active = true
  `);
  const row = stats.rows[0] as any;
  const acctRow = acctStats.rows[0] as any;
  res.json({
    totalItems: parseInt(row.total_items) || 0,
    activeItems: parseInt(row.active_items) || 0,
    needsAttention: parseInt(row.needs_attention) || 0,
    totalAccounts: parseInt(acctRow.total) || 0,
    mappedAccounts: parseInt(acctRow.mapped) || 0,
  });
});

adminRouter.get('/plaid/webhook-log', async (req, res) => {
  const { plaidWebhookLog } = await import('../db/schema/index.js');
  const { desc } = await import('drizzle-orm');
  const { db: database } = await import('../db/index.js');
  const logs = await database.select({
    id: plaidWebhookLog.id,
    receivedAt: plaidWebhookLog.receivedAt,
    plaidItemId: plaidWebhookLog.plaidItemId,
    webhookType: plaidWebhookLog.webhookType,
    webhookCode: plaidWebhookLog.webhookCode,
    processed: plaidWebhookLog.processed,
    error: plaidWebhookLog.error,
  }).from(plaidWebhookLog).orderBy(desc(plaidWebhookLog.receivedAt)).limit(100);
  res.json({ logs });
});

// ─── Backup Remote Config ──────────────────────────────────────

adminRouter.get('/backup/remote-config', async (req, res) => {
  const config = await adminService.getBackupRemoteConfig();
  // Redact secrets from the config JSON
  let safeConfig: Record<string, any> = {};
  try {
    const parsed = JSON.parse(config.backupRemoteConfig);
    safeConfig = { ...parsed };
    // Remove encrypted fields from response
    delete safeConfig['access_token_encrypted'];
    delete safeConfig['refresh_token_encrypted'];
    delete safeConfig['secret_access_key_encrypted'];
    delete safeConfig['app_secret_encrypted'];
    delete safeConfig['client_secret_encrypted'];
    delete safeConfig['application_key_encrypted'];
    // Indicate which secrets are present
    if (parsed['access_token_encrypted']) safeConfig['hasAccessToken'] = true;
    if (parsed['refresh_token_encrypted']) safeConfig['hasRefreshToken'] = true;
    if (parsed['secret_access_key_encrypted']) safeConfig['hasSecretAccessKey'] = true;
    if (parsed['app_secret_encrypted']) safeConfig['hasAppSecret'] = true;
    if (parsed['client_secret_encrypted']) safeConfig['hasClientSecret'] = true;
    if (parsed['application_key_encrypted']) safeConfig['hasApplicationKey'] = true;
  } catch { /* empty config is fine */ }

  res.json({
    ...config,
    backupRemoteConfig: JSON.stringify(safeConfig),
  });
});


adminRouter.put('/backup/remote-config', async (req, res) => {
  const input: Partial<adminService.BackupRemoteConfig> = {};

  if (req.body.backupRemoteProvider !== undefined) input.backupRemoteProvider = req.body.backupRemoteProvider;
  if (req.body.backupLocalRetentionDays !== undefined) input.backupLocalRetentionDays = String(req.body.backupLocalRetentionDays);
  if (req.body.backupRemoteRetentionPreset !== undefined) input.backupRemoteRetentionPreset = req.body.backupRemoteRetentionPreset;
  if (req.body.backupRemoteRetentionDaily !== undefined) input.backupRemoteRetentionDaily = String(req.body.backupRemoteRetentionDaily);
  if (req.body.backupRemoteRetentionWeekly !== undefined) input.backupRemoteRetentionWeekly = String(req.body.backupRemoteRetentionWeekly);
  if (req.body.backupRemoteRetentionMonthly !== undefined) input.backupRemoteRetentionMonthly = String(req.body.backupRemoteRetentionMonthly);
  if (req.body.backupRemoteRetentionYearly !== undefined) input.backupRemoteRetentionYearly = String(req.body.backupRemoteRetentionYearly);
  if (req.body.backupDbSchedule !== undefined) {
    const v = String(req.body.backupDbSchedule);
    if (!['none', 'daily', 'weekly'].includes(v)) {
      res.status(400).json({ error: { message: 'backupDbSchedule must be none, daily, or weekly' } });
      return;
    }
    input.backupDbSchedule = v;
  }
  // Local mirror directory — trimmed; empty clears it; must be absolute so it
  // lands on the operator's mounted drive, not the process cwd.
  if (req.body.backupLocalMirrorDir !== undefined) {
    const dir = String(req.body.backupLocalMirrorDir).trim();
    if (dir && !dir.startsWith('/')) {
      res.status(400).json({ error: { message: 'Local mirror directory must be an absolute path (e.g. /data/backup-mirror)' } });
      return;
    }
    input.backupLocalMirrorDir = dir;
  }
  // Scheduler passphrase — encrypted at rest (the scheduler decrypts it),
  // written to its own top-level setting the scheduler reads. Blank/omitted
  // leaves the existing value untouched (never wipe it by accident).
  if (typeof req.body.scheduledPassphrase === 'string' && req.body.scheduledPassphrase.trim().length > 0) {
    await setSetting('backup_scheduled_passphrase', encrypt(req.body.scheduledPassphrase.trim()));
  }

  // Handle provider config with secret encryption
  if (req.body.providerConfig) {
    const pc = req.body.providerConfig;
    const configToStore: Record<string, any> = {};

    const provider = req.body.backupRemoteProvider || (await adminService.getBackupRemoteConfig()).backupRemoteProvider;

    switch (provider) {
      case 's3':
        configToStore['bucket'] = pc.bucket || '';
        configToStore['region'] = pc.region || 'us-east-1';
        configToStore['endpoint'] = pc.endpoint || '';
        configToStore['accessKeyId'] = pc.accessKeyId || '';
        if (pc.secretAccessKey) configToStore['secret_access_key_encrypted'] = encrypt(pc.secretAccessKey);
        configToStore['prefix'] = pc.prefix || 'backups/';
        break;
      case 'b2':
        configToStore['bucket'] = pc.bucket || '';
        configToStore['endpoint'] = pc.endpoint || '';
        configToStore['keyId'] = pc.keyId || '';
        if (pc.applicationKey) configToStore['application_key_encrypted'] = encrypt(pc.applicationKey);
        configToStore['region'] = pc.region || '';
        configToStore['prefix'] = pc.prefix || 'backups/';
        break;
      case 'dropbox':
        configToStore['app_key'] = pc.appKey || '';
        if (pc.appSecret) configToStore['app_secret_encrypted'] = encrypt(pc.appSecret);
        configToStore['root_folder'] = pc.rootFolder || '/Vibe MyBooks Backups';
        break;
      case 'google_drive':
        configToStore['client_id'] = pc.clientId || '';
        if (pc.clientSecret) configToStore['client_secret_encrypted'] = encrypt(pc.clientSecret);
        configToStore['folder_id'] = pc.folderId || 'root';
        break;
      case 'onedrive':
        configToStore['client_id'] = pc.clientId || '';
        if (pc.clientSecret) configToStore['client_secret_encrypted'] = encrypt(pc.clientSecret);
        configToStore['ms_tenant_id'] = pc.tenantId || 'common';
        configToStore['folder_id'] = pc.folderId || 'root';
        configToStore['drive_id'] = pc.driveId || 'me';
        break;
    }

    // Merge with existing config to preserve tokens
    try {
      const existing = JSON.parse((await adminService.getBackupRemoteConfig()).backupRemoteConfig);
      input.backupRemoteConfig = JSON.stringify({ ...existing, ...configToStore });
    } catch {
      input.backupRemoteConfig = JSON.stringify(configToStore);
    }
  }

  await adminService.saveBackupRemoteConfig(input);
  res.json({ message: 'Backup remote config saved' });
});

adminRouter.post('/backup/remote-test', async (req, res) => {
  try {
    const { DropboxProvider } = await import('../services/storage/dropbox.provider.js');
    const { GoogleDriveProvider } = await import('../services/storage/google-drive.provider.js');
    const { OneDriveProvider } = await import('../services/storage/onedrive.provider.js');
    const { S3Provider } = await import('../services/storage/s3.provider.js');

    const config = await adminService.getBackupRemoteConfig();
    const provider = config.backupRemoteProvider;
    const parsed = JSON.parse(config.backupRemoteConfig) as Record<string, any>;

    let storageProvider: import('../services/storage/storage-provider.interface.js').StorageProvider;

    switch (provider) {
      case 'dropbox': {
        const token = parsed['access_token_encrypted'] ? decrypt(parsed['access_token_encrypted']) : '';
        if (!token) { res.status(400).json({ error: { message: 'Dropbox not connected (no access token)' } }); return; }
        storageProvider = new DropboxProvider(token, { root_folder: parsed['root_folder'] });
        break;
      }
      case 'google_drive': {
        const token = parsed['access_token_encrypted'] ? decrypt(parsed['access_token_encrypted']) : '';
        if (!token) { res.status(400).json({ error: { message: 'Google Drive not connected (no access token)' } }); return; }
        storageProvider = new GoogleDriveProvider(token, { folder_id: parsed['folder_id'] });
        break;
      }
      case 'onedrive': {
        const token = parsed['access_token_encrypted'] ? decrypt(parsed['access_token_encrypted']) : '';
        if (!token) { res.status(400).json({ error: { message: 'OneDrive not connected (no access token)' } }); return; }
        storageProvider = new OneDriveProvider(token, { folder_id: parsed['folder_id'] });
        break;
      }
      case 's3': {
        if (!parsed['bucket'] || !parsed['accessKeyId']) {
          res.status(400).json({ error: { message: 'S3 not fully configured' } }); return;
        }
        storageProvider = new S3Provider({
          bucket: parsed['bucket'],
          region: parsed['region'],
          endpoint: parsed['endpoint'],
          accessKeyId: parsed['accessKeyId'],
          secretAccessKey: parsed['secret_access_key_encrypted'] ? decrypt(parsed['secret_access_key_encrypted']) : '',
          prefix: parsed['prefix'],
        });
        break;
      }
      case 'b2': {
        if (!parsed['bucket'] || !parsed['keyId'] || !parsed['endpoint']) {
          res.status(400).json({ error: { message: 'Backblaze B2 not fully configured' } }); return;
        }
        const { B2Provider } = await import('../services/storage/b2.provider.js');
        storageProvider = new B2Provider({
          bucket: parsed['bucket'],
          endpoint: parsed['endpoint'],
          keyId: parsed['keyId'],
          applicationKey: parsed['application_key_encrypted'] ? decrypt(parsed['application_key_encrypted']) : '',
          region: parsed['region'] || undefined,
          prefix: parsed['prefix'],
        });
        break;
      }
      default:
        res.status(400).json({ error: { message: 'No remote provider configured' } }); return;
    }

    const health = await storageProvider.checkHealth();
    res.json(health);
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ─── System File Storage Config ──────────────────────────────────
//
// System-level default for FILE storage (attachments, receipts, report
// PDFs). Applies to every tenant that has not configured their own
// provider under Settings > File Storage; tenants with their own
// provider are unaffected. Secrets follow the backup-remote pattern:
// encrypted at rest, never round-tripped (has* flags only), omitted
// secrets preserved on re-save.

const SYSTEM_STORAGE_PROVIDERS = ['local', 'b2', 's3'];

adminRouter.get('/storage/system-config', async (_req, res) => {
  const config = await adminService.getSystemStorageConfig();
  let safeConfig: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(config.storageSystemConfig) as Record<string, unknown>;
    safeConfig = { ...parsed };
    delete safeConfig['application_key_encrypted'];
    delete safeConfig['secret_access_key_encrypted'];
    if (parsed['application_key_encrypted']) safeConfig['hasApplicationKey'] = true;
    if (parsed['secret_access_key_encrypted']) safeConfig['hasSecretAccessKey'] = true;
  } catch { /* empty config is fine */ }

  res.json({
    storageSystemProvider: config.storageSystemProvider,
    storageSystemConfig: JSON.stringify(safeConfig),
    // Surface the deploy-time env override so the UI can explain why
    // edits here won't take effect until the env var is removed.
    envOverrideActive: !!env.STORAGE_SYSTEM_PROVIDER,
    envOverrideProvider: env.STORAGE_SYSTEM_PROVIDER ?? null,
  });
});

adminRouter.put('/storage/system-config', async (req, res) => {
  const provider = req.body.storageSystemProvider;
  if (!SYSTEM_STORAGE_PROVIDERS.includes(provider)) {
    res.status(400).json({ error: { message: `storageSystemProvider must be one of: ${SYSTEM_STORAGE_PROVIDERS.join(', ')}` } });
    return;
  }

  const input: Partial<adminService.SystemStorageConfig> = { storageSystemProvider: provider };

  if (req.body.providerConfig) {
    const pc = req.body.providerConfig as Record<string, string | undefined>;
    const configToStore: Record<string, unknown> = {};

    switch (provider) {
      case 'b2':
        configToStore['bucket'] = pc['bucket'] || '';
        configToStore['endpoint'] = pc['endpoint'] || '';
        configToStore['keyId'] = pc['keyId'] || '';
        if (pc['applicationKey']) configToStore['application_key_encrypted'] = encrypt(pc['applicationKey']);
        configToStore['region'] = pc['region'] || '';
        configToStore['prefix'] = pc['prefix'] || '';
        break;
      case 's3':
        configToStore['bucket'] = pc['bucket'] || '';
        configToStore['region'] = pc['region'] || 'us-east-1';
        configToStore['endpoint'] = pc['endpoint'] || '';
        configToStore['accessKeyId'] = pc['accessKeyId'] || '';
        if (pc['secretAccessKey']) configToStore['secret_access_key_encrypted'] = encrypt(pc['secretAccessKey']);
        configToStore['prefix'] = pc['prefix'] || '';
        break;
    }

    // Merge with existing config so omitted secrets are preserved
    try {
      const existing = JSON.parse((await adminService.getSystemStorageConfig()).storageSystemConfig);
      input.storageSystemConfig = JSON.stringify({ ...existing, ...configToStore });
    } catch {
      input.storageSystemConfig = JSON.stringify(configToStore);
    }
  }

  await adminService.saveSystemStorageConfig(input);

  // With a remote system default, tenant-level local storage is disabled:
  // deactivate any tenant rows that explicitly picked 'local' so those
  // tenants fall through to the system default. (Tenants with their own
  // REMOTE provider keep it — only local is locked down.)
  if (provider !== 'local') {
    await db.execute(sql`UPDATE storage_providers SET is_active = false WHERE provider = 'local' AND is_active = true`);
  }

  // Tenants without their own provider cached the old system default —
  // drop it so the new setting takes effect immediately.
  const { invalidateSystemProviderCache } = await import('../services/storage/storage-provider.factory.js');
  invalidateSystemProviderCache();

  res.json({ message: 'System storage config saved' });
});

adminRouter.post('/storage/system-test', async (_req, res) => {
  try {
    // Test exactly what tenants will resolve to (env override included).
    const { getSystemStorageProvider, invalidateSystemProviderCache } = await import('../services/storage/storage-provider.factory.js');
    invalidateSystemProviderCache();
    const provider = await getSystemStorageProvider();

    const health = await provider.checkHealth();
    if (health.status === 'error') {
      res.json({ ...health, provider: provider.name, probe: 'skipped' });
      return;
    }

    // Live round-trip probe: put/get/delete a tiny object so we verify
    // write + read + delete permissions, not just bucket visibility.
    const probeKey = `_vibe_health/${crypto.randomUUID()}.txt`;
    const payload = Buffer.from('vibe-mybooks system storage probe');
    try {
      await provider.upload(probeKey, payload, { fileName: 'probe.txt', mimeType: 'text/plain', sizeBytes: payload.length });
      const echoed = await provider.download(probeKey);
      if (!echoed.equals(payload)) throw new Error('Probe read-back mismatch');
      await provider.delete(probeKey);
      res.json({ ...health, provider: provider.name, probe: 'ok' });
    } catch (probeErr) {
      const message = probeErr instanceof Error ? probeErr.message : 'Probe failed';
      res.json({ status: 'error', latencyMs: health.latencyMs, error: message, provider: provider.name, probe: 'failed' });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: { message } });
  }
});

// ─── System Storage Migration ────────────────────────────────────
//
// Copies every locally-stored file blob (attachments + the rest of the
// FILE_EXPORT_REGISTRY universe) to the system remote provider, for all
// tenants using the system default. Idempotent — re-run after failures.

adminRouter.post('/storage/system-migrate', async (_req, res) => {
  const migration = await import('../services/system-storage-migration.service.js');
  if (migration.isSystemMigrationRunning()) {
    res.status(409).json({ error: { message: 'A system storage migration is already running' } });
    return;
  }
  try {
    // Resolve up-front so a local/unconfigured provider 400s here instead
    // of surfacing as a failed background run.
    const { getSystemStorageProvider } = await import('../services/storage/storage-provider.factory.js');
    const provider = await getSystemStorageProvider();
    if (provider.name === 'local') {
      res.status(400).json({ error: { message: 'System file storage is local — configure and save a remote provider first' } });
      return;
    }
  } catch (err) {
    res.status(400).json({ error: { message: err instanceof Error ? err.message : 'System storage provider unavailable' } });
    return;
  }

  migration.runSystemStorageMigration().catch((err) =>
    console.error('[SystemStorageMigration] Error:', err instanceof Error ? err.message : err));
  res.json({ started: true });
});

adminRouter.get('/storage/system-migrate/status', async (_req, res) => {
  const migration = await import('../services/system-storage-migration.service.js');
  res.json(await migration.getSystemMigrationStatus());
});

adminRouter.post('/storage/system-migrate/cancel', async (_req, res) => {
  const migration = await import('../services/system-storage-migration.service.js');
  migration.cancelSystemMigration();
  res.json({ cancelled: true });
});

// ─── Backup Remote OAuth Flow ────────────────────────────────────

// Callback base comes from env, not from req headers. A tenant who stands up
// the appliance behind a reverse proxy that forwards an arbitrary Host header
// could otherwise trick the server into building a callback URL pointing at
// an attacker-controlled host (host-header injection).
function oauthCallbackBase(): string {
  const origin = (env.CORS_ORIGIN || 'http://localhost:5173').replace(/\/$/, '');
  return origin;
}

adminRouter.get('/backup/remote-connect/:provider', async (req, res) => {
  const provider = req.params['provider']!;
  const callbackUrl = `${oauthCallbackBase()}/api/v1/admin/backup/remote-callback/${provider}`;
  const state = issueOAuthState(req.userId, provider);

  const config = await adminService.getBackupRemoteConfig();
  const parsed = JSON.parse(config.backupRemoteConfig) as Record<string, any>;

  switch (provider) {
    case 'dropbox': {
      const appKey = parsed['app_key'];
      if (!appKey) { res.status(400).json({ error: { message: 'Dropbox app credentials not configured' } }); return; }
      res.redirect(`https://www.dropbox.com/oauth2/authorize?client_id=${appKey}&response_type=code&redirect_uri=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(state)}&token_access_type=offline`);
      break;
    }
    case 'google_drive': {
      const clientId = parsed['client_id'];
      if (!clientId) { res.status(400).json({ error: { message: 'Google Drive credentials not configured' } }); return; }
      res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(state)}&scope=https://www.googleapis.com/auth/drive.file&access_type=offline&prompt=consent`);
      break;
    }
    case 'onedrive': {
      const clientId = parsed['client_id'];
      const msTenantId = parsed['ms_tenant_id'] || 'common';
      if (!clientId) { res.status(400).json({ error: { message: 'OneDrive credentials not configured' } }); return; }
      res.redirect(`https://login.microsoftonline.com/${msTenantId}/oauth2/v2.0/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(state)}&scope=Files.ReadWrite%20User.Read%20offline_access`);
      break;
    }
    default:
      res.status(400).json({ error: { message: `OAuth not supported for provider: ${provider}` } });
  }
});

adminRouter.get('/backup/remote-callback/:provider', async (req, res) => {
  const provider = req.params['provider']!;
  const code = req.query['code'] as string;
  const state = req.query['state'] as string | undefined;
  const appUrl = oauthCallbackBase();
  const callbackUrl = `${appUrl}/api/v1/admin/backup/remote-callback/${provider}`;

  if (!code) { res.redirect(`${appUrl}/admin/system?error=no_code`); return; }
  // Verify the state was issued by us for this admin + provider. Without
  // this an attacker can complete the OAuth dance against a token they
  // control and bind their cloud account to the tenant's backup config.
  if (!verifyOAuthState(state, req.userId, provider)) {
    res.redirect(`${appUrl}/admin/system?error=invalid_state`);
    return;
  }

  try {
    const config = await adminService.getBackupRemoteConfig();
    const parsed = JSON.parse(config.backupRemoteConfig) as Record<string, any>;

    let accessToken = '';
    let refreshToken = '';
    let expiresIn = 3600;

    switch (provider) {
      case 'dropbox': {
        const appKey = parsed['app_key'];
        const appSecret = parsed['app_secret_encrypted'] ? decrypt(parsed['app_secret_encrypted']) : '';
        const tokenRes = await fetch('https://api.dropboxapi.com/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `code=${code}&grant_type=authorization_code&redirect_uri=${encodeURIComponent(callbackUrl)}&client_id=${appKey}&client_secret=${appSecret}`,
        });
        const data = await tokenRes.json() as any;
        accessToken = data.access_token;
        refreshToken = data.refresh_token || '';
        break;
      }
      case 'google_drive': {
        const clientId = parsed['client_id'];
        const clientSecret = parsed['client_secret_encrypted'] ? decrypt(parsed['client_secret_encrypted']) : '';
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `code=${code}&grant_type=authorization_code&redirect_uri=${encodeURIComponent(callbackUrl)}&client_id=${clientId}&client_secret=${clientSecret}`,
        });
        const data = await tokenRes.json() as any;
        accessToken = data.access_token;
        refreshToken = data.refresh_token || '';
        expiresIn = data.expires_in || 3600;
        break;
      }
      case 'onedrive': {
        const clientId = parsed['client_id'];
        const clientSecret = parsed['client_secret_encrypted'] ? decrypt(parsed['client_secret_encrypted']) : '';
        const msTenantId = parsed['ms_tenant_id'] || 'common';
        const tokenRes = await fetch(`https://login.microsoftonline.com/${msTenantId}/oauth2/v2.0/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `code=${code}&grant_type=authorization_code&redirect_uri=${encodeURIComponent(callbackUrl)}&client_id=${clientId}&client_secret=${clientSecret}&scope=Files.ReadWrite%20User.Read%20offline_access`,
        });
        const data = await tokenRes.json() as any;
        accessToken = data.access_token;
        refreshToken = data.refresh_token || '';
        expiresIn = data.expires_in || 3600;
        break;
      }
    }

    // Merge tokens into existing config
    const updatedConfig = {
      ...parsed,
      access_token_encrypted: encrypt(accessToken),
      refresh_token_encrypted: refreshToken ? encrypt(refreshToken) : undefined,
      token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };

    await adminService.saveBackupRemoteConfig({
      backupRemoteConfig: JSON.stringify(updatedConfig),
    });

    res.redirect(`${appUrl}/admin/system?backup_connected=${provider}`);
  } catch (err: any) {
    res.redirect(`${appUrl}/admin/system?error=${encodeURIComponent(err.message)}`);
  }
});

// ─── COA Templates ──────────────────────────────────────────────
//
// Super-admin CRUD over the chart-of-accounts templates that ship with
// the app and that admins can extend at runtime. The actual seeding of
// a tenant's accounts table from these templates happens in
// accounts.service.seedFromTemplate.

adminRouter.get('/coa-templates', async (_req, res) => {
  const templates = await coaTemplatesService.list();
  res.json({ templates });
});

adminRouter.get('/coa-templates/:slug', async (req, res) => {
  const template = await coaTemplatesService.getBySlug(req.params['slug']!);
  res.json({ template });
});

adminRouter.post('/coa-templates', validate(createCoaTemplateSchema), async (req, res) => {
  const template = await coaTemplatesService.create(req.body, req.userId);
  res.status(201).json({ template });
});

adminRouter.put('/coa-templates/:slug', validate(updateCoaTemplateSchema), async (req, res) => {
  const template = await coaTemplatesService.update(req.params['slug']!, req.body);
  res.json({ template });
});

adminRouter.delete('/coa-templates/:slug', async (req, res) => {
  await coaTemplatesService.remove(req.params['slug']!, req.tenantId, req.userId);
  res.json({ message: 'Template deleted' });
});

// Toggle hidden state. Body: { hidden: boolean }. Hiding a template
// removes it from the public business-type dropdowns at registration
// / setup time without deleting it. Built-in templates support this
// (since they can't be deleted) and so do custom templates.
adminRouter.patch('/coa-templates/:slug/hidden', async (req, res) => {
  const hidden = req.body?.hidden;
  if (typeof hidden !== 'boolean') {
    res.status(400).json({ error: { message: 'hidden (boolean) is required' } });
    return;
  }
  const template = await coaTemplatesService.setHidden(req.params['slug']!, hidden);
  res.json({ template });
});

// ─── CPA report letters (SSARS 21) — system-level templates ───
// CRUD is super-admin only (inherits the router-level requireSuperAdmin).
// The active-letter picker used by the report-pack builder is served on the
// tenant-facing reports router (reports:read), not here.
adminRouter.get('/report-letters', async (_req, res) => {
  const letters = await reportLetterService.listLetters();
  res.json({ letters });
});

adminRouter.get('/report-letters/:id', async (req, res) => {
  const letter = await reportLetterService.getLetter(req.params['id']!);
  res.json({ letter });
});

adminRouter.post('/report-letters', validate(createReportLetterSchema), async (req, res) => {
  const letter = await reportLetterService.createLetter(req.body, req.tenantId, req.userId);
  res.status(201).json({ letter });
});

adminRouter.put('/report-letters/:id', validate(updateReportLetterSchema), async (req, res) => {
  const letter = await reportLetterService.updateLetter(req.params['id']!, req.body, req.tenantId, req.userId);
  res.json({ letter });
});

adminRouter.delete('/report-letters/:id', async (req, res) => {
  await reportLetterService.deleteLetter(req.params['id']!, req.tenantId, req.userId);
  res.json({ message: 'Letter deleted' });
});

// Import = same shape as create. Kept as a separate endpoint so the
// frontend can present a clearer "Import JSON" UI and so we can later
// add format negotiation (CSV, etc.) without breaking the create route.
adminRouter.post('/coa-templates/import', validate(importCoaTemplateSchema), async (req, res) => {
  const template = await coaTemplatesService.create(req.body, req.userId);
  res.status(201).json({ template });
});

adminRouter.post(
  '/coa-templates/from-tenant',
  validate(cloneCoaTemplateFromTenantSchema),
  async (req, res) => {
    const { tenantId, slug, label } = req.body;
    const template = await coaTemplatesService.cloneFromTenant(tenantId, slug, label, req.userId);
    res.status(201).json({ template });
  },
);

// ─── Installation Security (Phase B) ─────────────────────────────

/**
 * Verify the caller's password against the users table. Each of the three
 * destructive security actions below requires a fresh password to prove
 * the admin is still at the keyboard — this is not something we want a
 * stolen session token to unlock.
 */
async function verifyCallerPassword(userId: string, password: string): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT password_hash FROM users WHERE id = ${userId} LIMIT 1
  `);
  const row = (rows.rows as any[])[0];
  if (!row) return false;
  return bcrypt.compare(password, row.password_hash);
}

adminRouter.get('/security/status', async (_req, res) => {
  let sentinelHeader = null;
  if (sentinelExists()) {
    try {
      sentinelHeader = readSentinelHeader();
    } catch {
      sentinelHeader = null;
    }
  }
  const dbInstallationId = await getSetting(SystemSettingsKeys.INSTALLATION_ID);

  // F14: freshness check. Compare the sentinel's stored secret hashes
  // against the live process.env values. If they disagree, something
  // was rotated out-of-band (manual .env edit, different JWT secret
  // pushed via config management, etc.) and the recovery file is no
  // longer consistent with /data/config/.env.
  let recoveryFileStale = false;
  const staleFields: string[] = [];
  const encryptionKey = process.env['ENCRYPTION_KEY'];
  if (sentinelExists() && encryptionKey) {
    try {
      const { readSentinelPayload } = await import('../services/sentinel.service.js');
      const payload = readSentinelPayload(encryptionKey);
      if (payload) {
        const liveDbHash = crypto.createHash('sha256').update(process.env['DATABASE_URL'] ?? '').digest('hex');
        const liveJwtHash = crypto.createHash('sha256').update(process.env['JWT_SECRET'] ?? '').digest('hex');
        if (payload.databaseUrlHash !== liveDbHash) staleFields.push('DATABASE_URL');
        if (payload.jwtSecretHash !== liveJwtHash) staleFields.push('JWT_SECRET');
        recoveryFileStale = staleFields.length > 0;
      }
    } catch {
      // If we can't decrypt the sentinel, freshness is unknowable — leave false.
    }
  }

  res.json({
    sentinelExists: sentinelExists(),
    sentinelHeader,
    recoveryFileExists: recoveryFileExists(),
    recoveryFileStale,
    staleFields,
    dbInstallationId,
    // Cross-host restores park the source install's recovery file so the
    // operator can recover credential encryption with their original key.
    sourceRecoveryFileExists: sourceRecoveryFileExists(),
  });
});

/**
 * Cross-host credential recovery: re-encrypt every stored *_encrypted
 * credential from the SOURCE server's key to this server's key. The source
 * key comes either from the parked source recovery file (operator enters
 * their ORIGINAL recovery key) or as a directly-pasted PLAID_ENCRYPTION_KEY.
 * Verify-first and transactional — a wrong key changes nothing.
 */
adminRouter.post('/security/credential-encryption/recover', stepUpLimiter, async (req, res) => {
  const password = (req.body?.password ?? '').toString();
  if (!password) {
    res.status(400).json({ error: { message: 'current password required' } });
    return;
  }
  if (!(await verifyCallerPassword(req.userId!, password))) {
    res.status(401).json({ error: { message: 'incorrect password' } });
    return;
  }

  const report = await recoverCredentialEncryption({
    recoveryKey: typeof req.body?.recoveryKey === 'string' ? req.body.recoveryKey : undefined,
    sourceKey: typeof req.body?.sourceKey === 'string' ? req.body.sourceKey : undefined,
  });
  sentinelAudit('credentials.reencrypted', {
    source: 'admin-security-page',
    origin: report.sourceKeyOrigin,
    reencrypted: report.totals.reencrypted,
    unreadable: report.totals.unreadable,
  });
  res.json(report);
});

/**
 * F14: refresh /data/.env.recovery with the current process.env values
 * while keeping the same recovery key. Used when an admin rotates
 * ENCRYPTION_KEY / JWT_SECRET / DATABASE_URL out-of-band and wants the
 * recovery file to stay in sync without regenerating the recovery key.
 *
 * Requires the operator to enter BOTH their password (for step-up auth)
 * AND their current recovery key (to prove they still hold it — we'd
 * otherwise be silently re-encrypting values they might not control).
 */
adminRouter.post('/security/recovery-file/refresh', stepUpLimiter, async (req, res) => {
  const password = (req.body?.password ?? '').toString();
  const recoveryKey = (req.body?.recoveryKey ?? '').toString();
  if (!password || !recoveryKey) {
    res.status(400).json({ error: { message: 'password and recoveryKey required' } });
    return;
  }
  if (!(await verifyCallerPassword(req.userId!, password))) {
    res.status(401).json({ error: { message: 'incorrect password' } });
    return;
  }
  if (!recoveryFileExists()) {
    res.status(404).json({ error: { message: 'no recovery file to refresh' } });
    return;
  }

  // Verify the operator's recovery key matches the current file.
  try {
    const contents = readRecoveryFile(recoveryKey);
    if (!contents) {
      res.status(404).json({ error: { message: 'recovery file missing' } });
      return;
    }
  } catch {
    res.status(401).json({ error: { message: 'recovery key did not decrypt the current recovery file' } });
    return;
  }

  const encryptionKey = process.env['ENCRYPTION_KEY'];
  const jwtSecret = process.env['JWT_SECRET'];
  const databaseUrl = process.env['DATABASE_URL'];
  if (!encryptionKey || !jwtSecret || !databaseUrl) {
    res.status(500).json({
      error: { message: 'ENCRYPTION_KEY, JWT_SECRET, and DATABASE_URL must all be set' },
    });
    return;
  }

  const installationId = await getSetting(SystemSettingsKeys.INSTALLATION_ID);
  try {
    writeRecoveryFile(recoveryKey, { encryptionKey, jwtSecret, databaseUrl, ...(process.env['PLAID_ENCRYPTION_KEY'] ? { plaidEncryptionKey: process.env['PLAID_ENCRYPTION_KEY'] } : {}) }, installationId);
  } catch (err) {
    res.status(500).json({ error: { message: (err as Error).message } });
    return;
  }

  sentinelAudit('recovery.key_regenerated', {
    source: 'admin-security-refresh',
    mode: 'refresh-in-place',
    installationId,
    userId: req.userId,
  });

  res.json({
    success: true,
    message: 'Recovery file refreshed with current environment values. The recovery key is unchanged.',
  });
});

/**
 * Regenerate the recovery key. Requires current password. Returns the new
 * key exactly once — server never persists it. The old recovery key stops
 * working the moment /data/.env.recovery is overwritten.
 */
adminRouter.post('/security/recovery-key/regenerate', stepUpLimiter, async (req, res) => {
  const password = (req.body?.password ?? '').toString();
  if (!password) {
    res.status(400).json({ error: { message: 'current password required' } });
    return;
  }
  if (!(await verifyCallerPassword(req.userId!, password))) {
    res.status(401).json({ error: { message: 'incorrect password' } });
    return;
  }

  const encryptionKey = process.env['ENCRYPTION_KEY'];
  const jwtSecret = process.env['JWT_SECRET'];
  const databaseUrl = process.env['DATABASE_URL'];
  if (!encryptionKey || !jwtSecret || !databaseUrl) {
    res.status(500).json({
      error: { message: 'ENCRYPTION_KEY, JWT_SECRET, and DATABASE_URL must be set' },
    });
    return;
  }

  const installationId = await getSetting(SystemSettingsKeys.INSTALLATION_ID);
  const newKey = generateRecoveryKey();
  try {
    writeRecoveryFile(newKey, { encryptionKey, jwtSecret, databaseUrl, ...(process.env['PLAID_ENCRYPTION_KEY'] ? { plaidEncryptionKey: process.env['PLAID_ENCRYPTION_KEY'] } : {}) }, installationId);
  } catch (err) {
    res.status(500).json({ error: { message: (err as Error).message } });
    return;
  }

  sentinelAudit('recovery.key_regenerated', {
    source: 'admin-security-page',
    installationId,
    userId: req.userId,
  });

  res.json({
    success: true,
    recoveryKey: newKey,
    message: 'New recovery key generated. Save it — it will not be shown again.',
  });
});

/**
 * Test an operator-supplied recovery key without revealing the decrypted
 * values. Responds with success/failure only. Used in admin settings so
 * operators can verify their paper copy still works before needing it in
 * an emergency.
 */
adminRouter.post('/security/recovery-key/test', async (req, res) => {
  const candidate = (req.body?.recoveryKey ?? '').toString();
  if (!candidate) {
    res.status(400).json({ error: { message: 'recoveryKey required' } });
    return;
  }
  if (!recoveryFileExists()) {
    res.status(404).json({ error: { message: 'no recovery file on this server' } });
    return;
  }
  try {
    parseRecoveryKey(candidate);
  } catch (err) {
    res.status(400).json({ valid: false, error: { message: (err as Error).message } });
    return;
  }
  try {
    const contents = readRecoveryFile(candidate);
    if (!contents) {
      res.status(404).json({ valid: false });
      return;
    }
    res.json({ valid: true, createdAt: contents.createdAt, installationId: contents.installationId });
  } catch {
    res.status(401).json({ valid: false });
  }
});

/**
 * Rotate installation_id. Useful after a suspected compromise or a
 * compliance-driven rotation cycle. Regenerates the sentinel with the new
 * ID and writes a new recovery file (with a new recovery key — shown once).
 * Requires current password.
 */
adminRouter.post('/security/installation-id/rotate', stepUpLimiter, async (req, res) => {
  const password = (req.body?.password ?? '').toString();
  if (!password) {
    res.status(400).json({ error: { message: 'current password required' } });
    return;
  }
  if (!(await verifyCallerPassword(req.userId!, password))) {
    res.status(401).json({ error: { message: 'incorrect password' } });
    return;
  }

  const encryptionKey = process.env['ENCRYPTION_KEY'];
  const jwtSecret = process.env['JWT_SECRET'];
  const databaseUrl = process.env['DATABASE_URL'];
  if (!encryptionKey || !jwtSecret || !databaseUrl) {
    res.status(500).json({
      error: { message: 'ENCRYPTION_KEY, JWT_SECRET, and DATABASE_URL must be set' },
    });
    return;
  }

  // Look up admin email for the new sentinel header.
  const adminRow = await db.execute(sql`
    SELECT email FROM users WHERE id = ${req.userId} LIMIT 1
  `);
  const adminEmail = (adminRow.rows as any[])[0]?.email ?? 'unknown';

  let newInstallationId: string;
  let newRecoveryKey: string;
  try {
    const result = await withSetupLock(async () => {
      newInstallationId = crypto.randomUUID();
      await setSetting(SystemSettingsKeys.INSTALLATION_ID, newInstallationId);

      const hostId = ensureHostId();
      deleteSentinel();
      createSentinel(
        {
          installationId: newInstallationId,
          hostId,
          adminEmail,
          appVersion: process.env['APP_VERSION'] || '0.1.0',
          databaseUrl,
          jwtSecret,
          tenantCountAtSetup: 1,
        },
        encryptionKey,
      );

      newRecoveryKey = generateRecoveryKey();
      writeRecoveryFile(
        newRecoveryKey,
        { encryptionKey, jwtSecret, databaseUrl, ...(process.env['PLAID_ENCRYPTION_KEY'] ? { plaidEncryptionKey: process.env['PLAID_ENCRYPTION_KEY'] } : {}) },
        newInstallationId,
      );
      return { installationId: newInstallationId, recoveryKey: newRecoveryKey };
    });

    sentinelAudit('installation.host_id_changed', {
      source: 'admin-security-page',
      reason: 'installation_id rotation',
      newInstallationId: result.installationId,
      userId: req.userId,
    });

    res.json({
      success: true,
      installationId: result.installationId,
      recoveryKey: result.recoveryKey,
      message: 'Installation ID rotated. Save the new recovery key — it will not be shown again.',
    });
  } catch (err) {
    const message = err instanceof SentinelError ? err.message : (err as Error).message;
    res.status(500).json({ error: { message } });
  }
});

/**
 * Delete the recovery file entirely. Used if the operator no longer wants
 * recovery capability (e.g., they manage their env separately and consider
 * the recovery file a liability). Irreversible without a new regenerate.
 */
adminRouter.delete('/security/recovery-key', stepUpLimiter, async (req, res) => {
  const password = (req.body?.password ?? '').toString();
  if (!password) {
    res.status(400).json({ error: { message: 'current password required' } });
    return;
  }
  if (!(await verifyCallerPassword(req.userId!, password))) {
    res.status(401).json({ error: { message: 'incorrect password' } });
    return;
  }
  deleteRecoveryFile();
  sentinelAudit('recovery.key_regenerated', {
    source: 'admin-security-page',
    action: 'delete',
    userId: req.userId,
  });
  res.json({ success: true, message: 'Recovery file deleted.' });
});
