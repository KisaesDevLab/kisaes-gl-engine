// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

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
import { resolvedSecure, appendSetCookie } from '../utils/cookie-secure.js';

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

/**
 * Base URL for the emailed magic link: the operator-configured
 * PUBLIC_URL when set, NEVER the request headers on a configured
 * install. The previous X-Forwarded-Host/Host derivation let a spoofed
 * header poison the victim's sign-in email with an attacker host
 * carrying a REAL token (click = account takeover). Header fallback
 * remains for dev installs where PUBLIC_URL is genuinely unset.
 * Exported for tests.
 */
export function resolveEmailBaseUrl(
  headers: Record<string, string | string[] | undefined>,
  protocol: string,
): string {
  const configured = (process.env['PUBLIC_URL'] || '').replace(/\/$/, '');
  if (configured) return configured;
  const proto = (headers['x-forwarded-proto'] as string | undefined) ?? protocol;
  const host = (headers['x-forwarded-host'] as string | undefined) ?? (headers['host'] as string | undefined) ?? '';
  return `${proto}://${host}`;
}

async function resolveTenantId(
  hostHeader: string | undefined,
  tenantSlug: string | undefined,
): Promise<{ tenantId: string | null; viaCustomDomain: boolean }> {
  if (tenantSlug) {
    const t = await db.query.tenants.findFirst({ where: eq(tenants.slug, tenantSlug) });
    return { tenantId: t?.id ?? null, viaCustomDomain: false };
  }
  if (!hostHeader) return { tenantId: null, viaCustomDomain: false };
  const tenantId = await portalAuth.resolveTenantByHost(hostHeader);
  return { tenantId, viaCustomDomain: tenantId !== null };
}

portalAuthRouter.post(
  '/auth/request-link',
  requestLinkLimiter,
  validate(requestLinkSchema),
  async (req, res) => {
    const { email, tenantSlug } = req.body as { email: string; tenantSlug?: string };
    const { tenantId, viaCustomDomain } = await resolveTenantId(req.headers.host, tenantSlug);
    if (!tenantId) {
      // Don't leak which firm a contact belongs to. Always return ok.
      res.json({ ok: true });
      return;
    }

    // When the tenant was resolved via a CONFIGURED custom portal
    // domain, the link must target that domain — it's what the contact
    // is using, and it's allowlisted (resolveTenantByHost only matches
    // hosts stored in portal_settings_per_practice, so this is not the
    // spoofable free-form Host fallback that resolveEmailBaseUrl
    // guards against). Everything else uses the trusted PUBLIC_URL.
    const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol;
    const baseUrl = viaCustomDomain
      ? `${proto}://${req.headers.host}`
      : resolveEmailBaseUrl(req.headers, req.protocol);

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

// Same shape as requestLinkLimiter — verify was the one unthrottled
// public portal endpoint (256-bit tokens make brute force infeasible,
// but there's no reason to leave it uncapped).
const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: getRateLimitStore('portal-auth-verify'),
  message: { error: { message: 'Too many requests. Try again later.' } },
});

