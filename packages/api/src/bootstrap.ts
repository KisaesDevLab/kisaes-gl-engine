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

const REQUIRED_ENV_VARS = ['DATABASE_URL', 'JWT_SECRET', 'ENCRYPTION_KEY'] as const;

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
    console.error('[bootstrap] copy .env.example to /data/config/.env and fill it in before starting.');
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

  // 'ok' or 'fresh-install' — normal startup.
  await import('./index.js');
}

main().catch((err) => {
  console.error('[bootstrap] fatal error during startup:', err);
  process.exit(1);
});
