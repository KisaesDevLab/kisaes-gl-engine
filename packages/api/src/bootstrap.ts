// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

/**
 * Application entrypoint. Replaces the pre-Phase-A `src/index.ts` as the
 * file pointed to by package.json `main` / `start` and the Dockerfile CMD.
 *
 * The first thing this file does is check that the required env vars are
 * present. Because `config/env.ts` calls `process.exit(1)` on missing vars
 * at import time, we MUST NOT statically import anything that transitively
 * imports it. `process.env` is read directly here, and every further step
 * is a dynamic import so the import chain is deferred until we know it is
 * safe to load.
 *
 * Order:
 *   1. read process.env for DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY
 *   2. if any is missing:
 *      - read the sentinel header (no DB, no env required)
 *      - if the sentinel exists → serve `createEnvMissingApp` so the
 *        operator can paste their recovery key and rebuild /data/config/.env
 *      - if no sentinel → print a plain error and exit, since there's
 *        nothing to recover yet
 *   3. if all present → dynamic-import `./startup/preflight.js` (pulls in
 *      env.ts safely) → run preflight → either start the normal app via
 *      `./index.js` or the Phase A `createDiagnosticApp` for block states
 *
 * Keeping this file small (and with zero static imports from env/db) is
 * the load-bearing piece of the Phase B recovery story. If you add imports
 * here, make sure they stay env-free.
 */

// Every var that will trip Zod validation in env.ts. Listed here so the
// pre-check catches them before any module import chain runs — otherwise
// the operator sees a dense "Invalid environment variables: { FOO: ['Required'] }"
// dump instead of the friendly "copy .env.example" message below. Keep in
// sync with the required fields in config/env.ts.
const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'PLAID_ENCRYPTION_KEY',
] as const;

async function main(): Promise<void> {
  // --- Phase B: env pre-check ------------------------------------------
  const missing = REQUIRED_ENV_VARS.filter((k) => !process.env[k] || process.env[k]!.trim() === '');

  if (missing.length > 0) {
    // Try to read the sentinel header without touching env.ts or db. This is
    // a DYNAMIC import so missing vars don't crash the ESM module graph
    // through transitive dependencies.
    const { sentinelExists, readSentinelHeader } = await import('./services/sentinel.service.js');
    let sentinelReadable = false;
    if (sentinelExists()) {
      try {
        readSentinelHeader();
        sentinelReadable = true;
      } catch {
        // Corrupt header — still counts as "this server was set up before"
        // for the purposes of the env-missing flow, so we let the UI show
        // whatever it can.
        sentinelReadable = true;
      }
    }

    const port = parseInt(process.env['PORT'] || '3001', 10);

    if (sentinelExists()) {
      const { createEnvMissingApp } = await import('./startup/env-missing-app.js');
      const app = createEnvMissingApp({ missingVars: [...missing], sentinelReadable });
      app.listen(port, () => {
        console.error(
          `[bootstrap] ENV_MISSING: ${missing.join(', ')}. Sentinel found — serving recovery diagnostic on port ${port}.`,
        );
      });
      return;
    }

    console.error(
      `[bootstrap] missing required environment variables and no sentinel to recover from: ${missing.join(', ')}.`,
    );
    console.error('[bootstrap] fix this by either:');
    console.error('[bootstrap]   a) re-running scripts/install.sh (generates fresh secrets in .env), or');
    console.error('[bootstrap]   b) adding these lines to your .env (generate 64-hex-char values with `openssl rand -hex 32`):');
    for (const key of missing) {
      if (key === 'DATABASE_URL') {
        console.error(`[bootstrap]        ${key}=postgresql://USER:PASS@HOST:5432/DB`);
      } else {
        console.error(`[bootstrap]        ${key}=<64 hex chars>`);
      }
    }
    process.exit(1);
  }

  // --- All required vars present: proceed to Phase A preflight ---------
  const { env } = await import('./config/env.js');
  const { runPreflight } = await import('./startup/preflight.js');
  const { createDiagnosticApp } = await import('./startup/diagnostic-app.js');

  const result = await runPreflight();

  if (result.status === 'blocked') {
    const app = createDiagnosticApp(result);
    app.listen(env.PORT, () => {
      console.error(
        `[bootstrap] installation is BLOCKED (${result.code}). ` +
          `Diagnostic server listening on port ${env.PORT}. ` +
          `Only /api/diagnostic/* is available until the issue is resolved.`,
      );
    });
    return;
  }

  // --- Phase B: license enforcement (vibe-distribution-plan D6) -------
  // Runs after preflight so migrations / sentinel are healthy first
  // — a license error is a different operator-facing problem than
  // "install hasn't completed". Skipped in NODE_ENV=development|test
  // and when DISABLE_LICENSE_CHECK=1 (CI default). Failure exits
  // cleanly with a structured log line rather than starting the
  // diagnostic app: that app is for installation-state issues
  // (CRC / orphan sentinel / etc.), and surfacing a license expiry
  // there would be misleading.
  const { checkLicense, formatLicenseResult } = await import('./startup/license-check.js');
  const { log } = await import('./utils/logger.js');
  const license = checkLicense();
  log.info({
    component: 'bootstrap',
    event: 'license_check',
    status: license.status,
    message: formatLicenseResult(license),
  });
  if (license.status !== 'ok' && license.status !== 'skipped') {
    // Concrete next steps depend on the failure shape so an operator
    // upgrading from a pre-D6 version without a license token isn't
    // left at a dead-end. See vibe-distribution-plan §licensing.
    let nextSteps: string;
    if (license.status === 'missing') {
      nextSteps =
        'For production: run `vibe install --license-token <token>` or set LICENSE_TOKEN + LICENSE_PUBLIC_KEY in .env. ' +
        'For local dev: set DISABLE_LICENSE_CHECK=1 in .env (or use NODE_ENV=development). ' +
        'For tokens, contact licensing@kisaes.com.';
    } else if (license.status === 'expired') {
      nextSteps =
        'Renew the license at https://licensing.kisaes.com or contact licensing@kisaes.com. ' +
        'If the host clock is wrong, fix NTP — LICENSE_CLOCK_TOLERANCE_SECONDS controls grace (default 60s).';
    } else if (license.status === 'not-yet-valid') {
      nextSteps =
        'Token is dated for the future. Verify host clock against NTP, or wait until the nbf time. ' +
        'LICENSE_CLOCK_TOLERANCE_SECONDS controls grace (default 60s).';
    } else {
      nextSteps =
        'License token signature is invalid. Verify LICENSE_PUBLIC_KEY matches the issuer that signed LICENSE_TOKEN. ' +
        'Re-fetch both via the installer if unsure.';
    }
    log.fatal({
      component: 'bootstrap',
      event: 'license_check_failed',
      status: license.status,
      message: `License check failed (${license.status}). The API will not start. ${nextSteps}`,
    });
    // Close the DB pool that env.ts/preflight opened so the process
    // exits without dangling Postgres connections that the operator
    // would later see in `pg_stat_activity` until idle-timeout.
    try {
      const { pool } = await import('./db/index.js');
      await pool.end();
    } catch {
      // Best-effort — never block exit on cleanup. The process is
      // about to die anyway and the OS will reap the FD.
    }
    process.exit(1);
  }

  // 'ok' or 'fresh-install' — normal startup.
  await import('./index.js');
}

main().catch((err) => {
  console.error('[bootstrap] fatal error during startup:', err);
  process.exit(1);
});
