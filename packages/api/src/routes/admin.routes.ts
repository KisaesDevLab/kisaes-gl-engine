// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as adminService from '../services/admin.service.js';
import * as authService from '../services/auth.service.js';
import { testSmtpConnection, withSetupLock } from '../services/setup.service.js';
import * as tfaConfigService from '../services/tfa-config.service.js';
import * as bankRulesService from '../services/bank-rules.service.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import * as coaTemplatesService from '../services/coa-templates.service.js';
import { db } from '../db/index.js';
import {
  generateRecoveryKey,
  parseRecoveryKey,
} from '../services/recovery-key.service.js';
import {
  writeRecoveryFile,
  readRecoveryFile,
  recoveryFileExists,
  deleteRecoveryFile,
} from '../services/env-recovery.service.js';
import {
  createSentinel,
  readSentinelHeader,
  sentinelExists,
  deleteSentinel,
  SentinelError,
} from '../services/sentinel.service.js';
import { ensureHostId } from '../services/host-id.service.js';
import { getSetting, setSetting } from '../services/admin.service.js';
import { SystemSettingsKeys } from '../constants/system-settings-keys.js';
import { sentinelAudit } from '../startup/sentinel-audit.js';
import {
  createCoaTemplateSchema,
  updateCoaTemplateSchema,
  cloneCoaTemplateFromTenantSchema,
  importCoaTemplateSchema,
  createBankRuleSchema,
  updateBankRuleSchema,
  adminResetPasswordSchema,
  adminToggleTenantAccessSchema,
  adminSetRoleSchema,
  adminCompanyAccessSchema,
  adminSmtpSettingsSchema,
  adminSmtpTestSchema,
  adminApplicationSettingsSchema,
  adminTfaConfigSchema,
  adminTfaSmsTestSchema,
  adminCreateClientSchema,
  adminMcpConfigSchema,
  adminPlaidConfigSchema,
} from '@kis-books/shared';
import { eq } from 'drizzle-orm';
import { tailscaleRouter } from './tailscale.routes.js';

export const adminRouter = Router();
adminRouter.use(authenticate);
adminRouter.use(requireSuperAdmin);

// Tailscale remote-access management (super-admin only, already gated above).
adminRouter.use('/tailscale', tailscaleRouter);

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

adminRouter.put('/settings/smtp', validate(adminSmtpSettingsSchema), async (req, res) => {
  await adminService.saveSmtpSettings(req.body);
  res.json({ message: 'SMTP settings saved' });
});

adminRouter.put('/settings/application', validate(adminApplicationSettingsSchema), async (req, res) => {
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
  await adminService.disableTenant(req.params['id']!, req.userId);
  res.json({ message: 'Tenant disabled' });
});

adminRouter.post('/tenants/:id/enable', async (req, res) => {
  await adminService.enableTenant(req.params['id']!, req.userId);
  res.json({ message: 'Tenant enabled' });
});

// Hard-delete a tenant and all its scoped data. Destructive and
// irreversible — see deleteTenant() in admin.service.ts for the full
// safety logic. Requires super admin (already enforced by the
// requireSuperAdmin middleware applied to the whole router).
adminRouter.delete('/tenants/:id', async (req, res) => {
  const result = await adminService.deleteTenant(req.params['id']!, req.userId);
  res.json({ message: 'Tenant deleted', ...result });
});

// ─── User Management ────────────────────────────────────────────

adminRouter.get('/users', async (req, res) => {
  const users = await adminService.listAllUsers();
  res.json({ users });
});

adminRouter.post('/users/create', async (req, res) => {
  const { email: rawEmail, password, displayName, tenantId, role } = req.body;
  if (!rawEmail || !password || !tenantId) {
    res.status(400).json({ error: { message: 'email, password, and tenantId are required' } });
    return;
  }
  // Normalize to lowercase; users.email is treated case-insensitively
  // elsewhere in the auth path, so storing mixed-case here would create a
  // row that no normal login flow can find.
  const email = String(rawEmail).trim().toLowerCase();

  const { users, tenants, userTenantAccess } = await import('../db/schema/index.js');
  const { eq } = await import('drizzle-orm');
  const { env } = await import('../config/env.js');

  // Check email uniqueness
  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (existing) {
    res.status(409).json({ error: { message: 'A user with this email already exists' } });
    return;
  }

  // Verify tenant exists
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) {
    res.status(404).json({ error: { message: 'Tenant not found' } });
    return;
  }

  const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);
  const [user] = await db.insert(users).values({
    tenantId,
    email,
    passwordHash,
    displayName: displayName || null,
    role: role || 'owner',
  }).returning();

  if (user) {
    await db.insert(userTenantAccess).values({
      userId: user.id,
      tenantId,
      role: role || 'owner',
    }).onConflictDoNothing();
  }

  res.status(201).json({ user: { id: user!.id, email: user!.email, displayName: user!.displayName, role: user!.role } });
});

