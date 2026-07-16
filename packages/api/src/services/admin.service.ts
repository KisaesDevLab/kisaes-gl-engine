// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and, ne, sql, count } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import type { JwtPayload } from '@kis-books/shared';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, transactions, accounts, contacts, systemSettings, accountantCompanyExclusions, userTenantAccess, plaidItems, plaidAccounts } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';

// ─── Tenant Management ───────────────────────────────────────────

export async function listTenants() {
  const rows = await db.execute(sql`
    SELECT t.id, t.name, t.slug, t.created_at,
      (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) as user_count,
      (SELECT COUNT(*) FROM companies c WHERE c.tenant_id = t.id) as company_count,
      (SELECT COUNT(*) FROM transactions tx WHERE tx.tenant_id = t.id) as transaction_count
    FROM tenants t
    ORDER BY t.created_at DESC
  `);
  return (rows.rows as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    createdAt: r.created_at,
    userCount: parseInt(r.user_count || '0'),
    companyCount: parseInt(r.company_count || '0'),
    transactionCount: parseInt(r.transaction_count || '0'),
  }));
}

export async function getTenantDetail(tenantId: string) {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) throw AppError.notFound('Tenant not found');

  // Get all users with access to this tenant (via junction table, falling back to direct FK)
  const accessRows = await db.execute(sql`
    SELECT u.id, u.email, u.display_name, u.is_super_admin, u.last_login_at,
      uta.role, uta.is_active as tenant_active
    FROM user_tenant_access uta
    JOIN users u ON u.id = uta.user_id
    WHERE uta.tenant_id = ${tenantId}
    ORDER BY u.created_at
  `);

  let tenantUsers = (accessRows.rows as any[]).map((r) => ({
    id: r.id, email: r.email, displayName: r.display_name, role: r.role,
    isActive: r.tenant_active, isSuperAdmin: r.is_super_admin, lastLoginAt: r.last_login_at,
  }));

  // Fallback: if no access records, use direct FK users
  if (tenantUsers.length === 0) {
    const directUsers = await db.select().from(users).where(eq(users.tenantId, tenantId));
    tenantUsers = directUsers.map((u) => ({
      id: u.id, email: u.email, displayName: u.displayName, role: u.role,
      isActive: u.isActive, isSuperAdmin: u.isSuperAdmin, lastLoginAt: u.lastLoginAt,
    }));
  }

  const tenantCompanies = await db.select({
    id: companies.id, businessName: companies.businessName, setupComplete: companies.setupComplete,
  }).from(companies).where(eq(companies.tenantId, tenantId));

  const stats = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM transactions WHERE tenant_id = ${tenantId}) as transactions,
      (SELECT COUNT(*) FROM accounts WHERE tenant_id = ${tenantId}) as accounts,
      -- Non-system accounts drive the "delete COA" / "apply template" flow:
      -- delete preserves system accounts, so re-templating is gated on this.
      (SELECT COUNT(*) FROM accounts WHERE tenant_id = ${tenantId} AND is_system IS NOT TRUE) as non_system_accounts,
      (SELECT COUNT(*) FROM contacts WHERE tenant_id = ${tenantId}) as contacts
  `);

  return {
    tenant,
    users: tenantUsers,
    companies: tenantCompanies,
    stats: (stats.rows as any[])[0] || {},
  };
}

export async function disableTenant(tenantId: string, actingUserId?: string) {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) throw AppError.notFound('Tenant not found');

  // Deactivate all users in the tenant
  await db.update(users).set({ isActive: false }).where(eq(users.tenantId, tenantId));
  await auditLog(tenantId, 'update', 'tenant', tenantId, { isActive: true }, { isActive: false }, actingUserId);
}

export async function enableTenant(tenantId: string, actingUserId?: string) {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) throw AppError.notFound('Tenant not found');

  await db.update(users).set({ isActive: true }).where(eq(users.tenantId, tenantId));
  await auditLog(tenantId, 'update', 'tenant', tenantId, { isActive: false }, { isActive: true }, actingUserId);
}

/**
 * Before a tenant is hard-deleted, deprovision any Plaid Items that this
 * tenant is the SOLE consumer of.
 *
 * plaid_items / plaid_accounts are system-scoped (no tenant_id, no FK
 * cascade — migration 0031). deleteTenant's dynamic sweep deletes this
 * tenant's tenant-scoped `plaid_account_mappings` rows but leaves the
 * parent Item live and BILLABLE on Plaid forever. This function calls
 * Plaid's itemRemove for every Item that, once this tenant's mappings are
 * gone, would have NO remaining consumer in any other tenant — mirroring
 * plaid-connection.deleteConnection's soft-delete (accounts deactivated,
 * item marked removed, token wiped). Returns the count actually removed.
 *
 * Ordering: this MUST run BEFORE the destructive sweep (it needs the
 * mappings + access tokens, which the sweep deletes) and BEFORE the DB
 * transaction (a Plaid network hiccup must never leave a half-deleted
 * tenant).
 *
 * Failure tolerance (differs from deleteConnection, which aborts on a
 * Plaid error): a Plaid API failure here must NOT block the tenant
 * deletion — the tenant delete is the bigger operation. On failure we
 * loud-log and leave the Item row INTACT and NOT-removed, so a super
 * admin can find and retry it from the connections page. Marking it
 * removed locally would hide a still-live, still-billable Item from the
 * manual-cleanup path. Only a SUCCESSFUL itemRemove marks the row removed.
 */
async function deprovisionOrphanedPlaidItems(
  tenantId: string,
  actingUserId: string,
): Promise<number> {
  // 1. Distinct parent Plaid Items this tenant maps accounts into.
  const itemRows = await db.execute(sql`
    SELECT DISTINCT pa.plaid_item_id AS item_id
    FROM plaid_account_mappings pam
    JOIN plaid_accounts pa ON pa.id = pam.plaid_account_id
    WHERE pam.tenant_id = ${tenantId}
  `);
  const itemIds = (itemRows.rows as { item_id: string }[]).map((r) => r.item_id);
  if (itemIds.length === 0) return 0;

  // Dynamic imports mirror the pattern used elsewhere in this file and keep
  // the Plaid SDK out of admin.service's static import graph (avoids any
  // circular-import surprise via plaid-client.service).
  const plaidClient = await import('./plaid-client.service.js');
  const { decrypt } = await import('../utils/encryption.js');

  let deprovisioned = 0;
  for (const itemId of itemIds) {
    // 2. Does ANY other tenant still consume this Item? If so, leave it —
    // it's still legitimately in use (and legitimately billable).
    const otherRows = await db.execute(sql`
      SELECT 1
      FROM plaid_account_mappings pam
      JOIN plaid_accounts pa ON pa.id = pam.plaid_account_id
      WHERE pa.plaid_item_id = ${itemId} AND pam.tenant_id <> ${tenantId}
      LIMIT 1
    `);
    if (otherRows.rows.length > 0) continue;

    const item = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, itemId) });
    // Already removed / token wiped → nothing left to deprovision.
    if (!item || item.itemStatus === 'removed' || item.accessTokenEncrypted === 'REMOVED') continue;

    // 3. Deprovision on Plaid, then mirror deleteConnection's soft-delete.
    try {
      const accessToken = decrypt(item.accessTokenEncrypted);
      await plaidClient.removeItem(accessToken);
      // Only reached on a SUCCESSFUL removal — safe to mark removed now.
      await db.update(plaidAccounts).set({ isActive: false }).where(eq(plaidAccounts.plaidItemId, item.id));
      await db.update(plaidItems).set({
        itemStatus: 'removed',
        removedAt: new Date(),
        removedBy: actingUserId,
        accessTokenEncrypted: 'REMOVED',
        updatedAt: new Date(),
      }).where(eq(plaidItems.id, item.id));
      deprovisioned++;
    } catch (err) {
      // Item is STILL LIVE on Plaid — do NOT mark it removed. Loud-log so
      // it's findable/retryable via the connections page.
      console.error(
        `[deleteTenant] Plaid itemRemove failed for item ${item.id} — MANUAL DEPROVISION NEEDED:`,
        err,
      );
    }
  }
  return deprovisioned;
}

/**
 * Hard-delete a tenant and ALL its scoped data.
 *
 * This is a destructive, irreversible operation. The flow:
 *
 *   1. Find users whose HOME tenant_id is the one being deleted. These
 *      need to be re-homed to another tenant they have access to before
 *      we can drop the tenant row (the FK from users.tenant_id to
 *      tenants.id is NOT NULL and has no ON DELETE CASCADE).
 *
 *   2. If any home user has no other active tenant access, REJECT the
 *      deletion with a clear error message naming the stuck users. The
 *      operator must either grant them access to another tenant or
 *      delete them via /admin/users first.
 *
 *   3. Inside a single db.transaction:
 *      a. Reassign each home user's tenant_id to one of their other
 *         accessible tenants.
 *      b. Drop user_tenant_access rows for this tenant.
 *      c. Discover every table in the public schema that has a
 *         `tenant_id` column and DELETE from it scoped to this
 *         tenant. Most tables have no FK constraints (only auth.ts
 *         declares FKs against tenants/users), so deletion order
 *         doesn't matter — but the dynamic discovery means we don't
 *         have to maintain a hardcoded list as new schemas are added.
 *      d. Finally DELETE FROM tenants.
 *
 *   4. After the transaction commits, write an audit log entry under
 *      the DELETER'S tenant_id (the deleted tenant's audit_log rows
 *      are gone, so the entry has to live somewhere else).
 *
 * Returns the count of users that were re-homed so the UI can show a
 * meaningful confirmation message.
 */
export async function deleteTenant(
  tenantId: string,
  deletingUserId: string,
): Promise<{ deleted: true; tenantId: string; tenantName: string; usersReassigned: number }> {
  // UUID format check up front. The DB column is `uuid` and will reject
  // malformed input at parse time, but we validate here so a malformed
  // id never reaches the parameterized raw DELETE below (defense in
  // depth for CLAUDE.md rule #17).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw AppError.badRequest('Invalid tenant id format');
  }

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) throw AppError.notFound('Tenant not found');

  // 0. Safety gate: refuse to delete an active tenant. The caller must
  // first POST /admin/tenants/:id/disable (which flips every user in
  // the tenant to is_active=false). That's our proxy for "tenant is
  // offline" — no new sessions can mint, no new writes can land, so
  // the deletion below isn't racing live user traffic.
  //
  // Without this gate, a user posting an invoice concurrently with the
  // delete would INSERT a journal_line row whose tenant_id immediately
  // becomes a dangling reference after the transaction commits (most
  // tenant-scoped tables have no FK to tenants).
  const activeUsers = await db.select({ id: users.id, email: users.email })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.isActive, true)));
  if (activeUsers.length > 0) {
    throw AppError.badRequest(
      `Cannot delete an active tenant. Disable the tenant first (POST /admin/tenants/${tenantId}/disable), ` +
      `which will deactivate all ${activeUsers.length} user(s), then retry the deletion.`,
    );
  }

  // 1. Find users whose HOME tenant_id is this tenant.
  const homeUsers = await db.select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.tenantId, tenantId));

  // 2. For each, find another active tenant they have access to.
  type Reassignment = { userId: string; email: string; newHomeTenantId: string | null };
  const reassignments: Reassignment[] = [];
  for (const u of homeUsers) {
    const other = await db.select({ tenantId: userTenantAccess.tenantId })
      .from(userTenantAccess)
      .where(and(
        eq(userTenantAccess.userId, u.id),
        ne(userTenantAccess.tenantId, tenantId),
        eq(userTenantAccess.isActive, true),
      ))
      .limit(1);
    reassignments.push({
      userId: u.id,
      email: u.email,
      newHomeTenantId: other[0]?.tenantId || null,
    });
  }

  // 3. Reject if any home user has nowhere to go.
  const stranded = reassignments.filter((r) => r.newHomeTenantId === null);
  if (stranded.length > 0) {
    const list = stranded.map((s) => s.email).join(', ');
    throw AppError.badRequest(
      `Cannot delete tenant: ${stranded.length} user(s) would be stranded with no tenant access (${list}). ` +
      `Grant them access to another tenant first, or delete those users via /admin/users.`,
    );
  }

  const beforeSnapshot = {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    homeUserCount: homeUsers.length,
  };

  // 3.5. Deprovision Plaid Items this tenant is the SOLE consumer of, so a
  // deleted tenant never leaves an orphaned, still-billable Plaid Item.
  // Done BEFORE the sweep (needs the mappings + tokens it would delete) and
  // BEFORE the transaction (a Plaid hiccup must not half-delete the tenant).
  // Failures are tolerated inside the helper — they never block the delete.
  const plaidItemsDeprovisioned = await deprovisionOrphanedPlaidItems(tenantId, deletingUserId);

  // 4. Atomic deletion.
  await db.transaction(async (tx) => {
    // 4a. Re-home each user to one of their other accessible tenants.
    for (const r of reassignments) {
      if (r.newHomeTenantId) {
        await tx.update(users)
          .set({ tenantId: r.newHomeTenantId, updatedAt: new Date() })
          .where(eq(users.id, r.userId));
      }
    }

    // 4b. Drop access junction rows for this tenant.
    await tx.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tenantId));

    // 4c. Dynamically discover all tables with a tenant_id column and
    // delete from each. Skips tenants/users/user_tenant_access because
    // those need special handling above (FK from users.tenant_id, and
    // we already dropped the access rows).
    // Join information_schema.tables and filter to BASE TABLE — otherwise
    // VIEWS that expose a tenant_id column (e.g. conditional_rule_stats,
    // an aggregate view with GROUP BY) get matched too, and `DELETE FROM
    // <view>` fails with "cannot delete from view" (SQLSTATE 55000),
    // aborting the whole transaction and 500-ing the delete.
    const tablesResult = await tx.execute(sql`
      SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.column_name = 'tenant_id'
        AND c.table_schema = 'public'
        AND t.table_type = 'BASE TABLE'
        AND c.table_name NOT IN ('tenants', 'users', 'user_tenant_access')
      ORDER BY c.table_name
    `);

    for (const row of tablesResult.rows as { table_name: string }[]) {
      const tableName = row.table_name;
      // Table identifier comes from information_schema, but we still
      // regex-check it before concatenation because `sql.identifier`
      // accepts any string and a malformed name would produce invalid
      // SQL. The tenant_id is passed as a *parameter* via the sql``
      // template — NOT interpolated — so even if tenantId somehow
      // contained SQL metacharacters there's no injection path.
      if (!/^[a-z_][a-z0-9_]*$/.test(tableName)) {
        throw new Error(`Refusing to delete from suspicious table: ${tableName}`);
      }
      await tx.execute(
        sql`DELETE FROM ${sql.identifier(tableName)} WHERE tenant_id = ${tenantId}`,
      );
    }

    // 4d. Finally delete the tenant row itself.
    await tx.delete(tenants).where(eq(tenants.id, tenantId));
  });

  // 5. Write the audit log entry under the deleter's tenant (the deleted
  // tenant's audit_log rows are gone). After the reassignment, the
  // deleter's users.tenant_id may have changed if they were one of the
  // home users — re-fetch to get the post-reassignment value.
  const deleter = await db.query.users.findFirst({ where: eq(users.id, deletingUserId) });
  if (deleter) {
    await auditLog(deleter.tenantId, 'delete', 'tenant', tenantId, { ...beforeSnapshot, plaidItemsDeprovisioned }, null, deletingUserId);
  }

  return {
    deleted: true,
    tenantId,
    tenantName: tenant.name,
    usersReassigned: reassignments.length,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Hard-delete a single company from a tenant: permanently removes every
 * company-scoped row (transactions, journal lines, invoices, bills, banking,
 * company-scoped accounts/contacts, etc.) and then the company itself. The
 * tenant, its users, and any OTHER companies are untouched.
 *
 * Mirrors deleteTenant's dynamic sweep but scoped to company_id. company_id is
 * a globally-unique UUID that always references companies.id, and we verify the
 * company belongs to the tenant up front, so a bare `WHERE company_id = ?` can
 * never touch another tenant's rows. Refuses to delete the tenant's only
 * company (a tenant needs at least one). IRREVERSIBLE.
 */
export async function deleteCompany(tenantId: string, companyId: string, actingUserId?: string) {
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(companyId)) {
    throw AppError.badRequest('Invalid id format');
  }
  const company = await db.query.companies.findFirst({
    where: and(eq(companies.id, companyId), eq(companies.tenantId, tenantId)),
  });
  if (!company) throw AppError.notFound('Company not found in this tenant');

  const companyCountRows = await db.select({ c: count() }).from(companies).where(eq(companies.tenantId, tenantId));
  const companyCount = companyCountRows[0]?.c ?? 0;
  if (companyCount <= 1) {
    throw AppError.badRequest("Cannot delete a tenant's only company. Delete the tenant instead.");
  }

  const rowsDeleted = await db.transaction(async (tx) => {
    const tablesResult = await tx.execute(sql`
      SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.column_name = 'company_id'
        AND c.table_schema = 'public'
        AND t.table_type = 'BASE TABLE'
        AND c.table_name <> 'companies'
      ORDER BY c.table_name
    `);
    let total = 0;
    for (const row of tablesResult.rows as { table_name: string }[]) {
      const tableName = row.table_name;
      if (!/^[a-z_][a-z0-9_]*$/.test(tableName)) {
        throw new Error(`Refusing to delete from suspicious table: ${tableName}`);
      }
      const res = await tx.execute(sql`DELETE FROM ${sql.identifier(tableName)} WHERE company_id = ${companyId}`);
      total += res.rowCount ?? 0;
    }
    await tx.delete(companies).where(and(eq(companies.id, companyId), eq(companies.tenantId, tenantId)));
    return total;
  });

  await auditLog(tenantId, 'delete', 'company', companyId,
    { id: company.id, name: company.businessName, rowsDeleted }, null, actingUserId);
  return { deleted: true, companyId, companyName: company.businessName, rowsDeleted };
}

