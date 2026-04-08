import { Router } from 'express';
import { loginSchema, registerSchema, forgotPasswordSchema, resetPasswordSchema, refreshTokenSchema, updatePreferencesSchema } from '@kis-books/shared';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import * as authService from '../services/auth.service.js';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import rateLimit from 'express-rate-limit';

const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: { error: { message: 'Too many requests, please try again later', code: 'RATE_LIMIT' } },
});

export const authRouter = Router();

authRouter.post('/register', authLimiter, validate(registerSchema), async (req, res) => {
  const result = await authService.register(req.body);
  res.status(201).json({
    user: sanitizeUser(result.user),
    tokens: result.tokens,
  });
});

authRouter.post('/login', authLimiter, validate(loginSchema), async (req, res) => {
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

  res.json({
    user: sanitizeUser(result.user),
    tokens: result.tokens,
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

  // Issue real tokens
  const user = await authService.getMe(payload.userId);
  const accessibleTenants = await authService.getAccessibleTenants(payload.userId);
  const activeTenant = accessibleTenants[0];

  const jwt = await import('jsonwebtoken');
  const { env } = await import('../config/env.js');
  const accessToken = jwt.default.sign(
    { userId: user.id, tenantId: user.tenantId, role: user.role, isSuperAdmin: user.isSuperAdmin || false },
    env.JWT_SECRET, { expiresIn: 900 },
  );
  const crypto = await import('crypto');
  const refreshToken = crypto.default.randomBytes(48).toString('hex');
  const refreshHash = crypto.default.createHash('sha256').update(refreshToken).digest('hex');
  const { sessions } = await import('../db/schema/index.js');
  const { db } = await import('../db/index.js');
  const expiresAt = new Date(); expiresAt.setDate(expiresAt.getDate() + 7);
  await db.insert(sessions).values({ userId: user.id, refreshTokenHash: refreshHash, expiresAt });

  res.json({
    user: sanitizeUser(user),
    tokens: { accessToken, refreshToken },
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

  // Issue real tokens (same as tfa/verify success path)
  const user = await authService.getMe(payload.userId);
  const accessibleTenants = await authService.getAccessibleTenants(payload.userId);
  const jwt = await import('jsonwebtoken');
  const { env } = await import('../config/env.js');
  const accessToken = jwt.default.sign(
    { userId: user.id, tenantId: user.tenantId, role: user.role, isSuperAdmin: user.isSuperAdmin || false },
    env.JWT_SECRET, { expiresIn: 900 },
  );
  const crypto = await import('crypto');
  const refreshToken = crypto.default.randomBytes(48).toString('hex');
  const refreshHash = crypto.default.createHash('sha256').update(refreshToken).digest('hex');
  const { sessions } = await import('../db/schema/index.js');
  const { db } = await import('../db/index.js');
  const expiresAt = new Date(); expiresAt.setDate(expiresAt.getDate() + 7);
  await db.insert(sessions).values({ userId: user.id, refreshTokenHash: refreshHash, expiresAt });

  res.json({
    user: sanitizeUser(user),
    tokens: { accessToken, refreshToken },
    accessibleTenants,
  });
});

authRouter.post('/refresh', validate(refreshTokenSchema), async (req, res) => {
  const tokens = await authService.refresh(req.body.refreshToken);
  res.json({ tokens });
});

authRouter.post('/logout', async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    await authService.logout(refreshToken);
  }
  res.json({ message: 'Logged out' });
});

authRouter.post('/forgot-password', authLimiter, validate(forgotPasswordSchema), async (req, res) => {
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
  const tokens = await authService.switchTenant(req.userId, req.body.tenantId);
  res.json({ tokens });
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
