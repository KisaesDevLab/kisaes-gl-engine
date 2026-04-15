import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import net from 'net';
import pg from 'pg';
import bcrypt from 'bcrypt';
import nodemailer from 'nodemailer';
import { db } from '../db/index.js';
import { tenants, users, companies, userTenantAccess } from '../db/schema/index.js';
import { sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import * as accountsService from './accounts.service.js';
import * as adminService from './admin.service.js';
import {
  createSentinel,
  readSentinelHeader,
  sentinelExists,
  SentinelError,
} from './sentinel.service.js';
import { ensureHostId } from './host-id.service.js';
import { writeAtomicSync } from '../utils/atomic-write.js';
import { SystemSettingsKeys } from '../constants/system-settings-keys.js';
import { generateRecoveryKey } from './recovery-key.service.js';
import { writeRecoveryFile } from './env-recovery.service.js';

const CONFIG_DIR = process.env['CONFIG_DIR'] || '/data/config';
const INITIALIZED_MARKER = path.join(CONFIG_DIR, '.initialized');

// Advisory-lock key used to serialize `/initialize` and `/restore/execute`
// calls across concurrent processes. Picked arbitrarily; the only
// requirement is that it stays stable across deploys so two API replicas
// contend on the same lock.
const SETUP_ADVISORY_LOCK_KEY = 4242424242;

export interface SetupStatus {
  envFileExists: boolean;
  databaseReachable: boolean;
  databaseInitialized: boolean;
  hasAdminUser: boolean;
  smtpConfigured: boolean;
  setupComplete: boolean;
  /**
   * True when we could not determine whether the system is initialized
   * (e.g. DB unreachable). The route guard treats this as "locked" — fail
   * closed — so a transient DB hiccup can never open the destructive
   * setup endpoints to an anonymous caller.
   */
  statusCheckFailed: boolean;
}

/**
 * Persistent installation marker. Once this file exists, the system is
 * treated as initialized forever — no heuristic can flip it back. Removing
 * it requires deliberate manual action on the server filesystem.
 */
export function isInitialized(): boolean {
  return fs.existsSync(INITIALIZED_MARKER);
}

export function markInitialized(extra: Record<string, unknown> = {}): void {
  const payload = { initializedAt: new Date().toISOString(), ...extra };
  writeAtomicSync(INITIALIZED_MARKER, JSON.stringify(payload, null, 2), 0o600);
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const smtpConfigured = !!(process.env['SMTP_HOST'] && process.env['SMTP_HOST'].length > 0);

  // Short-circuit #1: persistent marker is authoritative.
  if (isInitialized()) {
    return {
      envFileExists: true,
      databaseReachable: true,
      databaseInitialized: true,
      hasAdminUser: true,
      smtpConfigured,
      setupComplete: true,
      statusCheckFailed: false,
    };
  }

  const envFileExists = fs.existsSync(path.join(CONFIG_DIR, '.env')) || !!process.env['JWT_SECRET'];

  let databaseReachable = false;
  let databaseInitialized = false;
  let hasAdminUser = false;
  let statusCheckFailed = false;

  try {
    const result = await db.execute(sql`SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'tenants') as exists`);
    databaseReachable = true;
    databaseInitialized = (result.rows as any[])[0]?.exists === true;

    if (databaseInitialized) {
      try {
        const userCount = await db.execute(sql`SELECT COUNT(*) as cnt FROM users`);
        hasAdminUser = parseInt((userCount.rows as any[])[0]?.cnt || '0') > 0;

        // Self-healing: if the DB already has tenants + users but the
        // marker file is missing (e.g. operator lost /data/config/), write
        // the marker now so no future status check can ever flip back to
        // "not initialized". This closes the "lost volume → wipe" path.
        if (hasAdminUser) {
          const tenantCount = await db.execute(sql`SELECT COUNT(*) as cnt FROM tenants`);
          const hasTenants = parseInt((tenantCount.rows as any[])[0]?.cnt || '0') > 0;
          if (hasTenants) {
            // SENTINEL GUARD (F2): do not self-heal if the sentinel exists
            // and its installation ID disagrees with the DB. That combination
            // means the DB was wiped and an attacker — or a mistake — has
            // inserted tenant+user rows without updating installation_id in
            // system_settings. Letting self-heal run would hide the reset
            // from the validator. Instead, bail out with statusCheckFailed
            // so the route guard stays locked and the validator produces
            // the appropriate diagnostic page on next boot.
            if (sentinelExists()) {
              try {
                const header = readSentinelHeader();
                const dbInstallationId = await adminService.getSetting(
                  SystemSettingsKeys.INSTALLATION_ID,
                );
                if (header && dbInstallationId && header.installationId !== dbInstallationId) {
                  return {
                    envFileExists,
                    databaseReachable: true,
                    databaseInitialized: true,
                    hasAdminUser,
                    smtpConfigured,
                    setupComplete: true,
                    statusCheckFailed: true,
                  };
                }
                if (header && !dbInstallationId) {
                  // Sentinel exists but DB has no installation_id row — the
                  // tenant rows came from somewhere other than a real setup.
                  // Refuse to self-heal.
                  return {
                    envFileExists,
                    databaseReachable: true,
                    databaseInitialized: true,
                    hasAdminUser,
                    smtpConfigured,
                    setupComplete: true,
                    statusCheckFailed: true,
                  };
                }
              } catch {
                // If we can't read the sentinel at all, be conservative and
                // block self-heal too.
                return {
                  envFileExists,
                  databaseReachable: true,
                  databaseInitialized: true,
                  hasAdminUser,
                  smtpConfigured,
                  setupComplete: true,
                  statusCheckFailed: true,
                };
              }
            }
            try {
              markInitialized({ recoveredFromExistingData: true });
            } catch {
              // best-effort; next call will retry
            }
            return {
              envFileExists: true,
              databaseReachable: true,
              databaseInitialized: true,
              hasAdminUser: true,
              smtpConfigured,
              setupComplete: true,
              statusCheckFailed: false,
            };
          }
        }
      } catch {
        // Second query failed independently; treat the whole check as
        // indeterminate rather than silently falling through with
        // hasAdminUser = false (which would open the guard).
        statusCheckFailed = true;
      }
    }
  } catch {
    statusCheckFailed = true;
  }

  // Fail closed: if we couldn't verify the DB state, report
  // setupComplete = true so the route guard rejects destructive calls.
  // The UI separately sees statusCheckFailed = true and can tell the
  // operator to wait for the DB.
  const setupComplete =
    statusCheckFailed ||
    (envFileExists && databaseReachable && databaseInitialized && hasAdminUser);

  return {
    envFileExists,
    databaseReachable,
    databaseInitialized,
    hasAdminUser,
    smtpConfigured,
    setupComplete,
    statusCheckFailed,
  };
}

/**
 * Wrap a setup operation in a Postgres advisory lock so concurrent
 * `/initialize` calls can't both proceed. Throws if the lock cannot be
 * acquired. Release happens in `finally` regardless of outcome.
 */
export async function withSetupLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockRes = await db.execute(
    sql`SELECT pg_try_advisory_lock(${SETUP_ADVISORY_LOCK_KEY}) as locked`,
  );
  const locked = (lockRes.rows as any[])[0]?.locked === true;
  if (!locked) {
    throw new Error('Another setup operation is already in progress. Please wait a moment and retry.');
  }
  try {
    return await fn();
  } finally {
    try {
      await db.execute(sql`SELECT pg_advisory_unlock(${SETUP_ADVISORY_LOCK_KEY})`);
    } catch {
      // If the unlock fails we log nothing — the session will release the
      // lock when it ends, so subsequent calls won't deadlock.
    }
  }
}

