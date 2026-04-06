import { eq, and, sql, count } from 'drizzle-orm';
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

export async function disableTenant(tenantId: string) {
  // Deactivate all users in the tenant
  await db.update(users).set({ isActive: false }).where(eq(users.tenantId, tenantId));
}

export async function enableTenant(tenantId: string) {
  await db.update(users).set({ isActive: true }).where(eq(users.tenantId, tenantId));
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

export async function resetUserPassword(userId: string, newPassword: string) {
  const passwordHash = await bcrypt.hash(newPassword, 12);
  await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, userId));
}

export async function toggleUserActive(userId: string) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');
  await db.update(users).set({ isActive: !user.isActive, updatedAt: new Date() }).where(eq(users.id, userId));
  return { isActive: !user.isActive };
}

export async function toggleTenantAccess(userId: string, tenantId: string) {
  const access = await db.query.userTenantAccess.findFirst({
    where: and(eq(userTenantAccess.userId, userId), eq(userTenantAccess.tenantId, tenantId)),
  });
  if (!access) throw AppError.notFound('User does not have access to this tenant');
  const newActive = !access.isActive;
  await db.update(userTenantAccess).set({ isActive: newActive })
    .where(eq(userTenantAccess.id, access.id));
  return { isActive: newActive };
}

export async function toggleSuperAdmin(userId: string) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');
  await db.update(users).set({ isSuperAdmin: !user.isSuperAdmin, updatedAt: new Date() }).where(eq(users.id, userId));
  return { isSuperAdmin: !user.isSuperAdmin };
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

  await auditLog(targetUser.tenantId, 'create', 'impersonation', targetUser.id, null, { adminUserId, targetEmail: targetUser.email }, adminUserId);

  return { accessToken: token, user: { id: targetUser.id, email: targetUser.email, displayName: targetUser.displayName, tenantId: targetUser.tenantId } };
}

export async function setUserRole(userId: string, role: string) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');
  await db.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, userId));
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

export async function excludeCompanyFromAccountant(userId: string, companyId: string) {
  await db.insert(accountantCompanyExclusions)
    .values({ userId, companyId })
    .onConflictDoNothing();
}

export async function includeCompanyForAccountant(userId: string, companyId: string) {
  await db.delete(accountantCompanyExclusions)
    .where(and(eq(accountantCompanyExclusions.userId, userId), eq(accountantCompanyExclusions.companyId, companyId)));
}

// ─── System Settings (DB-backed) ─────────────────────────────────

async function getSetting(key: string): Promise<string | null> {
  const row = await db.query.systemSettings.findFirst({
    where: eq(systemSettings.key, key),
  });
  return row?.value ?? null;
}

async function setSetting(key: string, value: string): Promise<void> {
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

export async function getApplicationSettings() {
  const appUrl = await getSetting('application_url');
  const maxFileSize = await getSetting('max_file_size_mb');
  const backupSchedule = await getSetting('backup_schedule');
  return {
    applicationUrl: appUrl ?? '',
    maxFileSizeMb: maxFileSize ?? process.env['MAX_FILE_SIZE_MB'] ?? '10',
    backupSchedule: backupSchedule ?? 'none',
  };
}

export async function saveApplicationSettings(input: {
  applicationUrl: string;
  maxFileSizeMb: string;
  backupSchedule: string;
}) {
  await setSetting('application_url', input.applicationUrl);
  await setSetting('max_file_size_mb', input.maxFileSizeMb);
  await setSetting('backup_schedule', input.backupSchedule);
}
