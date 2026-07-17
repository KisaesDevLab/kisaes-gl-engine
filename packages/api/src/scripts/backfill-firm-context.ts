// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Tiered-rules enablement backfill for EXISTING tenants.
 *
 * Two things gate the 3-tier conditional-rules UI (Mine / Firm /
 * Global) and neither is retroactive on its own:
 *   1. RULES_TIERED_V1 — now defaults ON for NEW tenants only;
 *      pre-existing tenants keep their stored (disabled) value.
 *   2. Firm context — auto-provisioning (firm-provisioning.service)
 *      only fires on NEW tenant creation.
 *
 * For every existing tenant this script therefore (a) enables
 * RULES_TIERED_V1 and (b) joins the tenant to the singleton
 * appliance firm, making its owner a firm_admin — so the tiered UI
 * lights up everywhere without per-tenant clicking or raw SQL.
 *
 * Idempotent: safe to run repeatedly. Already-enabled flags,
 * already-managed tenants, and existing memberships are no-ops.
 *
 * Usage (in the deployed appliance):
 *   docker compose exec -T api npm run backfill:firm-context
 *   # or directly:
 *   docker compose exec -T api npx tsx packages/api/src/scripts/backfill-firm-context.ts
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, userTenantAccess } from '../db/schema/index.js';
import * as tenantFirmAssignmentService from '../services/tenant-firm-assignment.service.js';
import * as featureFlagsService from '../services/feature-flags.service.js';
import { assignTenantToApplianceFirm } from '../services/firm-provisioning.service.js';

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
  console.log('  Tiered-rules backfill (enable flag + firm context)');
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
    // (a) enable the tiered-rules flag for this existing tenant.
    await featureFlagsService.setFlag(t.id, 'RULES_TIERED_V1', { enabled: true, rolloutPercent: 100 });
    // (b) provision firm context (owner → firm_admin, tenant joined).
    await assignTenantToApplianceFirm(t.id, ownerUserId);
    if (existing) {
      console.log(`  • ${t.name} (${t.id.slice(0, 8)}…) — flag on; already managed; ensured owner membership`);
      alreadyManaged++;
    } else {
      console.log(`  ✓ ${t.name} (${t.id.slice(0, 8)}…) — flag on; joined appliance firm (owner=firm_admin)`);
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
