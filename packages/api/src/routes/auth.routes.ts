// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { loginSchema, registerSchema, forgotPasswordSchema, resetPasswordSchema, updatePreferencesSchema } from '@kis-books/shared';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import * as authService from '../services/auth.service.js';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import rateLimit from 'express-rate-limit';
import { setRefreshCookie, clearRefreshCookie, readRefreshCookie } from '../utils/refresh-cookie.js';
import { requireTurnstile } from '../utils/turnstile.js';
import { getRateLimitStore } from '../utils/rate-limit-store.js';

// Per-IP limiter — the existing loose bound (10 requests / minute from
// the same IP across any auth endpoint). Redis-backed when
// RATE_LIMIT_REDIS=1 so counters survive a container restart; falls
// back to in-memory otherwise.
const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  store: getRateLimitStore('auth'),
  message: { error: { message: 'Too many requests, please try again later', code: 'RATE_LIMIT' } },
});

// Per-account login limiter — see CLOUDFLARE_TUNNEL_PLAN Phase 5.
// Caps the number of login attempts against a single email address to
// 10 in 15 minutes, regardless of how many source IPs they come from.
// Blocks the "spray attack" pattern where a credential-stuffing tool
// rotates through residential proxies to stay under the per-IP bound
// while hammering the same target account. Keyed by normalized email
// from the JSON body; requests without an email fall through to the
// per-IP limiter alone.
const loginAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: getRateLimitStore('login-account'),
  keyGenerator: (req) => {
    const email = (req.body && typeof req.body === 'object' && 'email' in req.body
      ? String((req.body as { email?: string }).email || '')
      : ''
    ).trim().toLowerCase();
    // Prefix so the email namespace can't collide with the IP-keyed
    // limiters sharing the same in-memory store.
    return email ? `account:${email}` : `ip:${req.ip || 'unknown'}`;
  },
  message: {
    error: {
      message: 'Too many login attempts for this account. Wait 15 minutes or use password recovery.',
      code: 'ACCOUNT_RATE_LIMIT',
    },
  },
});

// Per-email forgot-password limiter. Pairs with the per-IP authLimiter
// to stop an attacker rotating residential proxies from triggering a
// mailbox full of reset links for a single victim. Cap is 5 requests
// per hour per email; the existing authLimiter (10/min/IP) catches the
// volumetric case, this one catches the per-victim case.
const forgotPasswordEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: getRateLimitStore('forgot-password-email'),
  keyGenerator: (req) => {
    const email = (req.body && typeof req.body === 'object' && 'email' in req.body
      ? String((req.body as { email?: string }).email || '')
      : ''
    ).trim().toLowerCase();
    return email ? `email:${email}` : `ip:${req.ip || 'unknown'}`;
  },
  message: {
    error: {
      message: 'Too many password reset requests for this email. Try again later.',
      code: 'FORGOT_PASSWORD_RATE_LIMIT',
    },
  },
});

export const authRouter = Router();

authRouter.post('/register', authLimiter, requireTurnstile(), validate(registerSchema), async (req, res) => {
  const result = await authService.register(req.body);
  setRefreshCookie(res, result.tokens.refreshToken);
  res.status(201).json({
    user: sanitizeUser(result.user),
    tokens: { accessToken: result.tokens.accessToken },
  });
});

authRouter.post('/login', authLimiter, loginAccountLimiter, requireTurnstile(), validate(loginSchema), async (req, res) => {
  const result = await authService.login(req.body);

  // Check if 2FA is required
  const tfaService = await import('../services/tfa.service.js');
  const tfaCheck = await tfaService.checkTfaRequired(result.user.id, req.body.deviceFingerprint);

  if (tfaCheck.required) {
    // Don't issue real tokens — return a short-lived tfa_token instead
    const tfaToken = tfaService.generateTfaToken(result.user.id);
    res.json({
      tfa_required: true,
      tfa_token: tfaToken,
      available_methods: tfaCheck.methods,
      preferred_method: tfaCheck.preferredMethod,
      phone_masked: tfaCheck.phoneMasked,
      email_masked: tfaCheck.emailMasked,
    });
    return;
  }

  setRefreshCookie(res, result.tokens.refreshToken);
  res.json({
    user: sanitizeUser(result.user),
    tokens: { accessToken: result.tokens.accessToken },
    accessibleTenants: result.accessibleTenants,
  });
});

