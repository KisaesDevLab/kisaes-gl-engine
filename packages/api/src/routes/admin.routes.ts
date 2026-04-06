import { Router } from 'express';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import * as adminService from '../services/admin.service.js';
import * as authService from '../services/auth.service.js';
import { testSmtpConnection } from '../services/setup.service.js';
import * as tfaConfigService from '../services/tfa-config.service.js';
import * as bankRulesService from '../services/bank-rules.service.js';
import { eq } from 'drizzle-orm';

export const adminRouter = Router();
adminRouter.use(authenticate);
adminRouter.use(requireSuperAdmin);

// ─── System Stats ────────────────────────────────────────────────

adminRouter.get('/stats', async (req, res) => {
  const stats = await adminService.getSystemStats();
  res.json(stats);
});

adminRouter.get('/settings', async (req, res) => {
  const settings = await adminService.getGlobalSettings();
  const appSettings = await adminService.getApplicationSettings();
  res.json({ ...settings, ...appSettings });
});

adminRouter.put('/settings/smtp', async (req, res) => {
  await adminService.saveSmtpSettings(req.body);
  res.json({ message: 'SMTP settings saved' });
});

adminRouter.put('/settings/application', async (req, res) => {
  await adminService.saveApplicationSettings(req.body);
  res.json({ message: 'Application settings saved' });
});

// ─── Tenant Management ──────────────────────────────────────────

adminRouter.get('/tenants', async (req, res) => {
  const tenants = await adminService.listTenants();
  res.json({ tenants });
});

adminRouter.get('/tenants/:id', async (req, res) => {
  const detail = await adminService.getTenantDetail(req.params['id']!);
  res.json(detail);
});

adminRouter.post('/tenants/:id/disable', async (req, res) => {
  await adminService.disableTenant(req.params['id']!);
  res.json({ message: 'Tenant disabled' });
});

adminRouter.post('/tenants/:id/enable', async (req, res) => {
  await adminService.enableTenant(req.params['id']!);
  res.json({ message: 'Tenant enabled' });
});

// ─── User Management ────────────────────────────────────────────

adminRouter.get('/users', async (req, res) => {
  const users = await adminService.listAllUsers();
  res.json({ users });
});

adminRouter.post('/users/:id/reset-password', async (req, res) => {
  await adminService.resetUserPassword(req.params['id']!, req.body.password);
  res.json({ message: 'Password reset' });
});

adminRouter.post('/users/:id/toggle-active', async (req, res) => {
  const result = await adminService.toggleUserActive(req.params['id']!);
  res.json(result);
});

adminRouter.post('/users/:id/toggle-super-admin', async (req, res) => {
  const result = await adminService.toggleSuperAdmin(req.params['id']!);
  res.json(result);
});

adminRouter.post('/users/:id/toggle-tenant-access', async (req, res) => {
  const result = await adminService.toggleTenantAccess(req.params['id']!, req.body.tenantId);
  res.json(result);
});

adminRouter.post('/users/:id/set-role', async (req, res) => {
  const { role } = req.body;
  const validRoles = ['owner', 'accountant', 'bookkeeper'];
  if (!validRoles.includes(role)) {
    res.status(400).json({ error: { message: `Role must be one of: ${validRoles.join(', ')}` } });
    return;
  }
  await adminService.setUserRole(req.params['id']!, role);
  res.json({ message: 'Role updated', role });
});

// ─── Accountant Company Access ─────────────────────────────────

adminRouter.get('/users/:id/company-access', async (req, res) => {
  const access = await adminService.getAccountantCompanyAccess(req.params['id']!);
  res.json(access);
});

adminRouter.post('/users/:id/exclude-company', async (req, res) => {
  await adminService.excludeCompanyFromAccountant(req.params['id']!, req.body.companyId);
  res.json({ message: 'Company excluded' });
});

adminRouter.post('/users/:id/include-company', async (req, res) => {
  await adminService.includeCompanyForAccountant(req.params['id']!, req.body.companyId);
  res.json({ message: 'Company included' });
});

// ─── SMTP Test ─────────────────────────────────────────────────

