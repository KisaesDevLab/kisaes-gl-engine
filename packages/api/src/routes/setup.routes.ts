// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import * as setupService from '../services/setup.service.js';
import { createDemoTenant } from '../services/demo-data.service.js';
import {
  stashPendingRecoveryKey,
  peekPendingRecoveryKey,
  acknowledgePendingRecoveryKey,
} from '../services/pending-recovery-key.service.js';
import { getSetting as dbGetSetting } from '../services/admin.service.js';
import { SystemSettingsKeys } from '../constants/system-settings-keys.js';
import {
  mergeBundleSections,
  restoreDatabaseSections,
  resyncOwnedSequences,
  buildRestoreChecklist,
  writeBackBundleFiles,
  type RestoreReport,
  type FileRestoreReport,
} from '../services/system-restore.service.js';

// Restore uploads go to DISK, not memory: an attachments-included .vmx system
// backup can be many GB (createSystemBackup caps attachments at 10 GB), and
// buffering that in RAM either OOMs the process or (with the old 2 GB limit)
// makes large backups structurally unrestorable. The .vmx reader streams from
// the file path; legacy .vmb blobs (DB-only, small) are read into a buffer.
const RESTORE_UPLOAD_DIR = path.join(process.env['UPLOAD_DIR'] || '/data/uploads', '.restore-tmp');
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(RESTORE_UPLOAD_DIR, { recursive: true });
      cb(null, RESTORE_UPLOAD_DIR);
    },
    filename: (_req, _file, cb) => cb(null, `restore-${crypto.randomUUID()}`),
  }),
  limits: { fileSize: 12 * 1024 * 1024 * 1024 }, // 12 GB — above the .vmx attachment cap
});

// Read an uploaded restore file: sniff the 4-byte ZIP magic from disk, and
// load the full buffer only for the legacy .vmb path.
function isZipFile(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  } finally {
    fs.closeSync(fd);
  }
}

// Rate-limit the pre-setup endpoints: they're unauthenticated (by design —
// the first-run wizard has to be reachable before any user exists) and a
// few of them perform real network / subprocess work (test-database,
// test-smtp, check-port). Without a limiter, a LAN-reachable pre-install
// server acts as a free port scanner / SMTP prober for anyone on the
// network. Tight limit because legitimate wizard traffic is a handful of
// calls from one browser.
const setupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many setup requests', code: 'SETUP_RATE_LIMIT' } },
});

export const setupRouter = Router();
setupRouter.use(setupLimiter);

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