// ─── 2FA Verification (during login) ────────────────────────────

authRouter.post('/tfa/verify', authLimiter, async (req, res) => {
  const tfaService = await import('../services/tfa.service.js');
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: { message: 'Missing TFA token' } }); return;
  }

  const payload = tfaService.verifyTfaToken(authHeader.slice(7));
  if (!payload) {
    res.status(401).json({ error: { message: 'Invalid or expired TFA token' } }); return;
  }

  const { code, method, trustDevice, deviceFingerprint } = req.body;

  const result = await tfaService.verifyCode(payload.userId, code, method);
  if (!result.valid) {
    res.status(400).json({
      error: {
        message: result.lockedUntil ? 'Account temporarily locked' : 'Invalid code',
        remaining_attempts: result.remainingAttempts,
        locked_until: result.lockedUntil,
      },
    });
    return;
  }

  // Trust device if requested
  if (trustDevice && deviceFingerprint) {
    await tfaService.trustDevice(payload.userId, deviceFingerprint, req.headers['user-agent'] || '', req.ip || '');
  }

  // Issue real tokens via the shared helper — this is what enforces
  // MAX_SESSIONS_PER_USER and reads JWT_ACCESS_EXPIRY from env. The
  // prior inline db.insert(sessions) path bypassed both.
  const user = await authService.getMe(payload.userId);
  const accessibleTenants = await authService.getAccessibleTenants(payload.userId);

  const { accessToken, refreshToken } = await authService.issueSession({
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    isSuperAdmin: user.isSuperAdmin || false,
  });

  setRefreshCookie(res, refreshToken);
  res.json({
    user: sanitizeUser(user),
    tokens: { accessToken },
    accessibleTenants,
  });
});

authRouter.post('/tfa/send-code', authLimiter, async (req, res) => {
  const tfaService = await import('../services/tfa.service.js');
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: { message: 'Missing TFA token' } }); return;
  }
  const payload = tfaService.verifyTfaToken(authHeader.slice(7));
  if (!payload) {
    res.status(401).json({ error: { message: 'Invalid or expired TFA token' } }); return;
  }

  const result = await tfaService.generateAndSendCode(payload.userId, req.body.method);
  res.json({ sent: true, ...result });
});

authRouter.post('/tfa/verify-recovery', authLimiter, async (req, res) => {
  const tfaService = await import('../services/tfa.service.js');
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: { message: 'Missing TFA token' } }); return;
  }
  const payload = tfaService.verifyTfaToken(authHeader.slice(7));
  if (!payload) {
    res.status(401).json({ error: { message: 'Invalid or expired TFA token' } }); return;
  }

  const ok = await tfaService.verifyRecoveryCode(payload.userId, req.body.code);
  if (!ok) {
    res.status(400).json({ error: { message: 'Invalid recovery code' } }); return;
  }

  // Issue real tokens via the shared helper (same as tfa/verify success path).
  const user = await authService.getMe(payload.userId);
  const accessibleTenants = await authService.getAccessibleTenants(payload.userId);
  const { accessToken, refreshToken } = await authService.issueSession({
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    isSuperAdmin: user.isSuperAdmin || false,
  });

  setRefreshCookie(res, refreshToken);
  res.json({
    user: sanitizeUser(user),
    tokens: { accessToken },
    accessibleTenants,
  });
});

