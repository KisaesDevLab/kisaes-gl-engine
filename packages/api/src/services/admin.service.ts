import { eq, and, ne, sql, count } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import type { JwtPayload } from '@kis-books/shared';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, transactions, accounts, contacts, systemSettings, accountantCompanyExclusions, userTenantAccess } from '../db/schema/index.js';
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
    const tablesResult = await tx.execute(sql`
      SELECT table_name
      FROM information_schema.columns
      WHERE column_name = 'tenant_id'
        AND table_schema = 'public'
        AND table_name NOT IN ('tenants', 'users', 'user_tenant_access')
      ORDER BY table_name
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
    await auditLog(deleter.tenantId, 'delete', 'tenant', tenantId, beforeSnapshot, null, deletingUserId);
  }

  return {
    deleted: true,
    tenantId,
    tenantName: tenant.name,
    usersReassigned: reassignments.length,
  };
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
 */
async function assertUserAndCompanySameTenant(userId: string, companyId: string): Promise<void> {
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
}

export async function excludeCompanyFromAccountant(userId: string, companyId: string) {
  await assertUserAndCompanySameTenant(userId, companyId);
  await db.insert(accountantCompanyExclusions)
    .values({ userId, companyId })
    .onConflictDoNothing();
}

export async function includeCompanyForAccountant(userId: string, companyId: string) {
  await assertUserAndCompanySameTenant(userId, companyId);
  await db.delete(accountantCompanyExclusions)
    .where(and(eq(accountantCompanyExclusions.userId, userId), eq(accountantCompanyExclusions.companyId, companyId)));
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
  smtpPass: string;
  smtpFrom: string;
}) {
  await setSetting('smtp_host', input.smtpHost);
  await setSetting('smtp_port', String(input.smtpPort));
  await setSetting('smtp_user', input.smtpUser);
  await setSetting('smtp_pass', input.smtpPass);
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
}