// Return the Postgres connection parameters (including the auto-generated
// POSTGRES_PASSWORD) that the API container is currently running with,
// parsed from DATABASE_URL. The wizard uses these to pre-fill the Database
// step so the end user — who never sees the POSTGRES_PASSWORD minted by
// scripts/install.sh — can click straight through without typing anything.
//
// Safe by construction: this endpoint sits behind the same route guard
// that blocks every non-status setup endpoint once .initialized exists
// (see setupRouter.use above). Post-setup the endpoint returns 403. See
// the getDatabaseDefaults() docstring for the full threat-model rationale.
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
    // plaidEncryptionKey: clients no longer submit this (the wizard used
    // to surface it; it's now entirely server-side because non-technical
    // operators kept asking "what is this Plaid thing?" during setup).
    // If the client omits it we mint one here using crypto.randomBytes so
    // the rest of the flow always has a valid value. The key is still
    // validated on API boot by config/env.ts, and the recovery-key flow
    // still writes it into /data/.env.recovery alongside the others — so
    // nothing downstream changes.
    if (!config.plaidEncryptionKey || typeof config.plaidEncryptionKey !== 'string' || config.plaidEncryptionKey.length < 32) {
      const { randomBytes } = await import('crypto');
      config.plaidEncryptionKey = randomBytes(32).toString('hex');
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

  const uploadedPath = req.file.path;
  try {
    const { smartDecrypt } = await import('../services/portable-encryption.service.js');
    const { readTenantPackage } = await import('../services/vmx-package.js');
    let content;
    let method: 'passphrase' | 'server_key' = 'passphrase';
    if (isZipFile(uploadedPath)) {
      // .vmx package — readTenantPackage streams entries from the file path
      // (no whole-file buffering; the data payload is small).
      const pkg = await readTenantPackage(uploadedPath, passphrase);
      content = pkg.data;
    } else {
      // Legacy .vmb — a single encrypted JSON blob (DB-only, small).
      const decrypted = smartDecrypt(fs.readFileSync(uploadedPath), passphrase);
      content = JSON.parse(decrypted.data.toString());
      method = decrypted.method;
    }
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
  } finally {
    try { fs.unlinkSync(uploadedPath); } catch { /* already gone */ }
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
    const result = await runGuardedSetupRestore(async () => {
      // A .vmx package (ZIP) carries the DB dump plus attachment files; a
      // legacy .vmb/.kbk is a single encrypted JSON blob. Detect and read the
      // right one; `content` is the same DB payload either way. The .vmx is
      // read from its DISK path (streamed entries — a multi-GB package never
      // fully buffers); only the small legacy blob is loaded whole.
      const { smartDecrypt } = await import('../services/portable-encryption.service.js');
      const { readTenantPackage } = await import('../services/vmx-package.js');
      if (isZipFile(req.file!.path)) {
        const pkg = await readTenantPackage(req.file!.path, passphrase);
        return { content: pkg.data as RestoreContent, packageAttachments: () => pkg.attachments() };
      }
      const { data } = smartDecrypt(fs.readFileSync(req.file!.path), passphrase);
      return { content: JSON.parse(data.toString()) as RestoreContent, packageAttachments: null };
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
  } finally {
    // The uploaded backup landed on disk (multer diskStorage) — always
    // remove it, success or failure.
    try { fs.unlinkSync(req.file.path); } catch { /* already gone */ }
  }
});

// `content` is the decrypted DB payload (evolving-any, exactly as the
// original JSON.parse path — rows are re-inserted via parameterized SQL).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RestoreContent = any;

type ContentSource = () => Promise<{
  content: RestoreContent;
  packageAttachments: (() => AsyncGenerator<{ id: string; buffer: Buffer }>) | null;
}>;

/**
 * Shared core of restore-during-setup: emptiness guard, setup lock, row
 * re-insertion, attachment write-back, sentinel + marker finalization.
 * Both the single-file /restore/execute path and the staged multi-part
 * /restore/execute-staged path run through here — the only difference
 * between them is how `readContent` produces the decrypted payload.
 */
async function runGuardedSetupRestore(readContent: ContentSource): Promise<Record<string, unknown>> {
  const { sql } = await import('drizzle-orm');
  const { db } = await import('../db/index.js');

  // Refuse to merge a backup into a database that already contains
  // tenants. Restore-during-setup is strictly a fresh-install
  // operation — there is no safe "combine two backups" mode, and
  // ON CONFLICT DO NOTHING would otherwise silently diverge.
  const existingTenants = await db.execute(sql`SELECT COUNT(*) as cnt FROM tenants`);
  const tenantCount = parseInt((existingTenants.rows as any[])[0]?.cnt || '0');
  if (tenantCount > 0) {
    throw new Error(
      `Cannot restore: ${tenantCount} tenant(s) already exist in the database. ` +
      `Restore-from-backup is only available on a completely empty install.`,
    );
  }

  return setupService.withSetupLock(async () => {
      // Re-check under the lock.
      if (setupService.isInitialized()) {
        throw new Error('Setup already completed by another process');
      }
      const recheck = await db.execute(sql`SELECT COUNT(*) as cnt FROM tenants`);
      if (parseInt((recheck.rows as any[])[0]?.cnt || '0') > 0) {
        throw new Error('Tenants appeared between pre-check and lock acquisition');
      }

      const { content, packageAttachments } = await readContent();
      const metadata = content.metadata ?? {};
      const isSystem =
        metadata.backup_type === 'system' ||
        metadata.format === 'kis-books-system-v1' ||
        metadata.format === 'kis-books-system-v2';

      if (isSystem) {
        // System restore: merge every bundle section into one table → rows[]
        // map and hand it to the dynamic restore engine, which topo-orders by
        // the live FK graph and retries to fixpoint. This replaces the old
        // hardcoded INSERTs (which dropped most user/tenant columns) and the
        // silent per-row catch{} (which hid every FK-ordering loss).
        const sections = mergeBundleSections(content);
        const restoreReport: RestoreReport = await restoreDatabaseSections(db, sections);

        // Restored rows carry their original serial ids; bring every owned
        // sequence up to date or the first post-restore write to a
        // serial-PK table (e.g. audit_log on first login) hits duplicate-key.
        await resyncOwnedSequences(db);

        // Restore bundled FILES (present only in .vmx packages): receipt
        // attachments, extraction sources, portal receipt/Q&A uploads,
        // payroll import files, and report PDFs — each written back through
        // the owning tenant's storage provider (or under UPLOAD_DIR for
        // payroll local files).
        let fileReport: FileRestoreReport | null = null;
        if (packageAttachments) {
          fileReport = await writeBackBundleFiles(sections, packageAttachments);
          console.log('[restore] file write-back:', JSON.stringify(fileReport));
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

        // Same-host restore: the bundle carries the source install's
        // .env.recovery verbatim, and on the same host the env values inside
        // it are still correct — write it back (overwriting the fresh file
        // completeSetupSentinel just minted) so the operator's original
        // recovery key stays valid. Cross-host keeps rotate-on-restore: the
        // old file would decrypt to the *source* server's secrets.
        let recoveryKeyPreserved = false;
        if (isSameHost && restoredInstallationFiles.envRecovery) {
          try {
            const { writeRecoveryFileRaw } = await import('../services/env-recovery.service.js');
            writeRecoveryFileRaw(Buffer.from(restoredInstallationFiles.envRecovery, 'base64'));
            recoveryKeyPreserved = true;
            // eslint-disable-next-line no-console
            console.log(
              `[sentinel-audit] ${JSON.stringify({
                ts: new Date().toISOString(),
                kind: 'sentinel-audit',
                event: 'recovery.file_restored_from_backup',
                source: 'restore/execute',
                installationId: sentinelResultRestore.installationId,
              })}`,
            );
          } catch (err) {
            // Fall through to the new-key flow — worst case the operator
            // gets a rotated key, same as before this write-back existed.
            console.error('[restore] recovery file write-back failed, issuing new key:', err instanceof Error ? err.message : err);
          }
        }

        // F22: stash for wizard re-display resilience — only when a new key
        // was actually issued and must be shown to the operator.
        if (!recoveryKeyPreserved) {
          stashPendingRecoveryKey(
            sentinelResultRestore.installationId,
            sentinelResultRestore.recoveryKey,
          );
        }

        // Checklist reflects what was ACTUALLY restored — the previous
        // hardcoded 'not configured' literals ignored the bundle entirely.
        const checklist = await buildRestoreChecklist(db);

        const warnings: string[] = [];
        if (restoreReport.totals.failed > 0) {
          warnings.push(
            `${restoreReport.totals.failed} row(s) could not be restored — see tables report`,
          );
        }
        if (fileReport && Object.values(fileReport.perTable).some((t) => t.failed > 0)) {
          warnings.push('Some bundled files could not be written back — see files report');
        }

        return {
          success: true,
          message: recoveryKeyPreserved
            ? 'System restored successfully — your existing recovery key remains valid'
            : isSameHost
              ? 'System restored successfully (same host detected — new recovery key issued)'
              : 'System restored successfully (new host — new recovery key issued)',
          tenants_restored: (content.tenants || []).length,
          users_restored: (content.users || []).length,
          installationId: sentinelResultRestore.installationId,
          recoveryKey: recoveryKeyPreserved ? null : sentinelResultRestore.recoveryKey,
          recoveryKeyPreserved,
          crossHostRestore: !isSameHost,
          tables: {
            totals: restoreReport.totals,
            passes: restoreReport.passes,
            failures: Object.fromEntries(
              Object.entries(restoreReport.perTable)
                .filter(([, s]) => s.failed > 0)
                .map(([t, s]) => [t, { failed: s.failed, sampleErrors: s.sampleErrors }]),
            ),
          },
          files: fileReport,
          warnings,
          checklist,
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

        const sections: Record<string, Record<string, unknown>[]> = {};
        for (const [tableName, rows] of Object.entries(tables)) {
          if (Array.isArray(rows) && rows.length > 0) sections[tableName] = rows as Record<string, unknown>[];
        }
        const restoreReport: RestoreReport = await restoreDatabaseSections(db, sections);

        // Same sequence-resync as the system branch — restored serial ids
        // leave owned sequences behind otherwise.
        await resyncOwnedSequences(db);

        // Tenant .vmx packages carry attachment/upload files too; write them
        // back (the old flow ignored them entirely on this branch).
        let fileReport: FileRestoreReport | null = null;
        if (packageAttachments) {
          fileReport = await writeBackBundleFiles(sections, packageAttachments);
          console.log('[restore] file write-back:', JSON.stringify(fileReport));
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

        const checklist = await buildRestoreChecklist(db);
        // A tenant bundle carries no user accounts — keep the actionable hint.
        checklist['users'] = { status: 'warning', message: 'Create an admin account to access the restored data' };

        return {
          success: true,
          message: 'Tenant data restored',
          tenant_id: tenantId,
          row_count: metadata.rowCount,
          tables: {
            totals: restoreReport.totals,
            passes: restoreReport.passes,
            failures: Object.fromEntries(
              Object.entries(restoreReport.perTable)
                .filter(([, s]) => s.failed > 0)
                .map(([t, s]) => [t, { failed: s.failed, sampleErrors: s.sampleErrors }]),
            ),
          },
          files: fileReport,
          checklist,
        };
      }
  });
}

// ─── Staged multi-part restore ──────────────────────────────────────
//
// A disaster-recovery bundle larger than the per-request upload ceiling
// between the operator and this appliance arrives as SEVERAL .vmx part
// files (see vmx-package.ts). Each part uploads in its own request to
// /restore/stage, which fully validates it (passphrase, authenticated
// inventory, ZIP contents) and parks it on disk keyed by the series'
// backupId. Once every part is staged, /restore/execute-staged assembles
// and cross-validates the series and runs the exact same guarded restore
// core as the single-file path. Classic single-file .vmx/.vmb uploads
// also work through this flow (partCount 1), so new clients need only
// one code path.
//
// These endpoints sit behind the same setup guard as everything else in
// this router: they exist only while the appliance has no admin user.

const STAGE_ROOT = path.join(RESTORE_UPLOAD_DIR, 'staged');
const STAGE_TTL_MS = 48 * 60 * 60 * 1000;

interface StageMeta {
  backupId: string;
  classic: boolean;
  createdAt: string;
  updatedAt: string;
  /** Known once the series-bearing (final) part has been staged. */
  partCount: number | null;
  parts: Record<string, { size: number; uploadedAt: string }>;
}

function assertStageId(backupId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(backupId)) {
    throw new Error('Invalid backup id');
  }
}

function stageDirFor(backupId: string): string {
  assertStageId(backupId);
  return path.join(STAGE_ROOT, backupId.toLowerCase());
}

function readStageMeta(backupId: string): StageMeta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(stageDirFor(backupId), 'meta.json'), 'utf8')) as StageMeta;
  } catch {
    return null;
  }
}

