// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

/**
 * 3-tier rules plan, Phase 6 — legacy bank_rules → conditional_rules
 * migration CLI.
 *
 * Usage:
 *   docker compose exec -T api npx tsx packages/api/src/scripts/migrate-bank-rules.ts <tenantId> [--commit] [--deactivate-source] [--owner-user-id <uuid>]
 *
 * Default behavior is DRY-RUN — prints the conversions + warnings
 * without writing anything. Pass `--commit` to actually insert
 * the new conditional_rules rows. Pass `--deactivate-source` to
 * additionally flip the source bank_rules.is_active=false on a
 * successful commit (recommended only after the operator has
 * verified the converted rules fire correctly on the tenant's
 * pending feed items).
 *
 * Global legacy rules (tenant_id IS NULL, is_global=true) are
 * out of scope; they require a target firm + per-tenant
 * system_tag binding which is operator-driven. Re-author globals
 * directly via the firm-admin /firm/:firmId/rules surface.
 */

import { migrateTenantBankRules, type MigrationReport } from '../services/bank-rules-migration.service.js';

interface CliArgs {
  tenantId: string;
  commit: boolean;
  deactivateSource: boolean;
  ownerUserId?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let commit = false;
  let deactivateSource = false;
  let ownerUserId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--commit') commit = true;
    else if (a === '--deactivate-source') deactivateSource = true;
    else if (a === '--owner-user-id') ownerUserId = argv[++i];
    else positional.push(a);
  }
  if (positional.length !== 1) {
    throw new Error(
      'Usage: migrate-bank-rules <tenantId> [--commit] [--deactivate-source] [--owner-user-id <uuid>]',
    );
  }
  return { tenantId: positional[0]!, commit, deactivateSource, ownerUserId };
}

function printReport(report: MigrationReport, opts: CliArgs): void {
  const banner = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  console.log(banner);
  console.log(`  Bank rules → conditional rules migration`);
  console.log(`  Tenant: ${report.tenantId}`);
  console.log(`  Mode:   ${opts.commit ? 'COMMIT' : 'DRY-RUN'}${opts.deactivateSource ? ' + DEACTIVATE-SOURCE' : ''}`);
  console.log(banner);

  if (report.converted.length === 0 && report.errors.length === 0) {
    console.log('No tenant-scoped bank_rules rows found. Nothing to migrate.');
    return;
  }

  for (const c of report.converted) {
    console.log('');
    console.log(`Rule "${c.sourceRuleName}" (id ${c.sourceRuleId.slice(0, 8)}…)`);
    console.log(`  → scope=${c.scope} priority=${c.priority} active=${c.active}`);
    console.log(`  → conditions: ${JSON.stringify(c.conditions)}`);
    console.log(`  → actions:    ${JSON.stringify(c.actions)}`);
    if (c.warnings.length > 0) {
      for (const w of c.warnings) {
        console.log(`  ! ${w}`);
      }
    }
  }

  if (report.errors.length > 0) {
    console.log('');
    console.log('Errors:');
    for (const e of report.errors) {
      console.log(`  ✗ ${e.sourceRuleId.slice(0, 8)}…: ${e.message}`);
    }
  }

  console.log('');
  console.log(banner);
  if (opts.commit) {
    console.log(`  Committed ${report.insertedIds.length} new conditional_rules row(s).`);
    if (opts.deactivateSource) {
      console.log(`  Deactivated ${report.deactivatedSourceIds.length} source bank_rules row(s).`);
    } else {
      console.log('  Source bank_rules rows left ACTIVE. Pass --deactivate-source on a follow-up run once verified.');
    }
  } else {
    console.log(`  DRY-RUN. Re-run with --commit to insert ${report.converted.length} row(s).`);
  }
  console.log(banner);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await migrateTenantBankRules(args.tenantId, {
    dryRun: !args.commit,
    deactivateSource: args.deactivateSource,
    ownerUserId: args.ownerUserId,
  });
  printReport(report, args);
  if (report.errors.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Migration failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
