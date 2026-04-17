// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

/**
 * Chart of Accounts seeder.
 *
 * The canonical COA data lives in `@kis-books/shared` (`coa-templates.ts`),
 * which is generated from `BusinessCategoryList.xlsx` in the project root.
 * This module exposes:
 *
 *   - `seedCoaForTenant(tenantId, businessType)` — programmatic API
 *   - a CLI entry point so this file can be run directly to seed/reseed
 *     an existing tenant's COA after install
 *
 * New installs already get the correct COA via
 * `setup.service.ts → createAdminUser → accountsService.seedFromTemplate`.
 * This script exists for two cases:
 *
 *   1. Fixing an existing tenant whose COA is wrong or missing
 *   2. Listing the available business type templates
 *
 * Usage:
 *
 *   # List all available business type slugs
 *   tsx src/db/seeds/coa.ts --list
 *
 *   # Seed a specific tenant (will fail if accounts already exist)
 *   tsx src/db/seeds/coa.ts <tenantId> <businessTypeSlug>
 *
 *   # Reseed (deletes all existing accounts for the tenant first — destructive)
 *   tsx src/db/seeds/coa.ts <tenantId> <businessTypeSlug> --force
 */

import { eq } from 'drizzle-orm';
import { BUSINESS_TYPE_OPTIONS, COA_TEMPLATES } from '@kis-books/shared';
import { db } from '../index.js';
import { accounts, tenants } from '../schema/index.js';
import * as accountsService from '../../services/accounts.service.js';

export interface SeedCoaResult {
  tenantId: string;
  businessType: string;
  accountsInserted: number;
}

/**
 * Seed the chart of accounts for a tenant from a business type template.
 * Throws if the tenant doesn't exist, the business type is unknown, or
 * the tenant already has accounts and `force` is not set.
 */
export async function seedCoaForTenant(
  tenantId: string,
  businessType: string,
  options: { force?: boolean; companyId?: string } = {},
): Promise<SeedCoaResult> {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) {
    throw new Error(`Tenant not found: ${tenantId}`);
  }

  if (!COA_TEMPLATES[businessType]) {
    throw new Error(
      `Unknown business type: ${businessType}. Run with --list to see available templates.`,
    );
  }

  const existing = await db.select().from(accounts).where(eq(accounts.tenantId, tenantId));
  if (existing.length > 0) {
    if (!options.force) {
      throw new Error(
        `Tenant ${tenantId} already has ${existing.length} accounts. Pass --force to delete and reseed.`,
      );
    }
    await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  }

  await accountsService.seedFromTemplate(tenantId, businessType, options.companyId);

  const after = await db.select().from(accounts).where(eq(accounts.tenantId, tenantId));
  return {
    tenantId,
    businessType,
    accountsInserted: after.length,
  };
}

function printAvailableTemplates(): void {
  // eslint-disable-next-line no-console
  console.log('Available business type templates:');
  for (const opt of BUSINESS_TYPE_OPTIONS) {
    // eslint-disable-next-line no-console
    console.log(`  ${opt.value.padEnd(45)}  ${opt.label}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--list') || args.length === 0) {
    printAvailableTemplates();
    return;
  }

  const force = args.includes('--force');
  const positional = args.filter((a) => !a.startsWith('--'));
  const [tenantId, businessType] = positional;

  if (!tenantId || !businessType) {
    // eslint-disable-next-line no-console
    console.error('Usage: tsx src/db/seeds/coa.ts <tenantId> <businessTypeSlug> [--force]');
    // eslint-disable-next-line no-console
    console.error('       tsx src/db/seeds/coa.ts --list');
    process.exit(1);
  }

  const result = await seedCoaForTenant(tenantId, businessType, { force });
  // eslint-disable-next-line no-console
  console.log(
    `Seeded ${result.accountsInserted} accounts for tenant ${result.tenantId} ` +
      `using template "${result.businessType}".`,
  );
}

// CLI entry: only run when executed directly, not when imported.
const isCli =
  process.argv[1] &&
  (process.argv[1].endsWith('coa.ts') || process.argv[1].endsWith('coa.js'));
if (isCli) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Seed failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
