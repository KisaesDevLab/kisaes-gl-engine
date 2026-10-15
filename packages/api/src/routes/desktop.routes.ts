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
 *                     workspaceTenantId.
 */

import { Router } from 'express';
import fs from 'node:fs';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../utils/errors.js';
import { desktopProfile } from '../desktop/profile.js';
import { readDbRole } from '../startup/db-role.js';
import * as setupService from '../services/setup.service.js';
import * as authService from '../services/auth.service.js';
import * as accountsService from '../services/accounts.service.js';
import { createWorkspaceWithOwner, getWorkspaceTenantId } from '../desktop/workspace.js';
import { desktopWarning } from '../desktop/fatal.js';
import { env } from '../config/env.js';
import { getCurrentVersion } from '../services/updates.service.js';

export const desktopRouter = Router();

export const desktopInitializeSchema = z.object({
  admin: z.object({
    email: z.string().trim().email('A valid email is required').max(320),
    displayName: z.string().trim().min(1, 'Name is required').max(255),
    // Platform-wide password policy is 12 characters (see auth.service).
    password: z.string().min(12, 'Password must be at least 12 characters').max(1024),
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
  });
});
