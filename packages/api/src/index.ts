// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Must stay the first import: see the module header.
import './desktop/require-egress-guard.js';
import { flushAllSuggestionNotices } from './services/suggestion-notice-coalescer.service.js';
import { registerMybooksTaskClasses } from './services/ai-providers/index.js';
import { app } from './app.js';
import { env } from './config/env.js';
import { pool } from './db/index.js';
import { applyMigrations, MIGRATIONS_FOLDER } from './startup/migrations.js';
import { startBackupScheduler } from './services/backup-scheduler.service.js';
import { startRecurringScheduler } from './services/recurring.service.js';
import { startFingerprintScheduler } from './services/db-fingerprint.service.js';
import { startCloudflaredAlerter, stopCloudflaredAlerter } from './services/cloudflared/alert.service.js';
import { startBackupVerifier, stopBackupVerifier } from './services/backup-verify.service.js';
import { startRecurringDocRequestScheduler, stopRecurringDocRequestScheduler } from './services/recurring-doc-request-scheduler.service.js';
import { startAiRetentionScheduler, stopAiRetentionScheduler } from './services/ai-retention.service.js';
import { attachShareGateway, shutdownShareGateway } from './services/share/share-gateway.js';
import { startShareSweeper, stopShareSweeper } from './services/share/share-sweeper.js';
import * as coaTemplatesService from './services/coa-templates.service.js';
import { seedPayrollTemplates } from './services/payroll-templates.seed.js';
import { seedDefaultPrompts } from './services/ai-prompt.service.js';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { isDesktop, desktopProfile, queueBackend, type DesktopBind } from './desktop/profile.js';
import type { InProcessWorker } from './queue/in-process-worker.js';
import { setDesktopBoundAddress } from './middleware/desktop-gate.js';
import { desktopFatal } from './desktop/fatal.js';
import { schedulerEnabled } from './desktop/features.js';

// Graceful shutdown deadline. After SIGTERM we stop accepting new
// connections and wait up to this long for in-flight requests to drain
// before force-closing. 25s leaves 5s of slack under Docker's default
// 30s stop-grace-period.
const SHUTDOWN_DEADLINE_MS = 25_000;
// Desktop: how long shutdown waits for in-flight background jobs before it
// moves on (the job queue then gets the rest of the deadline).
const IN_PROCESS_WORKER_STOP_MS = 15_000;

// Desktop only: the in-process worker (job consumers + worker-only
// schedulers), started after listen. Resolves to null if it failed to start.
let inProcessWorker: Promise<InProcessWorker | null> | null = null;

function startDesktopWorker(): void {
  inProcessWorker = import('./queue/in-process-worker.js')
    .then((m) => m.startInProcessWorker())
    .catch((err: unknown) => {
      // Producers still work: an enqueue that cannot reach the queue falls
      // back to running the job in-process. /health reports the queue.
      console.error('[in-process-worker] failed to start:', err instanceof Error ? err.message : String(err));
      return null;
    });
}

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
    // Desktop: stop consuming background jobs (in-flight ones finish, up to
    // IN_PROCESS_WORKER_STOP_MS) and the worker-only schedulers, before the
    // API schedulers, the job queue and the DB pool go away.
    if (inProcessWorker) {
      const w = await inProcessWorker;
      await Promise.race([
        w?.stop(),
        new Promise((r) => setTimeout(r, IN_PROCESS_WORKER_STOP_MS).unref?.()),
      ]);
    }
    // Halt the interval-based schedulers so they don't try to run
    // a tick against a closing pool. Ticks that are already in
    // flight drain via the advisory lock's existing timeout.
    stopCloudflaredAlerter();
    stopBackupVerifier();
    stopRecurringDocRequestScheduler();
    stopAiRetentionScheduler();
    stopShareSweeper();
    await shutdownShareGateway().catch(() => undefined);
    // Portal answers are saved; only their coalesced staff email is pending.
    await Promise.race([
      flushAllSuggestionNotices().catch(() => undefined),
      new Promise((r) => setTimeout(r, 10_000)),
    ]);
    // A Postgres-backed (or no) job queue closes its own pool before the
    // engine pool. The BullMQ path is unchanged (its producers are not closed
    // here, as before).
    if (queueBackend() !== 'bullmq') {
      try {
        const { closeJobQueues } = await import('./queue/index.js');
        await closeJobQueues();
      } catch (err) {
        console.error('[shutdown] job queue close error:', err);
      }
    }
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