function writeStageMeta(meta: StageMeta): void {
  const dir = stageDirFor(meta.backupId);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.meta.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, path.join(dir, 'meta.json'));
}

function stageSummary(meta: StageMeta) {
  const received = Object.keys(meta.parts).map(Number).sort((a, b) => a - b);
  const complete =
    meta.partCount !== null &&
    received.length === meta.partCount &&
    received.every((idx, i) => idx === i + 1);
  return {
    backupId: meta.backupId,
    classic: meta.classic,
    partCount: meta.partCount,
    received,
    complete,
  };
}

/** Drop staged sessions that were never completed. Called opportunistically. */
function purgeStaleStageSessions(): void {
  try {
    if (!fs.existsSync(STAGE_ROOT)) return;
    for (const entry of fs.readdirSync(STAGE_ROOT)) {
      const dir = path.join(STAGE_ROOT, entry);
      try {
        const st = fs.statSync(path.join(dir, 'meta.json'));
        if (Date.now() - st.mtimeMs > STAGE_TTL_MS) fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // No meta — half-created dir; age it out by directory mtime.
        try {
          if (Date.now() - fs.statSync(dir).mtimeMs > STAGE_TTL_MS) {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        } catch { /* raced away */ }
      }
    }
  } catch { /* best-effort */ }
}

// Stage one backup file (a multi-part .vmx part, or a classic single-file
// .vmx/.vmb). The part is fully validated against the supplied passphrase
// before it is accepted, so a corrupt or mismatched file fails THIS request
// instead of poisoning the final restore.
setupRouter.post('/restore/stage', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: { message: 'No file uploaded' } });
    return;
  }
  const passphrase = req.body?.passphrase;
  if (!passphrase || typeof passphrase !== 'string') {
    try { fs.unlinkSync(req.file.path); } catch { /* already gone */ }
    res.status(400).json({ error: { message: 'Passphrase is required' } });
    return;
  }

  purgeStaleStageSessions();

  try {
    let meta: StageMeta;
    let partIndex = 1;

    if (isZipFile(req.file.path)) {
      const { openAndVerifyPart } = await import('../services/vmx-package.js');
      const verified = await openAndVerifyPart(req.file.path, passphrase);

      if (verified.multipart) {
        const { backupId } = verified.multipart;
        partIndex = verified.multipart.partIndex;
        assertStageId(backupId);
        const existing = readStageMeta(backupId);
        meta = existing ?? {
          backupId: backupId.toLowerCase(),
          classic: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          partCount: null,
          parts: {},
        };
        if (verified.hasSeries && verified.series) {
          const declared = Number((verified.series as { partCount?: unknown }).partCount);
          if (!Number.isInteger(declared) || declared < 1 || declared > 10_000) {
            throw new Error('Backup series descriptor is malformed');
          }
          if (meta.partCount !== null && meta.partCount !== declared) {
            throw new Error('Conflicting part counts across staged files');
          }
          meta.partCount = declared;
        }
        if (meta.partCount !== null && partIndex > meta.partCount) {
          throw new Error(`Part index ${partIndex} exceeds the declared part count ${meta.partCount}`);
        }
        const dir = stageDirFor(meta.backupId);
        fs.mkdirSync(dir, { recursive: true });
        fs.renameSync(req.file.path, path.join(dir, `part${partIndex}.vmx`));
        meta.parts[String(partIndex)] = { size: req.file.size, uploadedAt: new Date().toISOString() };
        meta.updatedAt = new Date().toISOString();
        writeStageMeta(meta);
        res.json(stageSummary(meta));
        return;
      }
      // Classic single-file .vmx (openAndVerifyPart already proved the
      // passphrase against it) — falls through to classic staging below.
    } else {
      // Legacy .vmb/.kbk blob: prove the passphrase before accepting.
      const { smartDecrypt } = await import('../services/portable-encryption.service.js');
      JSON.parse(smartDecrypt(fs.readFileSync(req.file.path), passphrase).data.toString());
    }

    // Classic (single-file) staging: mint a session id, one part, complete.
    const backupId = crypto.randomUUID();
    meta = {
      backupId,
      classic: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      partCount: 1,
      parts: { '1': { size: req.file.size, uploadedAt: new Date().toISOString() } },
    };
    const dir = stageDirFor(backupId);
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(req.file.path, path.join(dir, 'part1.vmx'));
    writeStageMeta(meta);
    res.json(stageSummary(meta));
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch { /* already staged or gone */ }
    const msg = err instanceof Error ? err.message : 'Staging failed';
    res.status(400).json({ error: { message: msg } });
  }
});

