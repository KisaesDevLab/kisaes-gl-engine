import { Router } from 'express';
import multer from 'multer';
import * as setupService from '../services/setup.service.js';
import { createDemoTenant } from '../services/demo-data.service.js';
import {
  stashPendingRecoveryKey,
  peekPendingRecoveryKey,
  acknowledgePendingRecoveryKey,
} from '../services/pending-recovery-key.service.js';
import { getSetting as dbGetSetting } from '../services/admin.service.js';
import { SystemSettingsKeys } from '../constants/system-settings-keys.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 * 1024 } }); // 2 GB

export const setupRouter = Router();

// Security guard: block all setup endpoints once setup is complete.
setupRouter.use(async (req, res, next) => {
  // Always-open endpoints:
  //   - /status: exposes installation state to the wizard bootstrap
  //   - /pending-recovery-key: F22 — post-setup re-display of a still-unacknowledged
  //     recovery key, scoped to a specific installation_id
  //   - /acknowledge-recovery-key: paired with the above, clears the pending entry
  if (
    req.path === '/status' ||
    req.path === '/pending-recovery-key' ||
    req.path === '/acknowledge-recovery-key'
  ) {
    return next();
  }

  // The persistent on-disk marker is authoritative. Once present it can
  // never be flipped back by a transient DB error or a missing volume.
  if (setupService.isInitialized()) {
    res.status(403).json({
      error: { message: 'Setup is already complete. These endpoints are disabled.' },
    });
    return;
  }

  let status: Awaited<ReturnType<typeof setupService.getSetupStatus>>;
  try {
    status = await setupService.getSetupStatus();
  } catch {
    // Any error reaching the status check itself means we can't verify
    // the system's state — fail closed rather than opening destructive
    // endpoints to an anonymous caller.
    res.status(503).json({
      error: { message: 'Unable to verify installation state. Please try again in a moment.' },
    });
    return;
  }

  if (status.setupComplete) {
    res.status(403).json({
      error: { message: 'Setup is already complete. These endpoints are disabled.' },
    });
    return;
  }
  if (status.statusCheckFailed) {
    // Fail closed — the DB hiccup made it impossible to confirm we're on
    // a fresh install. Refuse destructive operations until the operator
    // can prove the system is reachable.
    res.status(503).json({
      error: {
        message:
          'Database state could not be verified. Refusing setup operations until the database is reachable. ' +
          'Please wait for Postgres to come up and retry.',
      },
    });
    return;
  }

  next();
});

setupRouter.get('/status', async (req, res) => {
  const status = await setupService.getSetupStatus();

  // F22: surface pending-recovery-key info so the wizard bootstrap can
  // decide between "setup is genuinely done, go to login" and "setup is
  // done but the operator still needs to save the recovery key."
  let pendingRecoveryKeyForInstall: string | null = null;
  let installationId: string | null = null;
  try {
    installationId = await dbGetSetting(SystemSettingsKeys.INSTALLATION_ID);
    if (installationId) pendingRecoveryKeyForInstall = installationId;
  } catch {
    // DB unreachable — leave null
  }
  const hasPending =
    !!pendingRecoveryKeyForInstall && peekPendingRecoveryKey(pendingRecoveryKeyForInstall) !== null;

  res.json({
    ...status,
    installationId,
    pendingRecoveryKey: hasPending,
  });
});

setupRouter.get('/pending-recovery-key', async (req, res) => {
  const installationId = (req.query?.['installationId'] ?? '').toString();
  if (!installationId) {
    res.status(400).json({ error: { message: 'installationId query parameter required' } });
    return;
  }
  // Cross-check against system_settings: the caller must supply an
  // installation ID that actually matches this server. This stops a curl
  // against a random UUID from enumerating pending entries across servers
  // (not that the Map would return anything useful, but defensive).
  try {
    const dbId = await dbGetSetting(SystemSettingsKeys.INSTALLATION_ID);
    if (!dbId || dbId !== installationId) {
      res.status(404).json({ error: { message: 'no pending recovery key for this installation' } });
      return;
    }
  } catch {
    res.status(503).json({ error: { message: 'database unreachable' } });
    return;
  }
  const key = peekPendingRecoveryKey(installationId);
  if (!key) {
    res.status(404).json({ error: { message: 'no pending recovery key — it may have expired or been acknowledged' } });
    return;
  }
  res.json({ recoveryKey: key });
});

