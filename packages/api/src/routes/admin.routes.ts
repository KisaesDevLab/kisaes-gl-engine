import { Router } from 'express';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import * as adminService from '../services/admin.service.js';
import * as authService from '../services/auth.service.js';
import { testSmtpConnection } from '../services/setup.service.js';
import * as tfaConfigService from '../services/tfa-config.service.js';
import * as bankRulesService from '../services/bank-rules.service.js';
import { encrypt, decrypt } from '../utils/encryption.js';
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

// ─── Backup Remote Config ──────────────────────────────────────

adminRouter.get('/backup/remote-config', async (req, res) => {
  const config = await adminService.getBackupRemoteConfig();
  // Redact secrets from the config JSON
  let safeConfig: Record<string, any> = {};
  try {
    const parsed = JSON.parse(config.backupRemoteConfig);
    safeConfig = { ...parsed };
    // Remove encrypted fields from response
    delete safeConfig['access_token_encrypted'];
    delete safeConfig['refresh_token_encrypted'];
    delete safeConfig['secret_access_key_encrypted'];
    delete safeConfig['app_secret_encrypted'];
    delete safeConfig['client_secret_encrypted'];
    // Indicate which secrets are present
    if (parsed['access_token_encrypted']) safeConfig['hasAccessToken'] = true;
    if (parsed['refresh_token_encrypted']) safeConfig['hasRefreshToken'] = true;
    if (parsed['secret_access_key_encrypted']) safeConfig['hasSecretAccessKey'] = true;
    if (parsed['app_secret_encrypted']) safeConfig['hasAppSecret'] = true;
    if (parsed['client_secret_encrypted']) safeConfig['hasClientSecret'] = true;
  } catch { /* empty config is fine */ }

  res.json({
    ...config,
    backupRemoteConfig: JSON.stringify(safeConfig),
  });
});

adminRouter.put('/backup/remote-config', async (req, res) => {
  const input: Partial<adminService.BackupRemoteConfig> = {};

  if (req.body.backupRemoteProvider !== undefined) input.backupRemoteProvider = req.body.backupRemoteProvider;
  if (req.body.backupLocalRetentionDays !== undefined) input.backupLocalRetentionDays = String(req.body.backupLocalRetentionDays);
  if (req.body.backupRemoteRetentionPreset !== undefined) input.backupRemoteRetentionPreset = req.body.backupRemoteRetentionPreset;
  if (req.body.backupRemoteRetentionDaily !== undefined) input.backupRemoteRetentionDaily = String(req.body.backupRemoteRetentionDaily);
  if (req.body.backupRemoteRetentionWeekly !== undefined) input.backupRemoteRetentionWeekly = String(req.body.backupRemoteRetentionWeekly);
  if (req.body.backupRemoteRetentionMonthly !== undefined) input.backupRemoteRetentionMonthly = String(req.body.backupRemoteRetentionMonthly);
  if (req.body.backupRemoteRetentionYearly !== undefined) input.backupRemoteRetentionYearly = String(req.body.backupRemoteRetentionYearly);

  // Handle provider config with secret encryption
  if (req.body.providerConfig) {
    const pc = req.body.providerConfig;
    const configToStore: Record<string, any> = {};

    const provider = req.body.backupRemoteProvider || (await adminService.getBackupRemoteConfig()).backupRemoteProvider;

    switch (provider) {
      case 's3':
        configToStore['bucket'] = pc.bucket || '';
        configToStore['region'] = pc.region || 'us-east-1';
        configToStore['endpoint'] = pc.endpoint || '';
        configToStore['accessKeyId'] = pc.accessKeyId || '';
        if (pc.secretAccessKey) configToStore['secret_access_key_encrypted'] = encrypt(pc.secretAccessKey);
        configToStore['prefix'] = pc.prefix || 'backups/';
        break;
      case 'dropbox':
        configToStore['app_key'] = pc.appKey || '';
        if (pc.appSecret) configToStore['app_secret_encrypted'] = encrypt(pc.appSecret);
        configToStore['root_folder'] = pc.rootFolder || '/Vibe MyBooks Backups';
        break;
      case 'google_drive':
        configToStore['client_id'] = pc.clientId || '';
        if (pc.clientSecret) configToStore['client_secret_encrypted'] = encrypt(pc.clientSecret);
        configToStore['folder_id'] = pc.folderId || 'root';
        break;
      case 'onedrive':
        configToStore['client_id'] = pc.clientId || '';
        if (pc.clientSecret) configToStore['client_secret_encrypted'] = encrypt(pc.clientSecret);
        configToStore['ms_tenant_id'] = pc.tenantId || 'common';
        configToStore['folder_id'] = pc.folderId || 'root';
        configToStore['drive_id'] = pc.driveId || 'me';
        break;
    }

    // Merge with existing config to preserve tokens
    try {
      const existing = JSON.parse((await adminService.getBackupRemoteConfig()).backupRemoteConfig);
      input.backupRemoteConfig = JSON.stringify({ ...existing, ...configToStore });
    } catch {
      input.backupRemoteConfig = JSON.stringify(configToStore);
    }
  }

  await adminService.saveBackupRemoteConfig(input);
  res.json({ message: 'Backup remote config saved' });
});

