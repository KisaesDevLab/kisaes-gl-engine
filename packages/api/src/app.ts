// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { errorHandler } from './middleware/error-handler.js';
import { authRouter } from './routes/auth.routes.js';
import { companyRouter } from './routes/company.routes.js';
import { accountsRouter } from './routes/accounts.routes.js';
import { contactsRouter } from './routes/contacts.routes.js';
import { transactionsRouter } from './routes/transactions.routes.js';
import { invoicesRouter } from './routes/invoices.routes.js';
import { billsRouter } from './routes/bills.routes.js';
import { vendorCreditsRouter } from './routes/vendor-credits.routes.js';
import { billPaymentsRouter } from './routes/bill-payments.routes.js';
import { estimatesRouter } from './routes/estimates.routes.js';
import { tagsRouter } from './routes/tags.routes.js';
import { reportsRouter } from './routes/reports.routes.js';
import { bankingRouter } from './routes/banking.routes.js';
import { dashboardRouter } from './routes/dashboard.routes.js';
import { attachmentsRouter } from './routes/attachments.routes.js';
import { recurringRouter } from './routes/recurring.routes.js';
import { batchRouter } from './routes/batch.routes.js';
import { itemsRouter } from './routes/items.routes.js';
import { paymentsRouter } from './routes/payments.routes.js';
import { checksRouter } from './routes/checks.routes.js';
import { bankRulesRouter } from './routes/bank-rules.routes.js';
import { duplicatesRouter } from './routes/duplicates.routes.js';
import { budgetsRouter } from './routes/budgets.routes.js';
import { backupRouter } from './routes/backup.routes.js';
import { tenantExportRouter } from './routes/tenant-export.routes.js';
import { remoteBackupRouter } from './routes/remote-backup.routes.js';
import { exportRouter } from './routes/export.routes.js';
import { downloadsRouter } from './routes/downloads.routes.js';
import { auditRouter } from './routes/audit.routes.js';
import { adminRouter } from './routes/admin.routes.js';
import { apiKeysRouter } from './routes/api-keys.routes.js';
import { tenantSettingsRouter } from './routes/tenant-settings.routes.js';
import { tailscaleRouter } from './routes/tailscale.routes.js';
import { authenticate, requireSuperAdmin } from './middleware/auth.js';
import { apiV2Router } from './routes/api-v2.routes.js';
import { tfaRouter } from './routes/tfa.routes.js';
import { passkeyRouter } from './routes/passkey.routes.js';
import { magicLinkRouter } from './routes/magic-link.routes.js';
import { plaidRouter } from './routes/plaid.routes.js';
import { aiRouter } from './routes/ai.routes.js';
import { chatRouter } from './routes/chat.routes.js';
import { oauthRouter } from './routes/oauth.routes.js';
import { storageRouter } from './routes/storage.routes.js';
import { payrollImportRouter } from './routes/payroll-import.routes.js';
import { knowledgeRouter } from './routes/knowledge.routes.js';
import { featureFlagsRouter, adminFeatureFlagsRouter } from './routes/feature-flags.routes.js';
import { practiceClassificationRouter } from './routes/practice-classification.routes.js';
import { practiceSettingsRouter } from './routes/practice-settings.routes.js';
import { matchActionsRouter } from './routes/match-actions.routes.js';
import { conditionalRulesRouter } from './routes/conditional-rules.routes.js';
import { firmsRouter } from './routes/firms.routes.js';
import { reviewChecksRouter } from './routes/review-checks.routes.js';
import { portalContactsRouter } from './routes/portal-contacts.routes.js';
import { portalAuthRouter } from './routes/portal-auth.routes.js';
import { portalQuestionsRouter } from './routes/portal-questions.routes.js';
import { portalQuestionsPublicRouter } from './routes/portal-questions-public.routes.js';
import { portalFinancialsPublicRouter } from './routes/portal-financials-public.routes.js';
import { portalRemindersRouter } from './routes/portal-reminders.routes.js';
import { portalTrackingRouter } from './routes/portal-tracking.routes.js';
import { portal1099Router } from './routes/portal-1099.routes.js';
import { portalReportsRouter } from './routes/portal-reports.routes.js';
import { portalReceiptsRouter } from './routes/portal-receipts.routes.js';
import { portalReceiptsPublicRouter } from './routes/portal-receipts-public.routes.js';
import { portalW9PublicRouter } from './routes/portal-w9-public.routes.js';
import { recurringDocRequestsRouter } from './routes/recurring-doc-requests.routes.js';
import { portalDocumentRequestsPublicRouter } from './routes/portal-document-requests-public.routes.js';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './swagger.js';

