import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { eq, and, sql } from 'drizzle-orm';
import type { RegisterInput, LoginInput, AuthTokens, JwtPayload } from '@kis-books/shared';
import { db } from '../db/index.js';
import { tenants, users, sessions, userTenantAccess, companies, passwordResetTokens } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { createCompanyForTenant } from './company.service.js';
import { seedFromTemplate } from './accounts.service.js';
import * as systemEmail from './system-email.service.js';

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
    + '-' + crypto.randomBytes(4).toString('hex');
}

function parseExpiryToSeconds(expiry: string): number {
  const match = expiry.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 900; // default 15 minutes
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 3600;
    case 'd': return value * 86400;
    default: return 900;
  }
}

function generateAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: parseExpiryToSeconds(env.JWT_ACCESS_EXPIRY) });
}

function generateRefreshToken(): string {
  return crypto.randomBytes(48).toString('hex');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createSession(userId: string, refreshToken: string): Promise<void> {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

  await db.insert(sessions).values({
    userId,
    refreshTokenHash: hashToken(refreshToken),
    expiresAt,
  });
}

export async function createClientTenant(creatorUserId: string, input: { companyName: string; industry?: string; entityType?: string; businessType?: string }): Promise<{ tenantId: string; companyId: string; tenantName: string }> {
  // Create a new tenant
  const [tenant] = await db.insert(tenants).values({
    name: input.companyName,
    slug: generateSlug(input.companyName),
  }).returning();
  if (!tenant) throw AppError.internal('Failed to create tenant');

  // Create company and seed COA
  await createCompanyForTenant(tenant.id, input.companyName);
  await seedFromTemplate(tenant.id, input.businessType || 'default');

  // Get the company that was just created
  const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenant.id) });

  // Give the creator access to this tenant as accountant
  await db.insert(userTenantAccess).values({
    userId: creatorUserId,
    tenantId: tenant.id,
    role: 'accountant',
  }).onConflictDoNothing();

  return { tenantId: tenant.id, companyId: company?.id || '', tenantName: tenant.name };
}

export async function register(input: RegisterInput): Promise<{ user: typeof users.$inferSelect; tokens: AuthTokens }> {
  // Check if email already exists across all tenants
  const existingUser = await db.query.users.findFirst({
    where: eq(users.email, input.email),
  });
  if (existingUser) {
    throw AppError.conflict('An account with this email already exists', 'EMAIL_EXISTS');
  }

  // Create tenant
  const [tenant] = await db.insert(tenants).values({
    name: input.companyName,
    slug: generateSlug(input.companyName),
  }).returning();

  if (!tenant) {
    throw AppError.internal('Failed to create tenant');
  }

  // Create user
  const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS);
  const [user] = await db.insert(users).values({
    tenantId: tenant.id,
    email: input.email,
    passwordHash,
    displayName: input.displayName,
    role: 'owner',
  }).returning();

  if (!user) {
    throw AppError.internal('Failed to create user');
  }

  // Create company and seed COA
  await createCompanyForTenant(tenant.id, input.companyName);
  await seedFromTemplate(tenant.id, input.businessType || 'default');

  // Create tenant access record
  await db.insert(userTenantAccess).values({ userId: user.id, tenantId: tenant.id, role: 'owner' });

  // Generate tokens
  const jwtPayload: JwtPayload = { userId: user.id, tenantId: tenant.id, role: user.role, isSuperAdmin: user.isSuperAdmin || false };
  const accessToken = generateAccessToken(jwtPayload);
  const refreshToken = generateRefreshToken();
  await createSession(user.id, refreshToken);

  await auditLog(tenant.id, 'create', 'user', user.id, null, { email: user.email }, user.id);

  return {
    user,
    tokens: { accessToken, refreshToken },
  };
}

export async function getAccessibleTenants(userId: string) {
  const rows = await db.execute(sql`
    SELECT uta.tenant_id, uta.role, uta.is_active, t.name as tenant_name
    FROM user_tenant_access uta
    JOIN tenants t ON t.id = uta.tenant_id
    WHERE uta.user_id = ${userId} AND uta.is_active = true
    ORDER BY t.name
  `);
  return (rows.rows as any[]).map((r) => ({
    tenantId: r.tenant_id,
    tenantName: r.tenant_name,
    role: r.role,
  }));
}

