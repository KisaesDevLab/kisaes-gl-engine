// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// The recurrence-prevention test for DR completeness: every live table must
// be either exported (tenant loop, global dump, or a dedicated identity
// section) or EXPLICITLY excluded with a written justification. If you add a
// table and this test fails, either let it flow into the backup (do nothing —
// the plan picks it up) or add it to EXCLUDED_SYSTEM_BACKUP_TABLES with a
// reason. Silent omission is not an option — that is exactly how Plaid/SMS
// credentials and budget lines used to vanish from every disaster recovery.

import { describe, it, expect } from 'vitest';
import { db } from '../db/index.js';
import {
  getAllPublicTables,
  getSystemBackupTablePlan,
  EXCLUDED_SYSTEM_BACKUP_TABLES,
  OPTIONAL_EXTENSION_EXCLUSIONS,
} from './backup-table-plan.js';

const IDENTITY_SECTION_TABLES = ['tenants', 'users', 'user_tenant_access'];

describe('backup-table-plan', () => {
  it('covers EVERY public table: planned, identity section, or explicitly excluded', async () => {
    const all = await getAllPublicTables(db);
    expect(all.length).toBeGreaterThan(100); // sanity: migrations ran

    const plan = await getSystemBackupTablePlan(db);
    const planned = new Set([...plan.tenantScoped, ...plan.global]);

    const unaccounted = all
      .map((t) => t.table)
      .filter(
        (t) =>
          !planned.has(t) &&
          !IDENTITY_SECTION_TABLES.includes(t) &&
          !(t in EXCLUDED_SYSTEM_BACKUP_TABLES),
      );
    expect(unaccounted, `tables neither exported nor explicitly excluded: ${unaccounted.join(', ')}`).toEqual([]);
  });

  it('has no stale entries in the exclude list', async () => {
    const live = new Set((await getAllPublicTables(db)).map((t) => t.table));
    const stale = Object.keys(EXCLUDED_SYSTEM_BACKUP_TABLES)
      .filter((t) => !live.has(t) && !OPTIONAL_EXTENSION_EXCLUSIONS.has(t));
    expect(stale, `excluded tables that no longer exist: ${stale.join(', ')}`).toEqual([]);
  });

  it('never touches non-public schemas (drizzle migration bookkeeping)', async () => {
    const all = await getAllPublicTables(db);
    expect(all.map((t) => t.table)).not.toContain('__drizzle_migrations');
  });

  it('classifies the previously-lost tables correctly', async () => {
    const plan = await getSystemBackupTablePlan(db);
    // System-scoped credential/config tables the old backup never exported.
    for (const t of ['plaid_config', 'plaid_items', 'tfa_config', 'firm_integrations', 'ai_config', 'system_settings']) {
      expect(plan.global, `${t} must be in the global dump`).toContain(t);
    }
    // Child tables without tenant_id the old tenant loop missed.
    for (const t of ['budget_lines', 'budget_periods', 'reconciliation_lines', 'report_pack_items']) {
      expect(plan.global, `${t} must be in the global dump`).toContain(t);
    }
    // Nullable-tenant tables: per-tenant rows via the loop, NULL rows via global.
    expect(plan.tenantScoped).toContain('bank_rules');
    expect(plan.nullableTenant).toContain('bank_rules');
    // Ephemeral token state stays excluded.
    expect(plan.excluded).toContain('sessions');
    expect(plan.tenantScoped).not.toContain('sessions');
  });
});
