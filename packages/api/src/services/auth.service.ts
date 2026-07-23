// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

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
import { seedDefaultsForNewTenant as seedFeatureFlags } from './feature-flags.service.js';
import { joinApplianceFirm, assignTenantToApplianceFirm } from './firm-provisioning.service.js';

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
  await createSession(payload.userId, refreshToken, { tenantId: payload.tenantId, role: payload.role });
  return { accessToken, refreshToken };
}

async function createSession(
  userId: string,
  refreshToken: string,
  context?: { tenantId?: string | null; role?: string | null },
): Promise<void> {
  // 7 days from now, computed as an exact 7-day offset rather than via
  // `setDate(getDate() + 7)` which is TZ-sensitive during DST transitions.
  // Using millisecond arithmetic gives a true UTC offset regardless of
  // the container's local TZ.
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await db.insert(sessions).values({
    userId,
    refreshTokenHash: hashToken(refreshToken),
    expiresAt,
    // Persist the operating tenant/role so refresh() re-mints the access
    // token against the same context instead of the user's home tenant.
    tenantId: context?.tenantId ?? null,
    role: context?.role ?? null,
  });

  // Running the trim AFTER the insert keeps the new session the most-
  // recent row so a rapid re-login never revokes its own token. Shared
  // with switchTenant's post-transaction path so cap enforcement lives
  // in exactly one place.
  await trimOldestSessions(userId);
}

/** Shared tenant provisioning: tenant row + company + COA seed + feature
 *  flags. Access rows and firm membership are the caller's business —
 *  that's what distinguishes a practice client tenant from a
 *  self-service owned tenant. */
async function provisionTenant(input: { companyName: string; businessType?: string; systemAccountsOnly?: boolean }): Promise<{ tenantId: string; companyId: string; tenantName: string }> {
  const [tenant] = await db.insert(tenants).values({
    name: input.companyName,
    slug: generateSlug(input.companyName),
  }).returning();
  if (!tenant) throw AppError.internal('Failed to create tenant');

  // Create company and seed COA. When systemAccountsOnly is set, seed
  // just the required system accounts (A/R, A/P, Payments Clearing, Sales
  // Tax Payable, Opening Balances, Retained Earnings, Cash) so the tenant
  // still functions, and skip the rest of the business-type template.
  await createCompanyForTenant(tenant.id, input.companyName);
  await seedFromTemplate(tenant.id, input.businessType || 'default', undefined, { systemOnly: !!input.systemAccountsOnly });

  // New-tenant default: Practice flags turned ON. The build plan
  // distinguishes pre-Phase-1 tenants (migration seeds disabled)
  // from freshly-created tenants (all flags on). Called after
  // tenant.id exists but before we return so the caller always
  // sees a fully-configured tenant.
  await seedFeatureFlags(tenant.id);

  // Get the company that was just created
  const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenant.id) });

  // Seed the default JE template(s) (e.g. Monthly Payroll). Lines resolve
  // to the just-seeded chart by account NAME; any not found stay unmapped
  // for staff to pick. Best-effort — a failure here must not abort tenant
  // creation, so swallow and log.
  try {
    const { seedDefaultJeTemplatesForTenant } = await import('./je-templates.seed.js');
    await seedDefaultJeTemplatesForTenant(tenant.id, company?.id);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[auth.service] default JE template seed failed:', err instanceof Error ? err.message : err);
  }

  return { tenantId: tenant.id, companyId: company?.id || '', tenantName: tenant.name };
}

export async function createClientTenant(creatorUserId: string, input: { companyName: string; industry?: string; entityType?: string; businessType?: string; systemAccountsOnly?: boolean }): Promise<{ tenantId: string; companyId: string; tenantName: string }> {
  const provisioned = await provisionTenant(input);
  const tenant = { id: provisioned.tenantId, name: provisioned.tenantName };

  // Give the creator access to this tenant as accountant
  await db.insert(userTenantAccess).values({
    userId: creatorUserId,
    tenantId: tenant.id,
    role: 'accountant',
  }).onConflictDoNothing();

  // Auto-join the appliance firm so the tiered conditional-rules UI
  // resolves for the creator on this tenant. Idempotent. firm_staff,
  // not firm_admin: staff author tenant_firm rules but must not manage
  // the appliance-wide firm (membership, tenant assignments, creds).
  await joinApplianceFirm(tenant.id, creatorUserId, 'firm_staff');

  return provisioned;
}

