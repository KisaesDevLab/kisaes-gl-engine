// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { app } from './app.js';
import { env } from './config/env.js';
import { db } from './db/index.js';
import { startBackupScheduler } from './services/backup-scheduler.service.js';
import { startRecurringScheduler } from './services/recurring.service.js';
import { startFingerprintScheduler } from './services/db-fingerprint.service.js';
import * as coaTemplatesService from './services/coa-templates.service.js';
import { seedPayrollTemplates } from './services/payroll-templates.seed.js';

async function start() {
  // Run migrations
  console.log('Running migrations...');
  await migrate(db, { migrationsFolder: './packages/api/src/db/migrations' });
  console.log('Migrations complete.');

  // Bootstrap built-in COA templates from the static BUSINESS_TEMPLATES
  // constant. Idempotent — only inserts when the coa_templates table is
  // empty. After this runs once, super admins can edit templates via
  // /admin/coa-templates and those edits become the source of truth.
  try {
    const result = await coaTemplatesService.bootstrapBuiltins();
    if (result.inserted > 0) {
      console.log(`Bootstrapped ${result.inserted} COA templates.`);
    }
  } catch (err) {
    console.error('Failed to bootstrap COA templates:', err);
  }

  // Seed payroll provider templates
  try {
    await seedPayrollTemplates();
  } catch (err) {
    console.error('Failed to seed payroll templates:', err);
  }

  // Start server
  app.listen(env.PORT, () => {
    console.log(`Vibe MyBooks API listening on port ${env.PORT}`);
    startBackupScheduler();
    startRecurringScheduler();
    startFingerprintScheduler();
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
