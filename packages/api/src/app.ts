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
// keeps working unchanged.
const allowedOrigins = new Set(
  env.CORS_ORIGIN.split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean),
);
app.use(
  cors({
    origin: (origin, cb) => {
      // Same-origin fetches, curl, and server-to-server traffic arrive
      // without an Origin header — always allow. Browsers send Origin
      // on every cross-origin request so we get the security check we
      // want without blocking first-party calls.
      if (!origin) return cb(null, true);
      cb(null, allowedOrigins.has(origin.replace(/\/$/, '')));
    },
    credentials: true,
  }),
);

// Trust the appliance's front nginx so req.protocol respects
// X-Forwarded-Proto and req.ip reflects the client, not the proxy.
// Without this, request-derived URLs (below) pick up http:// even when
// the user is on https:// through the reverse proxy.
app.set('trust proxy', true);
app.use(compression());

// Stripe webhook route MUST be mounted BEFORE express.json() — raw body needed for signature verification
import { stripeWebhookRouter } from './routes/stripe-webhook.routes.js';
app.use('/api/v1/stripe', stripeWebhookRouter);

// Plaid webhook — same raw-body requirement. Plaid signs the exact
// bytes it sent, so the handler must see those bytes, not a re-
// stringified parsed object. Mounted here before express.json().
import { plaidWebhookRouter } from './routes/plaid-webhook.routes.js';
app.use('/api/v1/plaid/webhooks', plaidWebhookRouter);

app.use(express.json({ limit: '10mb' }));
app.use(morgan('short'));

// Global rate limiter — 200 requests/minute per IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many requests, please try again later' } },
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
// DEEP health check: runs a trivial SELECT 1 against Postgres with a
// short timeout. A socket-open check on the API port is not enough —
// orchestrators need to know whether the container can actually serve
// queries. On DB failure the endpoint returns 503 so Kubernetes /
// Compose / any load balancer routes around the unhealthy instance.
//
// Redis is not probed here because the API package has no direct Redis
// client — Redis is only used by the worker (via BullMQ). If the API
// starts using Redis directly (e.g., for cached session lookups), add
// the probe here.
import { sql } from 'drizzle-orm';
import { db as _dbForHealth } from './db/index.js';

const healthHandler = async (_req: express.Request, res: express.Response) => {
  const t0 = Date.now();
  let dbOk = false;
  let dbError: string | undefined;
  try {
    // 2s timeout — the healthcheck interval is 30s, so a slow DB
    // surfaces quickly without the probe itself piling up connections.
    await Promise.race([
      _dbForHealth.execute(sql`SELECT 1`),
      new Promise((_, rej) => setTimeout(() => rej(new Error('db probe timeout')), 2000)),
    ]);
    dbOk = true;
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }
  const latencyMs = Date.now() - t0;
  if (dbOk) {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), checks: { db: { ok: true, latencyMs } } });
  } else {
    res.status(503).json({
      status: 'degraded',
      timestamp: new Date().toISOString(),
      checks: { db: { ok: false, error: dbError, latencyMs } },
    });
  }
};
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

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

// Swagger UI — public in development, requires auth in production
import { authenticate as swaggerAuth } from './middleware/auth.js';
app.use('/api/docs',
  (req: any, res: any, next: any) => {
    if (env.NODE_ENV === 'production') return swaggerAuth(req, res, next);
    next();
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