export const app = express();

// Middleware
// Helmet defaults are tuned for HTTPS public sites. Vibe MyBooks is a
// self-hosted appliance that operators typically reach over plain HTTP
// on a LAN IP (e.g. http://192.168.1.10:3001), and two of helmet's
// defaults break that access mode:
//
//   1. The CSP directive `upgrade-insecure-requests` tells modern
//      Chromium browsers to rewrite every subresource URL from http://
//      to https://. When the page itself is loaded from a LAN IP with
//      no TLS, the JS/CSS bundle requests get silently upgraded, the
//      server can't answer them, and the user sees a blank white page.
//      Localhost is exempt (it's a "potentially trustworthy" origin in
//      the Secure Contexts spec) so the issue only appears on LAN.
//
//   2. Inline scripts in dist/index.html (the crypto.randomUUID shim for
//      insecure contexts and the pre-paint theme resolver that prevents
//      a dark/light flash) are blocked by `script-src 'self'`. The
//      crypto shim is belt-and-suspenders (the module import in
//      main.tsx also runs a polyfill), but the theme resolver has to
//      run before the bundle to avoid the flash. Hash-allowlisting the
//      two inline scripts is fragile across rebuilds — the app is a
//      first-party appliance, not a site that renders third-party
//      content, so 'unsafe-inline' is an acceptable tradeoff here.
//
// If the operator fronts the appliance with an HTTPS reverse proxy,
// the proxy can add its own HSTS / upgrade-insecure-requests headers.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'upgrade-insecure-requests': null,
        'script-src': ["'self'", "'unsafe-inline'"],
      },
    },
  }),
);
// CORS accepts a comma-separated list so the same appliance can be
// reached under multiple origins — typically the mDNS hostname
// (http://mb.kisaes.local) plus an IP:port fallback
// (http://192.168.68.100:3081) for Windows clients whose Chrome/Edge
// Secure DNS or Firefox DoH bypass the mDNS resolver. A single value
// keeps working unchanged. Entries in `/pattern/flags` form are
// compiled as regex (used by the appliance overlay to admit any
// `*.firm.com` host without listing each one).
import { buildOriginAllowlist } from './utils/cors-allowlist.js';
const originAllowlist = buildOriginAllowlist(env.CORS_ORIGIN);
app.use(
  cors({
    origin: (origin, cb) => {
      // Same-origin fetches, curl, and server-to-server traffic arrive
      // without an Origin header — always allow. Browsers send Origin
      // on every cross-origin request so we get the security check we
      // want without blocking first-party calls.
      if (!origin) return cb(null, true);
      cb(null, originAllowlist.matches(origin));
    },
    credentials: true,
  }),
);

// Trust-proxy configuration.
//
// Security-sensitive: `req.ip`, `req.protocol`, and `req.headers.host`
// are all read from X-Forwarded-* when trust proxy is enabled. Every
// consumer of these (rate limiters, staff IP allowlist, Stripe IP
// allowlist, baseUrlFor) makes authorization or URL-construction
// decisions based on them. Blanket `trust proxy: true` without a real
// proxy in front of the appliance lets an attacker spoof the headers
// and trivially bypass those checks.
//
// Defaults to `'loopback'` (only 127.0.0.0/8, ::1, fc00::/7 — safe for
// direct-exposure installs). Operators behind a reverse proxy or the
// Cloudflare Tunnel sidecar should set TRUST_PROXY=true (or a CIDR
// list like `"10.0.0.0/8,cloudflared"`). The Cloudflare Tunnel setup
// guide calls this out — without TRUST_PROXY=true, the tunnel's
// X-Forwarded-For header is ignored and every request appears to
// come from the cloudflared sidecar's internal IP.
const trustProxyRaw = process.env['TRUST_PROXY'];
if (!trustProxyRaw) {
  app.set('trust proxy', 'loopback');
} else if (trustProxyRaw === 'true' || trustProxyRaw === '1') {
  app.set('trust proxy', true);
} else if (trustProxyRaw === 'false' || trustProxyRaw === '0') {
  app.set('trust proxy', false);
} else if (/^\d+$/.test(trustProxyRaw)) {
  // Numeric → treat as number of hops (Express feature).
  app.set('trust proxy', Number(trustProxyRaw));
} else {
  // Comma-separated CIDR list / keyword (e.g. "10.0.0.0/8,loopback").
  app.set('trust proxy', trustProxyRaw.split(',').map((s) => s.trim()).filter(Boolean));
}
app.use(compression());