export function generateSecurePassword(length: number = 24): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes).map((b) => chars[b % chars.length]).join('');
}

export function generateJwtSecret(): string {
  return crypto.randomBytes(64).toString('hex');
}

export function generateSecrets() {
  // Reuse existing process.env values when they are set so the wizard
  // writes the same secrets the container is already running with. This
  // matters in dev where docker-compose reads from a host .env file and
  // the wizard would otherwise produce a NEW ENCRYPTION_KEY that doesn't
  // match the one used by the running process — the next container
  // restart would then hit SENTINEL_DECRYPT_FAILED.
  //
  // /generate-secrets is only reachable while the setup guard is open
  // (setupComplete=false), so this is not a post-setup info-leak surface.
  const envJwt = process.env['JWT_SECRET'];
  const envBackup = process.env['BACKUP_ENCRYPTION_KEY'];
  const envEncryption = process.env['ENCRYPTION_KEY'];
  const envPlaidEncryption = process.env['PLAID_ENCRYPTION_KEY'];
  // Use >= 32 (not env.ts's >= 20) so reused values pass the stricter
  // /initialize validation. Values shorter than that — the default dev
  // placeholder "change-me-in-production" — get replaced with a fresh one.
  return {
    dbPassword: generateSecurePassword(20),
    jwtSecret: envJwt && envJwt.length >= 32 ? envJwt : generateJwtSecret(),
    backupKey: envBackup && envBackup.length >= 32 ? envBackup : crypto.randomBytes(32).toString('hex'),
    // Installation ENCRYPTION_KEY — encrypts the sentinel file. 64-char hex
    // (32 bytes). Reused from process.env when present so the sentinel
    // stays decryptable across container restarts.
    encryptionKey: envEncryption && envEncryption.length >= 32 ? envEncryption : crypto.randomBytes(32).toString('hex'),
    // PLAID_ENCRYPTION_KEY — wraps Plaid / Stripe / OAuth refresh tokens
    // and TFA secrets. Distinct from the sentinel key so a key-rotation on
    // one surface doesn't force a rotation on the other. Reused from
    // process.env for the same reason encryptionKey is.
    plaidEncryptionKey:
      envPlaidEncryption && envPlaidEncryption.length >= 32
        ? envPlaidEncryption
        : crypto.randomBytes(32).toString('hex'),
  };
}

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

