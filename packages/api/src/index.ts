import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { app } from './app.js';
import { env } from './config/env.js';
import { db } from './db/index.js';
import { startBackupScheduler } from './services/backup-scheduler.service.js';
import { startRecurringScheduler } from './services/recurring.service.js';
import * as coaTemplatesService from './services/coa-templates.service.js';
import { seedPayrollTemplates } from './services/payroll-templates.seed.js';
import * as setupService from './services/setup.service.js';

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

  // Ensure the first-run setup token exists when the system is not yet
  // initialized. The token is printed prominently on every startup until
  // setup completes — it's the second factor (alongside the HTTP-level
  // guard) protecting /api/setup/initialize and /api/setup/restore/execute
  // from anonymous callers. Once setup finishes, the token file is
  // deleted and this block becomes a no-op.
  try {
    const token = setupService.ensureSetupToken();
    if (token) {
      const banner = '='.repeat(72);
      console.log('');
      console.log(banner);
      console.log('  FIRST-RUN SETUP TOKEN');
      console.log('');
      console.log('  The setup wizard at /first-run-setup requires this token to');
      console.log('  authorize creating the admin account or restoring a backup.');
      console.log('');
      console.log(`    ${token}`);
      console.log('');
      console.log('  (also saved to /data/config/.setup-token on the API container)');
      console.log('  This token is consumed automatically once setup completes.');
      console.log(banner);
      console.log('');
    }
  } catch (err) {
    console.error('Failed to prepare setup token:', err);
  }

  // Start server
  app.listen(env.PORT, () => {
    console.log(`Vibe MyBooks API listening on port ${env.PORT}`);
    startBackupScheduler();
    startRecurringScheduler();
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