// ─── Self-service tenant creation (non-firm users) ───────────────

export interface TenantCreationEligibility {
  /** The instance-level toggle (super-admin setting). */
  enabled: boolean;
  /** Whether THIS user may create a tenant right now. */
  allowed: boolean;
  /** Human-readable reason when !allowed. */
  reason?: string;
  /** Active 'owner' tenancies counted against the cap (home tenant included). */
  used: number;
  /** Max owned tenancies; 0 = unlimited. */
  limit: number;
}

export async function getTenantCreationEligibility(userId: string, currentRole: string): Promise<TenantCreationEligibility> {
  // Dynamic import matches the other settings readers in the auth path
  // and avoids a static cycle with the (large) admin service module.
  const { getSetting } = await import('./admin.service.js');
  const { SystemSettingsKeys } = await import('../constants/system-settings-keys.js');

  // Default OFF: only the literal 'true' enables (a new capability must
  // not appear because a row is absent or the DB read degraded).
  const enabled = (await getSetting(SystemSettingsKeys.SELF_SERVICE_TENANT_CREATION)) === 'true';
  const limitRaw = await getSetting(SystemSettingsKeys.SELF_SERVICE_TENANT_LIMIT);
  const parsedLimit = Number.parseInt(limitRaw ?? '', 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit >= 0 ? parsedLimit : 3;

  const owned = await db.select({ id: userTenantAccess.id }).from(userTenantAccess)
    .where(and(
      eq(userTenantAccess.userId, userId),
      eq(userTenantAccess.role, 'owner'),
      eq(userTenantAccess.isActive, true),
    ));
  const used = owned.length;
  const base = { enabled, used, limit };

  if (!enabled) return { ...base, allowed: false, reason: 'Creating additional businesses is disabled by your administrator.' };

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || user.isActive === false) return { ...base, allowed: false, reason: 'Account is not active.' };
  // Portal 'client' accounts and non-owner staff invited into someone
  // else's books don't get to mint tenants; super-admins always may.
  if (user.userType !== 'staff') return { ...base, allowed: false, reason: 'Portal accounts cannot create businesses.' };
  // Ownership gate: the user must OWN at least one active tenancy
  // (anywhere), not merely hold the 'owner' role on the tenant they
  // happen to be switched into right now — an owner browsing a client
  // tenant as bookkeeper must still be able to start a business.
  // `currentRole` deliberately no longer participates in the decision.
  void currentRole;
  if (used === 0 && !user.isSuperAdmin) {
    return { ...base, allowed: false, reason: 'Only a business owner can create a new business.' };
  }
  if (limit !== 0 && used >= limit) {
    return { ...base, allowed: false, reason: `You already own ${used} of ${limit} allowed businesses. Ask your administrator to raise the limit.` };
  }
  return { ...base, allowed: true };
}

/**
 * "New Business (separate books)": a fully-isolated tenant owned by the
 * creator. Unlike createClientTenant: creator role is 'owner' (not
 * accountant) and there is NO appliance-firm join — this is the user's
 * own books, not practice tooling. Gated by the self_service_tenant_*
 * settings; the route relies on THIS check as the security boundary.
 */