setupRouter.post('/acknowledge-recovery-key', async (req, res) => {
  const installationId = (req.body?.installationId ?? '').toString();
  if (!installationId) {
    res.status(400).json({ error: { message: 'installationId required' } });
    return;
  }
  const cleared = acknowledgePendingRecoveryKey(installationId);
  res.json({ success: true, cleared });
});

setupRouter.post('/generate-secrets', async (req, res) => {
  const secrets = setupService.generateSecrets();
  res.json(secrets);
});

setupRouter.post('/test-database', async (req, res) => {
  const result = await setupService.testDatabaseConnection(req.body);
  res.json(result);
});

// Return the Postgres connection parameters the API container is currently
// running with (parsed from DATABASE_URL) so the wizard's Database step can
// pre-populate fields that actually match the running Postgres service.
// Never returns the password — the operator supplies that themselves so we
// don't leak POSTGRES_PASSWORD over HTTP.
setupRouter.get('/db-defaults', async (_req, res) => {
  res.json(setupService.getDatabaseDefaults());
});

setupRouter.post('/check-port', async (req, res) => {
  const { port } = req.body;
  if (!port || port < 1 || port > 65535) {
    res.status(400).json({ error: { message: 'Invalid port number' } });
    return;
  }
  const result = await setupService.checkPortAvailability(Number(port));
  res.json(result);
});

setupRouter.post('/test-smtp', async (req, res) => {
  const result = await setupService.testSmtpConnection(req.body, req.body.testEmail);
  res.json(result);
});

