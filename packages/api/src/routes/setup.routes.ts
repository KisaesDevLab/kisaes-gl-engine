// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import net from 'node:net';
import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { getRateLimitStore } from '../utils/rate-limit-store.js';
import * as setupService from '../services/setup.service.js';
import { createDemoTenant } from '../services/demo-data.service.js';
import {
  stashPendingRecoveryKey,
  peekPendingRecoveryKey,
  acknowledgePendingRecoveryKey,
  hasPendingRecoveryKey,
} from '../services/pending-recovery-key.service.js';
import { getSetting as dbGetSetting } from '../services/admin.service.js';
import { SystemSettingsKeys } from '../constants/system-settings-keys.js';
import { decodeSentinelBuffer } from '../services/sentinel.service.js';
import {
  mergeBundleSections,
  restoreDatabaseSections,
  resyncOwnedSequences,
  buildRestoreChecklist,
  findUndecryptableTotpUsers,
  writeBackBundleFiles,
  type RestoreReport,
  type FileRestoreReport,
  type ChecklistItem,
  type UndecryptableTotpUser,
} from '../services/system-restore.service.js';
import {
  acknowledgeRecoveryKeySchema,
  checkPortSchema,
  dbConfigSchema,
  executeStagedSchema,
  initializeSchema,
  localExecuteSchema,
  parseOr400,
  pendingRecoveryKeyQuerySchema,
  recoverCredentialsSchema,
  remoteCredsSchema,
  remoteExecuteSchema,
  restoreUploadFieldsSchema,
  runIdParamSchema,
  stageIdParamSchema,
  testSmtpSchema,
} from './setup.schemas.js';

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
  store: getRateLimitStore('setup:setup'),
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many setup requests', code: 'SETUP_RATE_LIMIT' } },
});

export const setupRouter = Router();
setupRouter.use(setupLimiter);

const UUID_RE_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RUN_POLL_RE = new RegExp(`^/restore/runs/${UUID_RE_SRC}$`, 'i');
const RUN_RECOVER_RE = new RegExp(`^/restore/runs/${UUID_RE_SRC}/recover-credentials$`, 'i');

// Security guard: block all setup endpoints once setup is complete.
setupRouter.use(async (req, res, next) => {
  // Always-open endpoints:
  //   - /status: exposes installation state to the wizard bootstrap
  //   - /pending-recovery-key: F22 — post-setup re-display of a still-unacknowledged
  //     recovery key, scoped to a specific installation_id
  //   - /acknowledge-recovery-key: paired with the above, clears the pending entry
  //   - GET /restore/runs/<uuid>: polling a SPECIFIC restore run — a
  //     successful restore marks setup complete before the run flips to
  //     'complete', so without this exemption the wizard's poll 403s at the
  //     moment of success and the operator never sees the one-time recovery
  //     key. Only the by-id form is exempt: the runId is an unguessable UUID,
  //     so it acts as a bearer secret. /restore/runs/latest is NOT exempt —
  //     it would hand the last run's result (incl. the recovery key) to any
  //     unauthenticated caller with no id, post-setup.
  //   - POST /restore/runs/<uuid>/recover-credentials: same bearer-by-runId
  //     model — lets the operator who just ran a restore enter their recovery
  //     key to re-encrypt credentials/TOTP secrets BEFORE trying to log in,
  //     because an undecryptable TOTP secret is otherwise a lockout.
  const isRunByIdPoll = req.method === 'GET' && RUN_POLL_RE.test(req.path);
  const isRunRecover = req.method === 'POST' && RUN_RECOVER_RE.test(req.path);
  if (
    req.path === '/status' ||
    req.path === '/pending-recovery-key' ||
    req.path === '/acknowledge-recovery-key' ||
    isRunByIdPoll ||
    isRunRecover
  ) {
    return next();
  }

  // `getSetupStatus` is the single source of truth. It consults the
  // persistent marker AND the database: a marker whose database has no users
  // (volume carried to a new server, Postgres wiped) must not lock the
  // wizard — there is no account to sign in with and nothing to protect —
  // while an unreachable database still fails closed.
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
    !!pendingRecoveryKeyForInstall && hasPendingRecoveryKey(pendingRecoveryKeyForInstall);

  // White-label app name for PRE-LOGIN surfaces (login page, first-run wizard,
  // browser tab title) that have no authenticated /auth/me to read branding
  // from. Only the app name is exposed — it is already public branding, no
  // secrets. Best-effort: falls back to the default if the DB is unreachable.
  let appName = 'Vibe MyBooks';
  try {
    const { getBranding } = await import('../services/admin.service.js');
    appName = (await getBranding()).appName;
  } catch { /* DB unreachable — keep default */ }

  res.json({
    ...status,
    installationId,
    pendingRecoveryKey: hasPending,
    appName,
  });
});

setupRouter.get('/pending-recovery-key', async (req, res) => {
  // The installationId is public (returned by /status), so it locates the
  // entry but cannot authorize the read. The claim token — minted at stash
  // time and returned only to the browser that ran /initialize or the
  // restore — is the actual credential.
  const query = parseOr400(pendingRecoveryKeyQuerySchema, req.query, res);
  if (!query) return;
  const { installationId, claimToken } = query;
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
  const key = peekPendingRecoveryKey(installationId, claimToken);
  if (!key) {
    res.status(404).json({ error: { message: 'no pending recovery key — it may have expired or been acknowledged' } });
    return;
  }
  res.json({ recoveryKey: key });
});

setupRouter.post('/acknowledge-recovery-key', async (req, res) => {
  const body = parseOr400(acknowledgeRecoveryKeySchema, req.body, res);
  if (!body) return;
  const cleared = acknowledgePendingRecoveryKey(body.installationId, body.claimToken);
  res.json({ success: true, cleared });
});

setupRouter.post('/generate-secrets', async (req, res) => {
  const secrets = setupService.generateSecrets();
  res.json(secrets);
});

setupRouter.post('/test-database', async (req, res) => {
  const config = parseOr400(dbConfigSchema, req.body, res);
  if (!config) return;
  const result = await setupService.testDatabaseConnection(config);
  res.json(result);
});

// Return the Postgres connection parameters (including the auto-generated
// POSTGRES_PASSWORD) that the API container is currently running with,
// parsed from DATABASE_URL. The wizard uses these to pre-fill the Database
// step so the end user — who never sees the POSTGRES_PASSWORD minted by
// scripts/install.sh — can click straight through without typing anything.
//
// Safe by construction: this endpoint sits behind the same route guard
// that blocks every non-status setup endpoint once setup is complete
// (see setupRouter.use above). Post-setup the endpoint returns 403. See
// the getDatabaseDefaults() docstring for the full threat-model rationale.
setupRouter.get('/db-defaults', async (_req, res) => {
  res.json(setupService.getDatabaseDefaults());
});

setupRouter.post('/check-port', async (req, res) => {
  const body = parseOr400(checkPortSchema, req.body, res);
  if (!body) return;
  const result = await setupService.checkPortAvailability(body.port);
  res.json(result);
});

setupRouter.post('/test-smtp', async (req, res) => {
  const body = parseOr400(testSmtpSchema, req.body, res);
  if (!body) return;
  const { testEmail, ...smtp } = body;
  const result = await setupService.testSmtpConnection(smtp, testEmail);
  res.json(result);
});