// Stripe webhook route MUST be mounted BEFORE express.json() — raw body needed for signature verification
import { stripeWebhookRouter } from './routes/stripe-webhook.routes.js';
app.use('/api/v1/stripe', stripeWebhookRouter);

// Plaid webhook — same raw-body requirement. Plaid signs the exact
// bytes it sent, so the handler must see those bytes, not a re-
// stringified parsed object. Mounted here before express.json().
import { plaidWebhookRouter } from './routes/plaid-webhook.routes.js';
app.use('/api/v1/plaid/webhooks', plaidWebhookRouter);

// DOC_REQUEST_SMS_V1 — inbound SMS webhooks. Mounted before
// express.json() so the router can decode form-urlencoded bodies and
// verify HMAC signatures against the raw-form representation.
import { smsInboundRouter } from './routes/sms-inbound.routes.js';
app.use('/api/sms/inbound', smsInboundRouter);

app.use(express.json({ limit: '10mb' }));
app.use(morgan('short'));

// Optional staff-route IP allowlist (CLOUDFLARE_TUNNEL_PLAN Phase 6).
// No-op unless STAFF_IP_ALLOWLIST_ENFORCED=1 is set. Mounted after the
// webhook routers so external machine-to-machine traffic reaches its
// raw-body handlers without an IP check; mounted before authenticate()
// so unauthorised IPs get a uniform 403 without leaking whether a
// session would've worked. Super-admin tokens bypass the check (break-
// glass).
import { staffIpAllowlist } from './middleware/staff-ip-allowlist.js';
app.use('/api/v1/', staffIpAllowlist());

// Global rate limiter — 300 requests/minute per IP.
// See CLOUDFLARE_TUNNEL_PLAN Phase 5: this is a broad per-IP ceiling
// across the whole /api surface; tighter per-endpoint and per-account
// limiters (auth.routes.ts, ai.routes.ts, chat.routes.ts, etc.) sit
// below it and catch credential-stuffing / scraping patterns that
// stay under the global bound. Webhook paths reach their respective
// raw-body handlers via /api/v1/stripe and /api/v1/plaid/webhooks,
// which are mounted BEFORE this middleware in the chain.
// Optional Redis-backed store — see utils/rate-limit-store.ts. Off by
// default; enable with RATE_LIMIT_REDIS=1 when running multi-instance
// or when counters must survive container restart.
import { getRateLimitStore } from './utils/rate-limit-store.js';
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  store: getRateLimitStore('global'),
  message: { error: { message: 'Too many requests, please try again later' } },
  // Liveness/readiness probes are exempt — ops tools poll them on tight
  // intervals (HAProxy emergency probe at 1s, Caddy upstream every 2s,
  // Docker HEALTHCHECK every 30s). Counting those toward the 300/min
  // budget would crowd out real client traffic without adding any
  // security value (the endpoints reveal nothing tenant-specific).
  skip: (req) => {
    const p = req.path;
    return p === '/ping' || p === '/health' || p.endsWith('/ping') || p.endsWith('/health');
  },
});
app.use('/api/', globalLimiter);

// Sensitive API responses must never be cached by shared proxies or by the
// browser back/forward cache. This stamps every /api/v1/* response with a
// private/no-store policy so responses that contain tenant data, audit
// entries, or the authenticated user's profile don't leak to another
// session that reuses the same intermediary.
app.use('/api/v1/', (_req, res, next) => {
  res.set('Cache-Control', 'private, no-store, max-age=0');
  next();
});