export async function login(input: LoginInput): Promise<{ user: typeof users.$inferSelect; tokens: AuthTokens; accessibleTenants: any[] }> {
  const user = await db.query.users.findFirst({
    where: eq(users.email, input.email),
  });

  if (!user) {
    throw AppError.unauthorized('Invalid email or password');
  }

  if (!user.isActive) {
    throw AppError.unauthorized('Account is deactivated');
  }

  const validPassword = await bcrypt.compare(input.password, user.passwordHash);
  if (!validPassword) {
    throw AppError.unauthorized('Invalid email or password');
  }

  // Update last login
  await db.update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, user.id));

  // Get accessible tenants
  const accessibleTenants = await getAccessibleTenants(user.id);

  // Use the user's home tenant (or first accessible) for the JWT
  const activeTenant = accessibleTenants.find((t) => t.tenantId === user.tenantId) || accessibleTenants[0];
  const tenantId = activeTenant?.tenantId || user.tenantId;
  const role = activeTenant?.role || user.role;

  const jwtPayload: JwtPayload = { userId: user.id, tenantId, role, isSuperAdmin: user.isSuperAdmin || false };
  const accessToken = generateAccessToken(jwtPayload);
  const refreshToken = generateRefreshToken();
  await createSession(user.id, refreshToken);

  await auditLog(tenantId, 'login', 'user', user.id, null, null, user.id);

  return {
    user,
    tokens: { accessToken, refreshToken },
    accessibleTenants,
  };
}

export async function switchTenant(userId: string, targetTenantId: string): Promise<AuthTokens> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');

  // Verify access to the target tenant
  const access = await db.query.userTenantAccess.findFirst({
    where: and(eq(userTenantAccess.userId, userId), eq(userTenantAccess.tenantId, targetTenantId)),
  });

  // Super admins can switch to any tenant even without explicit access
  if (!user.isSuperAdmin && (!access || !access.isActive)) {
    throw AppError.forbidden('You do not have access to this tenant');
  }

  const role = access?.role || 'owner';
  const jwtPayload: JwtPayload = { userId: user.id, tenantId: targetTenantId, role, isSuperAdmin: user.isSuperAdmin || false };
  const accessToken = generateAccessToken(jwtPayload);
  const refreshToken = generateRefreshToken();
  await createSession(user.id, refreshToken);

  return { accessToken, refreshToken };
}

export async function refresh(refreshToken: string): Promise<AuthTokens> {
  const tokenHash = hashToken(refreshToken);

  const session = await db.query.sessions.findFirst({
    where: eq(sessions.refreshTokenHash, tokenHash),
  });

  if (!session) {
    throw AppError.unauthorized('Invalid refresh token');
  }

  if (new Date() > session.expiresAt) {
    // Clean up expired session
    await db.delete(sessions).where(eq(sessions.id, session.id));
    throw AppError.unauthorized('Refresh token expired');
  }

  // Get user
  const user = await db.query.users.findFirst({
    where: eq(users.id, session.userId),
  });

  if (!user || !user.isActive) {
    throw AppError.unauthorized('User not found or deactivated');
  }

  // Rotate refresh token
  await db.delete(sessions).where(eq(sessions.id, session.id));

  const jwtPayload: JwtPayload = { userId: user.id, tenantId: user.tenantId, role: user.role, isSuperAdmin: user.isSuperAdmin || false };
  const newAccessToken = generateAccessToken(jwtPayload);
  const newRefreshToken = generateRefreshToken();
  await createSession(user.id, newRefreshToken);

  return { accessToken: newAccessToken, refreshToken: newRefreshToken };
}

export async function logout(refreshToken: string): Promise<void> {
  const tokenHash = hashToken(refreshToken);
  await db.delete(sessions).where(eq(sessions.refreshTokenHash, tokenHash));
}

export async function forgotPassword(email: string): Promise<void> {
  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  });

  // Always return success to prevent email enumeration
  if (!user) return;

  // Generate a reset token
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 1); // 1 hour expiry

  // Invalidate any existing tokens for this user
  await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, user.id));

  // Store the hashed token
  await db.insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash,
    expiresAt,
  });

  // Send the email (uses system SMTP, falls back to stub if not configured)
  await systemEmail.sendPasswordResetEmail(email, rawToken);
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const resetRecord = await db.query.passwordResetTokens.findFirst({
    where: eq(passwordResetTokens.tokenHash, tokenHash),
  });

  if (!resetRecord) {
    throw AppError.badRequest('Invalid or expired reset token');
  }

  if (resetRecord.usedAt) {
    throw AppError.badRequest('This reset link has already been used');
  }

  if (new Date() > resetRecord.expiresAt) {
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.id, resetRecord.id));
    throw AppError.badRequest('Reset token has expired. Please request a new one.');
  }

  // Update password
  const passwordHash = await bcrypt.hash(newPassword, env.BCRYPT_ROUNDS);
  await db.update(users).set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, resetRecord.userId));

  // Mark token as used
  await db.update(passwordResetTokens).set({ usedAt: new Date() })
    .where(eq(passwordResetTokens.id, resetRecord.id));
}