/**
 * Purge a tenant's payroll import history (record-only). Removes every
 * payroll_import_session and its child rows (rows / errors / column mappings /
 * check-register rows). Posted sessions' journal entries are intentionally
 * LEFT in the ledger — this only cleans up the import-history records, not the
 * accounting. IRREVERSIBLE.
 */
export async function deletePayrollImportHistory(tenantId: string, actingUserId?: string) {
  if (!UUID_RE.test(tenantId)) throw AppError.badRequest('Invalid tenant id format');
  const sessionCount = await db.transaction(async (tx) => {
    const countRes = await tx.execute(sql`SELECT count(*)::int AS c FROM payroll_import_sessions WHERE tenant_id = ${tenantId}`);
    const n = (countRes.rows[0] as { c: number }).c;
    const childTables = ['payroll_import_rows', 'payroll_import_errors', 'payroll_import_column_mappings', 'payroll_check_register_rows'];
    for (const tbl of childTables) {
      await tx.execute(sql`DELETE FROM ${sql.identifier(tbl)} WHERE session_id IN (SELECT id FROM payroll_import_sessions WHERE tenant_id = ${tenantId})`);
    }
    await tx.execute(sql`DELETE FROM payroll_import_sessions WHERE tenant_id = ${tenantId}`);
    return n;
  });
  await auditLog(tenantId, 'delete', 'payroll_import_history', tenantId, { sessionCount }, null, actingUserId);
  return { deleted: true, sessionCount };
}