/**
 * Parse DATABASE_URL from the current process environment (injected by
 * docker-compose from the host .env) and return the connection components
 * so the setup wizard can pre-populate its Database step with values that
 * actually match the running Postgres container.
 *
 * This INCLUDES the password by design. The install scripts
 * (scripts/install.sh, scripts/install.ps1) auto-generate a random
 * POSTGRES_PASSWORD and write it to .env — the end user never sees it
 * and has no way to type it back into the wizard. Returning it here lets
 * the wizard auto-fill the Database step so the user just clicks Next.
 *
 * Why this is safe to expose over HTTP:
 *   - The setup router blocks every non-status endpoint once
 *     /data/config/.initialized exists (see setupRouter.use in
 *     setup.routes.ts). After setup completes, this endpoint returns 403.
 *   - The password is for the local Postgres container, which is only
 *     reachable from inside the docker-compose network. Leaking it to
 *     the local operator running the wizard is a no-op because they
 *     already have filesystem access to /data/config/.env.
 *   - Post-setup the value is written to /data/config/.env with mode
 *     0600; pre-setup the threat surface is strictly smaller.
 */
export function getDatabaseDefaults(): {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  /** True when the password was parsed from DATABASE_URL (i.e. the
   *  install script already generated one). The wizard uses this to
   *  decide whether to show "auto-detected" messaging or prompt the
   *  user for input. */
  passwordAutoDetected: boolean;
  source: 'env' | 'fallback';
} {
  const url = process.env['DATABASE_URL'];
  if (url) {
    try {
      const parsed = new URL(url);
      const password = decodeURIComponent(parsed.password || '');
      return {
        host: parsed.hostname || 'db',
        port: parsed.port ? Number(parsed.port) : 5432,
        database: (parsed.pathname || '').replace(/^\//, '') || 'kisbooks',
        username: decodeURIComponent(parsed.username || '') || 'kisbooks',
        password,
        passwordAutoDetected: password.length > 0,
        source: 'env',
      };
    } catch {
      // Malformed DATABASE_URL — fall through to compose defaults.
    }
  }
  // Match the docker-compose.yml service/user/db defaults. No password
  // fallback — if DATABASE_URL isn't set we legitimately don't know it
  // and the operator will have to type or paste one in.
  return {
    host: process.env['POSTGRES_HOST'] || 'db',
    port: Number(process.env['POSTGRES_PORT'] || 5432),
    database: process.env['POSTGRES_DB'] || 'kisbooks',
    username: process.env['POSTGRES_USER'] || 'kisbooks',
    password: process.env['POSTGRES_PASSWORD'] || '',
    passwordAutoDetected: !!process.env['POSTGRES_PASSWORD'],
    source: 'fallback',
  };
}

export async function testDatabaseConnection(config: DbConfig): Promise<{ success: boolean; error?: string }> {
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.username,
    password: config.password,
    connectionTimeoutMillis: 5000,
  });

  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    await pool.end();
    return { success: true };
  } catch (err) {
    await pool.end().catch(() => {});
    return { success: false, error: err instanceof Error ? err.message : 'Connection failed' };
  }
}

