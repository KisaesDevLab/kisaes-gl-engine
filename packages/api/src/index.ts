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
import { startCloudflaredAlerter, stopCloudflaredAlerter } from './services/cloudflared/alert.service.js';
import { startBackupVerifier, stopBackupVerifier } from './services/backup-verify.service.js';
import { startRecurringDocRequestScheduler, stopRecurringDocRequestScheduler } from './services/recurring-doc-request-scheduler.service.js';
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
    // Halt the interval-based schedulers so they don't try to run
    // a tick against a closing pool. Ticks that are already in
    // flight drain via the advisory lock's existing timeout.
    stopCloudflaredAlerter();
    stopBackupVerifier();
    stopRecurringDocRequestScheduler();
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

function logBootSummary(): void {
  // Security-sensitive effective settings, logged once at boot. Uses
  // the plain console so the line is visible even when LOG_LEVEL is
  // raised in production. Any operator looking at "what's on on this
  // appliance" should be able to answer from the first 20 log lines.
  const summary = {
    event: 'boot_summary',
    nodeEnv: env.NODE_ENV,
    corsOrigin: env.CORS_ORIGIN,
    staffIpAllowlistEnforced: env.STAFF_IP_ALLOWLIST_ENFORCED === '1',
    stripeWebhookIpAllowlistEnforced: env.STRIPE_WEBHOOK_IP_ALLOWLIST_ENFORCED === '1',
    rateLimitRedis: env.RATE_LIMIT_REDIS === '1',
    hibpDisabled: env.HIBP_DISABLED === '1',
    turnstileConfigured: Boolean(env.TURNSTILE_SECRET_KEY) && env.TURNSTILE_SECRET_KEY !== 'disabled',
    trustProxy: env.TRUST_PROXY ?? 'loopback',
    tagsSplitLevelV2: env.TAGS_SPLIT_LEVEL_V2,
    tagBudgetsV1: env.TAG_BUDGETS_V1,
  };
  console.log('[boot]', JSON.stringify(summary));

  // Production-mode sanity checks. These don't fail boot — a dev
  // running docker-compose.dev.yml on localhost is expected to hit
  // them — but they loudly surface misconfig that would otherwise
  // manifest as silent tenant-data leakage or CORS-preflight
  // mysteries.
  if (env.NODE_ENV === 'production') {
    if (env.CORS_ORIGIN.includes('localhost') || env.CORS_ORIGIN.includes('127.0.0.1')) {
      console.warn('[boot] WARN: CORS_ORIGIN contains localhost in NODE_ENV=production. Set it to your real hostname (e.g. https://books.yourfirm.com) before exposing the appliance.');
    }
    if (!env.TURNSTILE_SECRET_KEY || env.TURNSTILE_SECRET_KEY === 'disabled') {
      console.warn('[boot] WARN: Turnstile is disabled. Public-facing installs should configure TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY to blunt credential-stuffing bots.');
    }
    if (env.STAFF_IP_ALLOWLIST_ENFORCED !== '1' && env.CORS_ORIGIN !== 'http://localhost:5173') {
      // Soft note — staff IP allowlist is optional, but worth
      // mentioning on a non-localhost deployment that it's off.
      console.log('[boot] NOTE: STAFF_IP_ALLOWLIST_ENFORCED=0. Set to 1 and populate via Admin → Security → Staff IP Allowlist for office-only access.');
    }
  }
}

async function start() {
  logBootSummary();

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
    // The worker container (when present) also starts these two; the
    // Postgres advisory lock in each scheduler's cycle ensures only
    // one process does a given tick. Single-container installs
    // (docker-compose.prod.yml has no worker service) rely on these
    // calls to fire the tunnel-health audit and the monthly backup
    // integrity check.
    startCloudflaredAlerter();
    startBackupVerifier();
    // RECURRING_DOC_REQUESTS_V1 — calendar-cadence issuance scheduler.
    // Advisory-locked so the worker container can also run it without
    // double-firing.
    startRecurringDocRequestScheduler();
  });
  installShutdownHandlers(server);
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
