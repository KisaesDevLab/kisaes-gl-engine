// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// CLI seeder for the global tax-code crosswalk (Phase 2.5, D15).
//
//   npm run seed:tax-codes -w @kis-books/api -- 2025
//   npm run seed:tax-codes -w @kis-books/api -- 2025 --dry-run
//
// Reads db/seeds/tax-codes/<taxYear>/tax-codes.xlsx and imports it as
// the next version for that tax year. Idempotent: a byte-identical
// re-run is a no-op (ADR-TB-05).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importSeed } from '../services/tb/tax-code-seed.service.js';
import { pool } from '../db/index.js';

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const dryRun = args.includes('--dry-run');
  const taxYear = Number(args.find((a) => /^\d{4}$/.test(a)));
  if (!taxYear) {
    console.error('Usage: seed-tax-codes <taxYear> [--dry-run]');
    process.exit(1);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, '..', 'db', 'seeds', 'tax-codes', String(taxYear), 'tax-codes.xlsx');
  const buffer = readFileSync(file);
  const result = await importSeed({ taxYear, label: `Seed file ${taxYear}`, buffer, dryRun });
  if (result.unchanged) {
    console.log(`[seed-tax-codes] tax year ${taxYear} already at this file (v${result.version}, ${result.rowCount} rows) — no-op`);
  } else if (result.dryRun) {
    console.log(`[seed-tax-codes] DRY RUN — ${result.rowCount} rows; diff:`, JSON.stringify(result.diff));
  } else {
    console.log(`[seed-tax-codes] imported tax year ${taxYear} v${result.version} (${result.rowCount} rows); diff vs prior:`, JSON.stringify(result.diff));
  }
  await pool.end();
}

main().catch((err) => {
  console.error('[seed-tax-codes] failed:', err instanceof Error ? err.message : err);
  if (err && typeof err === 'object' && 'details' in err) {
    console.error(JSON.stringify((err as { details: unknown }).details, null, 2));
  }
  process.exit(1);
});
