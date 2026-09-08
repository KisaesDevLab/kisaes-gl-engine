// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// "Invite my accountant" routes. Owner side (send / list / resend / revoke)
// is tenant-scoped and owner-gated; staff side (lookup / accept) is any
// authenticated staff-type user — the service decides whether their firm
// membership lets them accept. Secrets always travel in POST bodies.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
import {
  acceptFirmInviteSchema,
  createFirmInviteSchema,
  firmInviteLookupSchema,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { AppError } from '../utils/errors.js';
import { baseUrlFor } from '../utils/base-url.js';
import { getRateLimitStore } from '../utils/rate-limit-store.js';
import { recordSecurityEvent } from '../utils/security-audit.js';
import * as firmInviteService from '../services/firm-invite.service.js';

export const firmInvitesRouter = Router();
firmInvitesRouter.use(authenticate);

// Owner gate. Client-type users get a 404 so the surface is invisible to
// them (same convention as the other staff-only routers); non-owner staff
// get a 403. Super admins pass, mirroring /company/invite-user.
function requireTenantOwner(req: Request, _res: Response, next: NextFunction) {
  if (req.userType === 'client') {
    next(AppError.notFound('Not found'));
    return;
  }
  if (req.userRole !== 'owner' && !req.isSuperAdmin) {
    next(AppError.forbidden('Only the owner can invite an accountant', 'OWNER_REQUIRED'));
    return;
  }
  next();
}

const limitMessage = { error: { message: 'Too many requests, please try again later', code: 'RATE_LIMIT' } };

// Per-tenant send caps: an invite is an outbound email on the owner's
// behalf, so bound it like forgot-password (bursts + daily volume).
const sendHourlyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: getRateLimitStore('firm-invite-send-hour'),
  keyGenerator: (req) => `tenant:${req.tenantId || req.ip || 'unknown'}`,
  message: limitMessage,
});
const sendDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: getRateLimitStore('firm-invite-send-day'),
  keyGenerator: (req) => `tenant:${req.tenantId || req.ip || 'unknown'}`,
  message: limitMessage,
});

// Accept/lookup caps: the 8-char code is 40 bits and acceptance is also
// bound to the recipient address, but bound guessing anyway — per user
// (an account can't spray) and per IP (one box can't cycle accounts).
const acceptUserLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: getRateLimitStore('firm-invite-accept-user'),
  keyGenerator: (req) => `user:${req.userId || req.ip || 'unknown'}`,
  message: limitMessage,
  handler: (req, res, _next, options) => {
    recordSecurityEvent({ component: 'firm_invite', reason: 'accept_rate_limited', details: { userId: req.userId } });
    res.status(options.statusCode).json(options.message);
  },
});
const acceptIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: getRateLimitStore('firm-invite-accept-ip'),
  keyGenerator: (req) => `ip:${req.ip || 'unknown'}`,
  message: limitMessage,
});

// ─── Owner side ──────────────────────────────────────────────────

firmInvitesRouter.post(
  '/',
  requireTenantOwner,
  sendHourlyLimiter,
  sendDailyLimiter,
  validate(createFirmInviteSchema),
  async (req, res) => {
    const result = await firmInviteService.createInvite({
      tenantId: req.tenantId,
      createdBy: req.userId,
      email: req.body.email,
      baseUrl: baseUrlFor(req),
    });
    res.status(201).json(result);
  },
);

firmInvitesRouter.get('/', requireTenantOwner, async (req, res) => {
  res.json(await firmInviteService.listInvites(req.tenantId));
});

firmInvitesRouter.post(
  '/:id/resend',
  requireTenantOwner,
  sendHourlyLimiter,
  sendDailyLimiter,
  async (req, res) => {
    const result = await firmInviteService.resendInvite(req.tenantId, req.params['id']!, req.userId, baseUrlFor(req));
    res.json(result);
  },
);

firmInvitesRouter.post('/:id/revoke', requireTenantOwner, async (req, res) => {
  await firmInviteService.revokeInvite(req.tenantId, req.params['id']!, req.userId);
  res.json({ revoked: true });
});

// ─── Staff side ──────────────────────────────────────────────────

function requireStaffUser(req: Request, _res: Response, next: NextFunction) {
  if (req.userType === 'client') {
    next(AppError.notFound('Not found'));
    return;
  }
  next();
}

firmInvitesRouter.post(
  '/lookup',
  requireStaffUser,
  acceptIpLimiter,
  acceptUserLimiter,
  validate(firmInviteLookupSchema),
  async (req, res) => {
    try {
      res.json(await firmInviteService.preview(req.body, { userId: req.userId }));
    } catch (err) {
      if (err instanceof AppError && err.code === 'INVITE_EMAIL_MISMATCH') {
        recordSecurityEvent({ component: 'firm_invite', reason: 'email_mismatch', details: { userId: req.userId } });
      }
      throw err;
    }
  },
);

firmInvitesRouter.post(
  '/accept',
  requireStaffUser,
  acceptIpLimiter,
  acceptUserLimiter,
  validate(acceptFirmInviteSchema),
  async (req, res) => {
    try {
      const { token, code, firmId } = req.body;
      res.json(await firmInviteService.accept({ token, code }, firmId, { userId: req.userId }));
    } catch (err) {
      if (err instanceof AppError && err.code === 'INVITE_EMAIL_MISMATCH') {
        recordSecurityEvent({ component: 'firm_invite', reason: 'email_mismatch', details: { userId: req.userId } });
      }
      throw err;
    }
  },
);