// Health check. Served at both paths so uptime monitors get the same
// response regardless of whether the main app or one of the fallback
// apps (env-missing, diagnostic) is responding — those only expose
// `/api/health`.
//
// DEEP health check: pings Postgres + Redis in parallel with bounded
// timeouts. A socket-open check on the API port is not enough —
// orchestrators need to know whether the container can actually serve
// queries. On DB or Redis failure the endpoint returns 503 so
// Kubernetes / Compose / any load balancer routes around the
// unhealthy instance.
//
// Response shape (vibe-distribution-plan.md §Vibe MyBooks health,
// extended in vibe-mybooks-compatibility-addendum §3.6 with workers):
//   { status: 'ok' | 'degraded',
//     db: 'ok' | 'fail',
//     redis: 'ok' | 'fail',
//     queue: 'ok' | 'fail',
//     workers: 'ok' | 'fail',
//     timestamp,
//     checks: { db: {...}, redis: {...}, queue: {...}, workers: {...} } }
// The top-level strings are what the installer's `vibe doctor` and the
// appliance health probe read; the `checks.*` block keeps latency /
// error detail for human debugging.
//
// `queue: 'ok'` mirrors `redis: 'ok'` for now — BullMQ queues aren't
// wired yet (worker schedulers run via Postgres advisory locks), so
// "queue infra is up" === "Redis is up". When BullMQ ships, deepen
// this check (e.g., HMGET on a known key, or read an oldest-job
// timestamp).
//
// `workers` reads `mybooks:workers:heartbeat:*` keys written by the
// worker container every 15s with a 30s TTL — see
// utils/worker-heartbeat.ts. EXPECT_WORKER=false skips the check so
// api-only deployments don't degrade.
import { sql } from 'drizzle-orm';
import { db as _dbForHealth } from './db/index.js';
import { redisPing } from './utils/health-redis.js';
import { readHeartbeats } from './utils/worker-heartbeat.js';

const healthHandler = async (_req: express.Request, res: express.Response) => {
  const t0 = Date.now();

  const dbProbe = (async () => {
    try {
      await Promise.race([
        _dbForHealth.execute(sql`SELECT 1`),
        new Promise((_, rej) => setTimeout(() => rej(new Error('db probe timeout')), 2000)),
      ]);
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  })();

  const [db, redis, workers] = await Promise.all([dbProbe, redisPing(), readHeartbeats()]);

  // Queue health rides on Redis until BullMQ wiring lands.
  const queue = { ok: redis.ok, latencyMs: redis.latencyMs, error: redis.error };

  // Workers sub-check is gated on EXPECT_WORKER. Default true matches
  // standalone docker-compose (which always runs the worker service);
  // operators on api-only deployments set EXPECT_WORKER=false so a
  // missing heartbeat doesn't drag the overall status to degraded.
  const workersCheckActive = env.EXPECT_WORKER;
  const workersOk = workersCheckActive ? workers.ok : true;

  const allOk = db.ok && redis.ok && queue.ok && workersOk;
  const status = allOk ? 'ok' : 'degraded';

  const body = {
    status,
    db: db.ok ? 'ok' : 'fail',
    redis: redis.ok ? 'ok' : 'fail',
    queue: queue.ok ? 'ok' : 'fail',
    workers: workersOk ? 'ok' : 'fail',
    timestamp: new Date().toISOString(),
    checks: {
      db,
      redis,
      queue,
      workers: {
        ...workers,
        // Make the EXPECT_WORKER gating visible in the response body
        // so operators inspecting /health output understand why a
        // missing heartbeat isn't tripping degraded status.
        expected: workersCheckActive,
      },
    },
  };

  if (allOk) {
    res.json(body);
  } else {
    res.status(503).json(body);
  }
};
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);
// vibe-mybooks-compatibility-addendum §3.5 — `/api/v1/health` alias is
// the path the appliance manifest references. Existing `/health` and
// `/api/health` stay reachable so Caddy / Docker HEALTHCHECK / uptime
// monitors that hardcoded the old paths keep working.
app.get('/api/v1/health', healthHandler);

// vibe-mybooks-compatibility-addendum §3.5, §3.14.5 — liveness probe.
// Stays 200 even when DB or Redis is down (that's the readiness
// concern of /health). Used by the appliance's HAProxy emergency
// proxy as the backend health check at port 5171, where "DB is
// wonky" is exactly the scenario where staff need to log in.
const pingHandler = (_req: express.Request, res: express.Response) => {
  res.json({ ok: true });
};
app.get('/ping', pingHandler);
app.get('/api/ping', pingHandler);
app.get('/api/v1/ping', pingHandler);

// Setup routes (no auth required — self-destructs after setup)
import { setupRouter } from './routes/setup.routes.js';
app.use('/api/setup', setupRouter);

// Public invoice routes (no auth required — customer-facing payment links)
import { publicInvoiceRouter } from './routes/public-invoice.routes.js';
app.use('/api/v1/public/invoices', publicInvoiceRouter);

