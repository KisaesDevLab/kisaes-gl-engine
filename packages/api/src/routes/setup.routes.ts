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
  //   - /restore/runs/*: polling a restore run — a SUCCESSFUL restore marks
  //     setup complete before the run flips to 'complete', so without this
  //     exemption the wizard's poll 403s at the exact moment of success and
  //     the operator never sees the result (or the one-time recovery key).
  //     Read-only, in-memory run metadata; the same data the execute
  //     response used to carry synchronously.
  if (
    req.path === '/status' ||
    req.path === '/pending-recovery-key' ||
    req.path === '/acknowledge-recovery-key' ||
    (req.method === 'GET' && req.path.startsWith('/restore/runs/'))
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

  const uploadedPath = req.file.path;
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
        return { content: pkg.data as RestoreContent, packageAttachments: () => pkg.attachments() };
      }
      const { data } = smartDecrypt(fs.readFileSync(uploadedPath), passphrase);
      return { content: JSON.parse(data.toString()) as RestoreContent, packageAttachments: null };
    },
    {
      // The uploaded backup landed on disk (multer diskStorage) — remove it
      // once the run settles (NOT in this handler: the run reads it async).
      onSettle: () => { try { fs.unlinkSync(uploadedPath); } catch { /* already gone */ } },
    },
  );
  res.status(202).json(restoreRunView(run));
});

// `content` is the decrypted DB payload (evolving-any, exactly as the
// original JSON.parse path — rows are re-inserted via parameterized SQL).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RestoreContent = any;

type ContentSource = () => Promise<{
  content: RestoreContent;
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

function startRestoreRun(
  readContent: ContentSource,
  opts: { onSuccess?: () => void; onSettle?: () => void } = {},
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
      run.result = await runGuardedSetupRestore(readContent);
      run.status = 'complete';
      try { opts.onSuccess?.(); } catch { /* cleanup is best-effort */ }
    } catch (err) {
      run.status = 'failed';
      run.error = err instanceof Error ? err.message : 'Restore failed';
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
  const run = restoreRuns.get(req.params['runId']!);
  if (!run) {
    res.status(404).json({ error: { message: 'Unknown restore run — it may have been lost to an api restart; retry the restore' } });
    return;
  }
  res.json(restoreRunView(run));
});

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
        } else if (!isSameHost && restoredInstallationFiles.envRecovery) {
          // Cross-host: the main recovery file was just re-minted for THIS
          // host, but PARK the source install's file alongside it. The
          // operator can later enter their ORIGINAL recovery key to recover
          // the source credential-encryption key and re-encrypt every
          // restored *_encrypted credential (Admin → Security).
          try {
            const { writeSourceRecoveryFileRaw } = await import('../services/env-recovery.service.js');
            writeSourceRecoveryFileRaw(Buffer.from(restoredInstallationFiles.envRecovery, 'base64'));
          } catch (err) {
            console.error('[restore] source recovery file parking failed (non-fatal):', err instanceof Error ? err.message : err);
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

  const run = startRestoreRun(
    async () => {
      if (meta!.classic && !isZipFile(paths[0]!)) {
        const { smartDecrypt } = await import('../services/portable-encryption.service.js');
        const { data } = smartDecrypt(fs.readFileSync(paths[0]!), passphrase);
        return { content: JSON.parse(data.toString()) as RestoreContent, packageAttachments: null };
      }
      const { readTenantPackageMulti } = await import('../services/vmx-package.js');
      const pkg = await readTenantPackageMulti(paths, passphrase);
      return { content: pkg.data as RestoreContent, packageAttachments: () => pkg.attachments() };
    },
    {
      // Success — the staged files have served their purpose. On failure
      // they stay so the operator can retry (e.g. re-upload one corrupted
      // part) without re-uploading everything.
      onSuccess: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } },
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

  const walk = (dir: string) => {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      // A symlink is fine ONLY if its realpath stays inside this root — a
      // legit backup drive is often symlink-mounted, but a link escaping the
      // root (e.g. → /etc/passwd) must never be listed or restored.
      let lst: fs.Stats;
      try { lst = fs.lstatSync(full); } catch { continue; }
      if (lst.isSymbolicLink()) {
        try {
          const real = fs.realpathSync(full);
          if (!(real + path.sep).startsWith(rootReal + path.sep) && real !== rootReal) continue;
        } catch { continue; }
      }
      let st: fs.Stats;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full); continue; }
      const mp = entry.match(MULTIPART_RE);
      if (mp) {
        const base = path.join(dir, mp[1]!);
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
      return { content: JSON.parse(data.toString()) as RestoreContent, packageAttachments: null };
    }
    if (files.length === 1) {
      const { readTenantPackage } = await import('../services/vmx-package.js');
      const pkg = await readTenantPackage(files[0]!, passphrase);
      return { content: pkg.data as RestoreContent, packageAttachments: () => pkg.attachments() };
    }
    const { readTenantPackageMulti } = await import('../services/vmx-package.js');
    const pkg = await readTenantPackageMulti(files, passphrase);
    return { content: pkg.data as RestoreContent, packageAttachments: () => pkg.attachments() };
  };
}