/**
 * Desktop listen: bind exactly CL_BIND (loopback unless CL_LAN=1, checked
 * by the profile loader), tell the desktop gate the resolved address, and
 * print ONE ready line on stdout, {"event":"listening","host":...,"port":N},
 * so the supervisor can use port 0 without a pick-then-bind race.
 */
function listenDesktop(bind: DesktopBind, onListening: () => void): Server {
  const server = app.listen(bind.port, bind.host);
  server.once('error', (err) => {
    desktopFatal('BIND_FAILED', `cannot listen on ${bind.host}:${bind.port}: ${err.message}`, 1);
  });
  server.once('listening', () => {
    const port = (server.address() as AddressInfo).port;
    setDesktopBoundAddress(bind.host, port);
    process.stdout.write(`${JSON.stringify({ event: 'listening', host: bind.host, port })}\n`);
    onListening();
  });
  return server;
}

async function start() {
  logBootSummary();

  // Run migrations. preflight.ts has already migrated (or refused to
  // start when MIGRATIONS_AUTO=false and migrations are pending), so
  // this call is idempotent — kept for the path where index.ts is
  // loaded outside the bootstrap flow (legacy scripts, integration
  // tests). Skipped entirely when MIGRATIONS_AUTO=false.
  if (env.MIGRATIONS_AUTO) {
    console.log('Running migrations...');
    await applyMigrations(MIGRATIONS_FOLDER);
    console.log('Migrations complete.');
  }

  // Bootstrap built-in COA templates from the static BUSINESS_TEMPLATES
  // constant and re-sync built-in accounts when the constant changes.
  // Idempotent. Custom templates (and built-in labels / hidden flags)
  // edited via /admin/coa-templates are never touched.
  try {
    const result = await coaTemplatesService.bootstrapBuiltins();
    if (result.inserted > 0) {
      console.log(`Bootstrapped ${result.inserted} COA templates.`);
    }
    if (result.synced > 0) {
      console.log(`Synced accounts on ${result.synced} built-in COA templates.`);
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

  // Seed default AI prompt templates so the prompt editor isn't empty on a
  // fresh install (idempotent — skips any task type that already has an active
  // row, so it never clobbers admin customizations).
  try {
    await seedDefaultPrompts();
  } catch (err) {
    console.error('Failed to seed default AI prompts:', err);
  }

  // Seed the default JE templates (Monthly Payroll) for every existing
  // tenant (idempotent — skips any tenant that already has one, so it never
  // clobbers operator edits). New tenants get theirs at provisioning time.
  try {
    const { seedDefaultJeTemplatesAllTenants } = await import('./services/je-templates.seed.js');
    const r = await seedDefaultJeTemplatesAllTenants();
    if (r.seeded > 0) console.log(`Seeded default JE templates for ${r.seeded}/${r.total} tenants`);
  } catch (err) {
    console.error('Failed to seed default JE templates:', err);
  }

  // Tax Estimator: re-sync the shipped federal parameter seeds (idempotent;
  // never touches super-admin overrides). A bad seed row is logged, not fatal.
  try {
    const { syncShippedSeeds } = await import('./services/tax-estimator/tax-parameters.service.js');
    const r = await syncShippedSeeds();
    if (r.rows > 0) console.log(`Synced ${r.rows} tax parameter seed rows across ${r.years} year(s)`);
  } catch (err) {
    console.error('Failed to sync tax parameter seeds:', err);
  }

  // Tax Estimator Phase 2: re-sync the shipped state estimate-rule seeds (same contract).
  try {
    const { syncShippedStateRules } = await import('./services/tax-estimator/tax-state-rules.service.js');
    const r = await syncShippedStateRules();
    if (r.rows > 0) console.log(`Synced ${r.rows} state rule seed rows across ${r.groups} state-year set(s)`);
  } catch (err) {
    console.error('Failed to sync state rule seeds:', err);
  }

  // Desktop: the workspace invariant (one workspace, every user homed there
  // with an active workspace access row). A violation is a warning with
  // counts and ids only, never fatal.
  if (isDesktop()) {
    try {
      const { checkWorkspaceInvariant } = await import('./desktop/workspace.js');
      await checkWorkspaceInvariant();
    } catch (err) {
      console.error('Failed to check the desktop workspace invariant:', err instanceof Error ? err.message : err);
    }
  }

  // Background work that starts once the HTTP server is listening.
  const startBackground = () => {
    // MIG-2: router mode only; non-blocking with retry — AI features fail
    // closed at the router until registration lands, which is correct.
    // Load the Admin -> AI router connection (overrides env) before registering.
    void import('./services/ai-config.service.js')
      .then((m) => m.getRawConfig())
      .catch(() => undefined)
      .finally(() => registerMybooksTaskClasses());
    // Desktop mode starts only the schedulers in DESKTOP_SCHEDULERS
    // (desktop/features.ts); the server starts all of them.
    if (schedulerEnabled('backup')) startBackupScheduler();
    if (schedulerEnabled('recurring')) startRecurringScheduler();
    if (schedulerEnabled('fingerprint')) startFingerprintScheduler();
    // The worker container (when present) also starts these two; the
    // Postgres advisory lock in each scheduler's cycle ensures only
    // one process does a given tick. Single-container installs
    // (docker-compose.prod.yml has no worker service) rely on these
    // calls to fire the tunnel-health audit and the monthly backup
    // integrity check.
    if (schedulerEnabled('cloudflaredAlerter')) startCloudflaredAlerter();
    if (schedulerEnabled('backupVerifier')) startBackupVerifier();
    // RECURRING_DOC_REQUESTS_V1 — calendar-cadence issuance scheduler.
    // Advisory-locked so the worker container can also run it without
    // double-firing.
    if (schedulerEnabled('recurringDocRequests')) startRecurringDocRequestScheduler();
    // AI data retention purge (ai_jobs + old chat). Advisory-locked so
    // the worker container can also boot it without double-purging.
    if (schedulerEnabled('aiRetention')) startAiRetentionScheduler();
    if (schedulerEnabled('shareSweeper')) startShareSweeper();
    // Desktop has no worker container: consume the background job queues
    // and run the enabled worker-only schedulers in this process.
    if (isDesktop()) startDesktopWorker();
  };

  // Start server
  let server: Server;
  const profile = desktopProfile();
  if (profile.mode === 'desktop' && profile.bind) {
    server = listenDesktop(profile.bind, startBackground);
  } else {
    server = app.listen(env.PORT, () => {
      console.log(`Vibe MyBooks API listening on port ${env.PORT}`);
      startBackground();
    });
  }
  // Peer screen share WS gateway rides the same HTTP server (Phase 5.1);
  // no-ops entirely when SHARE_ENABLED is off.
  if (env.SHARE_ENABLED) {
    attachShareGateway(server);
    if (env.SHARE_SCOPE === 'any') {
      // 2.3 — make the cross-firm posture visible in deployment logs.
      console.log('[boot] NOTE: SHARE_SCOPE=any — cross-firm screen sharing is permitted (each viewer still requires per-viewer approval + the cross-firm confirmation).');
    }
  }
  installShutdownHandlers(server);
}

start().catch((err) => {
  if (isDesktop()) {
    desktopFatal('STARTUP_FAILED', err instanceof Error ? err.message : String(err), 1);
  }
  console.error('Failed to start server:', err);
  process.exit(1);
});