/**
 * Delete a tenant's chart of accounts — allowed ONLY when the tenant has
 * recorded no transactions. Intended for correcting a wrong COA template on
 * a freshly-provisioned tenant before any activity: delete, then re-seed
 * from the right template. Refuses once any transaction exists, because
 * journal_lines reference account_id and dropping accounts would orphan
 * posted history and corrupt reports.
 *
 * Deletes ONLY non-system accounts. System accounts (Payments Clearing,
 * A/R, A/P, Opening Balances, Retained Earnings, …) are looked up by
 * `systemTag` throughout the app and are protected by rule #25 — deleting
 * them would break bank mappings, default-account settings, and the ledger
 * services that resolve them. Preserving them also means a business-type
 * template can be swapped without destroying the required accounts;
 * applyCoaTemplate re-seeds only the non-system rows on top.
 */
export async function deleteChartOfAccounts(
  tenantId: string,
  actingUserId?: string,
): Promise<{ deleted: true; tenantId: string; accountsDeleted: number; systemAccountsKept: number }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw AppError.badRequest('Invalid tenant id format');
  }
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) throw AppError.notFound('Tenant not found');

  const [txn] = await db.select({ c: count() }).from(transactions).where(eq(transactions.tenantId, tenantId));
  const txnCount = Number(txn?.c ?? 0);
  if (txnCount > 0) {
    throw AppError.badRequest(
      `Cannot delete the chart of accounts: this tenant has ${txnCount} transaction(s). ` +
      `The chart of accounts can only be deleted before any transactions are recorded.`,
      'COA_HAS_TRANSACTIONS',
    );
  }

  // `is_system` is nullable (default false); treat NULL as non-system.
  const nonSystem = and(eq(accounts.tenantId, tenantId), sql`${accounts.isSystem} IS NOT TRUE`);
  const [toDelete] = await db.select({ c: count() }).from(accounts).where(nonSystem);
  const [kept] = await db.select({ c: count() }).from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.isSystem, true)));
  const accountsDeleted = Number(toDelete?.c ?? 0);
  const systemAccountsKept = Number(kept?.c ?? 0);

  await db.delete(accounts).where(nonSystem);
  await auditLog(tenantId, 'delete', 'chart_of_accounts', tenantId, { accountsDeleted, systemAccountsKept }, null, actingUserId);

  return { deleted: true, tenantId, accountsDeleted, systemAccountsKept };
}

/**
 * Delete EVERY transaction for a tenant — a books reset that keeps the
 * chart of accounts, contacts, companies, users, and settings intact.
 * Super-admin only (router-level guard) with a type-to-confirm UI.
 *
 * Wipes, in one atomic transaction:
 *   - transaction_tags, journal_lines, transactions
 *   - payment / bill-payment / vendor-credit applications, deposit lines
 *   - reconciliations + reconciliation_lines (they reference the
 *     deleted journal lines)
 *   - recurring schedules (their templates ARE transactions)
 * Resets (not deletes):
 *   - bank_feed_items that were matched/added → back to 'pending' so
 *     the bank data survives and can be re-categorized
 *   - daily_sales_entries → unlink posted JE, back to 'draft'
 *   - accounts.balance → 0 (no posted lines remain; rule 24 holds)
 */
