import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
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
import { auditRouter } from './routes/audit.routes.js';
import { adminRouter } from './routes/admin.routes.js';
import { apiKeysRouter } from './routes/api-keys.routes.js';
import { apiV2Router } from './routes/api-v2.routes.js';
import { tfaRouter } from './routes/tfa.routes.js';
import { passkeyRouter } from './routes/passkey.routes.js';
import { magicLinkRouter } from './routes/magic-link.routes.js';
import { plaidRouter } from './routes/plaid.routes.js';
import { aiRouter } from './routes/ai.routes.js';
import { chatRouter } from './routes/chat.routes.js';
import { oauthRouter } from './routes/oauth.routes.js';
import { storageRouter } from './routes/storage.routes.js';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './swagger.js';

export const app = express();

// Middleware
app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
app.use(compression());
app.use(express.json());
app.use(morgan('short'));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Setup routes (no auth required — self-destructs after setup)
import { setupRouter } from './routes/setup.routes.js';
app.use('/api/setup', setupRouter);

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
app.use('/api/v1/audit-log', auditRouter);
app.use('/api/v1/admin', adminRouter);
app.use('/api/v1/api-keys', apiKeysRouter);
app.use('/api/v1/users/me/tfa', tfaRouter);
app.use('/api/v1/auth/passkeys', passkeyRouter);

// User login preference (authenticated)
import { authenticate as authMw } from './middleware/auth.js';
app.put('/api/v1/users/me/login-preference', authMw, async (req: any, res: any) => {
  const { eq } = await import('drizzle-orm');
  const { db } = await import('./db/index.js');
  const { users } = await import('./db/schema/index.js');
  const updates: any = { updatedAt: new Date() };
  if (req.body.preferredLoginMethod !== undefined) updates.preferredLoginMethod = req.body.preferredLoginMethod;
  if (req.body.magicLinkEnabled !== undefined) updates.magicLinkEnabled = req.body.magicLinkEnabled;
  await db.update(users).set(updates).where(eq(users.id, req.userId));
  res.json({ updated: true });
});
app.use('/api/v1/auth/magic-link', magicLinkRouter);
app.use('/api/v1/plaid', plaidRouter);
app.use('/api/v1/ai', aiRouter);
app.use('/api/v1/chat', chatRouter);
app.use('/oauth', oauthRouter);
app.use('/api/v1/settings/storage', storageRouter);

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

// Error handler (must be last)
app.use(errorHandler);