authRouter.post('/refresh', async (req, res) => {
  // Refresh token lives in an HttpOnly cookie so it's never exposed to page
  // scripts. We still accept body.refreshToken as a deprecated path for
  // older clients that predated the cookie; once the web bundle is updated
  // this branch goes unused and can be removed.
  const fromCookie = readRefreshCookie(req);
  const fromBody = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : undefined;
  const refreshToken = fromCookie || fromBody;
  if (!refreshToken) {
    res.status(401).json({ error: { message: 'Missing refresh token' } });
    return;
  }
  const tokens = await authService.refresh(refreshToken);
  setRefreshCookie(res, tokens.refreshToken);
  res.json({ tokens: { accessToken: tokens.accessToken } });
});

authRouter.post('/logout', async (req, res) => {
  const refreshToken = readRefreshCookie(req) || req.body?.refreshToken;
  if (refreshToken) {
    await authService.logout(refreshToken);
  }
  clearRefreshCookie(res);
  res.json({ message: 'Logged out' });
});

authRouter.post('/forgot-password', authLimiter, forgotPasswordEmailLimiter, requireTurnstile(), validate(forgotPasswordSchema), async (req, res) => {
  await authService.forgotPassword(req.body.email);
  res.json({ message: 'If an account exists with that email, a reset link has been sent' });
});

authRouter.post('/reset-password', authLimiter, validate(resetPasswordSchema), async (req, res) => {
  await authService.resetPassword(req.body.token, req.body.newPassword);
  res.json({ message: 'Password has been reset' });
});

authRouter.get('/me', authenticate, async (req, res) => {
  const user = await authService.getMe(req.userId);
  const companyService = await import('../services/company.service.js');
  const companiesList = await companyService.listCompanies(req.tenantId, req.userId);
  const accessibleTenants = await authService.getAccessibleTenants(req.userId);
  const adminService = await import('../services/admin.service.js');
  const branding = await adminService.getBranding();
  res.json({
    user: sanitizeUser(user),
    companies: companiesList,
    accessibleTenants,
    activeTenantId: req.tenantId,
    branding,
  });
});

authRouter.post('/switch-tenant', authenticate, async (req, res) => {
  // Pass the current refresh cookie so switchTenant can atomically revoke
  // the pre-switch session when it mints the new one. Stops a compromised
  // token under the old tenant context from staying valid post-switch.
  const prior = readRefreshCookie(req);
  const tokens = await authService.switchTenant(req.userId, req.body.tenantId, prior);
  setRefreshCookie(res, tokens.refreshToken);
  res.json({ tokens: { accessToken: tokens.accessToken } });
});

authRouter.post('/create-client', authenticate, async (req, res) => {
  // Only accountants, bookkeepers, and super admins can create client tenants
  if (req.userRole !== 'accountant' && req.userRole !== 'bookkeeper' && !req.isSuperAdmin) {
    res.status(403).json({ error: { message: 'Only accountants and super admins can create client companies' } });
    return;
  }
  const result = await authService.createClientTenant(req.userId, req.body);
  res.status(201).json(result);
});

authRouter.put('/me/preferences', authenticate, validate(updatePreferencesSchema), async (req, res) => {
  const user = await authService.getMe(req.userId);
  const currentPrefs = (user.displayPreferences as Record<string, unknown>) || { fontScale: 1, theme: 'system' };
  const merged = { ...currentPrefs, ...req.body };

  await db.update(users).set({ displayPreferences: merged }).where(eq(users.id, req.userId));
  res.json({ displayPreferences: merged });
});

function sanitizeUser(user: { id: string; tenantId: string; email: string; displayName: string | null; role: string; isActive: boolean | null; isSuperAdmin: boolean | null; lastLoginAt: Date | null; displayPreferences: unknown; createdAt: Date | null; updatedAt: Date | null }) {
  return {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    isActive: user.isActive,
    isSuperAdmin: user.isSuperAdmin || false,
    lastLoginAt: user.lastLoginAt,
    displayPreferences: user.displayPreferences || { fontScale: 1, theme: 'system' },
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