export async function deleteAllTransactions(
  tenantId: string,
  actingUserId?: string,
): Promise<{ deleted: true; tenantId: string; transactionsDeleted: number }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw AppError.badRequest('Invalid tenant id format');
  }
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) throw AppError.notFound('Tenant not found');

  const [txn] = await db.select({ c: count() }).from(transactions).where(eq(transactions.tenantId, tenantId));
  const transactionsDeleted = Number(txn?.c ?? 0);
  if (transactionsDeleted === 0) {
    return { deleted: true, tenantId, transactionsDeleted: 0 };
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM transaction_tags WHERE tenant_id = ${tenantId}`);
    await tx.execute(sql`DELETE FROM reconciliation_lines WHERE reconciliation_id IN (SELECT id FROM reconciliations WHERE tenant_id = ${tenantId})`);
    await tx.execute(sql`DELETE FROM reconciliations WHERE tenant_id = ${tenantId}`);
    await tx.execute(sql`DELETE FROM payment_applications WHERE tenant_id = ${tenantId}`);
    await tx.execute(sql`DELETE FROM bill_payment_applications WHERE tenant_id = ${tenantId}`);
    await tx.execute(sql`DELETE FROM vendor_credit_applications WHERE tenant_id = ${tenantId}`);
    // deposit_lines has no tenant_id — scope through the parent deposit.
    await tx.execute(sql`DELETE FROM deposit_lines WHERE deposit_id IN (SELECT id FROM transactions WHERE tenant_id = ${tenantId})`);
    await tx.execute(sql`DELETE FROM recurring_schedules WHERE tenant_id = ${tenantId}`);
    await tx.execute(sql`
      UPDATE daily_sales_entries
      SET transaction_id = NULL, status = 'draft', posted_at = NULL
      WHERE tenant_id = ${tenantId} AND transaction_id IS NOT NULL
    `);
    await tx.execute(sql`
      UPDATE bank_feed_items
      SET matched_transaction_id = NULL, status = 'pending', match_type = NULL
      WHERE tenant_id = ${tenantId} AND matched_transaction_id IS NOT NULL
    `);
    await tx.execute(sql`DELETE FROM journal_lines WHERE tenant_id = ${tenantId}`);
    await tx.execute(sql`DELETE FROM transactions WHERE tenant_id = ${tenantId}`);
    // No posted lines remain → every account's running balance is zero.
    await tx.execute(sql`UPDATE accounts SET balance = 0, updated_at = now() WHERE tenant_id = ${tenantId}`);
  });

  await auditLog(tenantId, 'delete', 'all_transactions', tenantId,
    { transactionsDeleted, tenantName: tenant.name }, null, actingUserId);

  return { deleted: true, tenantId, transactionsDeleted };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Shared validation for the date-range transaction tools: tenant-id
 * format, tenant existence, well-formed YYYY-MM-DD dates, and
 * start <= end. Returns the tenant row so callers can reuse its name in
 * audit entries without a second lookup.
 */
async function validateTenantAndRange(tenantId: string, startDate: string, endDate: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw AppError.badRequest('Invalid tenant id format');
  }
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    throw AppError.badRequest('startDate and endDate must be YYYY-MM-DD', 'BAD_DATE_FORMAT');
  }
  // ISO dates sort lexicographically, so a string compare is a correct
  // chronological compare here.
  if (startDate > endDate) {
    throw AppError.badRequest('startDate must be on or before endDate', 'BAD_DATE_RANGE');
  }
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) throw AppError.notFound('Tenant not found');
  return tenant;
}

/**
 * Count what deleteTransactionsInDateRange would remove, without
 * touching anything. Powers the admin confirm dialog's "this will
 * delete N transactions, M feed items, R reconciliations" preview.
 */
export async function previewTransactionsInDateRange(
  tenantId: string,
  startDate: string,
  endDate: string,
): Promise<{ transactionsToDelete: number; feedItemsToDelete: number; reconciliationsToDelete: number }> {
  await validateTenantAndRange(tenantId, startDate, endDate);

  const counts = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM transactions
        WHERE tenant_id = ${tenantId} AND txn_date BETWEEN ${startDate}::date AND ${endDate}::date) AS txns,
      (SELECT COUNT(*) FROM bank_feed_items
        WHERE tenant_id = ${tenantId} AND feed_date BETWEEN ${startDate}::date AND ${endDate}::date) AS feed,
      (SELECT COUNT(*) FROM reconciliations
        WHERE tenant_id = ${tenantId} AND statement_date BETWEEN ${startDate}::date AND ${endDate}::date) AS recs
  `);
  const row = (counts.rows as { txns: string; feed: string; recs: string }[])[0]!;
  return {
    transactionsToDelete: Number(row.txns ?? 0),
    feedItemsToDelete: Number(row.feed ?? 0),
    reconciliationsToDelete: Number(row.recs ?? 0),
  };
}

/**
 * Delete every transaction whose `txn_date` falls in [startDate,
 * endDate] for one tenant — a surgical, date-scoped counterpart to
 * deleteAllTransactions. Super-admin only (router guard) with a
 * type-to-confirm + preview UI.
 *
 * The critical difference from the whole-tenant reset is that every
 * dependent cleanup is SCOPED to the target transactions (or, for
 * reconciliations and bank-feed items, to the range), never tenant-
 * wide — deleting Q1 must not touch Q2's applications, deposits, or
 * recurring templates.
 *
 * Confirmed semantics (from the feature request):
 *   - Reconciliations whose statement_date is in the range are DELETED
 *     (with their lines); bank_statements.reconciliation_id pointing at
 *     them is nulled (its FK is ON DELETE SET NULL, but we null it
 *     explicitly for defense in depth). A reconciliation OUTSIDE the
 *     range that happened to clear an in-range journal line keeps
 *     existing — only its now-orphaned lines are removed.
 *   - Bank-feed items are purged by `feed_date` in the range. Feed
 *     items OUTSIDE the range that were matched to a deleted (target)
 *     transaction are reset to pending so no dangling match remains.
 *   - daily_sales_entries posted to a target transaction are unlinked
 *     back to 'draft'. recurring_schedules are TEMPLATES, not dated
 *     transactions, so they are left intact (unlike the full reset).
 *   - Account balances are RECOMPUTED (not zeroed) from the surviving
 *     posted/void journal lines, matching the debit-minus-credit
 *     convention the ledger service maintains on post/void.
 */
export async function deleteTransactionsInDateRange(
  tenantId: string,
  startDate: string,
  endDate: string,
  actingUserId?: string,
): Promise<{
  deleted: true;
  tenantId: string;
  startDate: string;
  endDate: string;
  transactionsDeleted: number;
  feedItemsDeleted: number;
  reconciliationsDeleted: number;
}> {
  const tenant = await validateTenantAndRange(tenantId, startDate, endDate);

  const { transactionsToDelete, feedItemsToDelete, reconciliationsToDelete } =
    await previewTransactionsInDateRange(tenantId, startDate, endDate);

  // No-op guard: nothing dated in range and no feed rows to purge. We
  // still bail even if an in-range reconciliation exists with no
  // transactions — a reconciliation cannot be meaningful without any
  // dated activity, and this matches the confirmed no-op condition.
  if (transactionsToDelete === 0 && feedItemsToDelete === 0) {
    return {
      deleted: true, tenantId, startDate, endDate,
      transactionsDeleted: 0, feedItemsDeleted: 0, reconciliationsDeleted: 0,
    };
  }

  await db.transaction(async (tx) => {
    // Reusable subqueries. Each embedding re-emits its bound params, so
    // they are safe to reference multiple times.
    const targetTxns = sql`SELECT id FROM transactions WHERE tenant_id = ${tenantId} AND txn_date BETWEEN ${startDate}::date AND ${endDate}::date`;
    const targetJournalLines = sql`SELECT id FROM journal_lines WHERE tenant_id = ${tenantId} AND transaction_id IN (${targetTxns})`;
    const inRangeRecs = sql`SELECT id FROM reconciliations WHERE tenant_id = ${tenantId} AND statement_date BETWEEN ${startDate}::date AND ${endDate}::date`;

    // 1. transaction_tags for target txns (scoped by both tenant + txn).
    await tx.execute(sql`DELETE FROM transaction_tags WHERE tenant_id = ${tenantId} AND transaction_id IN (${targetTxns})`);

    // 2. reconciliation_lines that reference a deleted journal line —
    // covers in-range recs AND out-of-range recs that cleared an
    // in-range line (the latter keep their reconciliation).
    await tx.execute(sql`DELETE FROM reconciliation_lines WHERE journal_line_id IN (${targetJournalLines})`);
    // 3. remaining lines of the in-range recs (may reference lines
    // outside the range that this rec cleared — they go with the rec).
    await tx.execute(sql`DELETE FROM reconciliation_lines WHERE reconciliation_id IN (${inRangeRecs})`);
    // 4. detach bank_statements from the recs about to be deleted.
    await tx.execute(sql`UPDATE bank_statements SET reconciliation_id = NULL, updated_at = now() WHERE tenant_id = ${tenantId} AND reconciliation_id IN (${inRangeRecs})`);
    // 5. the in-range reconciliations themselves.
    await tx.execute(sql`DELETE FROM reconciliations WHERE tenant_id = ${tenantId} AND statement_date BETWEEN ${startDate}::date AND ${endDate}::date`);

    // 6-8. Applications link two transactions; a row must go if EITHER
    // side is being deleted, otherwise it dangles on the surviving side.
    await tx.execute(sql`DELETE FROM payment_applications WHERE tenant_id = ${tenantId} AND (payment_id IN (${targetTxns}) OR invoice_id IN (${targetTxns}))`);
    await tx.execute(sql`DELETE FROM bill_payment_applications WHERE tenant_id = ${tenantId} AND (payment_id IN (${targetTxns}) OR bill_id IN (${targetTxns}))`);
    await tx.execute(sql`DELETE FROM vendor_credit_applications WHERE tenant_id = ${tenantId} AND (payment_id IN (${targetTxns}) OR credit_id IN (${targetTxns}) OR bill_id IN (${targetTxns}))`);

    // 9. deposit_lines link a deposit txn to a source txn (both are
    // transactions) — same either-side rule. deposit_lines has no
    // tenant_id, so scope purely through the target-txn set.
    await tx.execute(sql`DELETE FROM deposit_lines WHERE deposit_id IN (${targetTxns}) OR source_transaction_id IN (${targetTxns})`);

    // 10. daily_sales_entries posted to a target txn → back to draft.
    await tx.execute(sql`
      UPDATE daily_sales_entries
      SET transaction_id = NULL, status = 'draft', posted_at = NULL, updated_at = now()
      WHERE tenant_id = ${tenantId} AND transaction_id IN (${targetTxns})
    `);

    // 11. Purge feed items by feed_date in range.
    await tx.execute(sql`DELETE FROM bank_feed_items WHERE tenant_id = ${tenantId} AND feed_date BETWEEN ${startDate}::date AND ${endDate}::date`);
    // 12. Surviving (out-of-range) feed items matched to a deleted txn →
    // reset to pending so no dangling match_transaction_id remains.
    await tx.execute(sql`
      UPDATE bank_feed_items
      SET matched_transaction_id = NULL, status = 'pending', match_type = NULL, updated_at = now()
      WHERE tenant_id = ${tenantId} AND matched_transaction_id IN (${targetTxns})
    `);
    // NOTE: bank_statement_lines.matched_journal_line_id is ON DELETE
    // SET NULL (migration 0116), so the journal_line delete below clears
    // those references automatically — no explicit handling needed.

    // 13. journal_lines then 14. transactions.
    await tx.execute(sql`DELETE FROM journal_lines WHERE tenant_id = ${tenantId} AND transaction_id IN (${targetTxns})`);
    await tx.execute(sql`DELETE FROM transactions WHERE tenant_id = ${tenantId} AND txn_date BETWEEN ${startDate}::date AND ${endDate}::date`);

    // 15. Recompute every account's denormalized balance from the
    // surviving journal lines. The ledger service maintains
    // accounts.balance as SUM(debit - credit) over posted lines, and
    // void adds swapped-side reversal lines (so a voided txn nets to
    // zero). Draft txns never touched the balance, so they are excluded.
    await tx.execute(sql`
      UPDATE accounts a
      SET balance = COALESCE((
        SELECT SUM(jl.debit - jl.credit)
        FROM journal_lines jl
        JOIN transactions t ON t.id = jl.transaction_id
        WHERE jl.account_id = a.id
          AND jl.tenant_id = ${tenantId}
          AND t.status IN ('posted', 'void')
      ), 0),
      updated_at = now()
      WHERE a.tenant_id = ${tenantId}
    `);
  });

  await auditLog(tenantId, 'delete', 'transactions_date_range', tenantId, null, {
    startDate, endDate, tenantName: tenant.name,
    transactionsDeleted: transactionsToDelete,
    feedItemsDeleted: feedItemsToDelete,
    reconciliationsDeleted: reconciliationsToDelete,
  }, actingUserId);

  return {
    deleted: true, tenantId, startDate, endDate,
    transactionsDeleted: transactionsToDelete,
    feedItemsDeleted: feedItemsToDelete,
    reconciliationsDeleted: reconciliationsToDelete,
  };
}

