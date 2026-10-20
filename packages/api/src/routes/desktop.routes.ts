// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Desktop-only routes (CL_MODE=desktop), mounted at /api/v1/desktop. Every
 * request has already passed the launch-token gate; there is no user yet
 * when /initialize runs, so these routes do not use authenticate().
 *
 *   POST /initialize  first-run: create the hidden workspace tenant, the
 *                     owner account (super admin, homed in the workspace)
 *                     and, optionally, the first company. Replaces the
 *                     appliance's /api/setup/initialize, which writes a .env
 *                     with secrets and an installation sentinel and joins
 *                     the appliance firm — the desktop app keeps secrets in
 *                     the OS keychain, owns install identity and has no
 *                     firms, so this writes none of them. 409 once any user
 *                     exists.
 *   GET  /info        mode, queue backend, data dir, DB role, initialized,
 *                     workspaceTenantId, capabilities.
 *   PUT/GET/DELETE /session-secrets
 *                     per-session AI keys, Ollama endpoint and SMTP password
 *                     (desktop/session-secrets.ts). These DO authenticate:
 *                     the launch token plus a signed-in super admin (the
 *                     owner). Values are held in memory only and never
 *                     returned; GET shows presence and a fingerprint.
 */

import { Router } from 'express';
import fs from 'node:fs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { getRateLimitStore } from '../utils/rate-limit-store.js';
import { PASSWORD_MIN_LENGTH, PASSWORD_MIN_MESSAGE } from '@kis-books/shared';
import { validate } from '../middleware/validate.js';
import { AppError } from '../utils/errors.js';
import { desktopProfile } from '../desktop/profile.js';
import { readDbRole } from '../startup/db-role.js';
import * as setupService from '../services/setup.service.js';
import * as authService from '../services/auth.service.js';
import * as accountsService from '../services/accounts.service.js';
import { createWorkspaceWithOwner, getWorkspaceTenantId } from '../desktop/workspace.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { desktopWarning } from '../desktop/fatal.js';
import { env } from '../config/env.js';
import { getCurrentVersion } from '../services/updates.service.js';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { describe } from '../middleware/describe.js';
import * as sessionSecrets from '../desktop/session-secrets.js';

export const desktopRouter = Router();

export const desktopInitializeSchema = z.object({
  admin: z.object({
    email: z.string().trim().email('A valid email is required').max(320),
    displayName: z.string().trim().min(1, 'Name is required').max(255),
    // Platform-wide minimum (shared password policy). bcrypt only uses the
    // first 72 bytes, so longer passwords would silently be truncated.
    password: z.string()
      .min(PASSWORD_MIN_LENGTH, PASSWORD_MIN_MESSAGE)
      .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'Password must be at most 72 bytes (UTF-8)'),
  }),
  // Optional first company. Zero companies is a valid state: the caller can
  // create one later with POST /api/v1/auth/create-tenant.
  company: z.object({
    name: z.string().trim().min(1, 'Company name is required').max(255),
    businessType: z.string().trim().max(120).optional(),
    entityType: z.string().trim().max(60).optional(),
    industry: z.string().trim().max(120).optional(),
  }).optional(),
});

type DesktopInitializeInput = z.infer<typeof desktopInitializeSchema>;

export interface DesktopInitializeResult {
  workspaceTenantId: string;
  userId: string;
  companyTenantId: string | null;
  warnings: string[];
}