export interface SmtpConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  from: string;
}

export async function testSmtpConnection(config: SmtpConfig, testEmail?: string): Promise<{ success: boolean; error?: string }> {
  try {
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: config.username ? { user: config.username, pass: config.password } : undefined,
    });

    await transport.verify();

    if (testEmail) {
      await transport.sendMail({
        from: config.from,
        to: testEmail,
        subject: 'Vibe MyBooks — SMTP Test',
        text: 'If you received this email, your SMTP configuration is working correctly.',
      });
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'SMTP test failed' };
  }
}

export interface SetupConfig {
  db: DbConfig;
  redis: { host: string; port: number; password?: string };
  smtp?: SmtpConfig;
  jwtSecret: string;
  backupKey: string;
  encryptionKey: string;
  plaidEncryptionKey: string;
  appUrl?: string;
  ports?: { api?: number; frontend?: number };
  admin: { email: string; password: string; displayName: string };
  company: { name: string; industry?: string; entityType?: string; businessType?: string };
  /**
   * If true, the setup flow also creates a second "Demo Bookkeeping Co"
   * tenant populated with sample transactions across the current year and
   * the prior year. The admin user is granted owner access to both tenants
   * and can switch between them from the app UI. Opt-in because it's
   * roughly 200 extra ledger writes and the extra tenant is a surprise if
   * you weren't expecting it.
   */
  createDemoCompany?: boolean;
}

export async function checkPortAvailability(port: number): Promise<{ port: number; available: boolean }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve({ port, available: false }));
    server.once('listening', () => { server.close(); resolve({ port, available: true }); });
    server.listen(port, '0.0.0.0');
  });
}