/**
 * Apply a chart-of-accounts template to a tenant. Only valid when the
 * tenant currently has ZERO accounts — the intended flow for fixing a
 * wrong template is: delete the chart of accounts (guarded on zero
 * transactions), then apply the right template here. Template slugs
 * resolve DB-first (runtime-editable coa_templates) with the static
 * BUSINESS_TEMPLATES fallback, exactly like tenant creation.
 */
export async function applyCoaTemplate(
  tenantId: string,
  templateSlug: string,
  actingUserId?: string,
): Promise<{ applied: true; tenantId: string; templateSlug: string; accountsCreated: number }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw AppError.badRequest('Invalid tenant id format');
  }
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) throw AppError.notFound('Tenant not found');

  // Only NON-system accounts block re-templating: deleteChartOfAccounts
  // preserves system accounts, so a swap flow legitimately runs with them
  // still present. seedFromTemplate skips any template row whose account
  // number already exists (the preserved system accounts), so they aren't
  // duplicated.
  const [existing] = await db.select({ c: count() }).from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), sql`${accounts.isSystem} IS NOT TRUE`));
  if (Number(existing?.c ?? 0) > 0) {
    throw AppError.badRequest(
      `This tenant already has ${existing!.c} non-system accounts. Delete the chart of accounts first ` +
      `(only possible before any transactions are recorded), then apply the template.`,
      'COA_NOT_EMPTY',
    );
  }

  const accountsService = await import('./accounts.service.js');
  await accountsService.seedFromTemplate(tenantId, templateSlug);

  const [after] = await db.select({ c: count() }).from(accounts).where(eq(accounts.tenantId, tenantId));
  const accountsCreated = Number(after?.c ?? 0);
  await auditLog(tenantId, 'create', 'coa_template_applied', tenantId,
    null, { templateSlug, accountsCreated }, actingUserId);

  return { applied: true, tenantId, templateSlug, accountsCreated };
}

// ─── User Management ─────────────────────────────────────────────

export async function listAllUsers() {
  const rows = await db.execute(sql`
    SELECT u.id, u.email, u.display_name, u.role, u.is_active, u.is_super_admin,
      u.last_login_at, u.created_at, u.tenant_id,
      t.name as tenant_name
    FROM users u
    JOIN tenants t ON t.id = u.tenant_id
    ORDER BY u.created_at DESC
  `);
  return (rows.rows as any[]).map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    isActive: r.is_active,
    isSuperAdmin: r.is_super_admin,
    lastLoginAt: r.last_login_at,
    createdAt: r.created_at,
    tenantId: r.tenant_id,
    tenantName: r.tenant_name,
  }));
}

/**
 * Reset a user's password. Called by super admins via
 * /admin/users/:id/reset-password. Enforces a minimum length of 12
 * to line up with the register/reset-password flow; longer complexity
 * checks are left to the registration schema to avoid drift.
 */
export async function resetUserPassword(userId: string, newPassword: string, actingUserId?: string) {
  if (typeof newPassword !== 'string' || newPassword.length < 12) {
    throw AppError.badRequest('Password must be at least 12 characters', 'PASSWORD_TOO_SHORT');
  }
  if (newPassword.length > 128) {
    throw AppError.badRequest('Password must be 128 characters or fewer', 'PASSWORD_TOO_LONG');
  }

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');

  const passwordHash = await bcrypt.hash(newPassword, env.BCRYPT_ROUNDS);
  await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, userId));
  await auditLog(user.tenantId, 'update', 'user_password_reset', userId, null, { email: user.email }, actingUserId);
}

/**
 * Unlock a user whose login was locked by MAX_LOGIN_ATTEMPTS. See
 * CLOUDFLARE_TUNNEL_PLAN Phase 3 — auto-unlock was removed because it
 * gave credential-stuffing attackers a free wait-15-minutes-and-retry
 * path. Super-admin explicit action is now the only way back in.
 * Safe to call even when the user isn't locked — it's a clear of the
 * failed-attempts counter either way.
 */
export async function unlockUser(userId: string, actingUserId?: string) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');

  const wasLocked = !!user.loginLockedUntil;
  await db.update(users)
    .set({ loginFailedAttempts: 0, loginLockedUntil: null, updatedAt: new Date() })
    .where(eq(users.id, userId));
  await auditLog(
    user.tenantId,
    'update',
    'user_login_unlocked',
    userId,
    { failedAttempts: user.loginFailedAttempts || 0, wasLocked },
    { failedAttempts: 0, wasLocked: false },
    actingUserId,
  );
  return { unlocked: true, wasLocked };
}

export async function toggleUserActive(userId: string, actingUserId?: string) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');

  // Self-protection: refuse to deactivate the logged-in admin. If
  // they legitimately want to lock themselves out, they can do it
  // via password reset + logout instead. This prevents a single
  // misclick from stranding the only super admin with no way back
  // in.
  if (actingUserId && actingUserId === userId && user.isActive) {
    throw AppError.badRequest('You cannot deactivate your own account', 'CANNOT_DEACTIVATE_SELF');
  }

  const next = !user.isActive;
  await db.update(users).set({ isActive: next, updatedAt: new Date() }).where(eq(users.id, userId));
  await auditLog(user.tenantId, 'update', 'user_active', userId, { isActive: user.isActive }, { isActive: next }, actingUserId);
  return { isActive: next };
}

