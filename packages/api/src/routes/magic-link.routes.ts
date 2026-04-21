// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as magicLinkService from '../services/magic-link.service.js';
import * as tfaService from '../services/tfa.service.js';
import * as authService from '../services/auth.service.js';
import { setRefreshCookie } from '../utils/refresh-cookie.js';

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: { message: 'Too many requests, please try again later', code: 'RATE_LIMIT' } },
});

export const magicLinkRouter = Router();

// ─── Send Magic Link ───────────────────────────────────────────

magicLinkRouter.post('/send', authLimiter, async (req, res) => {
  const result = await magicLinkService.sendMagicLink(
    req.body.email,
    req.ip || '',
    req.headers['user-agent'] || '',
  );
  res.json(result);
});

// ─── Verify Magic Link Token ───────────────────────────────────

magicLinkRouter.get('/verify', authLimiter, async (req, res) => {
  const token = req.query['token'] as string;
  if (!token) { res.status(400).json({ error: { message: 'Token is required' } }); return; }

  const result = await magicLinkService.verifyMagicLink(token);
  res.json(result);
});

// ─── Complete Login with 2FA after Magic Link ──────────────────

magicLinkRouter.post('/tfa/verify', authLimiter, async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: { message: 'Missing TFA token' } }); return;
  }

  const payload = tfaService.verifyTfaToken(authHeader.slice(7));
  if (!payload) {
    res.status(401).json({ error: { message: 'Invalid or expired token' } }); return;
  }

  const { code, method } = req.body;

  // Enforce non-email 2FA only (magic link already proves email)
  if (method === 'email') {
    res.status(400).json({ error: { message: 'Email verification is not available for magic link login. Use your authenticator app or SMS.' } });
    return;
  }

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

  // Issue real tokens via the shared helper — enforces MAX_SESSIONS_PER_USER
  // and reads JWT_ACCESS_EXPIRY. The prior inline insert bypassed both.
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
    user: {
      id: user.id, tenantId: user.tenantId, email: user.email,
      displayName: user.displayName, role: user.role, isActive: user.isActive,
      isSuperAdmin: user.isSuperAdmin || false, lastLoginAt: user.lastLoginAt,
      displayPreferences: user.displayPreferences,
      createdAt: user.createdAt, updatedAt: user.updatedAt,
    },
    tokens: { accessToken },
    accessibleTenants,
  });
});