export async function createOwnedTenant(creatorUserId: string, currentRole: string, input: { companyName: string; entityType?: string; businessType?: string; systemAccountsOnly?: boolean }): Promise<{ tenantId: string; companyId: string; tenantName: string }> {
  const companyName = input.companyName?.trim();
  if (!companyName) throw AppError.badRequest('companyName is required');

  const eligibility = await getTenantCreationEligibility(creatorUserId, currentRole);
  if (!eligibility.allowed) {
    throw AppError.forbidden(eligibility.reason || 'You are not allowed to create a new business.');
  }

  // NOTE: the cap check above is best-effort against concurrent
  // requests (two simultaneous creates can both pass and overshoot the
  // limit by one) — acceptable for an admin-tunable soft cap; a serialized
  // check would need an advisory lock for a vanishingly rare overshoot.
  const provisioned = await provisionTenant({ ...input, companyName });

  // The access row is what makes the new tenant reachable — if this
  // insert is lost the tenant is orphaned (only a super-admin could see
  // it). provisionTenant's inserts aren't in one transaction with this
  // (its seeding spans services bound to the global db handle), so
  // retry hard and, if we still fail, surface an error naming the
  // tenant so an operator can grant access instead of the user retrying
  // into a pile of orphans.
  let accessErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db.insert(userTenantAccess).values({
        userId: creatorUserId,
        tenantId: provisioned.tenantId,
        role: 'owner',
      }).onConflictDoNothing();
      accessErr = null;
      break;
    } catch (err) {
      accessErr = err;
    }
  }
  if (accessErr) {
    console.error(`[create-tenant] tenant ${provisioned.tenantId} provisioned but owner access insert failed for user ${creatorUserId}:`, accessErr);
    throw AppError.internal(
      `Your business "${provisioned.tenantName}" was created but could not be linked to your account. Do NOT retry — ask your administrator to grant you access (tenant ${provisioned.tenantId}).`,
    );
  }

  return provisioned;
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
  const company = await createCompanyForTenant(tenant.id, input.companyName);
  await seedFromTemplate(tenant.id, input.businessType || 'default');

  // New-tenant Practice flag seed (see createClientTenant above).
  await seedFeatureFlags(tenant.id);

  // Create tenant access record
  await db.insert(userTenantAccess).values({ userId: user.id, tenantId: tenant.id, role: 'owner' });

  // Assign the new tenant to the appliance firm so practice staff can
  // manage it and firm/global rules apply — but do NOT make the
  // self-signup user a firm member. The appliance firm spans every
  // tenant on the box; membership would expose the Practice/Firm
  // surfaces and the firm roster/tenant list to a client.
  await assignTenantToApplianceFirm(tenant.id, user.id);

  // Self-signup owners also become a client-portal contact of their own
  // company. Best-effort: a portal-side failure must not fail the signup
  // (the account and tenant are already committed above).
  if (company) {
    try {
      const { createContact } = await import('./portal-contact.service.js');
      const nameParts = (input.displayName || '').trim().split(/\s+/).filter(Boolean);
      await createContact(tenant.id, {
        email,
        firstName: nameParts[0],
        lastName: nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined,
        companies: [{ companyId: company.id, role: 'owner', financialsAccess: true }],
      }, user.id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[auth.service] portal-contact auto-create on signup failed:', err instanceof Error ? err.message : err);
    }
  }

  // Generate tokens
  const jwtPayload: JwtPayload = { userId: user.id, tenantId: tenant.id, role: user.role, isSuperAdmin: user.isSuperAdmin || false };
  const accessToken = generateAccessToken(jwtPayload);
  const refreshToken = generateRefreshToken();
  await createSession(user.id, refreshToken, { tenantId: tenant.id, role: user.role });

  await auditLog(tenant.id, 'create', 'user', user.id, null, { email: user.email }, user.id);

  return {
    user,
    tokens: { accessToken, refreshToken },
  };
}