// Routes
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/company', companyRouter);
app.use('/api/v1/accounts', accountsRouter);
app.use('/api/v1/contacts', contactsRouter);
app.use('/api/v1/transactions', transactionsRouter);
app.use('/api/v1/invoices', invoicesRouter);
app.use('/api/v1/bills', billsRouter);
app.use('/api/v1/vendor-credits', vendorCreditsRouter);
app.use('/api/v1/bill-payments', billPaymentsRouter);
app.use('/api/v1/estimates', estimatesRouter);
app.use('/api/v1/tags', tagsRouter);
app.use('/api/v1/reports', reportsRouter);
app.use('/api/v1/banking', bankingRouter);
app.use('/api/v1/dashboard', dashboardRouter);
app.use('/api/v1/attachments', attachmentsRouter);
app.use('/api/v1/recurring', recurringRouter);
app.use('/api/v1/batch', batchRouter);
app.use('/api/v1/items', itemsRouter);
app.use('/api/v1/payments', paymentsRouter);
app.use('/api/v1/checks', checksRouter);
app.use('/api/v1/bank-rules', bankRulesRouter);
app.use('/api/v1/duplicates', duplicatesRouter);
app.use('/api/v1/budgets', budgetsRouter);
app.use('/api/v1/backup', backupRouter);
app.use('/api/v1/tenant-export', tenantExportRouter);
app.use('/api/v1/remote-backup', remoteBackupRouter);
app.use('/api/v1/export', exportRouter);
app.use('/api/v1/downloads', downloadsRouter);
app.use('/api/v1/audit-log', auditRouter);
app.use('/api/v1/admin', adminRouter);
app.use('/api/v1/admin/tailscale', authenticate, requireSuperAdmin, tailscaleRouter);
app.use('/api/v1/api-keys', apiKeysRouter);
app.use('/api/v1/tenant-settings', tenantSettingsRouter);
app.use('/api/v1/users/me/tfa', tfaRouter);
app.use('/api/v1/auth/passkeys', passkeyRouter);

// User login preference (authenticated). Validates the values explicitly —
// preferredLoginMethod is a known enum used by auth-availability to decide
// which login UI to surface; writing an arbitrary string there wouldn't
// grant privilege but would silently disable login hints for the user.
import { authenticate as authMw } from './middleware/auth.js';
app.put('/api/v1/users/me/login-preference', authMw, async (req: any, res: any) => {
  const { eq } = await import('drizzle-orm');
  const { db } = await import('./db/index.js');
  const { users } = await import('./db/schema/index.js');
  const updates: any = { updatedAt: new Date() };
  const ALLOWED_METHODS = new Set(['password', 'magic_link', 'passkey']);
  if (req.body.preferredLoginMethod !== undefined) {
    if (!ALLOWED_METHODS.has(String(req.body.preferredLoginMethod))) {
      res.status(400).json({ error: { message: 'Invalid preferredLoginMethod' } });
      return;
    }
    updates.preferredLoginMethod = req.body.preferredLoginMethod;
  }
  if (req.body.magicLinkEnabled !== undefined) updates.magicLinkEnabled = !!req.body.magicLinkEnabled;
  await db.update(users).set(updates).where(eq(users.id, req.userId));
  res.json({ updated: true });
});
app.use('/api/v1/auth/magic-link', magicLinkRouter);
app.use('/api/v1/plaid', plaidRouter);
app.use('/api/v1/ai', aiRouter);
app.use('/api/v1/chat', chatRouter);
app.use('/oauth', oauthRouter);
app.use('/api/v1/settings/storage', storageRouter);
app.use('/api/v1/payroll-import', payrollImportRouter);
app.use('/api/v1/knowledge', knowledgeRouter);
app.use('/api/v1/feature-flags', featureFlagsRouter);
app.use('/api/v1/admin/feature-flags', adminFeatureFlagsRouter);
app.use('/api/v1/practice/classification', practiceClassificationRouter);
app.use('/api/v1/practice/classification', matchActionsRouter);
app.use('/api/v1/practice/settings', practiceSettingsRouter);
app.use('/api/v1/practice/conditional-rules', conditionalRulesRouter);
app.use('/api/v1/firms', firmsRouter);
app.use('/api/v1/practice/checks', reviewChecksRouter);
app.use('/api/v1/practice/portal', portalContactsRouter);
app.use('/api/v1/practice/portal/questions', portalQuestionsRouter);
app.use('/api/v1/practice/portal/reminders', portalRemindersRouter);
app.use('/api/v1/practice/1099', portal1099Router);
app.use('/api/v1/practice/reports', portalReportsRouter);
app.use('/api/v1/practice/receipts', portalReceiptsRouter);
// RECURRING_DOC_REQUESTS_V1 — both rule-CRUD and document-requests
// grid live under the same router (single feature-flag gate). The
// router's prefix is "/", so the routes inside read as
// /api/v1/practice/recurring-doc-requests/... and
// /api/v1/practice/document-requests/...
app.use('/api/v1/practice', recurringDocRequestsRouter);