export function writeEnvFile(config: SetupConfig): string {
  const dbUrl = `postgresql://${config.db.username}:${config.db.password}@${config.db.host}:${config.db.port}/${config.db.database}`;
  const redisUrl = config.redis.password
    ? `redis://:${config.redis.password}@${config.redis.host}:${config.redis.port}`
    : `redis://${config.redis.host}:${config.redis.port}`;

  const apiPort = config.ports?.api || 3001;
  const frontendPort = config.ports?.frontend || 5173;

  const envContent = `# Vibe MyBooks Configuration — Generated by Setup Wizard
# ${new Date().toISOString()}

# Database
DATABASE_URL=${dbUrl}
DB_HOST_PORT=${config.db.port}

# Redis
REDIS_URL=${redisUrl}
REDIS_HOST_PORT=${config.redis.port}

# Auth
JWT_SECRET=${config.jwtSecret}
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d

# Installation encryption key — encrypts the sentinel file at /data/.sentinel.
# Do NOT regenerate — a new key cannot decrypt the existing sentinel.
ENCRYPTION_KEY=${config.encryptionKey}

# Token encryption key — wraps Plaid access tokens, Stripe secrets, OAuth
# refresh tokens, and TFA secrets at rest. Do NOT regenerate after tokens
# have been stored: a new key cannot decrypt existing ciphertext.
PLAID_ENCRYPTION_KEY=${config.plaidEncryptionKey}

# Server Ports
PORT=${apiPort}
VITE_PORT=${frontendPort}
NODE_ENV=production
CORS_ORIGIN=${config.appUrl || `http://localhost:${frontendPort}`}

# Email (SMTP)
SMTP_HOST=${config.smtp?.host || ''}
SMTP_PORT=${config.smtp?.port || 587}
SMTP_USER=${config.smtp?.username || ''}
SMTP_PASS=${config.smtp?.password || ''}
SMTP_FROM=${config.smtp?.from || 'noreply@example.com'}

# File storage
UPLOAD_DIR=/data/uploads
MAX_FILE_SIZE_MB=10

# Backup
BACKUP_DIR=/data/backups
BACKUP_ENCRYPTION_KEY=${config.backupKey}
`;

  // Write to config dir
  const dir = CONFIG_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, '.env');

  // Bulletproof guard: refuse to overwrite an existing env file. The only
  // legitimate way to re-run setup is to delete both /data/config/.env
  // and /data/config/.initialized by hand on the server. This prevents
  // silently destroying BACKUP_ENCRYPTION_KEY — overwriting it would
  // render every previously-taken encrypted backup cryptographically
  // unrecoverable, with no warning to the operator.
  //
  // We still take a timestamped backup first as extra insurance: even if
  // some future code path bypasses this guard, the prior values remain
  // recoverable on disk.
  if (fs.existsSync(filePath)) {
    const backupPath = `${filePath}.pre-setup-${Date.now()}`;
    try { fs.copyFileSync(filePath, backupPath); } catch { /* best-effort */ }
    throw new Error(
      `Refusing to overwrite existing configuration at ${filePath}. ` +
      `A backup copy was saved to ${backupPath}. ` +
      `If you intend to reinstall from scratch, stop the service and delete both ` +
      `${filePath} and ${INITIALIZED_MARKER} manually before re-running setup.`,
    );
  }

  fs.writeFileSync(filePath, envContent, { mode: 0o600 });
  return filePath;
}

export async function createAdminUser(input: { email: string; password: string; displayName: string; companyName: string; industry?: string; entityType?: string; businessType?: string }) {
  // Defense-in-depth: refuse to initialize if the database already contains
  // tenants or users. Even if the route guard, the setup token, and the
  // persistent marker are all bypassed somehow, this check prevents a
  // setup run from silently planting a super-admin user on top of a
  // populated database.
  const existingTenants = await db.execute(sql`SELECT COUNT(*) as cnt FROM tenants`);
  const tenantCount = parseInt((existingTenants.rows as any[])[0]?.cnt || '0');
  if (tenantCount > 0) {
    throw new Error(
      `Cannot initialize: ${tenantCount} tenant(s) already exist in the database. ` +
      `This looks like an already-configured installation.`,
    );
  }
  const existingUsers = await db.execute(sql`SELECT COUNT(*) as cnt FROM users`);
  const userCount = parseInt((existingUsers.rows as any[])[0]?.cnt || '0');
  if (userCount > 0) {
    throw new Error(
      `Cannot initialize: ${userCount} user account(s) already exist in the database.`,
    );
  }

  // Create tenant
  const slug = input.companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80) + '-' + crypto.randomBytes(4).toString('hex');
  const [tenant] = await db.insert(tenants).values({ name: input.companyName, slug }).returning();
  if (!tenant) throw new Error('Failed to create tenant');

  // Create company
  await db.insert(companies).values({
    tenantId: tenant.id,
    businessName: input.companyName,
    entityType: input.entityType || 'sole_prop',
    industry: input.industry || null,
    setupComplete: true,
  });

  // Create user (first user is super admin)
  const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS);
  const [user] = await db.insert(users).values({
    tenantId: tenant.id,
    email: input.email,
    passwordHash,
    displayName: input.displayName,
    role: 'owner',
    isSuperAdmin: true,
  }).returning();

  if (!user) throw new Error('Failed to create admin user');

  // Create user-tenant access record
  await db.insert(userTenantAccess).values({
    userId: user.id,
    tenantId: tenant.id,
    role: 'owner',
  });

  // Seed COA with business type template
  await accountsService.seedFromTemplate(tenant.id, input.businessType || 'default');

  return { tenantId: tenant.id, userId: user.id };
}

/**
 * Finalize installation integrity state: generate an installation_id, write
 * it to system_settings, create the volume-pinned host-id file if missing,
 * write the encrypted sentinel file, and hand back the generated installation
 * ID so the caller can stash it in the .initialized marker for redundancy.
 *
 * Throws if any step fails. The caller (setup.routes.ts) must abort the
 * /initialize response with 500 when this throws (F9) — a partial setup
 * without a sentinel leaves the installation defenseless against the very
 * threat this work exists to solve.
 *
 * Idempotent only in the sense that writeAtomicSync will overwrite the
 * sentinel; callers should guard against repeat invocation with
 * withSetupLock.
 */
export async function completeSetupSentinel(input: {
  adminEmail: string;
  databaseUrl: string;
  jwtSecret: string;
  encryptionKey: string;
  appVersion: string;
  tenantCountAtSetup: number;
}): Promise<{ installationId: string; hostId: string; recoveryKey: string }> {
  const installationId = crypto.randomUUID();
  await adminService.setSetting(SystemSettingsKeys.INSTALLATION_ID, installationId);

  const hostId = ensureHostId();

  try {
    createSentinel(
      {
        installationId,
        hostId,
        adminEmail: input.adminEmail,
        appVersion: input.appVersion,
        databaseUrl: input.databaseUrl,
        jwtSecret: input.jwtSecret,
        tenantCountAtSetup: input.tenantCountAtSetup,
      },
      input.encryptionKey,
    );
  } catch (err) {
    const message = err instanceof SentinelError ? err.message : (err as Error).message;
    throw new Error(
      `Failed to write installation sentinel: ${message}. Setup is aborting — ` +
        `/data/ must be writable before re-running setup. The partially-created ` +
        `installation_id in system_settings will be overwritten on the next attempt.`,
    );
  }

  // Phase B: generate the recovery key and write /data/.env.recovery. The
  // key is returned to the caller so it can be shown exactly once in the
  // wizard UI. We do NOT persist the plaintext key anywhere — it lives only
  // in the HTTP response body until the operator acknowledges it.
  //
  // Sentinel write already succeeded, so if recovery file writing fails we
  // log but don't abort setup — the installation is still protected by the
  // sentinel, and the operator can regenerate the recovery file later from
  // admin settings (Phase B.8).
  const recoveryKey = generateRecoveryKey();
  try {
    writeRecoveryFile(
      recoveryKey,
      {
        encryptionKey: input.encryptionKey,
        jwtSecret: input.jwtSecret,
        databaseUrl: input.databaseUrl,
      },
      installationId,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[setup] failed to write /data/.env.recovery: ${(err as Error).message}. ` +
        `Setup will continue but operator must regenerate the recovery file from admin settings.`,
    );
  }

  return { installationId, hostId, recoveryKey };
}
