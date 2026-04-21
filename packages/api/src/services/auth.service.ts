// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { eq, and, sql, asc, inArray } from 'drizzle-orm';
import type { RegisterInput, LoginInput, AuthTokens, JwtPayload } from '@kis-books/shared';
import { db } from '../db/index.js';
import { tenants, users, sessions, userTenantAccess, companies, passwordResetTokens } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { createCompanyForTenant } from './company.service.js';
import { seedFromTemplate } from './accounts.service.js';
import * as systemEmail from './system-email.service.js';
import { checkPasswordBreached } from '../utils/hibp.js';

// Cap per CLOUDFLARE_TUNNEL_PLAN Phase 3: max 3 concurrent sessions per
// user. Oldest refresh token is revoked when the limit is exceeded —
// prevents an attacker who grabs one refresh token from holding it
// indefinitely after the user logs in elsewhere.
const MAX_SESSIONS_PER_USER = 3;

// Email is used as the unique-identifier primary key for a user. Case
// variations would otherwise create separate accounts (Alice@example and
// alice@example), which is both a UX pitfall and a security issue — a
// squatter could register `Victim@example.com` and prevent `victim@example.com`
// from ever being used. Normalize at every boundary.
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

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

/**
 * Mint a fresh access+refresh pair for an already-authenticated user and
 * persist the refresh-token session, enforcing MAX_SESSIONS_PER_USER.
 *
 * This is the single entry point every non-password login path (TFA,
 * magic link, passkey) must use. The session cap lives inside
 * createSession, so skipping this helper defeats the cap — the inline
 * db.insert(sessions) pattern this replaces was doing exactly that and
 * letting attackers hold indefinitely-many refresh tokens.
 *
 * Also reads JWT_ACCESS_EXPIRY from env via generateAccessToken, so
 * operators who tune the access-token lifetime only have to change it
 * in one place.
 */
export async function issueSession(payload: JwtPayload): Promise<AuthTokens> {
  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRefreshToken();
  await createSession(payload.userId, refreshToken);
  return { accessToken, refreshToken };
}

