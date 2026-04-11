import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { app } from './app.js';
import { env } from './config/env.js';
import { db } from './db/index.js';
import { startBackupScheduler } from './services/backup-scheduler.service.js';
import * as coaTemplatesService from './services/coa-templates.service.js';

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

  // Start server
  app.listen(env.PORT, () => {
    console.log(`Vibe MyBooks API listening on port ${env.PORT}`);
    startBackupScheduler();
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