setupRouter.post('/initialize', async (req, res) => {
  try {
    const config = req.body as setupService.SetupConfig;

    // --- Server-side input validation ---------------------------------
    // The wizard UI also validates, but a bulletproof system must never
    // rely on the client. Reject empty / too-short values here so we can
    // never end up with an unusable .env file (e.g. JWT_SECRET='') or a
    // trivially guessable admin password.
    const reject = (message: string) => {
      res.status(400).json({ error: { message } });
    };
    if (!config || typeof config !== 'object') {
      reject('Missing setup configuration');
      return;
    }
    if (!config.jwtSecret || typeof config.jwtSecret !== 'string' || config.jwtSecret.length < 32) {
      reject('JWT secret must be at least 32 characters');
      return;
    }
    if (!config.backupKey || typeof config.backupKey !== 'string' || config.backupKey.length < 32) {
      reject('Backup encryption key must be at least 32 characters');
      return;
    }
    if (!config.encryptionKey || typeof config.encryptionKey !== 'string' || config.encryptionKey.length < 32) {
      reject('Installation encryption key must be at least 32 characters');
      return;
    }
    if (!config.plaidEncryptionKey || typeof config.plaidEncryptionKey !== 'string' || config.plaidEncryptionKey.length < 32) {
      reject('Token encryption key must be at least 32 characters');
      return;
    }
    if (!config.admin || typeof config.admin !== 'object') {
      reject('Admin account details are required');
      return;
    }
    if (!config.admin.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(config.admin.email)) {
      reject('A valid admin email is required');
      return;
    }
    if (!config.admin.password || config.admin.password.length < 8) {
      reject('Admin password must be at least 8 characters');
      return;
    }
    if (!config.admin.displayName || !config.admin.displayName.trim()) {
      reject('Admin display name is required');
      return;
    }
    if (!config.company || !config.company.name || !config.company.name.trim()) {
      reject('Company name is required');
      return;
    }
    if (!config.db || !config.db.host || !config.db.database || !config.db.username) {
      reject('Database connection details are required');
      return;
    }

    // --- Serialize via advisory lock ----------------------------------
    // Two concurrent /initialize calls must never both proceed. The lock
    // is released automatically in withSetupLock's finally block.
    const result = await setupService.withSetupLock(async () => {
      // Re-check under the lock: another process may have completed
      // setup between the guard check and now.
      if (setupService.isInitialized()) {
        throw new Error('Setup already completed by another process');
      }

      // Step 1: Test database connection
      const dbTest = await setupService.testDatabaseConnection(config.db);
      if (!dbTest.success) {
        // Surface a clearly-labeled prefix so the wizard UI can attribute
        // the failure to the Database step instead of whichever step
        // happens to be "active" when the /initialize promise rejects.
        const isAuth = /password authentication failed/i.test(dbTest.error || '');
        const hint = isAuth
          ? ' Check that the password matches POSTGRES_PASSWORD in your .env file' +
            ` (the wizard does not default this value for you). Postgres reported: ${dbTest.error}`
          : ` ${dbTest.error}`;
        throw new Error(`[step:database] Database connection failed:${hint}`);
      }

      // Step 2: Write .env file (refuses to overwrite an existing file)
      const envPath = setupService.writeEnvFile(config);

      // Step 3: Create admin user and company (refuses if data exists)
      const admin = await setupService.createAdminUser({
        email: config.admin.email,
        password: config.admin.password,
        displayName: config.admin.displayName,
        companyName: config.company.name,
        industry: config.company.industry,
        entityType: config.company.entityType,
        businessType: config.company.businessType,
      });

      // Step 4 (optional): Create a demo tenant with sample data.
      //
      // Wrapped in its own try/catch so a demo-seeding failure does NOT
      // roll back the admin/company creation above — the real setup
      // must still succeed even if the demo step has a bug. Any failure
      // is reported alongside the success response so the operator
      // knows something went wrong without losing the rest of the
      // install.
      let demoResult: Awaited<ReturnType<typeof createDemoTenant>> | null = null;
      let demoError: string | null = null;
      if (config.createDemoCompany) {
        try {
          demoResult = await createDemoTenant(admin.userId, {
            log: (line) => console.log(`[demo-seed] ${line}`),
          });
        } catch (err) {
          demoError = err instanceof Error ? err.message : 'Demo company creation failed';
          console.error('[demo-seed] failed:', err);
        }
      }

      // Step 5: write the installation sentinel and record installation_id
      // in system_settings. This is the linchpin of the false-initialization
      // protection — if this fails, we abort the whole /initialize call so
      // the wizard can be re-run once /data/ is writable. F9.
      //
      // The DATABASE_URL we persist into the sentinel matches what was just
      // written to .env, so the validator can detect a wrong DATABASE_URL on
      // next boot via the hash comparison.
      const dbUrl = `postgresql://${config.db.username}:${config.db.password}@${config.db.host}:${config.db.port}/${config.db.database}`;
      const sentinelResult = await setupService.completeSetupSentinel({
        adminEmail: config.admin.email,
        databaseUrl: dbUrl,
        jwtSecret: config.jwtSecret,
        encryptionKey: config.encryptionKey,
        appVersion: process.env['APP_VERSION'] || '0.1.0',
        tenantCountAtSetup: 1,
      });

      // Step 6: mark the system as initialized. Once this runs, the
      // guard will reject every further call to /initialize and
      // /restore/execute forever, regardless of any transient DB state.
      setupService.markInitialized({
        via: 'initialize',
        tenantId: admin.tenantId,
        installationId: sentinelResult.installationId,
        hostId: sentinelResult.hostId,
      });

      // F22: hold the recovery key in memory so the wizard can re-display
      // it on reload if the operator closes the tab before acknowledging.
      stashPendingRecoveryKey(sentinelResult.installationId, sentinelResult.recoveryKey);

      return {
        success: true,
        message: 'Setup complete! You can now log in.',
        envPath,
        tenantId: admin.tenantId,
        userId: admin.userId,
        installationId: sentinelResult.installationId,
        recoveryKey: sentinelResult.recoveryKey,
        demo: demoResult
          ? {
              tenantId: demoResult.tenantId,
              tenantName: demoResult.tenantName,
              transactionCount: demoResult.counts.total,
              trialBalanceValid: demoResult.trialBalanceValid,
            }
          : null,
        demoError,
      };
    });

    res.status(201).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Setup failed';
    // Map certain errors to more meaningful status codes
    const status =
      message.includes('already in progress') ? 409 :
      message.includes('already exist') || message.includes('already completed') ? 409 :
      message.includes('Refusing to overwrite') ? 409 :
      500;
    res.status(status).json({ error: { message } });
  }
});