// Public portal API — note no /v1, no JWT auth. Rate-limited per route.
app.use('/api/portal', portalAuthRouter);
app.use('/api/portal/questions', portalQuestionsPublicRouter);
app.use('/api/portal/financials', portalFinancialsPublicRouter);
// Tracking pixel + click wrapper — public, no auth.
app.use('/api/portal', portalTrackingRouter);
// Public W-9 form — token in URL is the auth.
app.use('/api/w9', portalW9PublicRouter);
// Portal-side receipt upload (signed-in contact).
app.use('/api/portal/receipts', portalReceiptsPublicRouter);
// Portal-side outstanding-doc-requests list — drives the "Documents
// requested" panel on the portal dashboard.
app.use('/api/portal/document-requests', portalDocumentRequestsPublicRouter);

// MCP Server endpoint
app.post('/mcp', async (req, res) => {
  const { handleMcpRequest } = await import('./mcp/server.js');
  await handleMcpRequest(req, res);
});

// Public auth methods endpoint (no auth required — for login page rendering)
app.get('/api/v1/auth/methods', async (req, res) => {
  const { getAuthMethods } = await import('./services/auth-availability.service.js');
  const email = req.query['email'] as string | undefined;
  const methods = await getAuthMethods(email);
  res.json(methods);
});

// Public COA template options (no auth required — used by the first-run
// setup wizard, the in-app setup wizard, and the register page to populate
// the business-type dropdown). Returns the live list from the database so
// templates added by super admins show up everywhere.
app.get('/api/v1/coa-templates/options', async (_req, res) => {
  const { listOptions } = await import('./services/coa-templates.service.js');
  const options = await listOptions();
  res.json({ options });
});

// Public API v2
app.use('/api/v2', apiV2Router);

// Swagger UI — public in development, super-admin only in production.
// The API surface map is sensitive info-leak for a firm-employee tenant
// (routes like /admin/tailscale, /admin/backup-verify, Plaid webhooks
// etc.); anyone authenticated shouldn't be able to browse it. In
// development we leave it open so contributors can poke the API
// without first minting a super-admin token.
//
// authenticate() is async — `await` it so its throws (AppError.unauthorized)
// reach the Express error handler via express-async-errors instead of
// leaking as unhandled promise rejections.
import { authenticate as swaggerAuth, requireSuperAdmin as swaggerRequireSuperAdmin } from './middleware/auth.js';
app.use('/api/docs',
  async (req: any, res: any, next: any) => {
    if (env.NODE_ENV !== 'production') return next();
    await swaggerAuth(req, res, (err?: unknown) => {
      if (err) return next(err);
      try {
        swaggerRequireSuperAdmin(req, res, next);
      } catch (e) {
        next(e);
      }
    });
  },
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Vibe MyBooks API Documentation',
  }),
);

// Serve frontend static files in production
import path from 'path';
if (env.NODE_ENV === 'production') {
  const webDistPath = path.resolve('packages/web/dist');
  app.use(express.static(webDistPath));
  // SPA fallback: serve index.html for any non-API route
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/oauth') || req.path === '/health' || req.path === '/mcp') {
      return next();
    }
    res.sendFile(path.join(webDistPath, 'index.html'));
  });
}

// JSON 404 for unmatched `/api/*` routes. Without this Express falls
// back to its default HTML 404 page, which is (a) confusing for API
// clients, and (b) inconsistent with the JSON shape every other error
// uses. Leaves the SPA fallback above to handle non-API paths.
app.use('/api', (_req, res) => {
  res.status(404).json({
    error: { message: 'Not found', code: 'NOT_FOUND' },
  });
});

// Error handler (must be last)
app.use(errorHandler);
