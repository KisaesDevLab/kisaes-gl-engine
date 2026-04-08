/**
 * Standalone CLI wrapper around the `createDemoTenant` service.
 *
 * Usage:
 *   docker compose -f docker-compose.yml -f docker-compose.dev.yml \
 *     exec -T api npx tsx packages/api/src/scripts/seed-demo-data.ts
 *
 * The real logic lives in `services/demo-data.service.ts` so both this
 * script and the first-run setup wizard run identical code paths.
 *
 * This script attaches the demo tenant to the first existing user in the
 * database. Run it AFTER completing the first-run setup wizard.
 */

import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { createDemoTenant } from '../services/demo-data.service.js';

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Vibe MyBooks — Demo Data Seeder');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const [firstUser] = await db.select().from(users).limit(1);
  if (!firstUser) {
    throw new Error('No users exist yet. Run the first-run setup wizard first.');
  }
  console.log(`Attaching demo tenant to user: ${firstUser.email}`);

  const result = await createDemoTenant(firstUser.id, {
    log: (line) => console.log(`  ${line}`),
  });

  console.log();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (result.alreadyExisted) {
    console.log('  Demo tenant already existed — nothing to do');
    console.log(`  Tenant: ${result.tenantName} (${result.tenantId})`);
    console.log('  To re-seed, delete it first:');
    console.log(`    docker compose exec -T db psql -U kisbooks -d kisbooks \\`);
    console.log(`      -c "DELETE FROM tenants WHERE id = '${result.tenantId}';"`);
  } else {
    console.log('  Demo data created');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  Tenant:            ${result.tenantName}`);
    console.log(`  Tenant ID:         ${result.tenantId}`);
    console.log();
    console.log(`  Invoices:          ${result.counts.invoices}`);
    console.log(`  Cash sales:        ${result.counts.cashSales}`);
    console.log(`  Customer payments: ${result.counts.customerPayments}`);
    console.log(`  Expenses:          ${result.counts.expenses}`);
    console.log(`  Bank deposits:     ${result.counts.deposits}`);
    console.log(`  Transfers:         ${result.counts.transfers}`);
    console.log(`  Journal entries:   ${result.counts.journalEntries}`);
    console.log(`  Bills:             ${result.counts.bills}`);
    console.log(`  Vendor credits:    ${result.counts.vendorCredits}`);
    console.log(`  Bill payments:     ${result.counts.billPayments}`);
    console.log(`  TOTAL:             ${result.counts.total}`);
    console.log();
    console.log(`  Trial balance valid: ${result.trialBalanceValid ? 'YES' : 'NO'}`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