export async function inviteUser(tenantId: string, input: { email: string; displayName: string; role: string }): Promise<{ user: typeof users.$inferSelect; temporaryPassword: string | null; existingUser: boolean }> {
  const role = input.role || 'accountant';

  // Check if user already exists
  const existing = await db.query.users.findFirst({ where: eq(users.email, input.email) });

  if (existing) {
    // User exists — check if they already have access to this tenant
    const existingAccess = await db.query.userTenantAccess.findFirst({
      where: and(eq(userTenantAccess.userId, existing.id), eq(userTenantAccess.tenantId, tenantId)),
    });
    if (existingAccess) {
      if (existingAccess.isActive) throw AppError.conflict('This user already has access to this tenant');
      // Reactivate
      await db.update(userTenantAccess).set({ isActive: true, role }).where(eq(userTenantAccess.id, existingAccess.id));
    } else {
      // Grant access to this tenant
      await db.insert(userTenantAccess).values({ userId: existing.id, tenantId, role });
    }
    await auditLog(tenantId, 'create', 'user_access', existing.id, null, { email: existing.email, role }, undefined);

    // Send access granted email
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
    systemEmail.sendAccessGrantedEmail(existing.email, tenant?.name || 'Company').catch(() => {});

    return { user: existing, temporaryPassword: null, existingUser: true };
  }

  // New user — create account + access
  const temporaryPassword = crypto.randomBytes(8).toString('hex');
  const passwordHash = await bcrypt.hash(temporaryPassword, env.BCRYPT_ROUNDS);

  const [user] = await db.insert(users).values({
    tenantId,
    email: input.email,
    passwordHash,
    displayName: input.displayName,
    role,
  }).returning();

  if (!user) throw AppError.internal('Failed to create user');

  await db.insert(userTenantAccess).values({ userId: user.id, tenantId, role });
  await auditLog(tenantId, 'create', 'user', user.id, null, { email: user.email, role }, undefined);

  // Send invite email with temporary credentials
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  systemEmail.sendInviteEmail(user.email, input.displayName, tenant?.name || 'Company', temporaryPassword).catch(() => {});

  return { user, temporaryPassword, existingUser: false };
}

export async function listTenantUsers(tenantId: string) {
  const rows = await db.execute(sql`
    SELECT u.id, u.email, u.display_name, u.role as user_role, u.is_active as user_active,
      u.is_super_admin, u.last_login_at, u.created_at, u.tenant_id,
      uta.role as tenant_role, uta.is_active as tenant_active
    FROM user_tenant_access uta
    JOIN users u ON u.id = uta.user_id
    WHERE uta.tenant_id = ${tenantId}
    ORDER BY u.created_at
  `);
  return (rows.rows as any[]).map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    role: r.tenant_role || r.user_role,
    isActive: r.tenant_active && r.user_active,
    tenantActive: r.tenant_active,
    isSuperAdmin: r.is_super_admin,
    lastLoginAt: r.last_login_at,
    createdAt: r.created_at,
    isHomeTenant: r.tenant_id === tenantId,
  }));
}

export async function deactivateUser(tenantId: string, userId: string) {
  const access = await db.query.userTenantAccess.findFirst({
    where: and(eq(userTenantAccess.userId, userId), eq(userTenantAccess.tenantId, tenantId)),
  });
  if (!access) throw AppError.notFound('User access not found');
  if (access.role === 'owner') throw AppError.badRequest('Cannot deactivate the owner');

  await db.update(userTenantAccess).set({ isActive: false })
    .where(and(eq(userTenantAccess.userId, userId), eq(userTenantAccess.tenantId, tenantId)));
}

export async function reactivateUser(tenantId: string, userId: string) {
  await db.update(userTenantAccess).set({ isActive: true })
    .where(and(eq(userTenantAccess.userId, userId), eq(userTenantAccess.tenantId, tenantId)));
}

export async function getMe(userId: string): Promise<typeof users.$inferSelect> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });

  if (!user) {
    throw AppError.notFound('User not found');
  }

  return user;
}