adminRouter.post('/test-smtp', async (req, res) => {
  const result = await testSmtpConnection(req.body, req.body.testEmail);
  res.json(result);
});

// ─── 2FA Configuration ──────────────────────────────────────────

adminRouter.get('/tfa/config', async (req, res) => {
  const config = await tfaConfigService.getConfig();
  res.json(config);
});

adminRouter.put('/tfa/config', async (req, res) => {
  const config = await tfaConfigService.updateConfig(req.body, req.userId);
  res.json(config);
});

adminRouter.post('/tfa/sms-test', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) { res.status(400).json({ error: { message: 'Phone number is required' } }); return; }
  const { getSmsProvider } = await import('../services/sms-providers/index.js');
  const config = await tfaConfigService.getRawConfig();
  const provider = getSmsProvider(config);
  const result = await provider.sendCode(phoneNumber, '123456', 'Vibe MyBooks (Test)');
  if (result.success) {
    res.json({ success: true, message: `Test SMS sent to ${phoneNumber} via ${provider.name}` });
  } else {
    res.status(400).json({ error: { message: result.error || 'SMS send failed' } });
  }
});

adminRouter.get('/tfa/stats', async (req, res) => {
  const stats = await tfaConfigService.getTfaStats();
  res.json(stats);
});

// ─── Global Bank Rules ──────────────────────────────────────────

adminRouter.get('/bank-rules', async (req, res) => {
  const rules = await bankRulesService.listGlobal();
  res.json({ rules });
});

adminRouter.post('/bank-rules', async (req, res) => {
  const rule = await bankRulesService.createGlobal(req.body);
  res.status(201).json({ rule });
});

adminRouter.put('/bank-rules/:id', async (req, res) => {
  const rule = await bankRulesService.updateGlobal(req.params['id']!, req.body);
  res.json({ rule });
});

adminRouter.delete('/bank-rules/:id', async (req, res) => {
  await bankRulesService.removeGlobal(req.params['id']!);
  res.json({ message: 'Global rule deleted' });
});

adminRouter.get('/bank-rule-submissions', async (req, res) => {
  const status = req.query['status'] as string | undefined;
  const submissions = await bankRulesService.listSubmissions(status);
  res.json({ submissions });
});

adminRouter.post('/bank-rule-submissions/:id/approve', async (req, res) => {
  const rule = await bankRulesService.approveSubmission(req.params['id']!);
  res.json({ message: 'Submission approved', rule });
});

adminRouter.post('/bank-rule-submissions/:id/reject', async (req, res) => {
  await bankRulesService.rejectSubmission(req.params['id']!);
  res.json({ message: 'Submission rejected' });
});

// ─── Create Client Tenant ───────────────────────────────────────

adminRouter.post('/create-client', async (req, res) => {
  const result = await authService.createClientTenant(req.userId, req.body);
  res.status(201).json(result);
});

// ─── Impersonation ──────────────────────────────────────────────

// ─── MCP Configuration ─────────────────────────────────────────

adminRouter.get('/mcp/config', async (req, res) => {
  const { db: database } = await import('../db/index.js');
  const { mcpConfig } = await import('../db/schema/index.js');
  let config = await database.query.mcpConfig.findFirst();
  if (!config) { const [c] = await database.insert(mcpConfig).values({}).returning(); config = c; }
  res.json(config);
});

adminRouter.put('/mcp/config', async (req, res) => {
  const { db: database } = await import('../db/index.js');
  const { mcpConfig } = await import('../db/schema/index.js');
  let config = await database.query.mcpConfig.findFirst();
  if (!config) { const [c] = await database.insert(mcpConfig).values({}).returning(); config = c; }
  const updates: any = { updatedAt: new Date(), configuredBy: req.userId, configuredAt: new Date() };
  for (const key of ['isEnabled', 'maxKeysPerUser', 'systemRateLimitPerMinute', 'oauthEnabled', 'requireKeyExpiration', 'maxKeyLifetimeDays']) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (req.body.allowedScopes) updates.allowedScopes = Array.isArray(req.body.allowedScopes) ? req.body.allowedScopes.join(',') : req.body.allowedScopes;
  await database.update(mcpConfig).set(updates).where(eq(mcpConfig.id, config!.id));
  res.json(await database.query.mcpConfig.findFirst());
});

