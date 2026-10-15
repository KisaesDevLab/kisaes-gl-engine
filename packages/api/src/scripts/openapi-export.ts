// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * OpenAPI 3.1 export (U-04).
 *
 *   npm run openapi:export            # writes <repo root>/openapi.json
 *   npm run openapi:check             # fails if openapi.json is out of date
 *   tsx src/scripts/openapi-export.ts --out <file>
 *
 * Imports the app with the registration recorder installed and writes a
 * deterministic OpenAPI document. It needs no database, no Redis and no
 * network: config/env.ts is satisfied with fixed dummy values that point
 * at unreachable ports, and importing app.ts never opens a connection
 * (pools and queue clients are lazy). The script exits explicitly because
 * a few modules start housekeeping intervals at import time.
 *
 * Nothing here is imported by the server, so the recorder never runs on
 * an appliance.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// Values that affect which routes exist or that config/env.ts requires.
// Forced (not defaulted) so a developer's shell cannot change the output
// or make the export reach a real database or Redis.
const FORCED_ENV: Record<string, string> = {
  NODE_ENV: 'test', // 'production' would add the static web bundle + SPA catch-all
  DATABASE_URL: 'postgresql://openapi:openapi@127.0.0.1:1/openapi',
  REDIS_URL: 'redis://127.0.0.1:1',
  RATE_LIMIT_REDIS: '0',
  JWT_SECRET: 'openapi-export-not-a-secret',
  ENCRYPTION_KEY: '0'.repeat(64),
  PLAID_ENCRYPTION_KEY: '0'.repeat(64),
  UPLOAD_DIR: resolve(tmpdir(), 'mybooks-openapi-export', 'uploads'),
  DATA_DIR: resolve(tmpdir(), 'mybooks-openapi-export', 'data'),
};

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(here, '../../../../openapi.json');

function parseArgs(argv: string[]): { out: string; check: boolean } {
  let out = DEFAULT_OUT;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') check = true;
    else if (a === '--out' && argv[i + 1]) out = resolve(argv[++i]!);
    else throw new Error(`unknown argument: ${a}`);
  }
  return { out, check };
}

/** Produces the spec text. FORCED_ENV must already be applied. */
async function renderOpenApi(): Promise<string> {
  const { loadEngineSpec } = await import('../openapi/engine-spec.js');
  const { stableStringify } = await import('../openapi/generate.js');
  const { doc } = await loadEngineSpec();
  return stableStringify(doc);
}

async function main(): Promise<void> {
  const { out, check } = parseArgs(process.argv.slice(2));
  Object.assign(process.env, FORCED_ENV);
  mkdirSync(FORCED_ENV['UPLOAD_DIR']!, { recursive: true });
  mkdirSync(FORCED_ENV['DATA_DIR']!, { recursive: true });

  const text = await renderOpenApi();

  if (check) {
    let current = '';
    try {
      current = readFileSync(out, 'utf8').replace(/\r\n/g, '\n');
    } catch {
      // missing file counts as out of date
    }
    if (current !== text) {
      console.error(
        `[openapi] ${relative(process.cwd(), out)} is out of date with the route registrations. ` +
          'Run `npm run openapi:export` and commit the result.',
      );
      process.exit(1);
    }
    console.log(`[openapi] ${relative(process.cwd(), out)} is up to date.`);
    process.exit(0);
  }

  writeFileSync(out, text, 'utf8');
  const doc = JSON.parse(text) as { paths: Record<string, Record<string, unknown>> };
  const ops = Object.values(doc.paths).reduce((n, p) => n + Object.keys(p).length, 0);
  console.log(
    `[openapi] wrote ${relative(process.cwd(), out)}: ${Object.keys(doc.paths).length} paths, ${ops} operations, ${text.length} bytes.`,
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('[openapi] export failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
