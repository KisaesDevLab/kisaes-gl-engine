// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Desktop-only routes (CL_MODE=desktop), mounted at /api/v1/desktop. Every
 * request has already passed the launch-token gate; there is no user yet
 * when /initialize runs, so these routes do not use authenticate().
 *
 *   POST /initialize  first-run: create the owner account and first company.
 *                     Replaces the appliance's /api/setup/initialize, which
 *                     writes a .env with secrets and an installation
 *                     sentinel — the desktop app keeps secrets in the OS
 *                     keychain and owns install identity, so this writes
 *                     neither. 409 once any user exists.
 *   GET  /info        mode, queue backend, data dir, DB role, initialized.
 */

import { Router } from 'express';
import fs from 'node:fs';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../utils/errors.js';
import { desktopProfile } from '../desktop/profile.js';
import { readDbSuperuser } from '../startup/db-role.js';
import * as setupService from '../services/setup.service.js';
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
  // The first company is required: the engine creates the owner account
  // inside it (setup.service createAdminUser).
  company: z.object({
    name: z.string().trim().min(1, 'Company name is required').max(255),
    businessType: z.string().trim().max(120).optional(),
    entityType: z.string().trim().max(60).optional(),
    industry: z.string().trim().max(120).optional(),
  }),
});

type DesktopInitializeInput = z.infer<typeof desktopInitializeSchema>;

desktopRouter.post('/initialize', validate(desktopInitializeSchema), async (req, res) => {
  const input = req.body as DesktopInitializeInput;
  let created: { tenantId: string; userId: string };
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
      const result = await setupService.createAdminUser({
        email: input.admin.email,
        password: input.admin.password,
        displayName: input.admin.displayName,
        companyName: input.company.name,
        businessType: input.company.businessType,
        entityType: input.company.entityType,
        industry: input.company.industry,
      });
      // Non-secret marker under CONFIG_DIR (= CL_DATA_DIR/config) so
      // /api/setup/status reports the install as set up.
      setupService.markInitialized({ via: 'desktop/initialize', tenantId: result.tenantId });
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
  res.status(201).json({ tenantId: created.tenantId, userId: created.userId });
});

desktopRouter.get('/info', async (_req, res) => {
  const p = desktopProfile();
  let dbSuperuser: boolean | null = null;
  let initialized: boolean | null = null;
  try {
    dbSuperuser = await readDbSuperuser();
    initialized = (await setupService.countTenantsAndUsers()).users > 0;
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
    initialized,
  });
});
