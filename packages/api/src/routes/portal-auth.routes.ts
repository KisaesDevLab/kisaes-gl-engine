// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants } from '../db/schema/index.js';
import { validate } from '../middleware/validate.js';
import { portalAuthenticate, PORTAL_SESSION_COOKIE } from '../middleware/portal-auth.js';
import { AppError } from '../utils/errors.js';
import * as portalAuth from '../services/portal-auth.service.js';
import * as contactSvc from '../services/portal-contact.service.js';
import { getRateLimitStore } from '../utils/rate-limit-store.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 9 — portal-side auth
// endpoints. Mounted at /api/portal/auth/* (note the lack of /v1 —
// this is the portal namespace, distinct from the firm app's API).

export const portalAuthRouter = Router();

// 9.2 — server-side rate limit (in addition to the per-email cap inside
// requestMagicLink). Protects against bot floods on the public endpoint.
const requestLinkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: getRateLimitStore('portal-auth-request'),
  message: { error: { message: 'Too many requests. Try again later.' } },
});

const requestLinkSchema = z.object({
  email: z.string().email().max(320),
  // Either tenantSlug (when the portal is reached via the firm's app URL
  // and the contact picks the firm explicitly) or omitted (when the host
  // header maps to a custom domain in portal_settings_per_practice).
  tenantSlug: z.string().min(1).max(100).optional(),
});

async function resolveTenantId(
  hostHeader: string | undefined,
  tenantSlug: string | undefined,
): Promise<string | null> {
  if (tenantSlug) {
    const t = await db.query.tenants.findFirst({ where: eq(tenants.slug, tenantSlug) });
    return t?.id ?? null;
  }
  if (!hostHeader) return null;
  return portalAuth.resolveTenantByHost(hostHeader);
}

portalAuthRouter.post(
  '/auth/request-link',
  requestLinkLimiter,
  validate(requestLinkSchema),
  async (req, res) => {
    const { email, tenantSlug } = req.body as { email: string; tenantSlug?: string };
    const tenantId = await resolveTenantId(req.headers.host, tenantSlug);
    if (!tenantId) {
      // Don't leak which firm a contact belongs to. Always return ok.
      res.json({ ok: true });
      return;
    }

    // Best-effort base URL: prefer X-Forwarded-Proto+Host (CF Tunnel)
    // then the request's protocol+host.
    const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol;
    const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? '';
    const baseUrl = `${proto}://${host}`;

    await portalAuth.requestMagicLink({
      tenantId,
      email,
      baseUrl,
      ipAddress: req.ip,
    });
    res.json({ ok: true });
  },
);

const verifySchema = z.object({
  token: z.string().min(16).max(200),
});

portalAuthRouter.post('/auth/verify', validate(verifySchema), async (req, res) => {
  const { token } = req.body as { token: string };
  const session = await portalAuth.verifyMagicLink({
    token,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  });

  // Set the session cookie. SameSite=Lax matches the staff cookie pattern;
  // Secure is enabled in production but skipped in dev/HTTP.
  const isProd = process.env['NODE_ENV'] === 'production';
  const cookieParts = [
    `${PORTAL_SESSION_COOKIE}=${encodeURIComponent(session.sessionToken)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor((session.expiresAt.getTime() - Date.now()) / 1000)}`,
  ];
  if (isProd) cookieParts.push('Secure');
  res.setHeader('Set-Cookie', cookieParts.join('; '));

  res.json({
    ok: true,
    contactId: session.contactId,
    expiresAt: session.expiresAt.toISOString(),
    companies: session.companies,
  });
});

// 9.4 — password sign-in alternate flow. Same cookie shape as
// magic-link verify so the rest of the portal is unaware of the
// auth method.
const passwordLoginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
  tenantSlug: z.string().min(1).max(100).optional(),
});

portalAuthRouter.post(
  '/auth/password-login',
  requestLinkLimiter,
  validate(passwordLoginSchema),
  async (req, res) => {
    const tenantId = await resolveTenantId(req.headers.host, (req.body as { tenantSlug?: string }).tenantSlug);
    if (!tenantId) {
      // Same response shape as success when tenant unknown so we don't
      // leak directory info — except no Set-Cookie, so the call still
      // fails on the client side.
      throw AppError.unauthorized('Invalid email or password', 'INVALID_CREDS');
    }
    const session = await portalAuth.loginWithPassword({
      tenantId,
      email: (req.body as { email: string }).email,
      password: (req.body as { password: string }).password,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    const isProd = process.env['NODE_ENV'] === 'production';
    const cookieParts = [
      `${PORTAL_SESSION_COOKIE}=${encodeURIComponent(session.sessionToken)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor((session.expiresAt.getTime() - Date.now()) / 1000)}`,
    ];
    if (isProd) cookieParts.push('Secure');
    res.setHeader('Set-Cookie', cookieParts.join('; '));
    res.json({
      ok: true,
      contactId: session.contactId,
      expiresAt: session.expiresAt.toISOString(),
      companies: session.companies,
    });
  },
);

// 9.4 — set or rotate password (must already be signed in).
const setPasswordSchema = z.object({ password: z.string().min(8).max(200) });
portalAuthRouter.post(
  '/auth/set-password',
  portalAuthenticate,
  validate(setPasswordSchema),
  async (req, res) => {
    if (!req.portalContact) throw AppError.unauthorized('No portal session');
    if (req.portalContact.isPreview) {
      throw AppError.forbidden('Action disabled in preview mode', 'PREVIEW_READ_ONLY');
    }
    await portalAuth.setPassword(req.portalContact.contactId, (req.body as { password: string }).password);
    res.json({ ok: true });
  },
);

portalAuthRouter.post('/auth/logout', async (req, res) => {
  const cookieHeader = req.headers.cookie ?? '';
  const match = cookieHeader
    .split(';')
    .map((s) => s.trim())
    .find((c) => c.startsWith(`${PORTAL_SESSION_COOKIE}=`));
  const token = match ? decodeURIComponent(match.slice(PORTAL_SESSION_COOKIE.length + 1)) : '';
  await portalAuth.logout(token);
  res.setHeader(
    'Set-Cookie',
    `${PORTAL_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
  res.json({ ok: true });
});

// Portal "me" — returns the current contact + companies. The portal
// shell calls this on every page load to hydrate the layout.
portalAuthRouter.get('/me', portalAuthenticate, async (req, res) => {
  if (!req.portalContact) throw AppError.unauthorized('No portal session');
  const contact = await contactSvc.getContact(req.portalContact.tenantId, req.portalContact.contactId);
  // 8.4 — if a preview is active, restrict the company list to the
  // single companyId the preview was initiated for. Prevents the
  // banner switcher from leaking other clients' names.
  const visibleCompanies = req.portalContact.isPreview && req.portalContact.previewCompanyId
    ? contact.companies.filter((c) => c.companyId === req.portalContact!.previewCompanyId)
    : contact.companies;
  res.json({
    contact: {
      id: contact.id,
      email: contact.email,
      firstName: contact.firstName,
      lastName: contact.lastName,
      companies: visibleCompanies,
    },
    preview: req.portalContact.isPreview
      ? {
          isPreview: true,
          previewSessionId: req.portalContact.previewSessionId,
          companyId: req.portalContact.previewCompanyId,
        }
      : null,
  });
});