adminRouter.get('/mcp/log', async (req, res) => {
  const { db: database } = await import('../db/index.js');
  const { mcpRequestLog } = await import('../db/schema/index.js');
  const { desc } = await import('drizzle-orm');
  const logs = await database.select().from(mcpRequestLog).orderBy(desc(mcpRequestLog.createdAt)).limit(100);
  res.json({ logs });
});

adminRouter.post('/impersonate/:userId', async (req, res) => {
  const result = await adminService.impersonateUser(req.userId, req.params['userId']!);
  res.json(result);
});

// ─── Plaid Configuration ───────────────────────────────────────

adminRouter.get('/plaid/config', async (req, res) => {
  const { getConfig } = await import('../services/plaid-client.service.js');
  const config = await getConfig();
  res.json(config);
});

adminRouter.put('/plaid/config', async (req, res) => {
  const { updateConfig } = await import('../services/plaid-client.service.js');
  const config = await updateConfig(req.body, req.userId);
  res.json(config);
});

adminRouter.post('/plaid/test', async (req, res) => {
  const { testConnection } = await import('../services/plaid-client.service.js');
  const ok = await testConnection();
  res.json({ success: ok, message: ok ? 'Plaid connection successful' : 'Plaid connection failed' });
});

adminRouter.get('/plaid/connections', async (req, res) => {
  const { plaidItems, plaidAccounts } = await import('../db/schema/index.js');
  const { sql: sqlTag } = await import('drizzle-orm');
  const { db: database } = await import('../db/index.js');
  const items = await database.select().from(plaidItems).where(sqlTag`removed_at IS NULL`);
  const result = [];
  for (const item of items) {
    const accounts = await database.select().from(plaidAccounts).where(eq(plaidAccounts.plaidItemId, item.id));
    result.push({ ...item, accounts, accessTokenEncrypted: undefined });
  }
  res.json({ connections: result });
});

adminRouter.get('/plaid/stats', async (req, res) => {
  const { plaidItems, plaidAccounts } = await import('../db/schema/index.js');
  const { sql: sqlTag } = await import('drizzle-orm');
  const { db: database } = await import('../db/index.js');
  const stats = await database.execute(sqlTag`
    SELECT
      COUNT(*) FILTER (WHERE removed_at IS NULL) as total_items,
      COUNT(*) FILTER (WHERE item_status = 'active' AND removed_at IS NULL) as active_items,
      COUNT(*) FILTER (WHERE item_status IN ('login_required','pending_disconnect','error') AND removed_at IS NULL) as needs_attention
    FROM plaid_items
  `);
  const acctStats = await database.execute(sqlTag`
    SELECT COUNT(*) as total,
      (SELECT COUNT(*) FROM plaid_account_mappings) as mapped
    FROM plaid_accounts WHERE is_active = true
  `);
  const row = stats.rows[0] as any;
  const acctRow = acctStats.rows[0] as any;
  res.json({
    totalItems: parseInt(row.total_items) || 0,
    activeItems: parseInt(row.active_items) || 0,
    needsAttention: parseInt(row.needs_attention) || 0,
    totalAccounts: parseInt(acctRow.total) || 0,
    mappedAccounts: parseInt(acctRow.mapped) || 0,
  });
});

adminRouter.get('/plaid/webhook-log', async (req, res) => {
  const { plaidWebhookLog } = await import('../db/schema/index.js');
  const { desc } = await import('drizzle-orm');
  const { db: database } = await import('../db/index.js');
  const logs = await database.select({
    id: plaidWebhookLog.id,
    receivedAt: plaidWebhookLog.receivedAt,
    plaidItemId: plaidWebhookLog.plaidItemId,
    webhookType: plaidWebhookLog.webhookType,
    webhookCode: plaidWebhookLog.webhookCode,
    processed: plaidWebhookLog.processed,
    error: plaidWebhookLog.error,
  }).from(plaidWebhookLog).orderBy(desc(plaidWebhookLog.receivedAt)).limit(100);
  res.json({ logs });
});