async function createSession(userId: string, refreshToken: string): Promise<void> {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

  await db.insert(sessions).values({
    userId,
    refreshTokenHash: hashToken(refreshToken),
    expiresAt,
  });

  // Running the trim AFTER the insert keeps the new session the most-
  // recent row so a rapid re-login never revokes its own token. Shared
  // with switchTenant's post-transaction path so cap enforcement lives
  // in exactly one place.
  await trimOldestSessions(userId);
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
  const email = normalizeEmail(input.email);
  // Check if email already exists across all tenants
  const existingUser = await db.query.users.findFirst({
    where: eq(users.email, email),
  });
  if (existingUser) {
    throw AppError.conflict('An account with this email already exists', 'EMAIL_EXISTS');
  }

  // HIBP breached-password check. Fails open on network error so an
  // HIBP outage doesn't block registration; callers just get the
  // pre-HIBP baseline for that request. Re-checked explicitly on every
  // future password change.
  const breach = await checkPasswordBreached(input.password);
  if (breach.ok && breach.breached) {
    throw AppError.badRequest(
      `This password has appeared in ${breach.count.toLocaleString()} known data breaches and is unsafe to reuse. Pick a different password.`,
      'PASSWORD_BREACHED',
    );
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
    email,
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

// A real bcrypt hash of an empty input. Used to equalize timing when the
// login path gets an email that isn't registered: we still run bcrypt.compare
// so the response time matches the user-exists branch. Without this, an
// attacker can enumerate valid emails by measuring whether a login attempt
// ran bcrypt (~200ms) or returned immediately (~10ms).
const DUMMY_PASSWORD_HASH =
  '$2b$12$CwTycUXWue0Thq9StjUM0uJ8lGwkE1dKtDSpFQNshLQ4uMRGjB3sC';

export async function login(input: LoginInput): Promise<{ user: typeof users.$inferSelect; tokens: AuthTokens; accessibleTenants: any[] }> {
  const MAX_LOGIN_ATTEMPTS = 5;

  const email = normalizeEmail(input.email);
  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  });

  if (!user) {
    // Equalize timing with the user-exists path — always run a bcrypt
    // compare so enumeration via response time isn't possible. Discard
    // the result, fall through to the same error.
    await bcrypt.compare(input.password, DUMMY_PASSWORD_HASH);
    throw AppError.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }

  if (!user.isActive) {
    throw AppError.forbidden(
      'This account has been deactivated. Please contact your administrator.',
      'ACCOUNT_DEACTIVATED',
    );
  }

  // Account lockout — CLOUDFLARE_TUNNEL_PLAN Phase 3.
  // Locked accounts stay locked until a super-admin explicitly
  // unlocks them via POST /admin/users/:id/unlock. Previously the
  // record carried a loginLockedUntil timestamp that auto-released
  // after 15 minutes, which made sustained credential-stuffing free
  // (attacker waits 16 min, tries another 5). Admin-unlock removes
  // that cheap oracle; loginLockedUntil being set (to any date past
  // or future) blocks login.
  if (user.loginLockedUntil) {
    throw AppError.forbidden(
      'This account is locked due to too many failed login attempts. Contact your administrator to unlock it.',
      'ACCOUNT_LOCKED',
    );
  }

  const validPassword = await bcrypt.compare(input.password, user.passwordHash);
  if (!validPassword) {
    const attempts = (user.loginFailedAttempts || 0) + 1;
    // When the threshold is hit, stamp the lockout with "now" as a
    // sentinel — any truthy value means locked. The admin unlock path
    // clears both columns.
    const lockUntil = attempts >= MAX_LOGIN_ATTEMPTS ? new Date() : null;
    await db.update(users)
      .set({ loginFailedAttempts: attempts, loginLockedUntil: lockUntil, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    // Audit the failed attempt so the login-events view is complete.
    // The user's own id is carried as both entityId and userId so the
    // row is attributable even when the attempt is from a third party
    // guessing the email — the audit trail still captures which account
    // was targeted.
    await auditLog(
      user.tenantId,
      'login',
      'user_login_failed',
      user.id,
      null,
      { attempts, locked: !!lockUntil, reason: 'invalid_password' },
      user.id,
    );
    throw AppError.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }

  // Reset failed attempts on successful login
  if (user.loginFailedAttempts && user.loginFailedAttempts > 0) {
    await db.update(users)
      .set({ loginFailedAttempts: 0, loginLockedUntil: null, updatedAt: new Date() })
      .where(eq(users.id, user.id));
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

export async function switchTenant(userId: string, targetTenantId: string, priorRefreshToken?: string): Promise<AuthTokens> {
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

  // Revoke the prior refresh token *and* issue the new one in a single
  // transaction. Previously switchTenant minted a new pair while leaving
  // the old refresh token valid — a compromised browser tab under the old
  // tenant context could keep refreshing long after the user switched.
  await db.transaction(async (tx) => {
    if (priorRefreshToken) {
      await tx.delete(sessions).where(eq(sessions.refreshTokenHash, hashToken(priorRefreshToken)));
    }
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    await tx.insert(sessions).values({
      userId: user.id,
      refreshTokenHash: hashToken(refreshToken),
      expiresAt,
    });
  });

  // Enforce the per-user session cap. The `priorRefreshToken` branch
  // above keeps net count unchanged, but the api-v2 switchTenant path
  // doesn't pass a prior token and would otherwise grow sessions
  // without bound. Running the trim here handles both paths
  // consistently and is idempotent when nothing needs trimming.
  await trimOldestSessions(user.id);

  return { accessToken, refreshToken };
}

/**
 * Drop the oldest active sessions for a user until MAX_SESSIONS_PER_USER
 * remain. Called after any flow that might push the user over the cap.
 * Idempotent — a no-op when the user already has ≤ the cap.
 */
async function trimOldestSessions(userId: string): Promise<void> {
  const active = await db.select({ id: sessions.id, createdAt: sessions.createdAt })
    .from(sessions)
    .where(and(
      eq(sessions.userId, userId),
      sql`${sessions.expiresAt} > NOW()`,
    ))
    .orderBy(asc(sessions.createdAt));

  if (active.length > MAX_SESSIONS_PER_USER) {
    const toDrop = active.slice(0, active.length - MAX_SESSIONS_PER_USER).map((s) => s.id);
    await db.delete(sessions).where(inArray(sessions.id, toDrop));
  }
}

export async function refresh(refreshToken: string): Promise<AuthTokens> {
  const tokenHash = hashToken(refreshToken);

  // Atomic delete-and-return: only the caller that wins the race actually
  // gets the session row. A concurrent second call (e.g., two browser tabs
  // both detecting an expired access token at the same instant) gets an
  // empty result and throws cleanly. This preserves the replay-protection
  // guarantee that refresh-token rotation is supposed to give: any second
  // use of a rotated token is rejected.
  //
  // The previous implementation did findFirst → check → delete → insert
  // as four separate statements, so two tabs could both observe the
  // session, both delete it (one is a no-op), and both mint new tokens.
  // That's fine for usability but breaks replay protection — an attacker
  // who somehow got a copy of the refresh token would be able to use it
  // alongside the legitimate user instead of being detected.
  const [session] = await db.delete(sessions)
    .where(eq(sessions.refreshTokenHash, tokenHash))
    .returning();

  if (!session) {
    throw AppError.unauthorized('Invalid refresh token');
  }

  if (new Date() > session.expiresAt) {
    throw AppError.unauthorized('Refresh token expired');
  }

  // Get user (after we've claimed the session row, so even if user lookup
  // fails the old refresh token is already invalidated)
  const user = await db.query.users.findFirst({
    where: eq(users.id, session.userId),
  });

  if (!user || !user.isActive) {
    throw AppError.unauthorized('User not found or deactivated');
  }

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
  const normalized = normalizeEmail(email);
  const user = await db.query.users.findFirst({
    where: eq(users.email, normalized),
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
  await systemEmail.sendPasswordResetEmail(normalized, rawToken);
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

  // HIBP breached-password check on password-reset too — the reset
  // path is the most common way users set a new password, so blocking
  // here is where the protection actually matters in practice. Fails
  // open on HIBP outage.
  const breach = await checkPasswordBreached(newPassword);
  if (breach.ok && breach.breached) {
    throw AppError.badRequest(
      `This password has appeared in ${breach.count.toLocaleString()} known data breaches and is unsafe to reuse. Pick a different password.`,
      'PASSWORD_BREACHED',
    );
  }

  // Update password
  const passwordHash = await bcrypt.hash(newPassword, env.BCRYPT_ROUNDS);
  await db.update(users).set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, resetRecord.userId));

  // Mark this token as used and purge any other outstanding reset tokens for
  // the user so a stolen reset link can't race the legitimate one.
  await db.update(passwordResetTokens).set({ usedAt: new Date() })
    .where(eq(passwordResetTokens.id, resetRecord.id));
  await db.delete(passwordResetTokens).where(
    and(
      eq(passwordResetTokens.userId, resetRecord.userId),
      sql`${passwordResetTokens.usedAt} IS NULL`,
    ),
  );

  // A password reset is a trust-boundary event: every refresh token that
  // existed before this point must be invalidated, otherwise an attacker
  // who captured a refresh token keeps session access across the reset.
  await db.delete(sessions).where(eq(sessions.userId, resetRecord.userId));
}

export async function inviteUser(tenantId: string, input: { email: string; displayName: string; role: string }): Promise<{ user: typeof users.$inferSelect; temporaryPassword: string | null; existingUser: boolean }> {
  const role = input.role || 'accountant';
  const email = normalizeEmail(input.email);

  // Check if user already exists
  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });

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
    email,
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
