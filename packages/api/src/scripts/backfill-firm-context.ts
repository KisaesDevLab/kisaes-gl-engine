// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

/**
 * Appliance-firm context backfill.
 *
 * Auto-provisioning (firm-provisioning.service.ts) only fires on
 * NEW tenant creation. Tenants that pre-date the feature have no
 * firm assignment, so the 3-tier conditional-rules UI (Mine / Firm
 * / Global) stays hidden for them. This script joins every existing
 * tenant to the singleton appliance firm and makes each tenant's
 * owner a firm_admin, so the tiered UI lights up everywhere.
 *
 * Idempotent: safe to run repeatedly. Already-managed tenants and
 * existing memberships are skipped (no duplicate firms, memberships,
 * or active assignments).
 *
 * Usage:
 *   docker compose exec -T api npx tsx packages/api/src/scripts/backfill-firm-context.ts
 *   # or, locally with DATABASE_URL set:
 *   npm --workspace @kis-books/api run backfill:firm-context
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, userTenantAccess } from '../db/schema/index.js';
import * as tenantFirmAssignmentService from '../services/tenant-firm-assignment.service.js';
import { joinApplianceFirm } from '../services/firm-provisioning.service.js';

// Resolve the user we attribute the tenant's firm membership to:
// prefer an active 'owner', else any active access row. Returns null
// for an orphaned tenant (no active access), which we skip + warn.
async function resolveOwnerUserId(tenantId: string): Promise<string | null> {
  const owner = await db.query.userTenantAccess.findFirst({
    where: and(
      eq(userTenantAccess.tenantId, tenantId),
      eq(userTenantAccess.role, 'owner'),
      eq(userTenantAccess.isActive, true),
    ),
  });
  if (owner) return owner.userId;
  const anyAccess = await db.query.userTenantAccess.findFirst({
    where: and(
      eq(userTenantAccess.tenantId, tenantId),
      eq(userTenantAccess.isActive, true),
    ),
  });
  return anyAccess ? anyAccess.userId : null;
}

async function main(): Promise<void> {
  const allTenants = await db.select({ id: tenants.id, name: tenants.name }).from(tenants);
  const banner = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  console.log(banner);
  console.log('  Appliance-firm context backfill');
  console.log(`  Tenants found: ${allTenants.length}`);
  console.log(banner);

  let joined = 0;
  let alreadyManaged = 0;
  let skipped = 0;

  for (const t of allTenants) {
    const existing = await tenantFirmAssignmentService.getActiveForTenant(t.id);
    const ownerUserId = await resolveOwnerUserId(t.id);
    if (!ownerUserId) {
      console.log(`  ✗ ${t.name} (${t.id.slice(0, 8)}…) — no active user access; skipped`);
      skipped++;
      continue;
    }
    await joinApplianceFirm(t.id, ownerUserId);
    if (existing) {
      console.log(`  • ${t.name} (${t.id.slice(0, 8)}…) — already managed; ensured owner membership`);
      alreadyManaged++;
    } else {
      console.log(`  ✓ ${t.name} (${t.id.slice(0, 8)}…) — joined appliance firm (owner=firm_admin)`);
      joined++;
    }
  }

  console.log(banner);
  console.log(`  Joined: ${joined}   Already managed: ${alreadyManaged}   Skipped: ${skipped}`);
  console.log(banner);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Backfill failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