export async function getAccessibleTenants(userId: string) {
  const rows = await db.execute(sql`
    SELECT uta.tenant_id, uta.role, uta.is_active, uta.last_accessed_at, t.name as tenant_name
    FROM user_tenant_access uta
    JOIN tenants t ON t.id = uta.tenant_id
    WHERE uta.user_id = ${userId} AND uta.is_active = true
    ORDER BY uta.last_accessed_at DESC NULLS LAST, t.name
  `);
  return (rows.rows as any[]).map((r) => ({
    tenantId: r.tenant_id,
    tenantName: r.tenant_name,
    role: r.role,
    lastAccessedAt: r.last_accessed_at ? new Date(r.last_accessed_at).toISOString() : null,
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
  await createSession(user.id, refreshToken, { tenantId, role });

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
      // Bind the session to the switched-into tenant/role so a later token
      // refresh preserves the switch instead of reverting to the home tenant.
      tenantId: targetTenantId,
      role,
    });
    // Mark this tenant as most-recently-accessed for the switcher's "recent"
    // ordering. No-ops for a super-admin with no explicit access row.
    await tx.update(userTenantAccess)
      .set({ lastAccessedAt: new Date() })
      .where(and(eq(userTenantAccess.userId, userId), eq(userTenantAccess.tenantId, targetTenantId)));
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

  // Preserve the TENANT the session was operating under, so an expired
  // access token refreshed mid-session doesn't silently revert a tenant
  // switch (the root cause of "it switched tenants on me and wiped my
  // inputs"). Pre-migration sessions have no stored context — fall back to
  // the user's home tenant.
  let effectiveTenantId = session.tenantId ?? user.tenantId;

  // SECURITY: the ROLE is always re-derived from CURRENT database state,
  // never from the stored session row. Trusting session.role let a demoted
  // user keep their old role indefinitely — every refresh re-minted (and
  // re-persisted) the stale role. Home tenant → users.role; switched tenant
  // → the (re-verified) userTenantAccess.role.
  let effectiveRole = user.role;

  // If the session is scoped to a non-home tenant, re-verify the user still
  // has active access before re-issuing — revoked access must not keep
  // refreshing into it. Super-admins retain cross-tenant access.
  if (effectiveTenantId !== user.tenantId) {
    const access = await db.query.userTenantAccess.findFirst({
      where: and(eq(userTenantAccess.userId, user.id), eq(userTenantAccess.tenantId, effectiveTenantId)),
    });
    if (access?.isActive) {
      effectiveRole = access.role || user.role;
    } else if (user.isSuperAdmin) {
      // Super-admins keep cross-tenant scope without an access row.
      effectiveRole = session.role ?? user.role;
    } else {
      effectiveTenantId = user.tenantId;
      effectiveRole = user.role;
    }
  }

  const jwtPayload: JwtPayload = { userId: user.id, tenantId: effectiveTenantId, role: effectiveRole, isSuperAdmin: user.isSuperAdmin || false };
  const newAccessToken = generateAccessToken(jwtPayload);
  const newRefreshToken = generateRefreshToken();
  await createSession(user.id, newRefreshToken, { tenantId: effectiveTenantId, role: effectiveRole });

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

export async function inviteUser(tenantId: string, input: { email: string; displayName: string; role: string }, inviterUserId?: string): Promise<{ user: typeof users.$inferSelect; temporaryPassword: string | null; existingUser: boolean }> {
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

    // Send access granted email. Fire-and-forget — failing to send the
    // notification mustn't block the grant. Log so an admin can see if
    // SMTP is broken and follow up with the user manually.
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
    systemEmail.sendAccessGrantedEmail(existing.email, tenant?.name || 'Company').catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`[auth.service] access-granted email to ${existing.email} failed:`, err?.message ?? err);
    });

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

  // Send invite email with temporary credentials. Fire-and-forget but
  // log on failure — temporaryPassword is returned to the caller so the
  // admin can hand it off manually if email isn't reaching the user.
  // The email template reads "<inviterName> has invited you", so resolve
  // the actual inviter — passing the invitee's own name here made the
  // email say "Bob has invited you" to Bob.
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  const inviter = inviterUserId ? await db.query.users.findFirst({ where: eq(users.id, inviterUserId) }) : null;
  const inviterName = inviter?.displayName || inviter?.email || 'An administrator';
  systemEmail.sendInviteEmail(user.email, inviterName, tenant?.name || 'Company', temporaryPassword).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(`[auth.service] invite email to ${user.email} failed:`, err?.message ?? err);
  });

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