export async function toggleTenantAccess(userId: string, tenantId: string, actingUserId?: string) {
  const access = await db.query.userTenantAccess.findFirst({
    where: and(eq(userTenantAccess.userId, userId), eq(userTenantAccess.tenantId, tenantId)),
  });
  if (!access) throw AppError.notFound('User does not have access to this tenant');
  const newActive = !access.isActive;
  await db.update(userTenantAccess).set({ isActive: newActive })
    .where(eq(userTenantAccess.id, access.id));
  await auditLog(tenantId, 'update', 'user_tenant_access', userId, { isActive: access.isActive }, { isActive: newActive }, actingUserId);
  return { isActive: newActive };
}

// Grant (or reactivate) an existing user's access to a tenant with a role.
// Idempotent: if an active row with the same role exists it's a no-op; a
// deactivated or differently-roled row is reactivated/updated. Unlike
// toggleTenantAccess this creates the row when none exists — the "add" half of
// admin tenant/user access management.
export async function grantTenantAccess(
  userId: string,
  tenantId: string,
  role: string,
  actingUserId?: string,
) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) throw AppError.notFound('Tenant not found');

  const existing = await db.query.userTenantAccess.findFirst({
    where: and(eq(userTenantAccess.userId, userId), eq(userTenantAccess.tenantId, tenantId)),
  });
  if (existing) {
    if (existing.isActive && existing.role === role) {
      return { granted: false, alreadyActive: true, role };
    }
    await db.update(userTenantAccess).set({ isActive: true, role })
      .where(eq(userTenantAccess.id, existing.id));
    await auditLog(tenantId, 'update', 'user_tenant_access', userId,
      { isActive: existing.isActive, role: existing.role }, { isActive: true, role }, actingUserId);
    return { granted: true, reactivated: true, role };
  }
  await db.insert(userTenantAccess).values({ userId, tenantId, role, isActive: true });
  await auditLog(tenantId, 'create', 'user_tenant_access', userId, null, { tenantId, role }, actingUserId);
  return { granted: true, reactivated: false, role };
}

// Every tenant a user can reach (active or revoked), with role — powers the
// admin "monitor & manage a user's tenant access" view.
export async function listUserTenantAccess(userId: string) {
  const rows = await db.execute(sql`
    SELECT uta.tenant_id, t.name AS tenant_name, uta.role, uta.is_active, uta.last_accessed_at
    FROM user_tenant_access uta
    JOIN tenants t ON t.id = uta.tenant_id
    WHERE uta.user_id = ${userId}
    ORDER BY t.name
  `);
  return (rows.rows as Array<{ tenant_id: string; tenant_name: string; role: string; is_active: boolean; last_accessed_at: string | null }>).map((r) => ({
    tenantId: r.tenant_id,
    tenantName: r.tenant_name,
    role: r.role,
    isActive: r.is_active,
    lastAccessedAt: r.last_accessed_at,
  }));
}

// ─── System Retained Earnings repair ───────────────────────────
//
// The system Retained Earnings account is identified by
// system_tag = 'retained_earnings'. If it gets deleted, the balance sheet
// falls back to the CALCULATED Retained Earnings rows and closing entries /
// system-account protections lose their target. These let a super-admin
// re-designate an equity account as the system RE.

const RETAINED_EARNINGS_TAG = 'retained_earnings';

export async function getRetainedEarningsInfo(tenantId: string) {
  const equityAccounts = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      accountNumber: accounts.accountNumber,
      systemTag: accounts.systemTag,
      isSystem: accounts.isSystem,
    })
    .from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'equity')))
    .orderBy(accounts.accountNumber, accounts.name);
  const current = equityAccounts.find((a) => a.systemTag === RETAINED_EARNINGS_TAG) ?? null;
  return { current, equityAccounts };
}

// Tag an equity account as the system Retained Earnings. Reassigns cleanly: any
// other account already holding the tag is cleared first so there's exactly one
// system RE per tenant. Sets isSystem (rule #25 protection) and the canonical
// retained_earnings detail type.
export async function designateRetainedEarnings(tenantId: string, accountId: string, actingUserId?: string) {
  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId)),
  });
  if (!account) throw AppError.notFound('Account not found');
  if (account.accountType !== 'equity') {
    throw AppError.badRequest('Retained Earnings must be an equity account', 'RE_NOT_EQUITY');
  }

  const existing = await db.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, RETAINED_EARNINGS_TAG)));

  await db.transaction(async (tx) => {
    for (const e of existing) {
      if (e.id !== accountId) {
        await tx.update(accounts).set({ systemTag: null, isSystem: false }).where(eq(accounts.id, e.id));
      }
    }
    await tx.update(accounts)
      .set({ systemTag: RETAINED_EARNINGS_TAG, isSystem: true, detailType: RETAINED_EARNINGS_TAG })
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId)));
  });

  await auditLog(tenantId, 'update', 'account', accountId,
    { systemTag: account.systemTag, isSystem: account.isSystem, detailType: account.detailType },
    { systemTag: RETAINED_EARNINGS_TAG, isSystem: true, detailType: RETAINED_EARNINGS_TAG }, actingUserId);

  return getRetainedEarningsInfo(tenantId);
}

// Distinct users who are active members of any firm, with the firm(s) they
// belong to — the candidate list for "add a firm user to this tenant".
export async function listFirmUsers() {
  const rows = await db.execute(sql`
    SELECT u.id, u.email, u.display_name, u.is_active,
      array_agg(DISTINCT f.name) FILTER (WHERE f.name IS NOT NULL) AS firm_names
    FROM firm_users fu
    JOIN users u ON u.id = fu.user_id
    JOIN firms f ON f.id = fu.firm_id
    WHERE fu.is_active = true
    GROUP BY u.id, u.email, u.display_name, u.is_active
    ORDER BY u.email
  `);
  return (rows.rows as Array<{ id: string; email: string; display_name: string | null; is_active: boolean; firm_names: string[] | null }>).map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    isActive: r.is_active,
    firmNames: r.firm_names ?? [],
  }));
}

export async function toggleSuperAdmin(userId: string, actingUserId?: string) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');

  // Self-protection: refuse to demote self. If we allowed it, a
  // misclick by the sole super admin would permanently lock the
  // admin surface area (there's no recovery UI for promoting a
  // fresh super admin without another super admin).
  if (actingUserId && actingUserId === userId && user.isSuperAdmin) {
    throw AppError.badRequest('You cannot demote your own super admin privileges', 'CANNOT_DEMOTE_SELF');
  }

  // Last-super-admin guard: if this would bring the active super
  // admin count to zero, refuse. We count active super admins (not
  // just super admins) because a deactivated one can't log in.
  if (user.isSuperAdmin) {
    const [row] = await db.select({ c: count() }).from(users)
      .where(and(eq(users.isSuperAdmin, true), eq(users.isActive, true)));
    if ((row?.c ?? 0) <= 1) {
      throw AppError.badRequest('Cannot demote the last active super admin', 'LAST_SUPER_ADMIN');
    }
  }

  const next = !user.isSuperAdmin;
  await db.update(users).set({ isSuperAdmin: next, updatedAt: new Date() }).where(eq(users.id, userId));
  await auditLog(user.tenantId, 'update', 'user_super_admin', userId, { isSuperAdmin: user.isSuperAdmin }, { isSuperAdmin: next }, actingUserId);
  return { isSuperAdmin: next };
}

// ─── System Monitoring ───────────────────────────────────────────