// Validate a backup file for restore-during-setup (no auth needed)
setupRouter.post('/restore/validate', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: { message: 'No file uploaded' } });
    return;
  }
  const passphrase = req.body?.passphrase;
  if (!passphrase) {
    res.status(400).json({ error: { message: 'Passphrase is required' } });
    return;
  }

  try {
    const { smartDecrypt } = await import('../services/portable-encryption.service.js');
    const { data, method } = smartDecrypt(req.file.buffer, passphrase);
    const content = JSON.parse(data.toString());
    const metadata = content.metadata ?? {};

    // Determine what's in the backup
    const isSystem = metadata.backup_type === 'system' || metadata.format === 'kis-books-system-v1';

    res.json({
      valid: true,
      method,
      backup_type: isSystem ? 'system' : 'tenant',
      metadata: {
        format: metadata.format,
        source_version: metadata.source_version || metadata.appVersion,
        created_at: metadata.created_at || metadata.timestamp,
        tenant_count: metadata.tenant_count || (isSystem ? Object.keys(content.tenant_data || {}).length : 1),
        user_count: metadata.user_count || (content.users || []).length,
        transaction_count: metadata.transaction_count || metadata.rowCount || 0,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Validation failed';
    res.status(400).json({ error: { message: msg } });
  }
});

// Restore from a system backup during first-run setup
setupRouter.post('/restore/execute', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: { message: 'No file uploaded' } });
    return;
  }
  const passphrase = req.body?.passphrase;
  if (!passphrase) {
    res.status(400).json({ error: { message: 'Passphrase is required' } });
    return;
  }

  try {
    const { sql } = await import('drizzle-orm');
    const { db } = await import('../db/index.js');

    // Refuse to merge a backup into a database that already contains
    // tenants. Restore-during-setup is strictly a fresh-install
    // operation — there is no safe "combine two backups" mode, and
    // ON CONFLICT DO NOTHING would otherwise silently diverge.
    const existingTenants = await db.execute(sql`SELECT COUNT(*) as cnt FROM tenants`);
    const tenantCount = parseInt((existingTenants.rows as any[])[0]?.cnt || '0');
    if (tenantCount > 0) {
      res.status(409).json({
        error: {
          message:
            `Cannot restore: ${tenantCount} tenant(s) already exist in the database. ` +
            `Restore-from-backup is only available on a completely empty install.`,
        },
      });
      return;
    }

    const result = await setupService.withSetupLock(async () => {
      // Re-check under the lock.
      if (setupService.isInitialized()) {
        throw new Error('Setup already completed by another process');
      }
      const recheck = await db.execute(sql`SELECT COUNT(*) as cnt FROM tenants`);
      if (parseInt((recheck.rows as any[])[0]?.cnt || '0') > 0) {
        throw new Error('Tenants appeared between pre-check and lock acquisition');
      }

      const { smartDecrypt } = await import('../services/portable-encryption.service.js');
      const { data } = smartDecrypt(req.file!.buffer, passphrase);
      const content = JSON.parse(data.toString());
      const metadata = content.metadata ?? {};
      const isSystem = metadata.backup_type === 'system' || metadata.format === 'kis-books-system-v1';

      if (isSystem) {
        // System restore: restore tenants, users, tenant data
        // 1. Restore tenants
        for (const tenant of (content.tenants || [])) {
          await db.execute(sql`
            INSERT INTO tenants (id, name, slug, created_at, updated_at)
            VALUES (${tenant.id}, ${tenant.name}, ${tenant.slug},
                    ${tenant.created_at || new Date().toISOString()},
                    ${tenant.updated_at || new Date().toISOString()})
            ON CONFLICT (id) DO NOTHING
          `);
        }

        // 2. Restore users (with hashed passwords preserved)
        for (const user of (content.users || [])) {
          await db.execute(sql`
            INSERT INTO users (id, tenant_id, email, password_hash, display_name, role,
                              is_active, is_super_admin, tfa_enabled, tfa_methods,
                              preferred_login_method, magic_link_enabled)
            VALUES (${user.id}, ${user.tenant_id}, ${user.email}, ${user.password_hash},
                    ${user.display_name || null}, ${user.role || 'owner'},
                    ${user.is_active !== false}, ${user.is_super_admin === true},
                    ${user.tfa_enabled === true}, ${user.tfa_methods || ''},
                    ${user.preferred_login_method || 'password'},
                    ${user.magic_link_enabled === true})
            ON CONFLICT DO NOTHING
          `);
        }

        // 3. Restore user_tenant_access
        for (const uta of (content.user_tenant_access || [])) {
          await db.execute(sql`
            INSERT INTO user_tenant_access (id, user_id, tenant_id, role, is_active)
            VALUES (${uta.id}, ${uta.user_id}, ${uta.tenant_id}, ${uta.role || 'owner'}, ${uta.is_active !== false})
            ON CONFLICT DO NOTHING
          `);
        }

        // 4. Restore per-tenant data
        const tenantData = content.tenant_data || {};
        for (const [, tables] of Object.entries(tenantData)) {
          const tableData = tables as Record<string, Record<string, unknown>[]>;
          // Ordered table restore (respecting foreign keys)
          const tableOrder = [
            'companies', 'accounts', 'contacts', 'items',
            'tag_groups', 'tags', 'transactions', 'journal_lines',
            'transaction_tags', 'bill_payment_applications', 'vendor_credit_applications',
            'bank_rules', 'budgets', 'budget_lines',
            'recurring_schedules', 'attachments', 'audit_log',
            'saved_report_filters',
          ];

          // First restore ordered tables, then any remaining
          const restored = new Set<string>();
          for (const tableName of tableOrder) {
            const rows = tableData[tableName];
            if (!rows || rows.length === 0) continue;
            await restoreTableRows(db, tableName, rows);
            restored.add(tableName);
          }
          // Remaining tables not in the ordered list
          for (const [tableName, rows] of Object.entries(tableData)) {
            if (restored.has(tableName) || !rows || rows.length === 0) continue;
            await restoreTableRows(db, tableName, rows);
          }
        }

        // Write the installation sentinel after a successful system restore.
        // Phase A doesn't yet include sentinel data in backup archives, so we
        // generate a fresh installation_id + host ID as if this were a new
        // install. Phase C will extract these from the backup metadata and
        // branch on cross-host vs same-host restore via the host-id signal.
        //
        // We need an encryption key to write the sentinel. The restore flow
        // runs against an already-started container, so env.ts has been
        // loaded — ENCRYPTION_KEY is guaranteed to be in process.env by the
        // time this code runs in Phase A.
        const encryptionKeyForRestore = process.env['ENCRYPTION_KEY'];
        const jwtSecretForRestore = process.env['JWT_SECRET'];
        const databaseUrlForRestore = process.env['DATABASE_URL'];
        if (!encryptionKeyForRestore || !jwtSecretForRestore || !databaseUrlForRestore) {
          throw new Error(
            'Cannot finalize restore: ENCRYPTION_KEY, JWT_SECRET, and DATABASE_URL must all be set in the environment before running a system restore.',
          );
        }
        // Find the first super-admin in the restored users so the sentinel
        // header can record who owns the installation. Falls back to the
        // first user if no super admin is present.
        const restoredUsers = (content.users || []) as Array<{ email?: string; is_super_admin?: boolean }>;
        const superAdmin = restoredUsers.find((u) => u.is_super_admin) ?? restoredUsers[0];
        const restoreAdminEmail = superAdmin?.email ?? 'restored-installation@unknown';

        // Phase C: cross-host restore detection. The backup archive may
        // include the source server's `installation_files.hostId`. If the
        // current /data volume has a matching host-id, this is a same-host
        // restore — we still regenerate the sentinel because the DB has
        // been reset, but we keep the old installation_id to preserve
        // continuity for the operator. If it doesn't match, this is a new
        // host and we generate fresh IDs across the board.
        const restoredInstallationFiles = (content as { installation_files?: { hostId?: string | null; sentinel?: string | null; envRecovery?: string | null } }).installation_files ?? {};
        const restoredHostId = restoredInstallationFiles.hostId ?? null;
        const { readHostId } = await import('../services/host-id.service.js');
        const currentHostId = readHostId();
        const isSameHost = restoredHostId !== null && currentHostId !== null && restoredHostId === currentHostId;

        if (!isSameHost) {
          // eslint-disable-next-line no-console
          console.log(
            `[sentinel-audit] ${JSON.stringify({
              ts: new Date().toISOString(),
              kind: 'sentinel-audit',
              event: 'installation.host_id_changed',
              source: 'restore/execute',
              restoredHostId,
              currentHostId,
              reason: restoredHostId === null ? 'backup missing host-id field' : 'host-id mismatch',
            })}`,
          );
        }

        const sentinelResultRestore = await setupService.completeSetupSentinel({
          adminEmail: restoreAdminEmail,
          databaseUrl: databaseUrlForRestore,
          jwtSecret: jwtSecretForRestore,
          encryptionKey: encryptionKeyForRestore,
          appVersion: process.env['APP_VERSION'] || '0.1.0',
          tenantCountAtSetup: (content.tenants || []).length || 1,
        });

        // Mark initialized after successful restore.
        setupService.markInitialized({
          via: 'restore/system',
          installationId: sentinelResultRestore.installationId,
          hostId: sentinelResultRestore.hostId,
          crossHostRestore: !isSameHost,
        });

        // F22: stash for wizard re-display resilience.
        stashPendingRecoveryKey(
          sentinelResultRestore.installationId,
          sentinelResultRestore.recoveryKey,
        );

        return {
          success: true,
          message: isSameHost
            ? 'System restored successfully (same host detected)'
            : 'System restored successfully (new host — new recovery key issued)',
          tenants_restored: (content.tenants || []).length,
          users_restored: (content.users || []).length,
          installationId: sentinelResultRestore.installationId,
          recoveryKey: sentinelResultRestore.recoveryKey,
          crossHostRestore: !isSameHost,
          checklist: {
            smtp: { status: 'warning', message: 'SMTP not configured — email features unavailable' },
            plaid: { status: 'warning', message: 'Plaid not configured — bank feeds unavailable' },
            ai: { status: 'warning', message: 'AI not configured — AI features unavailable' },
            users: { status: 'ok', message: `${(content.users || []).length} user accounts restored` },
            tenants: { status: 'ok', message: `${(content.tenants || []).length} companies restored` },
          },
        };
      } else {
        // Tenant-scoped backup restore
        const tables = content.tables || {};
        const tenantId = metadata.tenantId;

        if (!tenantId) {
          throw new Error('Backup does not contain tenant information');
        }

        // Check if tenant already exists
        const existing = await db.execute(sql`SELECT id FROM tenants WHERE id = ${tenantId}`);
        if ((existing.rows as unknown[]).length === 0) {
          await db.execute(sql`
            INSERT INTO tenants (id, name, slug)
            VALUES (${tenantId}, ${'Restored Company'}, ${'restored-' + tenantId.substring(0, 8)})
          `);
        }

        for (const [tableName, rows] of Object.entries(tables)) {
          if (!rows || !(rows as unknown[]).length) continue;
          await restoreTableRows(db, tableName, rows as Record<string, unknown>[]);
        }

        // Mark initialized after successful restore. Tenant-scoped restore
        // does NOT touch the sentinel (F26): a tenant backup does not
        // represent a full installation, so generating a sentinel here
        // would produce a misleading "installation was set up" record
        // without the usual admin user, COA seed, or installation-wide
        // configuration. The current flow writes the .initialized marker
        // without a sentinel, which the validator will catch as Case 3
        // (regenerate-sentinel) on next boot — the regenerate path will
        // use the installation_id from system_settings if set, and this
        // tenant-restore flow does not set it, so the next boot will
        // effectively behave as a fresh install against a DB with one
        // restored tenant. This is pre-existing weirdness in the restore
        // flow and is tracked for Phase C cleanup.
        setupService.markInitialized({ via: 'restore/tenant', tenantId });

        return {
          success: true,
          message: 'Tenant data restored',
          tenant_id: tenantId,
          row_count: metadata.rowCount,
          checklist: {
            smtp: { status: 'warning', message: 'SMTP not configured — email features unavailable' },
            plaid: { status: 'warning', message: 'Plaid not configured — bank feeds unavailable' },
            users: { status: 'warning', message: 'Create an admin account to access the restored data' },
          },
        };
      }
    });

    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Restore failed';
    const status =
      msg.includes('already in progress') ? 409 :
      msg.includes('already exist') || msg.includes('already completed') ? 409 :
      msg.includes('tenant information') ? 400 :
      500;
    res.status(status).json({ error: { message: msg } });
  }
});