setupRouter.get('/restore/local/list', (_req, res) => {
  const bundles: LocalBundle[] = [];
  for (const [key, dir] of Object.entries(RESTORE_LOCAL_ROOTS)) bundles.push(...scanLocalBundles(key, dir));
  res.json({
    roots: Object.entries(RESTORE_LOCAL_ROOTS).map(([key, dir]) => ({ key, dir, present: fs.existsSync(dir) })),
    // Never leak absolute paths; the client restores by opaque `id`.
    bundles: bundles.map((b) => ({ id: b.id, root: b.root, label: b.label, kind: b.kind, partCount: b.partCount, size: b.size, modifiedAt: b.modifiedAt })),
  });
});

setupRouter.post('/restore/local/execute', async (req, res) => {
  const id = (req.body?.id ?? '').toString();
  const passphrase = req.body?.passphrase;
  if (!passphrase || typeof passphrase !== 'string') {
    res.status(400).json({ error: { message: 'Passphrase is required' } });
    return;
  }
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
  if (active) { res.status(409).json({ error: { message: 'A restore is already in progress. Wait for it to finish.', runId: active.id } }); return; }
  const run = startRestoreRun(localContentSource(bundle.files, passphrase));
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
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1') {
    throw new Error('endpoint host is not allowed');
  }
  // Range checks apply ONLY to literal IPv4 addresses — never to DNS names
  // (so "10.storage.example.com" is fine). Private RFC-1918 ranges are
  // ALLOWED (a self-hosted LAN MinIO/S3 is a legitimate restore source);
  // we block only loopback and the link-local / cloud-metadata range, which
  // is the high-value SSRF target and never a real object store.
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (isIpv4 && (/^127\./.test(host) || /^169\.254\./.test(host))) {
    throw new Error('endpoint host is not allowed');
  }
}

function parseRemoteCreds(body: Record<string, unknown>): RemoteRestoreCreds {
  const provider = String(body['provider'] ?? 'b2');
  if (provider !== 'b2' && provider !== 's3') throw new Error('provider must be b2 or s3');
  const bucket = String(body['bucket'] ?? '').trim();
  const endpoint = String(body['endpoint'] ?? '').trim();
  const keyId = String(body['keyId'] ?? '').trim();
  const applicationKey = String(body['applicationKey'] ?? '').trim();
  if (!bucket || !endpoint || !keyId || !applicationKey) {
    throw new Error('bucket, endpoint, keyId, and applicationKey are required');
  }
  assertSafeEndpoint(endpoint);
  return {
    provider, bucket, endpoint, keyId, applicationKey,
    region: body['region'] ? String(body['region']) : undefined,
    prefix: body['prefix'] !== undefined ? String(body['prefix']) : 'backups/',
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
  const passphrase = req.body?.passphrase;
  const keys: unknown = req.body?.keys;
  if (!passphrase || typeof passphrase !== 'string') {
    res.status(400).json({ error: { message: 'Passphrase is required' } });
    return;
  }
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => typeof k === 'string')) {
    res.status(400).json({ error: { message: 'keys (the object key[s] of the bundle part[s]) are required' } });
    return;
  }
  let creds: RemoteRestoreCreds;
  try { creds = parseRemoteCreds(req.body ?? {}); }
  catch (err) { res.status(400).json({ error: { message: err instanceof Error ? err.message : 'Invalid credentials' } }); return; }

  // One restore at a time — refuse (don't silently attach a different bundle
  // to the in-flight run) and skip a wasted multi-GB download.
  const active = peekActiveRestoreRun();
  if (active) { res.status(409).json({ error: { message: 'A restore is already in progress. Wait for it to finish.', runId: active.id } }); return; }

  // Download the part(s) to a temp stage dir — STREAMED with a per-object
  // size cap so a huge object can't OOM the process — then restore.
  const REMOTE_OBJECT_MAX = 4 * 1024 * 1024 * 1024; // 4 GB per part
  const dir = path.join(RESTORE_UPLOAD_DIR, `remote-${crypto.randomUUID()}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const provider = await buildRemoteProvider(creds);
    const localFiles: string[] = [];
    for (let i = 0; i < (keys as string[]).length; i++) {
      const key = (keys as string[])[i]!;
      const dest = path.join(dir, `part${i + 1}.${key.endsWith('.vmb') ? 'vmb' : 'vmx'}`);
      await provider.downloadToFile(key, dest, REMOTE_OBJECT_MAX);
      localFiles.push(dest);
    }
    const run = startRestoreRun(
      localContentSource(localFiles, passphrase),
      { onSettle: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } } },
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
