import { Router } from 'express';
import multer from 'multer';
import * as setupService from '../services/setup.service.js';
import { createDemoTenant } from '../services/demo-data.service.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 * 1024 } }); // 2 GB

export const setupRouter = Router();

// Endpoints that require a valid X-Setup-Token header on top of the
// standard "setup not yet complete" guard. These are the only endpoints
// that can destroy data or plant a super-admin user, so they get the
// strongest protection: the token is generated once on first boot,
// printed to the server console, and consumed on successful completion.
const DESTRUCTIVE_ENDPOINTS = new Set(['/initialize', '/restore/execute']);

// Paths that are always reachable, regardless of setup state — status
// lookup and token validation must work even after setup is complete
// (though token validation will simply return { valid: false } once the
// token file has been consumed).
const PUBLIC_SETUP_PATHS = new Set(['/status', '/validate-token']);

// Security guard: block all setup endpoints once setup is complete, and
// additionally require a valid setup token for destructive endpoints.
setupRouter.use(async (req, res, next) => {
  if (PUBLIC_SETUP_PATHS.has(req.path)) return next();

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

  // For destructive endpoints, additionally require the X-Setup-Token
  // header. The token is printed to the server console on first boot and
  // only someone with console (or filesystem) access can read it.
  if (DESTRUCTIVE_ENDPOINTS.has(req.path)) {
    const headerToken = req.headers['x-setup-token'];
    const token = Array.isArray(headerToken) ? headerToken[0] : headerToken;
    if (!setupService.validateSetupToken(token)) {
      res.status(401).json({
        error: {
          message:
            'Invalid or missing setup token. Check the server console for the token printed during startup, or look at /data/config/.setup-token on the API container filesystem.',
        },
      });
      return;
    }
  }

  next();
});

setupRouter.get('/status', async (req, res) => {
  const status = await setupService.getSetupStatus();
  res.json(status);
});

// Returns { valid: boolean }. Callable even after setup completes; after
// the token has been consumed the endpoint will simply report
// { valid: false }. Accepts the token in the JSON body (not a header) so
// the wizard UI can check validity before submitting the full form.
setupRouter.post('/validate-token', (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : undefined;
  const valid = setupService.validateSetupToken(token);
  res.json({ valid });
});

setupRouter.post('/generate-secrets', async (req, res) => {
  const secrets = setupService.generateSecrets();
  res.json(secrets);
});

setupRouter.post('/test-database', async (req, res) => {
  const result = await setupService.testDatabaseConnection(req.body);
  res.json(result);
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
        throw new Error(`Database connection failed: ${dbTest.error}`);
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

      // Step 5: mark the system as initialized and consume the setup
      // token. Once this runs, the guard will reject every further call
      // to /initialize and /restore/execute forever, regardless of any
      // transient DB state.
      setupService.markInitialized({
        via: 'initialize',
        tenantId: admin.tenantId,
      });
      setupService.consumeSetupToken();

      return {
        success: true,
        message: 'Setup complete! You can now log in.',
        envPath,
        tenantId: admin.tenantId,
        userId: admin.userId,
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

        // Mark initialized + consume token after successful restore.
        setupService.markInitialized({ via: 'restore/system' });
        setupService.consumeSetupToken();

        return {
          success: true,
          message: 'System restored successfully',
          tenants_restored: (content.tenants || []).length,
          users_restored: (content.users || []).length,
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

        // Mark initialized + consume token after successful restore.
        setupService.markInitialized({ via: 'restore/tenant', tenantId });
        setupService.consumeSetupToken();

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