/**
 * Restore rows into a table using raw SQL INSERT.
 * Uses column names from the first row. Skips on conflict.
 */
async function restoreTableRows(
  dbInstance: typeof import('../db/index.js')['db'],
  tableName: string,
  rows: Record<string, unknown>[],
) {
  if (!rows.length) return;
  // Validate table name
  if (!/^[a-z_][a-z0-9_]*$/.test(tableName)) return;

  const { sql } = await import('drizzle-orm');

  for (const row of rows) {
    const cols = Object.keys(row).filter((k) => /^[a-z_][a-z0-9_]*$/.test(k));
    if (cols.length === 0) continue;

    const colNames = cols.map((c) => sql.identifier(c));
    const values = cols.map((c) => {
      const v = row[c];
      if (v === null || v === undefined) return sql`NULL`;
      if (typeof v === 'object') return sql`${JSON.stringify(v)}::jsonb`;
      return sql`${String(v)}`;
    });

    try {
      // Build: INSERT INTO table (col1, col2) VALUES (v1, v2) ON CONFLICT DO NOTHING
      const colList = sql.join(colNames, sql`, `);
      const valList = sql.join(values, sql`, `);
      await dbInstance.execute(
        sql`INSERT INTO ${sql.identifier(tableName)} (${colList}) VALUES (${valList}) ON CONFLICT DO NOTHING`,
      );
    } catch {
      // Skip rows that fail (e.g., FK constraint for not-yet-restored references)
    }
  }
}