adminRouter.post('/backup/remote-test', async (req, res) => {
  try {
    const { DropboxProvider } = await import('../services/storage/dropbox.provider.js');
    const { GoogleDriveProvider } = await import('../services/storage/google-drive.provider.js');
    const { OneDriveProvider } = await import('../services/storage/onedrive.provider.js');
    const { S3Provider } = await import('../services/storage/s3.provider.js');

    const config = await adminService.getBackupRemoteConfig();
    const provider = config.backupRemoteProvider;
    const parsed = JSON.parse(config.backupRemoteConfig) as Record<string, any>;

    let storageProvider: import('../services/storage/storage-provider.interface.js').StorageProvider;

    switch (provider) {
      case 'dropbox': {
        const token = parsed['access_token_encrypted'] ? decrypt(parsed['access_token_encrypted']) : '';
        if (!token) { res.status(400).json({ error: { message: 'Dropbox not connected (no access token)' } }); return; }
        storageProvider = new DropboxProvider(token, { root_folder: parsed['root_folder'] });
        break;
      }
      case 'google_drive': {
        const token = parsed['access_token_encrypted'] ? decrypt(parsed['access_token_encrypted']) : '';
        if (!token) { res.status(400).json({ error: { message: 'Google Drive not connected (no access token)' } }); return; }
        storageProvider = new GoogleDriveProvider(token, { folder_id: parsed['folder_id'] });
        break;
      }
      case 'onedrive': {
        const token = parsed['access_token_encrypted'] ? decrypt(parsed['access_token_encrypted']) : '';
        if (!token) { res.status(400).json({ error: { message: 'OneDrive not connected (no access token)' } }); return; }
        storageProvider = new OneDriveProvider(token, { folder_id: parsed['folder_id'] });
        break;
      }
      case 's3': {
        if (!parsed['bucket'] || !parsed['accessKeyId']) {
          res.status(400).json({ error: { message: 'S3 not fully configured' } }); return;
        }
        storageProvider = new S3Provider({
          bucket: parsed['bucket'],
          region: parsed['region'],
          endpoint: parsed['endpoint'],
          accessKeyId: parsed['accessKeyId'],
          secretAccessKey: parsed['secret_access_key_encrypted'] ? decrypt(parsed['secret_access_key_encrypted']) : '',
          prefix: parsed['prefix'],
        });
        break;
      }
      default:
        res.status(400).json({ error: { message: 'No remote provider configured' } }); return;
    }

    const health = await storageProvider.checkHealth();
    res.json(health);
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ─── Backup Remote OAuth Flow ────────────────────────────────────

adminRouter.get('/backup/remote-connect/:provider', async (req, res) => {
  const provider = req.params['provider']!;
  const appUrl = process.env['CORS_ORIGIN'] || 'http://localhost:5173';
  const callbackUrl = `${req.protocol}://${req.get('host')}/api/v1/admin/backup/remote-callback/${provider}`;

  const config = await adminService.getBackupRemoteConfig();
  const parsed = JSON.parse(config.backupRemoteConfig) as Record<string, any>;

  switch (provider) {
    case 'dropbox': {
      const appKey = parsed['app_key'];
      if (!appKey) { res.status(400).json({ error: { message: 'Dropbox app credentials not configured' } }); return; }
      res.redirect(`https://www.dropbox.com/oauth2/authorize?client_id=${appKey}&response_type=code&redirect_uri=${encodeURIComponent(callbackUrl)}&token_access_type=offline`);
      break;
    }
    case 'google_drive': {
      const clientId = parsed['client_id'];
      if (!clientId) { res.status(400).json({ error: { message: 'Google Drive credentials not configured' } }); return; }
      res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=https://www.googleapis.com/auth/drive.file&access_type=offline&prompt=consent`);
      break;
    }
    case 'onedrive': {
      const clientId = parsed['client_id'];
      const msTenantId = parsed['ms_tenant_id'] || 'common';
      if (!clientId) { res.status(400).json({ error: { message: 'OneDrive credentials not configured' } }); return; }
      res.redirect(`https://login.microsoftonline.com/${msTenantId}/oauth2/v2.0/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=Files.ReadWrite%20User.Read%20offline_access`);
      break;
    }
    default:
      res.status(400).json({ error: { message: `OAuth not supported for provider: ${provider}` } });
  }
});

adminRouter.get('/backup/remote-callback/:provider', async (req, res) => {
  const provider = req.params['provider']!;
  const code = req.query['code'] as string;
  const appUrl = process.env['CORS_ORIGIN'] || 'http://localhost:5173';
  const callbackUrl = `${req.protocol}://${req.get('host')}/api/v1/admin/backup/remote-callback/${provider}`;

  if (!code) { res.redirect(`${appUrl}/admin/system?error=no_code`); return; }

  try {
    const config = await adminService.getBackupRemoteConfig();
    const parsed = JSON.parse(config.backupRemoteConfig) as Record<string, any>;

    let accessToken = '';
    let refreshToken = '';
    let expiresIn = 3600;

    switch (provider) {
      case 'dropbox': {
        const appKey = parsed['app_key'];
        const appSecret = parsed['app_secret_encrypted'] ? decrypt(parsed['app_secret_encrypted']) : '';
        const tokenRes = await fetch('https://api.dropboxapi.com/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `code=${code}&grant_type=authorization_code&redirect_uri=${encodeURIComponent(callbackUrl)}&client_id=${appKey}&client_secret=${appSecret}`,
        });
        const data = await tokenRes.json() as any;
        accessToken = data.access_token;
        refreshToken = data.refresh_token || '';
        break;
      }
      case 'google_drive': {
        const clientId = parsed['client_id'];
        const clientSecret = parsed['client_secret_encrypted'] ? decrypt(parsed['client_secret_encrypted']) : '';
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `code=${code}&grant_type=authorization_code&redirect_uri=${encodeURIComponent(callbackUrl)}&client_id=${clientId}&client_secret=${clientSecret}`,
        });
        const data = await tokenRes.json() as any;
        accessToken = data.access_token;
        refreshToken = data.refresh_token || '';
        expiresIn = data.expires_in || 3600;
        break;
      }
      case 'onedrive': {
        const clientId = parsed['client_id'];
        const clientSecret = parsed['client_secret_encrypted'] ? decrypt(parsed['client_secret_encrypted']) : '';
        const msTenantId = parsed['ms_tenant_id'] || 'common';
        const tokenRes = await fetch(`https://login.microsoftonline.com/${msTenantId}/oauth2/v2.0/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `code=${code}&grant_type=authorization_code&redirect_uri=${encodeURIComponent(callbackUrl)}&client_id=${clientId}&client_secret=${clientSecret}&scope=Files.ReadWrite%20User.Read%20offline_access`,
        });
        const data = await tokenRes.json() as any;
        accessToken = data.access_token;
        refreshToken = data.refresh_token || '';
        expiresIn = data.expires_in || 3600;
        break;
      }
    }

    // Merge tokens into existing config
    const updatedConfig = {
      ...parsed,
      access_token_encrypted: encrypt(accessToken),
      refresh_token_encrypted: refreshToken ? encrypt(refreshToken) : undefined,
      token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };

    await adminService.saveBackupRemoteConfig({
      backupRemoteConfig: JSON.stringify(updatedConfig),
    });

    res.redirect(`${appUrl}/admin/system?backup_connected=${provider}`);
  } catch (err: any) {
    res.redirect(`${appUrl}/admin/system?error=${encodeURIComponent(err.message)}`);
  }
});