adminRouter.post('/users/:id/reset-password', validate(adminResetPasswordSchema), async (req, res) => {
  await adminService.resetUserPassword(req.params['id']!, req.body.password, req.userId);
  res.json({ message: 'Password reset' });
});

adminRouter.post('/users/:id/toggle-active', async (req, res) => {
  const result = await adminService.toggleUserActive(req.params['id']!, req.userId);
  res.json(result);
});

adminRouter.post('/users/:id/toggle-super-admin', async (req, res) => {
  const result = await adminService.toggleSuperAdmin(req.params['id']!, req.userId);
  res.json(result);
});

adminRouter.post('/users/:id/toggle-tenant-access', validate(adminToggleTenantAccessSchema), async (req, res) => {
  const result = await adminService.toggleTenantAccess(req.params['id']!, req.body.tenantId, req.userId);
  res.json(result);
});

adminRouter.post('/users/:id/set-role', validate(adminSetRoleSchema), async (req, res) => {
  await adminService.setUserRole(req.params['id']!, req.body.role, req.userId);
  res.json({ message: 'Role updated', role: req.body.role });
});

// ─── Accountant Company Access ─────────────────────────────────

adminRouter.get('/users/:id/company-access', async (req, res) => {
  const access = await adminService.getAccountantCompanyAccess(req.params['id']!);
  res.json(access);
});

adminRouter.post('/users/:id/exclude-company', validate(adminCompanyAccessSchema), async (req, res) => {
  await adminService.excludeCompanyFromAccountant(req.params['id']!, req.body.companyId);
  res.json({ message: 'Company excluded' });
});

adminRouter.post('/users/:id/include-company', validate(adminCompanyAccessSchema), async (req, res) => {
  await adminService.includeCompanyForAccountant(req.params['id']!, req.body.companyId);
  res.json({ message: 'Company included' });
});

// ─── SMTP Test ─────────────────────────────────────────────────

adminRouter.post('/test-smtp', validate(adminSmtpTestSchema), async (req, res) => {
  const result = await testSmtpConnection(req.body, req.body.testEmail);
  res.json(result);
});

// ─── 2FA Configuration ──────────────────────────────────────────

adminRouter.get('/tfa/config', async (req, res) => {
  const config = await tfaConfigService.getConfig();
  res.json(config);
});

adminRouter.put('/tfa/config', validate(adminTfaConfigSchema), async (req, res) => {
  const config = await tfaConfigService.updateConfig(req.body, req.userId);
  res.json(config);
});