desktopRouter.post('/initialize', validate(desktopInitializeSchema), async (req, res) => {
  const input = req.body as DesktopInitializeInput;
  // An unknown chart-of-accounts template is a bad request: refuse before
  // anything is written.
  if (input.company) {
    await accountsService.assertTemplateExists(input.company.businessType || 'default');
  }
  let created: DesktopInitializeResult;
  try {
    created = await setupService.withSetupLock(async () => {
      const counts = await setupService.countTenantsAndUsers();
      if (counts.users > 0) {
        throw AppError.conflict('This company file is already set up.', 'ALREADY_INITIALIZED');
      }
      if (counts.tenants > 0) {
        throw AppError.conflict(
          'The database holds company data without any user account.',
          'TENANTS_WITHOUT_USERS',
        );
      }
      const owner = await createWorkspaceWithOwner(input.admin);
      // Non-secret marker under CONFIG_DIR (= CL_DATA_DIR/config) so
      // /api/setup/status reports the install as set up.
      setupService.markInitialized({ via: 'desktop/initialize', workspaceTenantId: owner.workspaceTenantId });

      const result: DesktopInitializeResult = { ...owner, companyTenantId: null, warnings: [] };
      if (input.company) {
        try {
          const company = await authService.createDesktopCompany(owner.userId, {
            companyName: input.company.name,
            businessType: input.company.businessType,
            entityType: input.company.entityType,
            industry: input.company.industry,
          });
          result.companyTenantId = company.tenantId;
        } catch (err) {
          // The workspace and the owner stay: zero companies is valid, and
          // the caller retries with POST /api/v1/auth/create-tenant.
          const code = err instanceof AppError ? err.code : (err as { code?: string } | null)?.code;
          desktopWarning('COMPANY_NOT_CREATED', `first company could not be created (${code ?? 'error'})`);
          result.warnings.push('COMPANY_NOT_CREATED');
        }
      }
      return result;
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('already in progress')) {
      throw AppError.conflict('Setup is already running. Try again in a moment.', 'SETUP_BUSY');
    }
    throw err;
  }
  res.status(201).json(created);
});

desktopRouter.get('/info', async (_req, res) => {
  const p = desktopProfile();
  let dbSuperuser: boolean | null = null;
  let dbRole: { dangerous: string[]; warnings: string[] } | null = null;
  let initialized: boolean | null = null;
  let workspaceTenantId: string | null = null;
  try {
    const role = await readDbRole();
    dbSuperuser = role.superuser;
    dbRole = { dangerous: role.dangerous, warnings: role.warnings };
    initialized = (await setupService.countTenantsAndUsers()).users > 0;
    workspaceTenantId = await getWorkspaceTenantId();
  } catch {
    /* database unavailable: report unknown */
  }
  res.json({
    mode: p.mode,
    version: getCurrentVersion(),
    engineCommit: env.ENGINE_COMMIT ?? null,
    queueBackend: p.queueBackend,
    offline: p.offline,
    lan: p.lan,
    dataDirExists: p.dataDir ? fs.existsSync(p.dataDir) : false,
    dbSuperuser,
    dbRole,
    initialized,
    workspaceTenantId,
    capabilities: [...DESKTOP_CAPABILITIES],
  });
});

// ─── Session secrets (E6) ───────────────────────────────────────
//
// Lengths are capped so an oversize body is a 400 before anything is
// stored. The schemas are strict: an unknown key is a validation error
// that names the key, never its value (the error handler echoes Zod
// issue paths and messages only).

const apiKeySchema = z.object({
  apiKey: z.string().min(8, 'API key is too short').max(512),
}).strict();

export const sessionSecretsPutSchema = z.object({
  ai: z.object({
    anthropic: apiKeySchema.optional(),
    openai: apiKeySchema.optional(),
    ollama: z.object({
      baseUrl: z.string().trim().min(1).max(512),
      model: z.string().trim().max(200).optional(),
    }).strict().optional(),
  }).strict().optional(),
  // The SMTP password for the session and, with it, the mail server the
  // owner wants to reach (validated, mail ports only; omitted = a relay on
  // this machine or a host in CL_EGRESS_ALLOW).
  // `security`: `tls` (TLS from the first byte, port 465), `starttls`
  // (STARTTLS required) or `none` (clear text; this machine or the owner's
  // own network only). Default: `tls` on port 465, else `starttls`.
  smtp: z.object({
    password: z.string().min(1).max(512).optional(),
    host: z.string().trim().min(1).max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    security: z.enum(['tls', 'starttls', 'none']).optional(),
  }).strict().refine((v) => v.password !== undefined || v.host !== undefined, {
    message: 'password or host is required',
  }).optional(),
}).strict();

type SessionSecretsPutInput = z.infer<typeof sessionSecretsPutSchema>;

const sessionSecretsResponse = z.record(
  z.enum(sessionSecrets.SESSION_SECRET_NAMES),
  z.object({ present: z.boolean(), fingerprint: z.string().optional() }),
);

// The desktop gate exempts the app from the global limiter; this one keeps
// a looping client from re-registering secrets (and DNS checks) all day.
const sessionSecretsLimiter = rateLimit({
  store: getRateLimitStore('desktop:sessionSecrets'),
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId || req.ip || 'desktop',
  message: { error: { message: 'Too many session-secret changes; wait a moment.', code: 'TOO_MANY_REQUESTS' } },
});

const requireOwner = [authenticate, requireSuperAdmin, sessionSecretsLimiter] as const;

desktopRouter.get(
  '/session-secrets',
  ...requireOwner,
  describe({ summary: 'Presence and fingerprint of each session secret (never the value)', response: sessionSecretsResponse }),
  (_req, res) => {
    res.json(sessionSecrets.sessionSecretStatus());
  },
);

desktopRouter.put(
  '/session-secrets',
  ...requireOwner,
  validate(sessionSecretsPutSchema),
  describe({ summary: 'Set per-session AI keys, Ollama endpoint and SMTP password (memory only)', response: sessionSecretsResponse }),
  async (req, res) => {
    const input = req.body as SessionSecretsPutInput;
    // Validate everything before storing anything, so a bad Ollama URL or
    // SMTP host does not leave half the body applied.
    const ollamaBaseUrl = input.ai?.ollama ? await sessionSecrets.validateOllamaBaseUrl(input.ai.ollama.baseUrl) : null;
    if (input.smtp?.host) {
      await sessionSecrets.allowSmtpEgress({ host: input.smtp.host, port: input.smtp.port ?? 587, security: input.smtp.security });
    }
    if (input.ai?.anthropic) sessionSecrets.setAnthropicKey(input.ai.anthropic.apiKey);
    if (input.ai?.openai) sessionSecrets.setOpenaiKey(input.ai.openai.apiKey);
    if (ollamaBaseUrl !== null) await sessionSecrets.setOllamaBaseUrl(ollamaBaseUrl, input.ai?.ollama?.model);
    if (input.smtp?.password !== undefined) sessionSecrets.setSmtpPassword(input.smtp.password);
    res.json(sessionSecrets.sessionSecretStatus());
  },
);

desktopRouter.delete(
  '/session-secrets/:name',
  ...requireOwner,
  describe({
    summary: 'Forget one session secret and its egress allowance',
    params: z.object({ name: z.enum(sessionSecrets.SESSION_SECRET_NAMES) }),
    response: sessionSecretsResponse,
  }),
  (req, res) => {
    const name = String(req.params['name']);
    if (!sessionSecrets.isSessionSecretName(name)) {
      throw AppError.notFound('Unknown session secret name');
    }
    sessionSecrets.deleteSessionSecret(name);
    res.json(sessionSecrets.sessionSecretStatus());
  },
);