setupRouter.post('/initialize', async (req, res) => {
  // Zod does the structural work; the wizard UI also validates, but a
  // bulletproof system must never rely on the client — an unusable .env
  // (JWT_SECRET='') or a guessable admin password is rejected here.
  const parsed = parseOr400(initializeSchema, req.body, res);
  if (!parsed) return;
  const config: setupService.SetupConfig = {
    ...parsed,
    // plaidEncryptionKey: clients no longer submit this (the wizard used to
    // surface it; it's now entirely server-side because non-technical
    // operators kept asking "what is this Plaid thing?" during setup). When
    // absent or too short we mint one so the rest of the flow always has a
    // valid value. It is validated on boot by config/env.ts and written into
    // /data/.env.recovery alongside the other secrets.
    plaidEncryptionKey:
      parsed.plaidEncryptionKey && parsed.plaidEncryptionKey.length >= 32
        ? parsed.plaidEncryptionKey
        : crypto.randomBytes(32).toString('hex'),
  };
  const adopt = config.adoptExistingTenants === true;

  try {
    // --- Serialize via advisory lock ----------------------------------
    // Two concurrent /initialize calls must never both proceed. The lock
    // is released automatically in withSetupLock's finally block.
    const result = await setupService.withSetupLock(async () => {
      // Re-check under the lock: another process may have completed
      // setup between the guard check and now.
      const status = await setupService.getSetupStatus();
      if (status.setupComplete) {
        throw new Error('Setup already completed by another process');
      }
      if (adopt && !status.needsAdminUser) {
        throw new Error('[step:admin] Nothing to adopt: the database holds no restored companies awaiting an admin account.');
      }
      if (!adopt && status.needsAdminUser) {
        throw new Error(
          `[step:admin] The database already contains ${status.tenantCount} restored compan${status.tenantCount === 1 ? 'y' : 'ies'} ` +
            'without any user account. Create the admin account for the restored data instead of a new installation.',
        );
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

      // Step 2: Write /data/config/.env. The guard above proved the database
      // has no user accounts, so an existing file can only belong to a
      // previous life of this volume (DB wiped, or /data carried to a new
      // server) — replacing it (a timestamped copy is kept) is what unwedges
      // exactly that disaster-recovery case. If anything below fails, the
      // file we wrote is removed again so a retry starts clean.
      const envPath = setupService.writeEnvFile(config, { replaceExisting: true });

      // Step 3: Create admin user (+ company for a fresh install). Atomic:
      // createAdminUser rolls back everything it created on failure so the
      // emptiness guards let the operator simply retry.
      let admin: Awaited<ReturnType<typeof setupService.createAdminUser>>;
      try {
        admin = await setupService.createAdminUser({
          email: config.admin.email,
          password: config.admin.password,
          displayName: config.admin.displayName,
          companyName: config.company.name,
          industry: config.company.industry,
          entityType: config.company.entityType,
          businessType: config.company.businessType,
          adoptExistingTenants: adopt,
        });
      } catch (err) {
        setupService.removeEnvFile(envPath);
        throw err;
      }

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
      if (config.createDemoCompany && !adopt) {
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
      const sentinelResult = await setupService.completeSetupSentinel({
        adminEmail: config.admin.email,
        databaseUrl: setupService.buildDatabaseUrl(config.db),
        jwtSecret: config.jwtSecret,
        encryptionKey: config.encryptionKey,
        plaidEncryptionKey: config.plaidEncryptionKey,
        appVersion: process.env['APP_VERSION'] || '0.1.0',
        tenantCountAtSetup: adopt ? Math.max(1, status.tenantCount) : 1,
      });

      // Step 6: mark the system as initialized. From here on the guard
      // rejects every further call to /initialize and /restore/execute while
      // the database holds users.
      setupService.markInitialized({
        via: adopt ? 'initialize/adopt' : 'initialize',
        tenantId: admin.tenantId,
        installationId: sentinelResult.installationId,
        hostId: sentinelResult.hostId,
      });

      // F22: hold the recovery key in memory so the wizard can re-display
      // it on reload if the operator closes the tab before acknowledging.
      // The returned claim token is the read credential — only this response
      // (and hence the operator's browser) ever sees it.
      const recoveryKeyClaimToken = stashPendingRecoveryKey(
        sentinelResult.installationId,
        sentinelResult.recoveryKey,
      );

      return {
        success: true,
        message: adopt
          ? 'Admin account created for the restored data. You can now log in.'
          : 'Setup complete! You can now log in.',
        envPath,
        tenantId: admin.tenantId,
        userId: admin.userId,
        installationId: sentinelResult.installationId,
        recoveryKey: sentinelResult.recoveryKey,
        recoveryKeyClaimToken,
        adoptedExistingTenants: adopt,
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
      message.includes('already exist') || message.includes('already completed') || message.includes('already contains') ? 409 :
      message.includes('Nothing to adopt') ? 409 :
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
  const uploadedPath = req.file.path;
  const fields = parseOr400(restoreUploadFieldsSchema, req.body, res);
  if (!fields) {
    try { fs.unlinkSync(uploadedPath); } catch { /* already gone */ }
    return;
  }
  const { passphrase } = fields;

  try {
    const { smartDecrypt } = await import('../services/portable-encryption.service.js');
    const { readTenantPackage } = await import('../services/vmx-package.js');
    let content: RestoreBundleContent;
    let method: 'passphrase' | 'server_key' = 'passphrase';
    if (isZipFile(uploadedPath)) {
      // .vmx package — readTenantPackage streams entries from the file path
      // (no whole-file buffering; the data payload is small).
      const pkg = await readTenantPackage(uploadedPath, passphrase);
      content = pkg.data as RestoreBundleContent;
    } else {
      // .vmb — a single encrypted blob (DB-only). System .vmb payloads are
      // NDJSON (large-DB safe); decodeVmbContent sniffs + parses accordingly.
      const decrypted = smartDecrypt(fs.readFileSync(uploadedPath), passphrase);
      content = await decodeVmbContent(decrypted.data);
      method = decrypted.method;
    }
    const metadata = content.metadata ?? {};

    // Determine what's in the backup
    const isSystem = metadata.backup_type === 'system' || metadata.format === 'kis-books-system-v1';
    const userCount = metadata.user_count ?? (Array.isArray(content.users) ? content.users.length : 0);

    res.json({
      valid: true,
      method,
      backup_type: isSystem ? 'system' : 'tenant',
      // A bundle with no user accounts restores fine but leaves nobody able
      // to sign in; the wizard tells the operator up front that it will ask
      // them to create an admin account after the restore.
      needsAdminUser: userCount === 0,
      metadata: {
        format: metadata.format,
        source_version: metadata.source_version || metadata.appVersion,
        created_at: metadata.created_at || metadata.timestamp,
        tenant_count: metadata.tenant_count || (isSystem ? Object.keys(content.tenant_data || {}).length : 1),
        user_count: userCount,
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
  const uploadedPath = req.file.path;
  const fields = parseOr400(restoreUploadFieldsSchema, req.body, res);
  if (!fields) {
    try { fs.unlinkSync(uploadedPath); } catch { /* already gone */ }
    return;
  }
  const { passphrase, recoveryKey } = fields;

  // One restore at a time — a second (possibly different) upload while one is
  // in flight must not silently attach to it. The wizard adopts the 409 runId.
  const activeUpload = peekActiveRestoreRun();
  if (activeUpload) {
    try { fs.unlinkSync(uploadedPath); } catch { /* already gone */ }
    res.status(409).json({ runId: activeUpload.id, error: { message: 'A restore is already in progress. Wait for it to finish.' } });
    return;
  }
  const run = startRestoreRun(
    async () => {
      // A .vmx package (ZIP) carries the DB dump plus attachment files; a
      // legacy .vmb/.kbk is a single encrypted JSON blob. Detect and read the
      // right one; `content` is the same DB payload either way. The .vmx is
      // read from its DISK path (streamed entries — a multi-GB package never
      // fully buffers); only the small legacy blob is loaded whole.
      const { smartDecrypt } = await import('../services/portable-encryption.service.js');
      const { readTenantPackage } = await import('../services/vmx-package.js');
      if (isZipFile(uploadedPath)) {
        const pkg = await readTenantPackage(uploadedPath, passphrase);
        return { content: pkg.data as RestoreBundleContent, packageAttachments: () => pkg.attachments() };
      }
      const { data } = smartDecrypt(fs.readFileSync(uploadedPath), passphrase);
      return { content: await decodeVmbContent(data), packageAttachments: null };
    },
    {
      // The uploaded backup landed on disk (multer diskStorage) — remove it
      // once the run settles (NOT in this handler: the run reads it async).
      onSettle: () => { try { fs.unlinkSync(uploadedPath); } catch { /* already gone */ } },
      recoveryKey,
    },
  );
  res.status(202).json(restoreRunView(run));
});

/**
 * Decrypted DB payload of a backup bundle. Rows are re-inserted via
 * parameterized SQL by the restore engine, which treats every section as
 * `Record<string, unknown>[]`; only the top-level envelope is typed here.
 */
interface RestoreBundleMetadata {
  backup_type?: string;
  /** tenant-export.service files carry `export_type: 'tenant'` — a different format from backups. */
  export_type?: string;
  format?: string;
  tenantId?: string;
  rowCount?: number;
  source_version?: string;
  appVersion?: string;
  created_at?: string;
  timestamp?: string;
  tenant_count?: number;
  user_count?: number;
  transaction_count?: number;
  [key: string]: unknown;
}

interface RestoreInstallationFiles {
  hostId?: string | null;
  sentinel?: string | null;
  envRecovery?: string | null;
}

interface RestoredUserRow {
  email?: string;
  is_super_admin?: boolean;
  [key: string]: unknown;
}

export interface RestoreBundleContent {
  metadata?: RestoreBundleMetadata;
  tenants?: unknown[];
  users?: RestoredUserRow[];
  user_tenant_access?: unknown[];
  tenant_data?: Record<string, Record<string, unknown[]>>;
  global_tables?: Record<string, unknown[]>;
  system_config?: Record<string, unknown[]>;
  /** Tenant-scoped bundles: table → rows. */
  tables?: Record<string, unknown>;
  installation_files?: RestoreInstallationFiles;
  [key: string]: unknown;
}

// Decode a decrypted .vmb payload. A SYSTEM .vmb is now an NDJSON dump
// (large-DB safe); a tenant/legacy .vmb is a single JSON blob. Sniff the NDJSON
// header so no restore path ever JSON.parse()s an NDJSON buffer — that fails
// with "Unexpected non-whitespace character after JSON" at the 2nd line. Every
// .vmb read path MUST go through this.
async function decodeVmbContent(data: Buffer): Promise<RestoreBundleContent> {
  const { isNdjsonDump, decodeSystemDump } = await import('../services/system-dump-codec.js');
  return (isNdjsonDump(data) ? decodeSystemDump(data) : JSON.parse(data.toString())) as RestoreBundleContent;
}

type ContentSource = () => Promise<{
  content: RestoreBundleContent;
  packageAttachments: (() => AsyncGenerator<{ id: string; buffer: Buffer }>) | null;
}>;

// ─── Async restore runs ─────────────────────────────────────────────
//
// A large restore takes minutes — far past reverse-proxy request ceilings
// (Cloudflare cuts ~100s), which used to strand the wizard on a dead spinner
// while the restore finished invisibly (and the one-time recovery key in the
// lost response with it). Restores now run in-process off the request: the
// execute endpoints return a runId immediately and the wizard polls
// GET /restore/runs/:id until the run settles. Runs live in memory — an api
// restart mid-restore fails the poll, and the restore itself is guarded by
// the setup lock + emptiness re-check, so a retry is always safe.

interface RestoreRun {
  id: string;
  status: 'running' | 'complete' | 'failed';
  startedAt: string;
  finishedAt?: string;
  result?: Record<string, unknown>;
  error?: string;
}

const restoreRuns = new Map<string, RestoreRun>();
let activeRestoreRunId: string | null = null;
const MAX_KEPT_RUNS = 5;

function restoreRunView(run: RestoreRun) {
  return {
    runId: run.id,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    result: run.result ?? null,
    error: run.error ?? null,
  };
}

/** The currently-running restore, or null. Lets callers avoid expensive
 *  prep (downloading a bundle) when a restore is already in flight, and lets
 *  them re-attach to it rather than silently restore a DIFFERENT bundle. */
function peekActiveRestoreRun(): RestoreRun | null {
  if (!activeRestoreRunId) return null;
  const active = restoreRuns.get(activeRestoreRunId);
  return active && active.status === 'running' ? active : null;
}

// Drizzle wraps a failed query as `Failed query: <sql> params: …` and hangs the
// real Postgres error (message + SQLSTATE + detail) off `.cause`. Surfacing only
// `.message` left operators staring at an opaque SQL blob with no reason. Prefer
// the pg cause's message and code so the run error says WHAT went wrong.
function describeRestoreError(err: unknown): string {
  if (!(err instanceof Error)) return String(err) || 'Restore failed';
  const cause = (err as { cause?: unknown }).cause;
  const pg = (cause instanceof Error ? cause : err) as unknown as Record<string, unknown>;
  const msg = (typeof pg['message'] === 'string' && pg['message']) || err.message || 'Restore failed';
  const code = typeof pg['code'] === 'string' ? pg['code'] : undefined;
  const detail = typeof pg['detail'] === 'string' ? pg['detail'] : undefined;
  return [msg, code ? `[${code}]` : '', detail ? `— ${detail}` : ''].filter(Boolean).join(' ');
}

function startRestoreRun(
  readContent: ContentSource,
  opts: { onSuccess?: () => void; onSettle?: () => void; recoveryKey?: string } = {},
): RestoreRun {
  // Re-attach instead of double-running: a second POST while a restore is
  // in flight (wizard reload after a proxy timeout) gets the SAME run. The
  // second caller's resources are NOT consumed by the active run, so its
  // settle-cleanup fires now — otherwise every duplicate upload leaks a
  // multi-GB file in multer's disk storage until the volume fills.
  if (activeRestoreRunId) {
    const active = restoreRuns.get(activeRestoreRunId);
    if (active && active.status === 'running') {
      try { opts.onSettle?.(); } catch { /* cleanup is best-effort */ }
      return active;
    }
  }

  const run: RestoreRun = { id: crypto.randomUUID(), status: 'running', startedAt: new Date().toISOString() };
  restoreRuns.set(run.id, run);
  activeRestoreRunId = run.id;
  for (const [k, v] of restoreRuns) {
    if (restoreRuns.size <= MAX_KEPT_RUNS) break;
    if (v.status !== 'running') restoreRuns.delete(k);
  }

  void (async () => {
    try {
      run.result = await runGuardedSetupRestore(readContent, opts.recoveryKey);
      run.status = 'complete';
      try { opts.onSuccess?.(); } catch { /* cleanup is best-effort */ }
    } catch (err) {
      run.status = 'failed';
      run.error = describeRestoreError(err);
      // Always log the full error server-side — the run only keeps a short
      // human string, but the stack + pg cause belong in the logs for triage.
      console.error('[restore] run failed:', err);
    } finally {
      run.finishedAt = new Date().toISOString();
      if (activeRestoreRunId === run.id) activeRestoreRunId = null;
      try { opts.onSettle?.(); } catch { /* cleanup is best-effort */ }
    }
  })();

  return run;
}

// Poll a restore run. Same setup-guard exposure as the execute endpoints —
// the completed result carries the one-time recovery key exactly as the old
// synchronous response did.
setupRouter.get('/restore/runs/latest', (_req, res) => {
  let latest: RestoreRun | null = null;
  for (const run of restoreRuns.values()) {
    if (!latest || run.startedAt > latest.startedAt) latest = run;
  }
  if (!latest) {
    res.status(404).json({ error: { message: 'No restore runs' } });
    return;
  }
  res.json(restoreRunView(latest));
});

setupRouter.get('/restore/runs/:runId', (req, res) => {
  const params = parseOr400(runIdParamSchema, req.params, res);
  if (!params) return;
  const run = restoreRuns.get(params.runId.toLowerCase()) ?? restoreRuns.get(params.runId);
  if (!run) {
    res.status(404).json({ error: { message: 'Unknown restore run — it may have been lost to an api restart; retry the restore' } });
    return;
  }
  res.json(restoreRunView(run));
});

/**
 * Post-restore credential recovery, keyed by the restore run (the runId is
 * the bearer credential, exactly as for polling). After a cross-host restore
 * — or a same-host restore of a bundle taken before a key rotation — every
 * restored `*_encrypted` value, INCLUDING users' authenticator (TOTP)
 * secrets, is unreadable under this server's key. Entering the ORIGINAL
 * recovery key here re-encrypts them before the operator ever reaches the
 * login screen, which is the only moment this can be fixed without a shell:
 * once setup is complete the admin UI requires a login that an unreadable
 * TOTP secret would refuse.
 */
setupRouter.post('/restore/runs/:runId/recover-credentials', async (req, res) => {
  const params = parseOr400(runIdParamSchema, req.params, res);
  if (!params) return;
  const body = parseOr400(recoverCredentialsSchema, req.body, res);
  if (!body) return;
  const run = restoreRuns.get(params.runId.toLowerCase()) ?? restoreRuns.get(params.runId);
  if (!run) {
    res.status(404).json({ error: { message: 'Unknown restore run — it may have been lost to an api restart' } });
    return;
  }
  if (run.status !== 'complete' || !run.result) {
    res.status(409).json({ error: { message: 'Credential recovery is only available after a restore has completed' } });
    return;
  }
  try {
    const { db } = await import('../db/index.js');
    const { recoverCredentialEncryption } = await import('../services/credential-reencrypt.service.js');
    const report = await recoverCredentialEncryption({ recoveryKey: body.recoveryKey });
    const checklist = await buildRestoreChecklist(db);
    const tfaLockedUsers = await findUndecryptableTotpUsers(db);
    run.result = {
      ...run.result,
      credentialRecovery: { attempted: true, reencrypted: report.totals.reencrypted, unreadable: report.totals.unreadable },
      checklist,
      tfaLockedUsers,
    };
    console.log(`[restore] post-restore credential recovery: ${report.totals.reencrypted} re-encrypted, ${report.totals.unreadable} unreadable`);
    res.json({ ...restoreRunView(run), report });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { statusCode?: number }).statusCode ?? 400;
    res.status(status >= 400 && status < 600 ? status : 400).json({ error: { message } });
  }
});

interface SourceSecretsAssessment {
  /** Bundle sentinel decrypts with THIS server's ENCRYPTION_KEY (null = bundle carried no sentinel). */
  sentinelDecrypts: boolean | null;
  /** Bundle sentinel's JWT_SECRET hash equals this server's (null = unknown). */
  jwtMatches: boolean | null;
}

/**
 * Same host ≠ same secrets. A same-host restore of a bundle taken BEFORE a
 * key rotation must not write the bundle's recovery file back verbatim (it
 * would decrypt to the OLD keys, and a later env-missing recovery would loop
 * into SENTINEL_DECRYPT_FAILED). Prove the keys are unchanged by decrypting
 * the bundle's own sentinel with the current ENCRYPTION_KEY and comparing its
 * JWT_SECRET hash; the credential probe in the checklist covers
 * PLAID_ENCRYPTION_KEY.
 */
function assessSourceSecrets(
  files: RestoreInstallationFiles,
  encryptionKey: string,
  jwtSecret: string,
): SourceSecretsAssessment {
  if (!files.sentinel) return { sentinelDecrypts: null, jwtMatches: null };
  try {
    const payload = decodeSentinelBuffer(Buffer.from(files.sentinel, 'base64'), encryptionKey);
    const jwtHash = crypto.createHash('sha256').update(jwtSecret).digest('hex');
    return { sentinelDecrypts: true, jwtMatches: payload.jwtSecretHash === jwtHash };
  } catch {
    return { sentinelDecrypts: false, jwtMatches: null };
  }
}

function tenantCountOf(content: RestoreBundleContent): number {
  return Array.isArray(content.tenants) ? content.tenants.length : 0;
}

/**
 * Shared core of restore-during-setup: emptiness guard, setup lock, row
 * re-insertion, attachment write-back, sentinel + marker finalization.
 * Both the single-file /restore/execute path and the staged multi-part
 * /restore/execute-staged path run through here — the only difference
 * between them is how `readContent` produces the decrypted payload.
 */
async function runGuardedSetupRestore(
  readContent: ContentSource,
  // Operator's original recovery key, entered WITH the restore. When the
  // restored credentials are unreadable under this box's key it drives the
  // automatic re-encryption below.
  recoveryKey?: string,
): Promise<Record<string, unknown>> {
  const { sql } = await import('drizzle-orm');
  const { db } = await import('../db/index.js');

  // Refuse to merge a backup into a database that already contains
  // tenants. Restore-during-setup is strictly a fresh-install
  // operation — there is no safe "combine two backups" mode, and
  // ON CONFLICT DO NOTHING would otherwise silently diverge.
  const before = await setupService.countTenantsAndUsers();
  if (before.tenants > 0 || before.users > 0) {
    throw new Error(
      `Cannot restore: ${before.tenants} tenant(s) and ${before.users} user(s) already exist in the database. ` +
      `Restore-from-backup is only available on a completely empty install.`,
    );
  }

  return setupService.withSetupLock(async () => {
      // Re-check under the lock.
      const status = await setupService.getSetupStatus();
      if (status.setupComplete) {
        throw new Error('Setup already completed by another process');
      }
      const recheck = await setupService.countTenantsAndUsers();
      if (recheck.tenants > 0 || recheck.users > 0) {
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
        // Wrap the DB restore + sequence resync in ONE transaction: if it
        // throws partway (e.g. a dropped connection), everything rolls back
        // so the DB stays EMPTY and the emptiness guard permits a clean
        // retry — a partial commit would otherwise wedge the restore forever.
        const restoreReport: RestoreReport = await db.transaction(async (tx) => {
          const rep = await restoreDatabaseSections(tx, sections);
          await resyncOwnedSequences(tx);
          return rep;
        });

        // Restore bundled FILES (present only in .vmx packages): receipt
        // attachments, extraction sources, portal receipt/Q&A uploads,
        // payroll import files, and report PDFs — each written back through
        // the owning tenant's storage provider (or under UPLOAD_DIR for
        // payroll local files).
        let fileReport: FileRestoreReport | null = null;
        if (packageAttachments) {
          try {
            fileReport = await writeBackBundleFiles(sections, packageAttachments);
          } catch (err) {
            // Defensive: writeBackBundleFiles is built not to throw, but the DB
            // restore has already COMMITTED — a file-phase throw must never fail
            // the run or skip the finalization below (which would wedge every
            // retry). Downgrade to a reported warning.
            console.error('[restore] file write-back threw (DB already committed):', err);
            fileReport = { perTable: {}, unknownEntries: 0, readErrors: 1, sampleErrors: [err instanceof Error ? err.message : String(err)] };
          }
          console.log('[restore] file write-back:', JSON.stringify(fileReport));
        }

        const filesFailed = !!(fileReport && (Object.values(fileReport.perTable).some((t) => t.failed > 0) || fileReport.readErrors > 0));
        const warnings: string[] = [];
        if (restoreReport.totals.failed > 0) {
          warnings.push(`${restoreReport.totals.failed} row(s) could not be restored — see tables report`);
        }
        if (filesFailed) {
          warnings.push('Some bundled files could not be written back — see files report');
        }
        // Partial = the restore committed but something was NOT restored. The
        // wizard MUST render this as a non-green result, never a plain success —
        // otherwise a firm is told all data returned when rows/files were
        // silently dropped.
        const partial = restoreReport.totals.failed > 0 || filesFailed;
        const tablesView = {
          totals: restoreReport.totals,
          passes: restoreReport.passes,
          failures: Object.fromEntries(
            Object.entries(restoreReport.perTable)
              .filter(([, s]) => s.failed > 0)
              .map(([t, s]) => [t, { failed: s.failed, sampleErrors: s.sampleErrors }]),
          ),
        };

        // A system bundle that carried NO user accounts (exported from a
        // half-provisioned install, or hand-built) restores its data fine,
        // but finishing setup here would leave an installation nobody can
        // log in to. Leave setup OPEN: the wizard asks for an admin account
        // that adopts the restored companies (/initialize adoptExistingTenants),
        // and that step writes the sentinel + marker.
        const after = await setupService.countTenantsAndUsers();
        if (after.users === 0) {
          const checklist = await buildRestoreChecklist(db);
          return {
            success: true,
            partial,
            needsAdminUser: true,
            message: partial
              ? `Restore completed with ISSUES — ${restoreReport.totals.failed} row(s)${filesFailed ? ' and some files' : ''} could NOT be restored. The backup contained no user accounts: create an admin account next.`
              : 'Data restored. This backup contained no user accounts — create your admin account next to finish.',
            tenants_restored: tenantCountOf(content),
            users_restored: 0,
            tables: tablesView,
            files: fileReport,
            warnings,
            checklist,
          };
        }

        // Finalization: sentinel + installation_id + marker + recovery file.
        // We need an encryption key to write the sentinel; env.ts has been
        // loaded, so ENCRYPTION_KEY is guaranteed to be in process.env.
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
        const restoredUsers = content.users ?? [];
        const superAdmin = restoredUsers.find((u) => u.is_super_admin) ?? restoredUsers[0];
        const restoreAdminEmail = superAdmin?.email ?? 'restored-installation@unknown';

        // Cross-host restore detection. The backup archive may include the
        // source server's `installation_files.hostId`. If the current /data
        // volume has a matching host-id, this is a same-host restore (the
        // volume survived; only the database was lost).
        const restoredInstallationFiles: RestoreInstallationFiles = content.installation_files ?? {};
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

        // Checklist reflects what was ACTUALLY restored; its `encryption`
        // probe tells us whether this server's PLAID_ENCRYPTION_KEY opens the
        // restored credentials.
        let checklist: Record<string, ChecklistItem> = await buildRestoreChecklist(db);
        const credentialsUnreadable = () => checklist['encryption']?.status === 'warning';
        let tfaLockedUsers: UndecryptableTotpUser[] = await findUndecryptableTotpUsers(db);

        // Same host ≠ same secrets (bundle taken before a key rotation).
        const secrets = assessSourceSecrets(restoredInstallationFiles, encryptionKeyForRestore, jwtSecretForRestore);
        const secretsUnchanged =
          isSameHost &&
          secrets.sentinelDecrypts === true &&
          secrets.jwtMatches === true &&
          !credentialsUnreadable() &&
          tfaLockedUsers.length === 0;
        const keysRotatedSinceBackup = isSameHost && !secretsUnchanged;

        // The restore has COMMITTED. From here on nothing may turn the run
        // into a failure: a sentinel write that fails because /data is not
        // writable must be REPORTED (data is fine; the sentinel regenerates
        // at the next boot once permissions are fixed), not presented as
        // "Restore failed" — which invited a retry that could only 409.
        let finalization: { ok: boolean; error: string | null } = { ok: true, error: null };
        let sentinelResultRestore: Awaited<ReturnType<typeof setupService.completeSetupSentinel>> | null = null;
        try {
          sentinelResultRestore = await setupService.completeSetupSentinel({
            adminEmail: restoreAdminEmail,
            databaseUrl: databaseUrlForRestore,
            jwtSecret: jwtSecretForRestore,
            encryptionKey: encryptionKeyForRestore,
            appVersion: process.env['APP_VERSION'] || '0.1.0',
            tenantCountAtSetup: tenantCountOf(content) || 1,
          });
          setupService.markInitialized({
            via: 'restore/system',
            installationId: sentinelResultRestore.installationId,
            hostId: sentinelResultRestore.hostId,
            crossHostRestore: !isSameHost,
            keysRotatedSinceBackup,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          finalization = { ok: false, error: message };
          console.error('[restore] finalization failed AFTER the database restore committed:', err);
          warnings.push(
            `Installation sentinel could not be written (${message}). Your data IS restored and you can log in; ` +
              'fix /data permissions (container UID 1001) and restart the api — the sentinel is regenerated at boot. No recovery key was issued.',
          );
        }

        let recoveryKeyPreserved = false;
        let credentialRecovery: { attempted: boolean; reencrypted: number; unreadable: number; error?: string } | null = null;
        if (finalization.ok && restoredInstallationFiles.envRecovery) {
          if (secretsUnchanged) {
            // Same host AND proven-unchanged secrets: the bundle's recovery
            // file still decrypts to this server's exact values — write it
            // back (over the fresh file completeSetupSentinel just minted) so
            // the operator's original recovery key stays valid.
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
                  installationId: sentinelResultRestore?.installationId,
                })}`,
              );
            } catch (err) {
              // Fall through to the new-key flow — worst case the operator
              // gets a rotated key, same as before this write-back existed.
              console.error('[restore] recovery file write-back failed, issuing new key:', err instanceof Error ? err.message : err);
            }
          } else {
            // Different server, or same server with rotated keys: the main
            // recovery file was re-minted for THIS host's current secrets.
            // PARK the source install's file alongside it so the operator's
            // ORIGINAL recovery key can unlock the source
            // credential-encryption key (now, or later in Admin → Security).
            try {
              const { writeSourceRecoveryFileRaw } = await import('../services/env-recovery.service.js');
              writeSourceRecoveryFileRaw(Buffer.from(restoredInstallationFiles.envRecovery, 'base64'));
            } catch (err) {
              console.error('[restore] source recovery file parking failed (non-fatal):', err instanceof Error ? err.message : err);
            }
          }
        }

        // Automate credential recovery IN the restore when it is actually
        // needed: if the restored credentials (or any TOTP secret) do not
        // open under this server's key and the operator supplied their
        // recovery key, decrypt the parked source recovery file with it and
        // re-encrypt every restored *_encrypted value — so a DR restore comes
        // back with WORKING credentials and nobody is locked out of 2FA.
        // Skipped when everything already decrypts (same key), which the old
        // code reported as a spurious "identical key" error.
        if (recoveryKey && recoveryKey.trim() && (credentialsUnreadable() || tfaLockedUsers.length > 0)) {
          try {
            const { recoverCredentialEncryption } = await import('../services/credential-reencrypt.service.js');
            const rep = await recoverCredentialEncryption({ recoveryKey: recoveryKey.trim() });
            credentialRecovery = { attempted: true, reencrypted: rep.totals.reencrypted, unreadable: rep.totals.unreadable };
            console.log(`[restore] auto credential recovery: ${rep.totals.reencrypted} re-encrypted, ${rep.totals.unreadable} unreadable`);
            checklist = await buildRestoreChecklist(db);
            tfaLockedUsers = await findUndecryptableTotpUsers(db);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            credentialRecovery = { attempted: true, reencrypted: 0, unreadable: 0, error: message };
            console.error('[restore] auto credential recovery failed (retry below or in Admin → Security):', message);
          }
        }

        if (tfaLockedUsers.length > 0) {
          const admins = tfaLockedUsers.filter((u) => u.isSuperAdmin).map((u) => u.email);
          warnings.push(
            `${tfaLockedUsers.length} user(s) with authenticator-app 2FA cannot sign in until their secrets are re-encrypted` +
              (admins.length ? ` — including super admin ${admins.join(', ')}` : '') +
              '. Enter your original recovery key below before going to the login page.',
          );
        }

        // F22: stash for wizard re-display resilience — only when a new key
        // was actually issued and must be shown to the operator. The claim
        // token rides back in the run result, which is itself only readable
        // via the unguessable runId.
        let recoveryKeyClaimToken: string | null = null;
        const issuedKey = finalization.ok && !recoveryKeyPreserved && sentinelResultRestore ? sentinelResultRestore.recoveryKey : null;
        if (issuedKey && sentinelResultRestore) {
          recoveryKeyClaimToken = stashPendingRecoveryKey(sentinelResultRestore.installationId, issuedKey);
        }

        const okMessage = !finalization.ok
          ? 'System restored — but the installation sentinel could not be written. See the warning below.'
          : recoveryKeyPreserved
            ? 'System restored successfully — your existing recovery key remains valid'
            : keysRotatedSinceBackup
              ? 'System restored successfully (same host, but this server’s keys differ from the backup’s — a new recovery key was issued)'
              : isSameHost
                ? 'System restored successfully (same host detected — new recovery key issued)'
                : 'System restored successfully (new host — new recovery key issued)';

        return {
          success: true,
          partial: partial || !finalization.ok,
          needsAdminUser: false,
          message: partial
            ? `Restore completed with ISSUES — ${restoreReport.totals.failed} row(s)${filesFailed ? ' and some files' : ''} could NOT be restored. Review the report below before relying on this data.`
            : okMessage,
          tenants_restored: tenantCountOf(content),
          users_restored: restoredUsers.length,
          installationId: sentinelResultRestore?.installationId ?? null,
          recoveryKey: issuedKey,
          recoveryKeyClaimToken,
          recoveryKeyPreserved,
          crossHostRestore: !isSameHost,
          keysRotatedSinceBackup,
          finalization,
          credentialRecovery,
          tfaLockedUsers,
          tables: tablesView,
          files: fileReport,
          warnings,
          checklist,
        };
      } else {
        // Tenant-scoped backup restore
        const tables = content.tables || {};
        const tenantId = typeof metadata.tenantId === 'string' ? metadata.tenantId : null;

        if (!tenantId) {
          if (metadata.export_type === 'tenant') {
            throw new Error(
              'This file is a company EXPORT (Settings → Export Data), not a backup, so it cannot seed an empty installation. ' +
                'Finish setup (New installation), then bring it in via Settings → Tenant Export → "Import as new company".',
            );
          }
          throw new Error('Backup does not contain tenant information');
        }

        const sections: Record<string, Record<string, unknown>[]> = {};
        for (const [tableName, rows] of Object.entries(tables)) {
          if (Array.isArray(rows) && rows.length > 0) sections[tableName] = rows as Record<string, unknown>[];
        }
        // Transactional (same rationale as the system branch): a mid-restore
        // throw rolls back so a retry isn't wedged by partial rows. The
        // placeholder tenants row is inserted INSIDE the transaction too — a
        // tenant-scoped bundle carries child data but not the tenants row, and
        // if this row committed on its own (autocommit) a later failure would
        // roll back the data but leave an orphan tenant that trips the
        // emptiness guard and wedges every retry.
        const restoreReport: RestoreReport = await db.transaction(async (tx) => {
          const existing = await tx.execute(sql`SELECT id FROM tenants WHERE id = ${tenantId}`);
          if ((existing.rows as unknown[]).length === 0) {
            await tx.execute(sql`
              INSERT INTO tenants (id, name, slug)
              VALUES (${tenantId}, ${'Restored Company'}, ${'restored-' + tenantId.substring(0, 8)})
            `);
          }
          const rep = await restoreDatabaseSections(tx, sections);
          await resyncOwnedSequences(tx);
          return rep;
        });

        // Tenant .vmx packages carry attachment/upload files too; write them
        // back (the old flow ignored them entirely on this branch).
        let fileReport: FileRestoreReport | null = null;
        if (packageAttachments) {
          try {
            fileReport = await writeBackBundleFiles(sections, packageAttachments);
          } catch (err) {
            // Defensive (DB already committed) — see the system branch.
            console.error('[restore] file write-back threw (DB already committed):', err);
            fileReport = { perTable: {}, unknownEntries: 0, readErrors: 1, sampleErrors: [err instanceof Error ? err.message : String(err)] };
          }
          console.log('[restore] file write-back:', JSON.stringify(fileReport));
        }

        // A tenant bundle carries company data but NO user accounts and no
        // installation-wide configuration, so it is NOT a finished
        // installation: writing the `.initialized` marker here used to close
        // the setup router (403 on every endpoint), make /status claim an
        // admin existed, and leave the operator at a login page no account
        // could satisfy. Setup stays open; the wizard continues to the admin
        // step, and /initialize with adoptExistingTenants writes the sentinel
        // and marker once an account exists.
        const checklist = await buildRestoreChecklist(db);

        const tenantFilesFailed = !!(fileReport && (Object.values(fileReport.perTable).some((t) => t.failed > 0) || fileReport.readErrors > 0));
        const tenantPartial = restoreReport.totals.failed > 0 || tenantFilesFailed;
        return {
          success: true,
          partial: tenantPartial,
          needsAdminUser: true,
          message: tenantPartial
            ? `Company data restored with ISSUES — ${restoreReport.totals.failed} row(s)${tenantFilesFailed ? ' and some files' : ''} could NOT be restored. Review the report below, then create your admin account.`
            : 'Company data restored. Create your admin account next to finish setup.',
          tenant_id: tenantId,
          tenants_restored: 1,
          users_restored: 0,
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
  const fields = parseOr400(restoreUploadFieldsSchema, req.body, res);
  if (!fields) {
    try { fs.unlinkSync(req.file.path); } catch { /* already gone */ }
    return;
  }
  const { passphrase } = fields;

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
      // .vmb/.kbk blob: prove the passphrase before accepting. smartDecrypt
      // throws on a wrong key; a system NDJSON dump validates via its header
      // (JSON.parse would wrongly reject it), a JSON blob must parse.
      const { smartDecrypt } = await import('../services/portable-encryption.service.js');
      const dec = smartDecrypt(fs.readFileSync(req.file.path), passphrase).data;
      const { isNdjsonDump } = await import('../services/system-dump-codec.js');
      if (!isNdjsonDump(dec)) JSON.parse(dec.toString());
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
  const params = parseOr400(stageIdParamSchema, req.params, res);
  if (!params) return;
  try {
    const meta = readStageMeta(params.backupId);
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
  const body = parseOr400(executeStagedSchema, req.body, res);
  if (!body) return;
  const { backupId, passphrase, recoveryKey } = body;
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

  // One restore at a time — don't silently attach a different staged series
  // to an in-flight run (the wizard adopts the 409 runId and polls it).
  const activeStaged = peekActiveRestoreRun();
  if (activeStaged) {
    res.status(409).json({ runId: activeStaged.id, error: { message: 'A restore is already in progress. Wait for it to finish.' } });
    return;
  }

  const run = startRestoreRun(
    async () => {
      if (meta!.classic && !isZipFile(paths[0]!)) {
        const { smartDecrypt } = await import('../services/portable-encryption.service.js');
        const { data } = smartDecrypt(fs.readFileSync(paths[0]!), passphrase);
        return { content: await decodeVmbContent(data), packageAttachments: null };
      }
      const { readTenantPackageMulti } = await import('../services/vmx-package.js');
      const pkg = await readTenantPackageMulti(paths, passphrase);
      return { content: pkg.data as RestoreBundleContent, packageAttachments: () => pkg.attachments() };
    },
    {
      // Success — the staged files have served their purpose. On failure
      // they stay so the operator can retry (e.g. re-upload one corrupted
      // part) without re-uploading everything.
      onSuccess: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } },
      recoveryKey,
    },
  );
  res.status(202).json(restoreRunView(run));
});

// ─── Restore from local disk / mounted drive ───────────────────────
//
// A backup that already lives on the box (BACKUP_DIR, or an external drive
// bind-mounted at BACKUP_MIRROR_DIR) can be restored WITHOUT a
// download-then-upload round-trip. During a true disaster recovery the DB is
// empty, so we can't read the operator's configured mirror path from
// settings — the roots are fixed by env/convention instead.

const RESTORE_LOCAL_ROOTS: Record<string, string> = {
  backups: process.env['BACKUP_DIR'] || '/data/backups',
  drive: process.env['BACKUP_MIRROR_DIR'] || '/data/backup-mirror',
};

const MULTIPART_RE = /^(.*)\.part(\d+)of(\d+)\.vmx$/i;

interface LocalBundle {
  id: string;            // stable id (root + base name)
  root: string;          // 'backups' | 'drive'
  label: string;         // display name
  kind: 'single' | 'multipart';
  files: string[];       // absolute paths, part-ordered for multipart
  partCount: number;
  size: number;          // total bytes
  modifiedAt: string | null;
}

/** Scan a root dir (root/<tenant|_system>/<file>) for restorable bundles.
 *  Exported for tests. */
export function scanLocalBundles(rootKey: string, rootDir: string): LocalBundle[] {
  if (!fs.existsSync(rootDir)) return [];
  let rootReal: string;
  try { rootReal = fs.realpathSync(rootDir); } catch { rootReal = path.resolve(rootDir); }
  const series = new Map<string, { base: string; parts: Map<number, { path: string; size: number; mtime: number }>; declared: number }>();
  const singles: LocalBundle[] = [];

  // Record a resolved regular file (used by both the plain and the
  // symlinked-file paths). `full` is the on-disk path; `st` its stat.
  const handleFile = (entry: string, full: string, st: fs.Stats) => {
    const mp = entry.match(MULTIPART_RE);
    if (mp) {
      const base = path.join(path.dirname(full), mp[1]!);
      const s = series.get(base) ?? { base, parts: new Map(), declared: parseInt(mp[3]!, 10) };
      s.declared = parseInt(mp[3]!, 10);
      s.parts.set(parseInt(mp[2]!, 10), { path: full, size: st.size, mtime: st.mtimeMs });
      series.set(base, s);
    } else if (entry.endsWith('.vmx') || entry.endsWith('.vmb')) {
      singles.push({
        id: `${rootKey}:${path.relative(rootDir, full)}`,
        root: rootKey, label: entry, kind: 'single',
        files: [full], partCount: 1, size: st.size,
        modifiedAt: new Date(st.mtimeMs).toISOString(),
      });
    }
  };

  const walk = (dir: string) => {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let lst: fs.Stats;
      try { lst = fs.lstatSync(full); } catch { continue; }
      if (lst.isSymbolicLink()) {
        // A symlink is fine ONLY if its realpath stays inside this root — a
        // legit backup drive is often symlink-mounted, but a link escaping
        // the root (→ /etc/passwd) must never be listed or restored.
        let real: string;
        try { real = fs.realpathSync(full); } catch { continue; }
        if (!(real + path.sep).startsWith(rootReal + path.sep)) continue;
        // Follow symlinked FILES only — NEVER recurse a symlinked directory
        // (a link to an ancestor would recurse forever / list twice).
        let st: fs.Stats;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.isDirectory()) continue;
        handleFile(entry, full, st);
        continue;
      }
      if (lst.isDirectory()) { walk(full); continue; }
      handleFile(entry, full, lst); // reuse lstat (no symlink → same as stat)
    }
  };
  walk(rootDir);

  const bundles: LocalBundle[] = [...singles];
  for (const s of series.values()) {
    const idxs = [...s.parts.keys()].sort((a, b) => a - b);
    if (idxs.length !== s.declared || !idxs.every((n, i) => n === i + 1)) continue; // incomplete
    bundles.push({
      id: `${rootKey}:${path.relative(rootDir, s.base)}`,
      root: rootKey, label: `${path.basename(s.base)} (${s.declared} parts)`, kind: 'multipart',
      files: idxs.map((n) => s.parts.get(n)!.path),
      partCount: s.declared,
      size: idxs.reduce((sum, n) => sum + s.parts.get(n)!.size, 0),
      modifiedAt: new Date(Math.max(...idxs.map((n) => s.parts.get(n)!.mtime))).toISOString(),
    });
  }
  return bundles.sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''));
}

/** Validate every path resolves inside one of the allowed roots (anti-traversal).
 *  Uses realpath so a symlink whose TARGET escapes a root is rejected, not
 *  just a lexical `..`. Exported for tests. */
export function assertPathsWithinRoots(paths: string[]): void {
  const roots = Object.values(RESTORE_LOCAL_ROOTS)
    .map((r) => { try { return fs.realpathSync(r) + path.sep; } catch { return path.resolve(r) + path.sep; } });
  for (const p of paths) {
    let real: string;
    try { real = fs.realpathSync(p); } catch { throw new Error('Restore path does not exist'); }
    if (!roots.some((r) => (real + path.sep).startsWith(r))) {
      throw new Error('Restore path is outside the allowed backup directories');
    }
  }
}

/** Build the async ContentSource for a set of local bundle files. */
function localContentSource(files: string[], passphrase: string): ContentSource {
  return async () => {
    if (files.length === 1 && !isZipFile(files[0]!)) {
      const { smartDecrypt } = await import('../services/portable-encryption.service.js');
      const { data } = smartDecrypt(fs.readFileSync(files[0]!), passphrase);
      return { content: await decodeVmbContent(data), packageAttachments: null };
    }
    if (files.length === 1) {
      const { readTenantPackage } = await import('../services/vmx-package.js');
      const pkg = await readTenantPackage(files[0]!, passphrase);
      return { content: pkg.data as RestoreBundleContent, packageAttachments: () => pkg.attachments() };
    }
    const { readTenantPackageMulti } = await import('../services/vmx-package.js');
    const pkg = await readTenantPackageMulti(files, passphrase);
    return { content: pkg.data as RestoreBundleContent, packageAttachments: () => pkg.attachments() };
  };
}

setupRouter.get('/restore/local/list', (_req, res) => {
  const bundles: LocalBundle[] = [];
  try {
    for (const [key, dir] of Object.entries(RESTORE_LOCAL_ROOTS)) bundles.push(...scanLocalBundles(key, dir));
  } catch (err) {
    // A pathological backup dir (e.g. a symlink loop) must not 500 the
    // whole restore browser — degrade to whatever scanned cleanly.
    console.warn('[setup] local restore scan error:', err instanceof Error ? err.message : err);
  }
  res.json({
    roots: Object.entries(RESTORE_LOCAL_ROOTS).map(([key, dir]) => ({ key, dir, present: fs.existsSync(dir) })),
    // Never leak absolute paths; the client restores by opaque `id`.
    bundles: bundles.map((b) => ({ id: b.id, root: b.root, label: b.label, kind: b.kind, partCount: b.partCount, size: b.size, modifiedAt: b.modifiedAt })),
  });
});

setupRouter.post('/restore/local/execute', async (req, res) => {
  const body = parseOr400(localExecuteSchema, req.body, res);
  if (!body) return;
  const { id, passphrase, recoveryKey } = body;
  // Re-scan and resolve `id` server-side — never trust a client-supplied path.
  const all: LocalBundle[] = [];
  for (const [key, dir] of Object.entries(RESTORE_LOCAL_ROOTS)) all.push(...scanLocalBundles(key, dir));
  const bundle = all.find((b) => b.id === id);
  if (!bundle) {
    res.status(404).json({ error: { message: 'No local backup with that id (it may have moved or the drive is unmounted)' } });
    return;
  }
  try { assertPathsWithinRoots(bundle.files); }
  catch (err) { res.status(400).json({ error: { message: err instanceof Error ? err.message : 'Invalid path' } }); return; }
  // A restore is one-at-a-time — refuse a second, possibly-different bundle
  // rather than silently attach it to the in-flight run and report false
  // success. (The wizard resumes a reload by polling the stored runId, not by
  // re-calling execute, so this never breaks resume.)
  const active = peekActiveRestoreRun();
  if (active) { res.status(409).json({ runId: active.id, error: { message: 'A restore is already in progress. Wait for it to finish.' } }); return; }
  const run = startRestoreRun(localContentSource(bundle.files, passphrase), { recoveryKey });
  res.status(202).json(restoreRunView(run));
});

// ─── Restore from a remote object store (B2/S3), creds entered now ──
//
// A wiped box has no stored B2 credentials (they were in the DB), so the
// operator supplies them at restore time. We list/download the bundle with
// those creds, then run the same guarded restore.

interface RemoteRestoreCreds {
  provider: 'b2' | 's3';
  bucket: string; endpoint: string; keyId: string; applicationKey: string;
  region?: string; prefix?: string;
}

// SSRF guard: these endpoints are pre-auth (first-run only) and connect to an
// operator-supplied endpoint. Require https and reject obvious internal
// targets (loopback, link-local/cloud-metadata, RFC-1918 literals) so a
// network-reachable actor on an un-provisioned box can't probe internal
// services. Full DNS-rebinding protection is out of scope for a trusted
// first-run appliance; this blocks the easy cases.
export function assertSafeEndpoint(endpoint: string): void {
  let u: URL;
  try { u = new URL(endpoint); } catch { throw new Error('endpoint must be a valid https URL'); }
  if (u.protocol !== 'https:') throw new Error('endpoint must use https');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // unwrap [::1]
  const blocked = () => { throw new Error('endpoint host is not allowed'); };
  if (host === 'localhost' || host === '0.0.0.0' || host === '::' || host === '::1') blocked();

  const kind = net.isIP(host); // 4, 6, or 0 (not an IP literal)
  if (kind === 6) {
    // Object stores don't use loopback/link-local/unique-local IPv6, and an
    // IPv4-mapped IPv6 (::ffff:169.254.169.254) can smuggle the metadata IP
    // past an IPv4-only check — block them all.
    if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd') || host.includes('::ffff:') || host.includes('::')) blocked();
  } else if (kind === 4) {
    // RFC-1918 private is ALLOWED (legit LAN object store); block only
    // loopback and the link-local / cloud-metadata range.
    if (/^127\./.test(host) || /^169\.254\./.test(host)) blocked();
  } else {
    // Not a valid IP literal. A real endpoint is a DNS name (has letters);
    // reject a purely-numeric host (decimal/hex/octal IP encodings like
    // 2852039166 or 0xA9FEA9FE that the resolver would turn into an IP).
    if (!/[a-z]/i.test(host)) blocked();
  }
}

function parseRemoteCreds(body: unknown): RemoteRestoreCreds {
  const parsed = remoteCredsSchema.safeParse(body ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(first ? `${first.path.join('.')}: ${first.message}` : 'bucket, endpoint, keyId, and applicationKey are required');
  }
  const c = parsed.data;
  assertSafeEndpoint(c.endpoint);
  return {
    provider: c.provider, bucket: c.bucket, endpoint: c.endpoint, keyId: c.keyId, applicationKey: c.applicationKey,
    region: c.region || undefined,
    prefix: c.prefix !== undefined ? c.prefix : 'backups/',
  };
}

// The restore provider is built with NO prefix and operates on FULL object
// keys — this sidesteps the double-slash prefix math entirely (list returns
// full keys, download uses them verbatim). The operator's `prefix` is used
// only to SCOPE the listing.
async function buildRemoteProvider(c: RemoteRestoreCreds) {
  if (c.provider === 's3') {
    const { S3Provider } = await import('../services/storage/s3.provider.js');
    return new S3Provider({
      bucket: c.bucket, region: c.region, endpoint: c.endpoint,
      accessKeyId: c.keyId, secretAccessKey: c.applicationKey, prefix: '',
    });
  }
  const { B2Provider } = await import('../services/storage/b2.provider.js');
  return new B2Provider({
    bucket: c.bucket, endpoint: c.endpoint, keyId: c.keyId,
    applicationKey: c.applicationKey, region: c.region, prefix: '',
  });
}

setupRouter.post('/restore/remote/list', async (req, res) => {
  let creds: RemoteRestoreCreds;
  try { creds = parseRemoteCreds(req.body ?? {}); }
  catch (err) { res.status(400).json({ error: { message: err instanceof Error ? err.message : 'Invalid credentials' } }); return; }

  try {
    const provider = await buildRemoteProvider(creds);
    // Scope by the operator's prefix; list generously so a multipart bundle
    // whose parts span a page boundary in a large bucket isn't truncated.
    const objects = await provider.listObjects(creds.prefix ?? '', 100_000);
    const series = new Map<string, { keys: Map<number, { key: string; size: number }>; declared: number; modified: string | null }>();
    const bundles: Array<{ id: string; label: string; keys: string[]; partCount: number; size: number; modifiedAt: string | null }> = [];
    for (const o of objects) {
      const name = o.key.split('/').pop() ?? o.key;
      const mp = name.match(MULTIPART_RE);
      if (mp) {
        const base = `${o.key.slice(0, o.key.length - name.length)}${mp[1]}`;
        const s = series.get(base) ?? { keys: new Map(), declared: parseInt(mp[3]!, 10), modified: o.lastModified };
        s.declared = parseInt(mp[3]!, 10);
        s.keys.set(parseInt(mp[2]!, 10), { key: o.key, size: o.size });
        if (o.lastModified && (!s.modified || o.lastModified > s.modified)) s.modified = o.lastModified;
        series.set(base, s);
      } else if (name.endsWith('.vmx') || name.endsWith('.vmb')) {
        bundles.push({ id: o.key, label: name, keys: [o.key], partCount: 1, size: o.size, modifiedAt: o.lastModified });
      }
    }
    for (const [base, s] of series) {
      const idxs = [...s.keys.keys()].sort((a, b) => a - b);
      if (idxs.length !== s.declared || !idxs.every((n, i) => n === i + 1)) continue;
      bundles.push({
        id: base, label: `${base.split('/').pop()} (${s.declared} parts)`,
        keys: idxs.map((n) => s.keys.get(n)!.key), partCount: s.declared,
        size: idxs.reduce((sum, n) => sum + s.keys.get(n)!.size, 0), modifiedAt: s.modified,
      });
    }
    bundles.sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''));
    res.json({ bundles });
  } catch (err) {
    res.status(400).json({ error: { message: `Could not list backups: ${err instanceof Error ? err.message : String(err)}` } });
  }
});

setupRouter.post('/restore/remote/execute', async (req, res) => {
  const body = parseOr400(remoteExecuteSchema, req.body, res);
  if (!body) return;
  const { passphrase, keys, recoveryKey } = body;
  let creds: RemoteRestoreCreds;
  try { creds = parseRemoteCreds(req.body ?? {}); }
  catch (err) { res.status(400).json({ error: { message: err instanceof Error ? err.message : 'Invalid credentials' } }); return; }

  // One restore at a time — refuse (don't silently attach a different bundle
  // to the in-flight run) and skip a wasted multi-GB download.
  const active = peekActiveRestoreRun();
  if (active) { res.status(409).json({ runId: active.id, error: { message: 'A restore is already in progress. Wait for it to finish.' } }); return; }

  // Download the part(s) to a temp stage dir — STREAMED with a per-object
  // size cap so a huge object can't OOM the process — then restore.
  const REMOTE_OBJECT_MAX = 4 * 1024 * 1024 * 1024; // 4 GB per part
  const dir = path.join(RESTORE_UPLOAD_DIR, `remote-${crypto.randomUUID()}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const provider = await buildRemoteProvider(creds);
    const localFiles: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const dest = path.join(dir, `part${i + 1}.${key.endsWith('.vmb') ? 'vmb' : 'vmx'}`);
      await provider.downloadToFile(key, dest, REMOTE_OBJECT_MAX);
      localFiles.push(dest);
    }
    const run = startRestoreRun(
      localContentSource(localFiles, passphrase),
      {
        onSettle: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } },
        recoveryKey,
      },
    );
    res.status(202).json(restoreRunView(run));
  } catch (err) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    res.status(400).json({ error: { message: `Restore from remote failed: ${err instanceof Error ? err.message : String(err)}` } });
  }
});

// restoreTableRows / resyncOwnedSequences moved to
// services/system-restore.service.ts, which adds FK-aware ordering,
// multi-pass fixpoint retry, and per-row failure reporting.