adminRouter.post('/tfa/sms-test', validate(adminTfaSmsTestSchema), async (req, res) => {
  const { phoneNumber } = req.body;
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

adminRouter.post('/bank-rules', validate(createBankRuleSchema), async (req, res) => {
  const rule = await bankRulesService.createGlobal(req.body);
  res.status(201).json({ rule });
});

adminRouter.put('/bank-rules/:id', validate(updateBankRuleSchema), async (req, res) => {
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

adminRouter.post('/create-client', validate(adminCreateClientSchema), async (req, res) => {
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

adminRouter.put('/mcp/config', validate(adminMcpConfigSchema), async (req, res) => {
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

adminRouter.put('/plaid/config', validate(adminPlaidConfigSchema), async (req, res) => {
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

// ─── COA Templates ──────────────────────────────────────────────
//
// Super-admin CRUD over the chart-of-accounts templates that ship with
// the app and that admins can extend at runtime. The actual seeding of
// a tenant's accounts table from these templates happens in
// accounts.service.seedFromTemplate.

adminRouter.get('/coa-templates', async (_req, res) => {
  const templates = await coaTemplatesService.list();
  res.json({ templates });
});

adminRouter.get('/coa-templates/:slug', async (req, res) => {
  const template = await coaTemplatesService.getBySlug(req.params['slug']!);
  res.json({ template });
});

adminRouter.post('/coa-templates', validate(createCoaTemplateSchema), async (req, res) => {
  const template = await coaTemplatesService.create(req.body, req.userId);
  res.status(201).json({ template });
});

adminRouter.put('/coa-templates/:slug', validate(updateCoaTemplateSchema), async (req, res) => {
  const template = await coaTemplatesService.update(req.params['slug']!, req.body);
  res.json({ template });
});

adminRouter.delete('/coa-templates/:slug', async (req, res) => {
  await coaTemplatesService.remove(req.params['slug']!);
  res.json({ message: 'Template deleted' });
});

// Toggle hidden state. Body: { hidden: boolean }. Hiding a template
// removes it from the public business-type dropdowns at registration
// / setup time without deleting it. Built-in templates support this
// (since they can't be deleted) and so do custom templates.
adminRouter.patch('/coa-templates/:slug/hidden', async (req, res) => {
  const hidden = req.body?.hidden;
  if (typeof hidden !== 'boolean') {
    res.status(400).json({ error: { message: 'hidden (boolean) is required' } });
    return;
  }
  const template = await coaTemplatesService.setHidden(req.params['slug']!, hidden);
  res.json({ template });
});

// Import = same shape as create. Kept as a separate endpoint so the
// frontend can present a clearer "Import JSON" UI and so we can later
// add format negotiation (CSV, etc.) without breaking the create route.
adminRouter.post('/coa-templates/import', validate(importCoaTemplateSchema), async (req, res) => {
  const template = await coaTemplatesService.create(req.body, req.userId);
  res.status(201).json({ template });
});

adminRouter.post(
  '/coa-templates/from-tenant',
  validate(cloneCoaTemplateFromTenantSchema),
  async (req, res) => {
    const { tenantId, slug, label } = req.body;
    const template = await coaTemplatesService.cloneFromTenant(tenantId, slug, label, req.userId);
    res.status(201).json({ template });
  },
);

// ─── Installation Security (Phase B) ─────────────────────────────

/**
 * Verify the caller's password against the users table. Each of the three
 * destructive security actions below requires a fresh password to prove
 * the admin is still at the keyboard — this is not something we want a
 * stolen session token to unlock.
 */
async function verifyCallerPassword(userId: string, password: string): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT password_hash FROM users WHERE id = ${userId} LIMIT 1
  `);
  const row = (rows.rows as any[])[0];
  if (!row) return false;
  return bcrypt.compare(password, row.password_hash);
}

adminRouter.get('/security/status', async (_req, res) => {
  let sentinelHeader = null;
  if (sentinelExists()) {
    try {
      sentinelHeader = readSentinelHeader();
    } catch {
      sentinelHeader = null;
    }
  }
  const dbInstallationId = await getSetting(SystemSettingsKeys.INSTALLATION_ID);

  // F14: freshness check. Compare the sentinel's stored secret hashes
  // against the live process.env values. If they disagree, something
  // was rotated out-of-band (manual .env edit, different JWT secret
  // pushed via config management, etc.) and the recovery file is no
  // longer consistent with /data/config/.env.
  let recoveryFileStale = false;
  const staleFields: string[] = [];
  const encryptionKey = process.env['ENCRYPTION_KEY'];
  if (sentinelExists() && encryptionKey) {
    try {
      const { readSentinelPayload } = await import('../services/sentinel.service.js');
      const payload = readSentinelPayload(encryptionKey);
      if (payload) {
        const liveDbHash = crypto.createHash('sha256').update(process.env['DATABASE_URL'] ?? '').digest('hex');
        const liveJwtHash = crypto.createHash('sha256').update(process.env['JWT_SECRET'] ?? '').digest('hex');
        if (payload.databaseUrlHash !== liveDbHash) staleFields.push('DATABASE_URL');
        if (payload.jwtSecretHash !== liveJwtHash) staleFields.push('JWT_SECRET');
        recoveryFileStale = staleFields.length > 0;
      }
    } catch {
      // If we can't decrypt the sentinel, freshness is unknowable — leave false.
    }
  }

  res.json({
    sentinelExists: sentinelExists(),
    sentinelHeader,
    recoveryFileExists: recoveryFileExists(),
    recoveryFileStale,
    staleFields,
    dbInstallationId,
  });
});

/**
 * F14: refresh /data/.env.recovery with the current process.env values
 * while keeping the same recovery key. Used when an admin rotates
 * ENCRYPTION_KEY / JWT_SECRET / DATABASE_URL out-of-band and wants the
 * recovery file to stay in sync without regenerating the recovery key.
 *
 * Requires the operator to enter BOTH their password (for step-up auth)
 * AND their current recovery key (to prove they still hold it — we'd
 * otherwise be silently re-encrypting values they might not control).
 */
adminRouter.post('/security/recovery-file/refresh', async (req, res) => {
  const password = (req.body?.password ?? '').toString();
  const recoveryKey = (req.body?.recoveryKey ?? '').toString();
  if (!password || !recoveryKey) {
    res.status(400).json({ error: { message: 'password and recoveryKey required' } });
    return;
  }
  if (!(await verifyCallerPassword(req.userId!, password))) {
    res.status(401).json({ error: { message: 'incorrect password' } });
    return;
  }
  if (!recoveryFileExists()) {
    res.status(404).json({ error: { message: 'no recovery file to refresh' } });
    return;
  }

  // Verify the operator's recovery key matches the current file.
  try {
    const contents = readRecoveryFile(recoveryKey);
    if (!contents) {
      res.status(404).json({ error: { message: 'recovery file missing' } });
      return;
    }
  } catch {
    res.status(401).json({ error: { message: 'recovery key did not decrypt the current recovery file' } });
    return;
  }

  const encryptionKey = process.env['ENCRYPTION_KEY'];
  const jwtSecret = process.env['JWT_SECRET'];
  const databaseUrl = process.env['DATABASE_URL'];
  if (!encryptionKey || !jwtSecret || !databaseUrl) {
    res.status(500).json({
      error: { message: 'ENCRYPTION_KEY, JWT_SECRET, and DATABASE_URL must all be set' },
    });
    return;
  }

  const installationId = await getSetting(SystemSettingsKeys.INSTALLATION_ID);
  try {
    writeRecoveryFile(recoveryKey, { encryptionKey, jwtSecret, databaseUrl }, installationId);
  } catch (err) {
    res.status(500).json({ error: { message: (err as Error).message } });
    return;
  }

  sentinelAudit('recovery.key_regenerated', {
    source: 'admin-security-refresh',
    mode: 'refresh-in-place',
    installationId,
    userId: req.userId,
  });

  res.json({
    success: true,
    message: 'Recovery file refreshed with current environment values. The recovery key is unchanged.',
  });
});

/**
 * Regenerate the recovery key. Requires current password. Returns the new
 * key exactly once — server never persists it. The old recovery key stops
 * working the moment /data/.env.recovery is overwritten.
 */
adminRouter.post('/security/recovery-key/regenerate', async (req, res) => {
  const password = (req.body?.password ?? '').toString();
  if (!password) {
    res.status(400).json({ error: { message: 'current password required' } });
    return;
  }
  if (!(await verifyCallerPassword(req.userId!, password))) {
    res.status(401).json({ error: { message: 'incorrect password' } });
    return;
  }

  const encryptionKey = process.env['ENCRYPTION_KEY'];
  const jwtSecret = process.env['JWT_SECRET'];
  const databaseUrl = process.env['DATABASE_URL'];
  if (!encryptionKey || !jwtSecret || !databaseUrl) {
    res.status(500).json({
      error: { message: 'ENCRYPTION_KEY, JWT_SECRET, and DATABASE_URL must be set' },
    });
    return;
  }

  const installationId = await getSetting(SystemSettingsKeys.INSTALLATION_ID);
  const newKey = generateRecoveryKey();
  try {
    writeRecoveryFile(newKey, { encryptionKey, jwtSecret, databaseUrl }, installationId);
  } catch (err) {
    res.status(500).json({ error: { message: (err as Error).message } });
    return;
  }

  sentinelAudit('recovery.key_regenerated', {
    source: 'admin-security-page',
    installationId,
    userId: req.userId,
  });

  res.json({
    success: true,
    recoveryKey: newKey,
    message: 'New recovery key generated. Save it — it will not be shown again.',
  });
});

/**
 * Test an operator-supplied recovery key without revealing the decrypted
 * values. Responds with success/failure only. Used in admin settings so
 * operators can verify their paper copy still works before needing it in
 * an emergency.
 */
adminRouter.post('/security/recovery-key/test', async (req, res) => {
  const candidate = (req.body?.recoveryKey ?? '').toString();
  if (!candidate) {
    res.status(400).json({ error: { message: 'recoveryKey required' } });
    return;
  }
  if (!recoveryFileExists()) {
    res.status(404).json({ error: { message: 'no recovery file on this server' } });
    return;
  }
  try {
    parseRecoveryKey(candidate);
  } catch (err) {
    res.status(400).json({ valid: false, error: { message: (err as Error).message } });
    return;
  }
  try {
    const contents = readRecoveryFile(candidate);
    if (!contents) {
      res.status(404).json({ valid: false });
      return;
    }
    res.json({ valid: true, createdAt: contents.createdAt, installationId: contents.installationId });
  } catch {
    res.status(401).json({ valid: false });
  }
});

/**
 * Rotate installation_id. Useful after a suspected compromise or a
 * compliance-driven rotation cycle. Regenerates the sentinel with the new
 * ID and writes a new recovery file (with a new recovery key — shown once).
 * Requires current password.
 */
adminRouter.post('/security/installation-id/rotate', async (req, res) => {
  const password = (req.body?.password ?? '').toString();
  if (!password) {
    res.status(400).json({ error: { message: 'current password required' } });
    return;
  }
  if (!(await verifyCallerPassword(req.userId!, password))) {
    res.status(401).json({ error: { message: 'incorrect password' } });
    return;
  }

  const encryptionKey = process.env['ENCRYPTION_KEY'];
  const jwtSecret = process.env['JWT_SECRET'];
  const databaseUrl = process.env['DATABASE_URL'];
  if (!encryptionKey || !jwtSecret || !databaseUrl) {
    res.status(500).json({
      error: { message: 'ENCRYPTION_KEY, JWT_SECRET, and DATABASE_URL must be set' },
    });
    return;
  }

  // Look up admin email for the new sentinel header.
  const adminRow = await db.execute(sql`
    SELECT email FROM users WHERE id = ${req.userId} LIMIT 1
  `);
  const adminEmail = (adminRow.rows as any[])[0]?.email ?? 'unknown';

  let newInstallationId: string;
  let newRecoveryKey: string;
  try {
    const result = await withSetupLock(async () => {
      newInstallationId = crypto.randomUUID();
      await setSetting(SystemSettingsKeys.INSTALLATION_ID, newInstallationId);

      const hostId = ensureHostId();
      deleteSentinel();
      createSentinel(
        {
          installationId: newInstallationId,
          hostId,
          adminEmail,
          appVersion: process.env['APP_VERSION'] || '0.1.0',
          databaseUrl,
          jwtSecret,
          tenantCountAtSetup: 1,
        },
        encryptionKey,
      );

      newRecoveryKey = generateRecoveryKey();
      writeRecoveryFile(
        newRecoveryKey,
        { encryptionKey, jwtSecret, databaseUrl },
        newInstallationId,
      );
      return { installationId: newInstallationId, recoveryKey: newRecoveryKey };
    });

    sentinelAudit('installation.host_id_changed', {
      source: 'admin-security-page',
      reason: 'installation_id rotation',
      newInstallationId: result.installationId,
      userId: req.userId,
    });

    res.json({
      success: true,
      installationId: result.installationId,
      recoveryKey: result.recoveryKey,
      message: 'Installation ID rotated. Save the new recovery key — it will not be shown again.',
    });
  } catch (err) {
    const message = err instanceof SentinelError ? err.message : (err as Error).message;
    res.status(500).json({ error: { message } });
  }
});

/**
 * Delete the recovery file entirely. Used if the operator no longer wants
 * recovery capability (e.g., they manage their env separately and consider
 * the recovery file a liability). Irreversible without a new regenerate.
 */
adminRouter.delete('/security/recovery-key', async (req, res) => {
  const password = (req.body?.password ?? '').toString();
  if (!password) {
    res.status(400).json({ error: { message: 'current password required' } });
    return;
  }
  if (!(await verifyCallerPassword(req.userId!, password))) {
    res.status(401).json({ error: { message: 'incorrect password' } });
    return;
  }
  deleteRecoveryFile();
  sentinelAudit('recovery.key_regenerated', {
    source: 'admin-security-page',
    action: 'delete',
    userId: req.userId,
  });
  res.json({ success: true, message: 'Recovery file deleted.' });
});
