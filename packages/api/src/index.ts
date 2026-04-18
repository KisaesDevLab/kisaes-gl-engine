// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { app } from './app.js';
import { env } from './config/env.js';
import { db, pool } from './db/index.js';
import { startBackupScheduler } from './services/backup-scheduler.service.js';
import { startRecurringScheduler } from './services/recurring.service.js';
import { startFingerprintScheduler } from './services/db-fingerprint.service.js';
import * as coaTemplatesService from './services/coa-templates.service.js';
import { seedPayrollTemplates } from './services/payroll-templates.seed.js';
import type { Server } from 'http';

// Graceful shutdown deadline. After SIGTERM we stop accepting new
// connections and wait up to this long for in-flight requests to drain
// before force-closing. 25s leaves 5s of slack under Docker's default
// 30s stop-grace-period.
const SHUTDOWN_DEADLINE_MS = 25_000;

function installShutdownHandlers(server: Server): void {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return; // ignore the second Ctrl-C / SIGTERM
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received — draining…`);

    const forceExit = setTimeout(() => {
      console.error('[shutdown] drain deadline exceeded — forcing exit');
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    // Don't let the timer keep the event loop alive on its own.
    if (typeof forceExit.unref === 'function') forceExit.unref();

    // Stop accepting new HTTP connections; existing ones finish.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await pool.end();
      console.log('[shutdown] DB pool closed, exiting cleanly');
    } catch (err) {
      console.error('[shutdown] pool.end error:', err);
    }
    clearTimeout(forceExit);
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  // Unexpected failure paths — log, then the OS / supervisor will
  // restart us. Don't swallow the error.
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
    void shutdown('uncaughtException');
  });
}

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
  const server = app.listen(env.PORT, () => {
    console.log(`Vibe MyBooks API listening on port ${env.PORT}`);
    startBackupScheduler();
    startRecurringScheduler();
    startFingerprintScheduler();
  });
  installShutdownHandlers(server);
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
