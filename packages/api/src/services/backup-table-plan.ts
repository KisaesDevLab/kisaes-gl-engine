// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Schema-driven table plan for the system disaster-recovery backup.
//
// The DR bundle must fail OPEN to inclusion: a table added to the schema
// tomorrow is exported automatically, either through the tenant loop (it has
// a tenant_id column) or through the global dump (it doesn't). The ONLY way
// for a table to be omitted is an explicit entry in
// EXCLUDED_SYSTEM_BACKUP_TABLES, and backup-table-plan.test.ts fails if a
// live table is neither planned nor excluded — so an omission is always a
// reviewed decision, never an accident. (The previous design was the
// opposite: a hardcoded two-table global list silently dropped Plaid/SMS
// credentials, budget lines, and forty-odd other tables from every backup.)
//
// Drizzle's migration bookkeeping (__drizzle_migrations) lives in the
// `drizzle` schema, not `public`, so the public-schema enumeration below
// never touches it — restore always runs against an already-migrated DB and
// must not replay migration rows.

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

/**
 * Tables deliberately left out of every system backup, with the reason.
 * Exclude ONLY short-TTL security-token state; when in doubt, include.
 */
export const EXCLUDED_SYSTEM_BACKUP_TABLES: Record<string, string> = {
  sessions:
    'Refresh-token hashes; short-lived bearer state. Restoring would resurrect possibly-revoked sessions — users re-login after DR.',
  tfa_codes: 'One-time email/SMS OTP codes with minutes-long TTL; worthless and unsafe after DR.',
  magic_links: 'One-time passwordless login tokens, short TTL.',
  portal_magic_links: 'One-time portal login tokens, short TTL.',
  portal_contact_sessions: 'Portal session tokens — ephemeral auth state, same rationale as sessions.',
  password_reset_tokens: 'One-time reset tokens; restoring reopens stale reset links.',
  oauth_authorization_codes:
    'OAuth code-exchange state with ~10-minute TTL. (oauth_clients and oauth_tokens ARE included — long-lived MCP grants DR should preserve.)',
  spatial_ref_sys:
    'PostGIS reference table — ~8500 fixed map-projection rows the extension pre-populates identically on every install. It is NOT user data; restoring it just collides with (or is rejected by) the extension-owned rows, which surfaced as a spurious "8500 rows failed" in the restore report. Excluded so the report reflects only real data.',
};

/**
 * Exclusions that belong to OPTIONAL Postgres extensions (e.g. PostGIS's
 * spatial_ref_sys): present on installs that enabled the extension, absent on
 * others (including a bare test DB). The "no stale exclusions" guard tolerates
 * these being absent so it still catches genuinely-renamed/dropped app tables.
 */
export const OPTIONAL_EXTENSION_EXCLUSIONS = new Set<string>(['spatial_ref_sys']);

/**
 * tenants / users / user_tenant_access are exported as dedicated top-level
 * bundle sections (not via the table plan), so both dump loops skip them.
 */
const IDENTITY_SECTION_TABLES = ['tenants', 'users', 'user_tenant_access'];

export interface PublicTableInfo {
  table: string;
  hasTenantId: boolean;
  tenantNullable: boolean;
}

export interface TablePlan {
  /** Tables with a tenant_id column — dumped per tenant (WHERE tenant_id = $t). */
  tenantScoped: string[];
  /** Subset of tenantScoped whose tenant_id is nullable — ALSO dumped WHERE tenant_id IS NULL into global_tables. */
  nullableTenant: string[];
  /** Tables with no tenant_id column — dumped whole into global_tables. */
  global: string[];
  /** Live tables skipped via EXCLUDED_SYSTEM_BACKUP_TABLES. */
  excluded: string[];
}

type DbLike = Pick<typeof db, 'execute'>;

/** Every BASE TABLE in the public schema, with tenant_id shape. */
export async function getAllPublicTables(dbi: DbLike = db): Promise<PublicTableInfo[]> {
  const res = await dbi.execute(sql`
    SELECT t.table_name,
           c.column_name IS NOT NULL AS has_tenant_id,
           COALESCE(c.is_nullable = 'YES', false) AS tenant_nullable
    FROM information_schema.tables t
    LEFT JOIN information_schema.columns c
      ON c.table_schema = t.table_schema
     AND c.table_name = t.table_name
     AND c.column_name = 'tenant_id'
    WHERE t.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
    ORDER BY t.table_name
  `);
  return (res.rows as { table_name: string; has_tenant_id: boolean; tenant_nullable: boolean }[])
    .filter((r) => /^[a-z_][a-z0-9_]*$/.test(r.table_name))
    .map((r) => ({ table: r.table_name, hasTenantId: r.has_tenant_id, tenantNullable: r.tenant_nullable }));
}

/** The full system-backup plan: everything is included unless explicitly excluded. */
export async function getSystemBackupTablePlan(dbi: DbLike = db): Promise<TablePlan> {
  const all = await getAllPublicTables(dbi);
  const plan: TablePlan = { tenantScoped: [], nullableTenant: [], global: [], excluded: [] };
  for (const t of all) {
    if (IDENTITY_SECTION_TABLES.includes(t.table)) continue;
    if (t.table in EXCLUDED_SYSTEM_BACKUP_TABLES) {
      plan.excluded.push(t.table);
      continue;
    }
    if (t.hasTenantId) {
      plan.tenantScoped.push(t.table);
      if (t.tenantNullable) plan.nullableTenant.push(t.table);
    } else {
      plan.global.push(t.table);
    }
  }
  return plan;
}