portalAuthRouter.post('/auth/verify', verifyLimiter, validate(verifySchema), async (req, res) => {
  const { token } = req.body as { token: string };
  const session = await portalAuth.verifyMagicLink({
    token,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  });

  // Set the session cookie. SameSite=Lax matches the staff cookie pattern;
  // Secure follows resolvedSecure() — honoring COOKIE_SECURE override so
  // the appliance's emergency-access proxy (plain HTTP at port 5171) can
  // operate from a NODE_ENV=production build without silently dropping
  // the cookie. See vibe-mybooks-compatibility-addendum §3.14.4.
  // Clamp Max-Age at 0 — a session whose expiresAt is already in the
  // past (clock skew, regenerated session, fixture quirk) would set a
  // cookie with a negative Max-Age, which browsers treat as
  // "expire immediately" — login would appear to succeed but the very
  // next request would arrive without the cookie.
  const maxAgeSec = Math.max(0, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000));
  const cookieParts = [
    `${PORTAL_SESSION_COOKIE}=${encodeURIComponent(session.sessionToken)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (resolvedSecure()) cookieParts.push('Secure');
  appendSetCookie(res, cookieParts.join('; '));

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
    const { tenantId } = await resolveTenantId(req.headers.host, (req.body as { tenantSlug?: string }).tenantSlug);
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
    // Same cookie shape as the magic-link verify path — see comment
    // there for why we route through resolvedSecure() rather than a
    // hard NODE_ENV check, and why we clamp Max-Age at 0.
    const maxAgeSec = Math.max(0, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000));
    const cookieParts = [
      `${PORTAL_SESSION_COOKIE}=${encodeURIComponent(session.sessionToken)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSec}`,
    ];
    if (resolvedSecure()) cookieParts.push('Secure');
    appendSetCookie(res, cookieParts.join('; '));
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

// PORTAL_IDENTITY_LINKING_V1 — the switcher.
//
// linked-contacts returns the list of sibling firm-contacts an
// identity can switch to. Empty array when the session has no
// identity (unlinked contact, preview session, or flag off) — the
// frontend hides the switcher in that case.
portalAuthRouter.get(
  '/auth/linked-contacts',
  portalAuthenticate,
  async (req, res) => {
    if (!req.portalContact) throw AppError.unauthorized('No portal session');
    if (!req.portalContact.identityId) {
      res.json({ contacts: [] });
      return;
    }
    const { listLinkedContacts } = await import(
      '../services/portal-identity.service.js'
    );
    const contacts = await listLinkedContacts(req.portalContact.identityId);
    res.json({ contacts });
  },
);

// Rate-limit the switch endpoint independently. 30/min per identity
// is comfortable for a human ("oh, wrong firm, switch back") but
// defeats any automated scraping of cross-tenant data by replaying
// the cookie against every contact id.
const switchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: getRateLimitStore('portal-auth-switch'),
  message: { error: { message: 'Too many switch requests. Slow down.' } },
});

const switchSchema = z.object({
  targetContactId: z.string().uuid(),
});

portalAuthRouter.post(
  '/auth/switch',
  switchLimiter,
  portalAuthenticate,
  validate(switchSchema),
  async (req, res) => {
    if (!req.portalContact) throw AppError.unauthorized('No portal session');
    if (req.portalContact.isPreview) {
      // Preview sessions don't carry an identity and must not be
      // able to switch — defense in depth (switchToContact already
      // refuses null-identity sessions).
      throw AppError.forbidden('Action disabled in preview mode', 'PREVIEW_READ_ONLY');
    }
    const cookieHeader = req.headers.cookie ?? '';
    const match = cookieHeader
      .split(';')
      .map((s) => s.trim())
      .find((c) => c.startsWith(`${PORTAL_SESSION_COOKIE}=`));
    const currentToken = match
      ? decodeURIComponent(match.slice(PORTAL_SESSION_COOKIE.length + 1))
      : '';
    if (!currentToken) throw AppError.unauthorized('No portal session', 'NO_SESSION');

    const session = await portalAuth.switchToContact({
      currentSessionToken: currentToken,
      targetContactId: (req.body as { targetContactId: string }).targetContactId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Rotate the cookie. Same shape as verify/password-login — keep
    // the three paths consistent so the cookie semantics live in one
    // place mentally.
    const maxAgeSec = Math.max(0, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000));
    const cookieParts = [
      `${PORTAL_SESSION_COOKIE}=${encodeURIComponent(session.sessionToken)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSec}`,
    ];
    if (resolvedSecure()) cookieParts.push('Secure');
    appendSetCookie(res, cookieParts.join('; '));

    res.json({
      ok: true,
      contactId: session.contactId,
      tenantId: session.tenantId,
      expiresAt: session.expiresAt.toISOString(),
      companies: session.companies,
    });
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
  appendSetCookie(
    res,
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