// Staging progress for a series — lets the wizard resume after a reload.
setupRouter.get('/restore/stage/:backupId', (req, res) => {
  try {
    const meta = readStageMeta(req.params['backupId']!);
    if (!meta) {
      res.status(404).json({ error: { message: 'No staged backup with that id' } });
      return;
    }
    res.json(stageSummary(meta));
  } catch {
    res.status(400).json({ error: { message: 'Invalid backup id' } });
  }
});

// Assemble a fully-staged series and run the guarded restore core.
setupRouter.post('/restore/execute-staged', async (req, res) => {
  const backupId = (req.body?.backupId ?? '').toString();
  const passphrase = req.body?.passphrase;
  if (!passphrase || typeof passphrase !== 'string') {
    res.status(400).json({ error: { message: 'Passphrase is required' } });
    return;
  }
  let meta: StageMeta | null = null;
  try {
    meta = readStageMeta(backupId);
  } catch {
    res.status(400).json({ error: { message: 'Invalid backup id' } });
    return;
  }
  if (!meta) {
    res.status(404).json({ error: { message: 'No staged backup with that id — upload the part files first' } });
    return;
  }
  const summary = stageSummary(meta);
  if (!summary.complete) {
    res.status(409).json({
      error: {
        message: meta.partCount === null
          ? `Staged ${summary.received.length} part(s) but the final part (which declares the total) has not been uploaded yet.`
          : `Staged ${summary.received.length} of ${meta.partCount} part(s). Upload the remaining part(s) before restoring.`,
      },
    });
    return;
  }

  const dir = stageDirFor(meta.backupId);
  const paths = summary.received.map((idx) => path.join(dir, `part${idx}.vmx`));

  try {
    const result = await runGuardedSetupRestore(async () => {
      if (meta!.classic && !isZipFile(paths[0]!)) {
        const { smartDecrypt } = await import('../services/portable-encryption.service.js');
        const { data } = smartDecrypt(fs.readFileSync(paths[0]!), passphrase);
        return { content: JSON.parse(data.toString()) as RestoreContent, packageAttachments: null };
      }
      const { readTenantPackageMulti } = await import('../services/vmx-package.js');
      const pkg = await readTenantPackageMulti(paths, passphrase);
      return { content: pkg.data as RestoreContent, packageAttachments: () => pkg.attachments() };
    });

    // Success — the staged files have served their purpose.
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    res.json(result);
  } catch (err) {
    // Keep the staged files on failure so the operator can retry (e.g.
    // re-upload one corrupted part) without re-uploading everything.
    const msg = err instanceof Error ? err.message : 'Restore failed';
    const status =
      msg.includes('already in progress') ? 409 :
      msg.includes('already exist') || msg.includes('already completed') ? 409 :
      msg.includes('Missing part') || msg.includes('final part') ? 409 :
      msg.includes('passphrase') || msg.includes('corrupted') ? 400 :
      msg.includes('tenant information') ? 400 :
      500;
    res.status(status).json({ error: { message: msg } });
  }
});

// restoreTableRows / resyncOwnedSequences moved to
// services/system-restore.service.ts, which adds FK-aware ordering,
// multi-pass fixpoint retry, and per-row failure reporting.