export async function getSystemStats() {
  const stats = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM tenants) as total_tenants,
      (SELECT COUNT(*) FROM users) as total_users,
      (SELECT COUNT(*) FROM users WHERE is_active = true) as active_users,
      (SELECT COUNT(*) FROM users WHERE is_super_admin = true) as super_admins,
      (SELECT COUNT(*) FROM companies) as total_companies,
      (SELECT COUNT(*) FROM transactions) as total_transactions,
      (SELECT COUNT(*) FROM sessions) as active_sessions,
      (SELECT pg_database_size(current_database())) as database_size_bytes
  `);

  const row = (stats.rows as any[])[0] || {};
  return {
    totalTenants: parseInt(row.total_tenants || '0'),
    totalUsers: parseInt(row.total_users || '0'),
    activeUsers: parseInt(row.active_users || '0'),
    superAdmins: parseInt(row.super_admins || '0'),
    totalCompanies: parseInt(row.total_companies || '0'),
    totalTransactions: parseInt(row.total_transactions || '0'),
    activeSessions: parseInt(row.active_sessions || '0'),
    databaseSizeMB: Math.round(parseInt(row.database_size_bytes || '0') / 1024 / 1024),
  };
}

// ─── Impersonation ───────────────────────────────────────────────

export async function impersonateUser(adminUserId: string, targetUserId: string) {
  const targetUser = await db.query.users.findFirst({ where: eq(users.id, targetUserId) });
  if (!targetUser) throw AppError.notFound('Target user not found');

  // Refuse to impersonate self — nothing is gained, and it creates
  // confusing audit entries.
  if (adminUserId === targetUserId) {
    throw AppError.badRequest('Cannot impersonate yourself', 'CANNOT_IMPERSONATE_SELF');
  }

  // Refuse to impersonate another super admin. Super admins should
  // troubleshoot each other directly, not via impersonation, so that
  // audit logs accurately reflect who did what.
  if (targetUser.isSuperAdmin) {
    throw AppError.badRequest('Cannot impersonate another super admin', 'CANNOT_IMPERSONATE_SUPER_ADMIN');
  }

  // Create a JWT with the target user's context but flag it as impersonation
  const jwtPayload: JwtPayload = {
    userId: targetUser.id,
    tenantId: targetUser.tenantId,
    role: targetUser.role,
    isSuperAdmin: false, // Don't give impersonated session super admin powers
    impersonating: adminUserId, // Track who's impersonating
  };

  // Short-lived token for impersonation (1 hour)
  const token = jwt.sign(jwtPayload, env.JWT_SECRET, { expiresIn: 3600 });

  // Write audit entries under BOTH the target's tenant (where the
  // actions will appear) and the acting admin's tenant (where the
  // admin's own audit trail lives). Otherwise an audit of the admin
  // surface misses this event entirely.
  const admin = await db.query.users.findFirst({ where: eq(users.id, adminUserId) });
  await auditLog(targetUser.tenantId, 'create', 'impersonation', targetUser.id, null, { adminUserId, targetEmail: targetUser.email }, adminUserId);
  if (admin && admin.tenantId !== targetUser.tenantId) {
    await auditLog(admin.tenantId, 'create', 'impersonation_started', targetUser.id, null, { targetTenantId: targetUser.tenantId, targetEmail: targetUser.email }, adminUserId);
  }

  return { accessToken: token, user: { id: targetUser.id, email: targetUser.email, displayName: targetUser.displayName, tenantId: targetUser.tenantId } };
}

export async function setUserRole(userId: string, role: string, actingUserId?: string) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');
  await db.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, userId));
  await auditLog(user.tenantId, 'update', 'user_role', userId, { role: user.role }, { role }, actingUserId);
}

// ─── Accountant Company Access ───────────────────────────────────

export async function getAccountantCompanyAccess(userId: string) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');

  // Get all companies in the user's tenant
  const allCompanies = await db.select({
    id: companies.id,
    businessName: companies.businessName,
  }).from(companies).where(eq(companies.tenantId, user.tenantId));

  // Get excluded company IDs
  const exclusions = await db.select({ companyId: accountantCompanyExclusions.companyId })
    .from(accountantCompanyExclusions).where(eq(accountantCompanyExclusions.userId, userId));
  const excludedIds = new Set(exclusions.map((e) => e.companyId));

  return {
    userId: user.id,
    email: user.email,
    role: user.role,
    companies: allCompanies.map((c) => ({
      id: c.id,
      businessName: c.businessName,
      hasAccess: !excludedIds.has(c.id),
    })),
  };
}

/**
 * Verify that `userId` and `companyId` live in the same tenant before
 * letting an admin link them. Without this check, a misclick in the
 * admin UI could insert an exclusion row whose user and company
 * belong to unrelated tenants — `listCompanies` would silently filter
 * against the wrong row and future audits would be very confusing.
 *
 * Returns the shared tenantId so callers can use it for audit logging
 * without a second lookup.
 */
async function assertUserAndCompanySameTenant(userId: string, companyId: string): Promise<string> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');

  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  if (!company) throw AppError.notFound('Company not found');

  if (user.tenantId !== company.tenantId) {
    throw AppError.badRequest(
      'User and company belong to different tenants',
      'TENANT_MISMATCH',
    );
  }
  return user.tenantId;
}

export async function excludeCompanyFromAccountant(userId: string, companyId: string, actingUserId?: string) {
  const tenantId = await assertUserAndCompanySameTenant(userId, companyId);
  await db.insert(accountantCompanyExclusions)
    .values({ userId, companyId })
    .onConflictDoNothing();
  // Permission mutation — must be auditable. The composite (userId,
  // companyId) is the natural entity key; pass it as `entityId` joined
  // for forensic readability.
  await auditLog(
    tenantId,
    'create',
    'accountant_company_exclusion',
    `${userId}:${companyId}`,
    null,
    { userId, companyId },
    actingUserId,
  );
}

export async function includeCompanyForAccountant(userId: string, companyId: string, actingUserId?: string) {
  const tenantId = await assertUserAndCompanySameTenant(userId, companyId);
  await db.delete(accountantCompanyExclusions)
    .where(and(eq(accountantCompanyExclusions.userId, userId), eq(accountantCompanyExclusions.companyId, companyId)));
  await auditLog(
    tenantId,
    'delete',
    'accountant_company_exclusion',
    `${userId}:${companyId}`,
    { userId, companyId },
    null,
    actingUserId,
  );
}

// ─── System Settings (DB-backed) ─────────────────────────────────

export async function getSetting(key: string): Promise<string | null> {
  const row = await db.query.systemSettings.findFirst({
    where: eq(systemSettings.key, key),
  });
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db
    .insert(systemSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value, updatedAt: new Date() },
    });
}

/** Returns SMTP config — DB values take priority over .env */
export async function getSmtpSettings() {
  const dbHost = await getSetting('smtp_host');
  const dbPort = await getSetting('smtp_port');
  const dbUser = await getSetting('smtp_user');
  const dbPass = await getSetting('smtp_pass');
  const dbFrom = await getSetting('smtp_from');

  return {
    smtpHost: dbHost ?? process.env['SMTP_HOST'] ?? '',
    smtpPort: parseInt(dbPort ?? process.env['SMTP_PORT'] ?? '587'),
    smtpUser: dbUser ?? process.env['SMTP_USER'] ?? '',
    smtpPass: dbPass ?? process.env['SMTP_PASS'] ?? '',
    smtpFrom: dbFrom ?? process.env['SMTP_FROM'] ?? 'noreply@example.com',
    source: dbHost ? 'database' : (process.env['SMTP_HOST'] ? 'env' : 'none'),
  };
}

export async function saveSmtpSettings(input: {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass?: string | null;
  smtpFrom: string;
}) {
  await setSetting('smtp_host', input.smtpHost);
  await setSetting('smtp_port', String(input.smtpPort));
  await setSetting('smtp_user', input.smtpUser);
  // 3-state sentinel for the password: null clears the stored value,
  // '' or undefined preserves it, a non-empty string sets it. Form
  // re-saves should NOT wipe credentials just because the password
  // field rendered blank.
  if (input.smtpPass === null) {
    await setSetting('smtp_pass', '');
  } else if (input.smtpPass) {
    await setSetting('smtp_pass', input.smtpPass);
  }
  await setSetting('smtp_from', input.smtpFrom);
}

export async function getGlobalSettings() {
  const smtp = await getSmtpSettings();
  return {
    smtpHost: smtp.smtpHost,
    smtpPort: smtp.smtpPort,
    smtpFrom: smtp.smtpFrom,
    smtpUser: smtp.smtpUser,
    smtpConfigured: !!smtp.smtpHost,
    // `passwordConfigured` lets the UI render a "Clear stored password"
    // button conditionally — the actual password never round-trips.
    smtpPasswordConfigured: !!smtp.smtpPass,
    smtpSource: smtp.source,
    backupDir: process.env['BACKUP_DIR'] || '/data/backups',
    uploadDir: process.env['UPLOAD_DIR'] || '/data/uploads',
    maxFileSizeMB: parseInt(process.env['MAX_FILE_SIZE_MB'] || '10'),
    nodeEnv: process.env['NODE_ENV'] || 'development',
  };
}

// Default product name. Kept as an exported constant so the sidebar's
// "powered by" footer logic and the API both compare against the same
// string — change it in one place and both sides agree.
export const DEFAULT_APP_NAME = 'Vibe MyBooks';

export async function getApplicationSettings() {
  const appUrl = await getSetting('application_url');
  const maxFileSize = await getSetting('max_file_size_mb');
  const backupSchedule = await getSetting('backup_schedule');
  const appName = await getSetting('app_name');
  return {
    applicationUrl: appUrl ?? '',
    maxFileSizeMb: maxFileSize ?? process.env['MAX_FILE_SIZE_MB'] ?? '10',
    backupSchedule: backupSchedule ?? 'none',
    appName: appName && appName.trim() ? appName : DEFAULT_APP_NAME,
  };
}

export async function saveApplicationSettings(input: {
  applicationUrl: string;
  maxFileSizeMb: string;
  backupSchedule: string;
  appName?: string;
}) {
  await setSetting('application_url', input.applicationUrl);
  await setSetting('max_file_size_mb', input.maxFileSizeMb);
  await setSetting('backup_schedule', input.backupSchedule);
  if (input.appName !== undefined) {
    // An empty string means "reset to default" — store empty so the
    // getter falls back to DEFAULT_APP_NAME on the next read.
    await setSetting('app_name', input.appName.trim());
  }
}

/**
 * Lightweight branding lookup used by the authenticated `/auth/me`
 * response. Kept separate from the heavier getApplicationSettings so the
 * sidebar fetch path doesn't pull in unrelated settings (and so it can
 * be cached independently in the future).
 */
export async function getBranding(): Promise<{ appName: string; isCustomName: boolean }> {
  const stored = await getSetting('app_name');
  const appName = stored && stored.trim() ? stored : DEFAULT_APP_NAME;
  return {
    appName,
    isCustomName: appName !== DEFAULT_APP_NAME,
  };
}

// ─── Backup Remote Config ────────────────────────────────────────

export interface BackupRemoteConfig {
  backupRemoteProvider: string;
  backupRemoteConfig: string; // JSON string, secrets encrypted
  backupLocalRetentionDays: string;
  backupRemoteRetentionPreset: string;
  backupRemoteRetentionDaily: string;
  backupRemoteRetentionWeekly: string;
  backupRemoteRetentionMonthly: string;
  backupRemoteRetentionYearly: string;
  backupLastRun: string;
  /** DB-only cadence, independent of the full-bundle backupSchedule. */
  backupDbSchedule: string;
  backupDbLastRun: string;
  /** Extra local directory each backup is mirrored to (e.g. an external drive bind-mount). */
  backupLocalMirrorDir: string;
  /** Whether the scheduler passphrase is set (never the value). */
  hasScheduledPassphrase: boolean;
}

const GFS_PRESETS: Record<string, { daily: string; weekly: string; monthly: string; yearly: string }> = {
  recommended: { daily: '14', weekly: '8', monthly: '12', yearly: '7' },
  minimal: { daily: '7', weekly: '4', monthly: '6', yearly: '0' },
  compliance: { daily: '30', weekly: '12', monthly: '24', yearly: '10' },
  unlimited: { daily: '0', weekly: '0', monthly: '0', yearly: '0' },
};

export { GFS_PRESETS };

export async function getBackupRemoteConfig(): Promise<BackupRemoteConfig> {
  const provider = await getSetting('backup_remote_provider');
  const config = await getSetting('backup_remote_config');
  const localRetention = await getSetting('backup_local_retention_days');
  const preset = await getSetting('backup_remote_retention_preset');
  const daily = await getSetting('backup_remote_retention_daily');
  const weekly = await getSetting('backup_remote_retention_weekly');
  const monthly = await getSetting('backup_remote_retention_monthly');
  const yearly = await getSetting('backup_remote_retention_yearly');
  const lastRun = await getSetting('backup_last_run');
  const dbSchedule = await getSetting('backup_db_schedule');
  const dbLastRun = await getSetting('backup_db_last_run');
  const mirrorDir = await getSetting('backup_local_mirror_dir');
  const scheduledPassphrase = await getSetting('backup_scheduled_passphrase');

  return {
    backupRemoteProvider: provider ?? 'none',
    backupRemoteConfig: config ?? '{}',
    backupLocalRetentionDays: localRetention ?? '30',
    backupRemoteRetentionPreset: preset ?? 'recommended',
    backupRemoteRetentionDaily: daily ?? '14',
    backupRemoteRetentionWeekly: weekly ?? '8',
    backupRemoteRetentionMonthly: monthly ?? '12',
    backupRemoteRetentionYearly: yearly ?? '7',
    backupLastRun: lastRun ?? '',
    backupDbSchedule: dbSchedule ?? 'none',
    backupDbLastRun: dbLastRun ?? '',
    backupLocalMirrorDir: mirrorDir ?? '',
    hasScheduledPassphrase: !!scheduledPassphrase,
  };
}

export async function saveBackupRemoteConfig(input: Partial<BackupRemoteConfig>) {
  if (input.backupRemoteProvider !== undefined) await setSetting('backup_remote_provider', input.backupRemoteProvider);
  if (input.backupRemoteConfig !== undefined) await setSetting('backup_remote_config', input.backupRemoteConfig);
  if (input.backupLocalRetentionDays !== undefined) await setSetting('backup_local_retention_days', input.backupLocalRetentionDays);
  if (input.backupRemoteRetentionPreset !== undefined) {
    await setSetting('backup_remote_retention_preset', input.backupRemoteRetentionPreset);
    // Auto-populate tier values from preset (unless custom)
    const presetValues = GFS_PRESETS[input.backupRemoteRetentionPreset];
    if (presetValues) {
      await setSetting('backup_remote_retention_daily', presetValues.daily);
      await setSetting('backup_remote_retention_weekly', presetValues.weekly);
      await setSetting('backup_remote_retention_monthly', presetValues.monthly);
      await setSetting('backup_remote_retention_yearly', presetValues.yearly);
    }
  }
  if (input.backupRemoteRetentionDaily !== undefined) await setSetting('backup_remote_retention_daily', input.backupRemoteRetentionDaily);
  if (input.backupRemoteRetentionWeekly !== undefined) await setSetting('backup_remote_retention_weekly', input.backupRemoteRetentionWeekly);
  if (input.backupRemoteRetentionMonthly !== undefined) await setSetting('backup_remote_retention_monthly', input.backupRemoteRetentionMonthly);
  if (input.backupRemoteRetentionYearly !== undefined) await setSetting('backup_remote_retention_yearly', input.backupRemoteRetentionYearly);
  if (input.backupLastRun !== undefined) await setSetting('backup_last_run', input.backupLastRun);
  if (input.backupDbSchedule !== undefined) await setSetting('backup_db_schedule', input.backupDbSchedule);
  if (input.backupDbLastRun !== undefined) await setSetting('backup_db_last_run', input.backupDbLastRun);
  if (input.backupLocalMirrorDir !== undefined) await setSetting('backup_local_mirror_dir', input.backupLocalMirrorDir);
}

// ─── System File Storage Config ──────────────────────────────────
//
// System-level (super-admin) file-storage default. Tenants that have
// NOT configured their own storage provider resolve to this; tenants
// with their own active storage_providers row are unaffected. Same
// key/value + encrypted-JSON shape as the backup remote config above.

export interface SystemStorageConfig {
  /** 'local' | 'b2' | 's3' */
  storageSystemProvider: string;
  /** JSON string; secrets stored encrypted (application_key_encrypted / secret_access_key_encrypted) */
  storageSystemConfig: string;
}

export async function getSystemStorageConfig(): Promise<SystemStorageConfig> {
  const provider = await getSetting('storage_system_provider');
  const config = await getSetting('storage_system_config');
  return {
    storageSystemProvider: provider ?? 'local',
    storageSystemConfig: config ?? '{}',
  };
}

export async function saveSystemStorageConfig(input: Partial<SystemStorageConfig>): Promise<void> {
  if (input.storageSystemProvider !== undefined) await setSetting('storage_system_provider', input.storageSystemProvider);
  if (input.storageSystemConfig !== undefined) await setSetting('storage_system_config', input.storageSystemConfig);
}
