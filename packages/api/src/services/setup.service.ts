// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import net from 'net';
import pg from 'pg';
import bcrypt from 'bcrypt';
import nodemailer from 'nodemailer';
import { db } from '../db/index.js';
import { tenants, users, companies, userTenantAccess } from '../db/schema/index.js';
import { sql, asc } from 'drizzle-orm';
import { env } from '../config/env.js';
import * as accountsService from './accounts.service.js';
import * as adminService from './admin.service.js';
import { seedDefaultsForNewTenant as seedFeatureFlags } from './feature-flags.service.js';
import { joinApplianceFirm } from './firm-provisioning.service.js';
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
import { clearRestoreIntent } from './restore-intent.service.js';

// Resolved per call (not at import) so the diagnostic app, tests and the
// CLI scripts all honour a CONFIG_DIR set after this module was first loaded.
function configDir(): string {
  return process.env['CONFIG_DIR'] || '/data/config';
}
function initializedMarkerPath(): string {
  return path.join(configDir(), '.initialized');
}

// Advisory-lock key used to serialize `/initialize` and `/restore/execute`
// calls across concurrent processes. Picked arbitrarily; the only
// requirement is that it stays stable across deploys so two API replicas
// contend on the same lock.
const SETUP_ADVISORY_LOCK_KEY = 4242424242;

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/** Shape of a `SELECT COUNT(*) AS cnt` row. pg returns bigint counts as strings. */
interface CountRow {
  cnt?: string | number | null;
}
interface ExistsRow {
  exists?: boolean | null;
}
interface LockedRow {
  locked?: boolean | null;
}

function firstCount(result: { rows: unknown[] }): number {
  const row = (result.rows as CountRow[])[0];
  const raw = row?.cnt;
  if (typeof raw === 'number') return raw;
  const parsed = parseInt(raw ?? '0', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

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
  /**
   * The database holds tenant data but NO user accounts (a tenant-scoped
   * restore, or a system bundle that carried no users). Setup stays open so
   * the wizard can create the admin account that adopts the restored data;
   * `/initialize` must be called with `adoptExistingTenants: true`.
   */
  needsAdminUser: boolean;
  /** Number of tenants currently in the database (0 when unknown). */
  tenantCount: number;
  /**
   * `/data/config/.initialized` exists but the database is completely empty
   * (no tenants, no users). The marker is from a previous life of this
   * volume — a Postgres wipe or a /data directory carried to a new server —
   * and must not hide the wizard: there is no account to log in with and
   * nothing in the database to protect. Setup re-opens; the marker is
   * rewritten when setup completes.
   */
  staleMarker: boolean;
}

/**
 * Persistent installation marker. Written when setup (or a restore that
 * produced user accounts) completes. It is a strong signal, not an oracle:
 * `getSetupStatus` always cross-checks it against the database, because a
 * marker on a volume whose database has been emptied would otherwise lock
 * the operator out of an installation that has no users at all.
 */
export function isInitialized(): boolean {
  return fs.existsSync(initializedMarkerPath());
}

export function markInitialized(extra: Record<string, unknown> = {}): void {
  const payload = { initializedAt: new Date().toISOString(), ...extra };
  writeAtomicSync(initializedMarkerPath(), JSON.stringify(payload, null, 2), 0o600);
  // A completed setup/restore supersedes any pending "I intend to restore"
  // flag written by the diagnostic prepare-restore flow.
  try { clearRestoreIntent(); } catch { /* best-effort */ }
}

export function getInitializedMarkerPath(): string {
  return initializedMarkerPath();
}

/** Row counts the setup/restore guards key on. Throws when the DB is unreachable. */
export async function countTenantsAndUsers(): Promise<{ tenants: number; users: number }> {
  const tenantRes = await db.execute(sql`SELECT COUNT(*) as cnt FROM tenants`);
  const userRes = await db.execute(sql`SELECT COUNT(*) as cnt FROM users`);
  return { tenants: firstCount(tenantRes), users: firstCount(userRes) };
}

let staleMarkerLogged = false;

function lockedStatus(base: Partial<SetupStatus>, smtpConfigured: boolean): SetupStatus {
  return {
    envFileExists: true,
    databaseReachable: true,
    databaseInitialized: true,
    hasAdminUser: true,
    smtpConfigured,
    setupComplete: true,
    statusCheckFailed: false,
    needsAdminUser: false,
    tenantCount: 0,
    staleMarker: false,
    ...base,
  };
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const smtpConfigured = !!(process.env['SMTP_HOST'] && process.env['SMTP_HOST'].length > 0);
  const envFileExists = fs.existsSync(path.join(configDir(), '.env')) || !!process.env['JWT_SECRET'];

  // Short-circuit #1: persistent marker — verified against the database.
  //
  // The marker alone used to be authoritative ("hasAdminUser = true without
  // consulting the DB"). That produced the worst possible failure mode in
  // disaster recovery: a /data volume rsync'd to a new server, or kept
  // across a Postgres wipe, carried the marker but no users, so every setup
  // endpoint returned 403, /status claimed an admin existed, and the login
  // page offered a form no account could satisfy. We now confirm the claim:
  //   - DB unreachable        → keep the lock (fail closed, as before)
  //   - users > 0             → initialized (the normal case)
  //   - users = 0, tenants > 0 → restored data awaiting an admin (adopt)
  //   - users = 0, tenants = 0 → stale marker; nothing to protect; re-open
  if (isInitialized()) {
    let counts: { tenants: number; users: number };
    try {
      counts = await countTenantsAndUsers();
    } catch {
      return lockedStatus({}, smtpConfigured);
    }
    if (counts.users > 0) {
      return lockedStatus({ tenantCount: counts.tenants }, smtpConfigured);
    }
    if (!staleMarkerLogged) {
      staleMarkerLogged = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[sentinel-audit] ${JSON.stringify({
          ts: new Date().toISOString(),
          kind: 'sentinel-audit',
          event: 'installation.stale_marker_detected',
          marker: initializedMarkerPath(),
          tenants: counts.tenants,
          users: counts.users,
          action: counts.tenants > 0 ? 'setup re-opened to create an admin for the restored data' : 'setup re-opened',
        })}`,
      );
    }
    return {
      envFileExists,
      databaseReachable: true,
      databaseInitialized: true,
      hasAdminUser: false,
      smtpConfigured,
      setupComplete: false,
      statusCheckFailed: false,
      needsAdminUser: counts.tenants > 0,
      tenantCount: counts.tenants,
      staleMarker: true,
    };
  }

  let databaseReachable = false;
  let databaseInitialized = false;
  let hasAdminUser = false;
  let statusCheckFailed = false;
  let needsAdminUser = false;
  let tenantCount = 0;

  try {
    const result = await db.execute(sql`SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'tenants') as exists`);
    databaseReachable = true;
    databaseInitialized = (result.rows as ExistsRow[])[0]?.exists === true;

    if (databaseInitialized) {
      try {
        const userCount = await db.execute(sql`SELECT COUNT(*) as cnt FROM users`);
        hasAdminUser = firstCount(userCount) > 0;
        const tenantRes = await db.execute(sql`SELECT COUNT(*) as cnt FROM tenants`);
        tenantCount = firstCount(tenantRes);
        needsAdminUser = !hasAdminUser && tenantCount > 0;

        // Self-healing: if the DB already has tenants + users but the
        // marker file is missing (e.g. operator lost /data/config/), write
        // the marker now so no future status check can ever flip back to
        // "not initialized". This closes the "lost volume → wipe" path.
        if (hasAdminUser && tenantCount > 0) {
          // SENTINEL GUARD (F2): do not self-heal if the sentinel exists
          // and its installation ID disagrees with the DB. That combination
          // means the DB was wiped and an attacker — or a mistake — has
          // inserted tenant+user rows without updating installation_id in
          // system_settings. Letting self-heal run would hide the reset
          // from the validator. Instead, bail out with statusCheckFailed
          // so the route guard stays locked and the validator produces
          // the appropriate diagnostic page on next boot.
          if (sentinelExists()) {
            const blocked: SetupStatus = {
              envFileExists,
              databaseReachable: true,
              databaseInitialized: true,
              hasAdminUser,
              smtpConfigured,
              setupComplete: true,
              statusCheckFailed: true,
              needsAdminUser: false,
              tenantCount,
              staleMarker: false,
            };
            try {
              const header = readSentinelHeader();
              const dbInstallationId = await adminService.getSetting(
                SystemSettingsKeys.INSTALLATION_ID,
              );
              if (header && dbInstallationId && header.installationId !== dbInstallationId) {
                return blocked;
              }
              if (header && !dbInstallationId) {
                // Sentinel exists but DB has no installation_id row — the
                // tenant rows came from somewhere other than a real setup.
                // Refuse to self-heal.
                return blocked;
              }
            } catch {
              // If we can't read the sentinel at all, be conservative and
              // block self-heal too.
              return blocked;
            }
          }
          try {
            markInitialized({ recoveredFromExistingData: true });
          } catch {
            // best-effort; next call will retry
          }
          return lockedStatus({ tenantCount }, smtpConfigured);
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
  //
  // `hasAdminUser` alone is sufficient: a real user can only exist because
  // /initialize already ran, so a populated database is "set up and running"
  // even if the .env / marker live on a volume this process can't see. This
  // stops an already-configured appliance from ever showing the first-run
  // wizard just because envFileExists probed false. (setupComplete = true is
  // the locked/safe direction — it only ever blocks provisioning, never opens
  // it.)
  //
  // Deliberately NOT part of this test: `envFileExists && databaseReachable
  // && databaseInitialized`. On the Docker appliance both are true before
  // setup has ever run — install.sh pre-generates JWT_SECRET into .env (so
  // envFileExists is true) and docker-entrypoint auto-runs migrations on
  // first boot (so the `tenants` table exists and databaseInitialized is
  // true). Including that clause therefore reported setupComplete = true on
  // a pristine install with zero users, which hid the first-run wizard and
  // made the guard below 403 every setup endpoint — an unrecoverable
  // deadlock: no account to log in with, and no way to create one.
  const setupComplete = statusCheckFailed || hasAdminUser;

  return {
    envFileExists,
    databaseReachable,
    databaseInitialized,
    hasAdminUser,
    smtpConfigured,
    setupComplete,
    statusCheckFailed,
    needsAdminUser: statusCheckFailed ? false : needsAdminUser,
    tenantCount,
    staleMarker: false,
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
  const locked = (lockRes.rows as LockedRow[])[0]?.locked === true;
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
 * Assemble a `postgresql://` URL from discrete connection fields. The
 * username and password are percent-encoded: `testDatabaseConnection` passes
 * them to pg as separate fields, so a password containing `@`, `/`, `:` or
 * `#` passes the connection test — and would then produce a URL that parses
 * to the wrong host (or fails env.ts validation) on the next boot unless it
 * is encoded here. `getDatabaseDefaults` decodes symmetrically.
 */
export function buildDatabaseUrl(config: DbConfig): string {
  const user = encodeURIComponent(config.username);
  const auth = config.password ? `${user}:${encodeURIComponent(config.password)}` : user;
  const host = config.host.includes(':') && !config.host.startsWith('[') ? `[${config.host}]` : config.host;
  return `postgresql://${auth}@${host}:${config.port}/${encodeURIComponent(config.database)}`;
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
 *   - The setup router blocks every non-status endpoint once setup is
 *     complete (see setupRouter.use in setup.routes.ts). After setup
 *     completes, this endpoint returns 403.
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
        host: parsed.hostname.replace(/^\[|\]$/g, '') || 'db',
        port: parsed.port ? Number(parsed.port) : 5432,
        database: decodeURIComponent((parsed.pathname || '').replace(/^\//, '')) || 'kisbooks',
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
  fromName?: string;
}

export async function testSmtpConnection(config: SmtpConfig, testEmail?: string): Promise<{ success: boolean; error?: string }> {
  try {
    // The host is tenant/operator supplied and this call opens a TCP
    // connection from inside the appliance. LAN relays are legitimate;
    // loopback (the api container itself), link-local and the cloud
    // metadata endpoint never are.
    const { assertHostSafe } = await import('../utils/url-safety.js');
    await assertHostSafe(config.host, 'SMTP host', { allowPrivate: true });
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: config.username ? { user: config.username, pass: config.password } : undefined,
    });

    await transport.verify();

    if (testEmail) {
      const brand = await (async () => {
        try { const { getBranding } = await import('./admin.service.js'); return (await getBranding()).appName; }
        catch { return 'Vibe MyBooks'; }
      })();
      await transport.sendMail({
        from: config.fromName ? { name: config.fromName, address: config.from } : config.from,
        to: testEmail,
        subject: `${brand} — SMTP Test`,
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
  /**
   * The database already holds restored tenant data but no user accounts
   * (`SetupStatus.needsAdminUser`). Instead of creating a new tenant, the
   * admin account is created inside the first restored tenant and granted
   * owner access to every restored tenant. No chart of accounts is seeded —
   * the restored one is the truth.
   */
  adoptExistingTenants?: boolean;
}

export async function checkPortAvailability(port: number): Promise<{ port: number; available: boolean }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve({ port, available: false }));
    server.once('listening', () => { server.close(); resolve({ port, available: true }); });
    server.listen(port, '0.0.0.0');
  });
}

export interface WriteEnvFileOptions {
  /**
   * Replace an existing /data/config/.env instead of refusing. The caller
   * must have verified that the database is EMPTY (no tenants, no users) —
   * i.e. the file belongs to a previous life of this volume and there is
   * no running installation whose keys it protects. The old file is kept
   * as a timestamped `.pre-setup-*` sibling either way.
   */
  replaceExisting?: boolean;
}

export function writeEnvFile(config: SetupConfig, options: WriteEnvFileOptions = {}): string {
  const dbUrl = buildDatabaseUrl(config.db);
  const redisUrl = config.redis.password
    ? `redis://:${encodeURIComponent(config.redis.password)}@${config.redis.host}:${config.redis.port}`
    : `redis://${config.redis.host}:${config.redis.port}`;

  const apiPort = config.ports?.api || 3001;
  const frontendPort = config.ports?.frontend || 5173;

  const envContent = `# Vibe MyBooks Configuration — Generated by Setup Wizard
# ${new Date().toISOString()}
#
# docker-entrypoint.sh loads this file at boot and uses it to FILL IN any
# variable that the compose environment leaves unset or empty. A value that
# compose already supplies (docker-compose.yml / the install .env) wins.

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
  const dir = configDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, '.env');

  // Guard: refuse to overwrite an existing env file unless the caller has
  // proven the database is empty (replaceExisting). Overwriting the file of
  // a LIVE installation would silently destroy BACKUP_ENCRYPTION_KEY and
  // render every previously-taken encrypted backup cryptographically
  // unrecoverable, with no warning to the operator.
  //
  // We always keep a timestamped copy first: even on the replace path the
  // prior values remain recoverable on disk.
  if (fs.existsSync(filePath)) {
    const backupPath = `${filePath}.pre-setup-${Date.now()}`;
    try { fs.copyFileSync(filePath, backupPath); } catch { /* best-effort */ }
    if (!options.replaceExisting) {
      throw new Error(
        `Refusing to overwrite existing configuration at ${filePath}. ` +
        `A backup copy was saved to ${backupPath}. ` +
        `If you intend to reinstall from scratch, stop the service and delete both ` +
        `${filePath} and ${initializedMarkerPath()} manually before re-running setup.`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn(`[setup] replacing stale ${filePath} (database is empty); previous copy kept at ${backupPath}`);
  }

  writeAtomicSync(filePath, envContent, 0o600);
  return filePath;
}

/** Remove a /data/config/.env this setup run created. Used to unwind a failed /initialize. */
export function removeEnvFile(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
}

export interface CreateAdminUserInput {
  email: string;
  password: string;
  displayName: string;
  companyName: string;
  industry?: string;
  entityType?: string;
  businessType?: string;
  /** See SetupConfig.adoptExistingTenants. */
  adoptExistingTenants?: boolean;
}

/**
 * Create the first-run admin account.
 *
 * Fresh install (default): creates tenant → company → user → access inside
 * ONE transaction, then runs the post-steps (chart-of-accounts seed, feature
 * flags, appliance firm). The chart-of-accounts template is resolved BEFORE
 * any row is written so an unknown template can never leave a half-built
 * tenant behind. If a post-step still fails, `rollbackPartialSetup` removes
 * every row this call created so the emptiness guards let the operator
 * simply retry — the previous behaviour left 1 tenant / 0 users in the DB
 * and every retry 409'd with "tenant(s) already exist".
 *
 * Adopt mode (`adoptExistingTenants`): the database already holds restored
 * tenant data but no users. The admin is created inside the oldest tenant
 * and granted owner access to every tenant. Nothing is seeded.
 */
export async function createAdminUser(input: CreateAdminUserInput) {
  // Defense-in-depth: refuse to initialize if the database already contains
  // users, or tenants we were not told to adopt. Even if the route guard and
  // the status check are bypassed somehow, this check prevents a setup run
  // from silently planting a super-admin user on top of a populated database.
  const counts = await countTenantsAndUsers();
  if (counts.users > 0) {
    throw new Error(
      `Cannot initialize: ${counts.users} user account(s) already exist in the database.`,
    );
  }
  if (counts.tenants > 0 && !input.adoptExistingTenants) {
    throw new Error(
      `Cannot initialize: ${counts.tenants} tenant(s) already exist in the database. ` +
      `This looks like restored data — re-run setup choosing to create an admin for the existing data.`,
    );
  }
  if (counts.tenants === 0 && input.adoptExistingTenants) {
    throw new Error('Cannot adopt existing data: the database has no tenants to adopt.');
  }

  const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS);

  if (input.adoptExistingTenants) {
    return adoptRestoredTenants(input, passwordHash);
  }

  const templateName = input.businessType || 'default';
  // Fail BEFORE writing anything if the chart-of-accounts template is unknown.
  await accountsService.assertTemplateExists(templateName);

  const slug = input.companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80) + '-' + crypto.randomBytes(4).toString('hex');

  const created = await db.transaction(async (tx) => {
    const [tenant] = await tx.insert(tenants).values({ name: input.companyName, slug }).returning();
    if (!tenant) throw new Error('Failed to create tenant');

    await tx.insert(companies).values({
      tenantId: tenant.id,
      businessName: input.companyName,
      entityType: input.entityType || 'sole_prop',
      industry: input.industry || null,
      setupComplete: true,
    });

    // First user is super admin.
    const [user] = await tx.insert(users).values({
      tenantId: tenant.id,
      email: input.email,
      passwordHash,
      displayName: input.displayName,
      role: 'owner',
      isSuperAdmin: true,
    }).returning();
    if (!user) throw new Error('Failed to create admin user');

    await tx.insert(userTenantAccess).values({
      userId: user.id,
      tenantId: tenant.id,
      role: 'owner',
    });

    return { tenantId: tenant.id, userId: user.id };
  });

  try {
    // Seed COA with business type template
    await accountsService.seedFromTemplate(created.tenantId, templateName);

    // First-run setup creates the bootstrap tenant; Practice flags
    // are on by default so the operator can see them immediately.
    await seedFeatureFlags(created.tenantId);

    // Create the appliance firm and make the first-run admin its
    // firm_admin, then assign this bootstrap tenant to it. This is the
    // natural place the singleton appliance firm comes into existence;
    // every later tenant joins the same firm.
    await joinApplianceFirm(created.tenantId, created.userId);
  } catch (err) {
    await rollbackPartialSetup(created.tenantId, created.userId);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[step:seed] Setup could not finish provisioning the first company (${message}). Nothing was kept — fix the cause and retry.`);
  }

  return created;
}

async function adoptRestoredTenants(input: CreateAdminUserInput, passwordHash: string) {
  const restored = await db.select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .orderBy(asc(tenants.createdAt), asc(tenants.id));
  const home = restored[0];
  if (!home) throw new Error('Cannot adopt existing data: the database has no tenants to adopt.');

  const created = await db.transaction(async (tx) => {
    const [user] = await tx.insert(users).values({
      tenantId: home.id,
      email: input.email,
      passwordHash,
      displayName: input.displayName,
      role: 'owner',
      isSuperAdmin: true,
    }).returning();
    if (!user) throw new Error('Failed to create admin user');

    await tx.insert(userTenantAccess).values(
      restored.map((t) => ({ userId: user.id, tenantId: t.id, role: 'owner' })),
    ).onConflictDoNothing();

    // A tenant-scoped bundle may not carry a companies row; make sure the
    // home tenant has one so the app shell can load.
    const companyRows = await tx.select({ id: companies.id }).from(companies)
      .where(sql`${companies.tenantId} = ${home.id}`).limit(1);
    if (companyRows.length === 0) {
      await tx.insert(companies).values({
        tenantId: home.id,
        businessName: input.companyName?.trim() || home.name,
        entityType: input.entityType || 'sole_prop',
        industry: input.industry || null,
        setupComplete: true,
      });
    }
    return { tenantId: home.id, userId: user.id };
  });

  try {
    for (const t of restored) {
      await seedFeatureFlags(t.id); // onConflictDoNothing — restored flags win
      await joinApplianceFirm(t.id, created.userId);
    }
  } catch (err) {
    // Only the user rows are ours; the restored tenant data must stay.
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`DELETE FROM firm_users WHERE user_id = ${created.userId}`);
        await tx.delete(userTenantAccess).where(sql`${userTenantAccess.userId} = ${created.userId}`);
        await tx.delete(users).where(sql`${users.id} = ${created.userId}`);
      });
    } catch (cleanupErr) {
      // eslint-disable-next-line no-console
      console.error('[setup] adopt rollback failed:', cleanupErr);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[step:admin] Could not link the admin account to the restored data (${message}). Nothing was kept — retry.`);
  }

  return created;
}

/**
 * Remove everything a failed fresh-install `createAdminUser` created, so
 * the database is EMPTY again and the emptiness guards allow a clean retry.
 * Precondition (checked by the caller): the DB held no tenants and no users
 * before this setup run, so every tenant-scoped row belongs to this run.
 */
export async function rollbackPartialSetup(tenantId: string, userId: string): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM firm_users WHERE user_id = ${userId}`);
      await tx.execute(sql`DELETE FROM firms WHERE created_by_user_id = ${userId}`);
      await tx.delete(userTenantAccess).where(sql`${userTenantAccess.tenantId} = ${tenantId}`);
      await tx.delete(users).where(sql`${users.id} = ${userId}`);
      const tablesResult = await tx.execute(sql`
        SELECT c.table_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.column_name = 'tenant_id'
          AND c.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
          AND c.table_name NOT IN ('tenants', 'users', 'user_tenant_access')
        ORDER BY c.table_name
      `);
      for (const row of tablesResult.rows as { table_name: string }[]) {
        if (!IDENT_RE.test(row.table_name)) continue;
        await tx.execute(sql`DELETE FROM ${sql.identifier(row.table_name)} WHERE tenant_id = ${tenantId}`);
      }
      await tx.delete(tenants).where(sql`${tenants.id} = ${tenantId}`);
    });
    // eslint-disable-next-line no-console
    console.warn(`[setup] rolled back partially-created tenant ${tenantId} after a provisioning failure`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[setup] rollback of partial setup FAILED — manual cleanup may be required:', err);
  }
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
  /** Credential-encryption key to protect in /data/.env.recovery. Defaults to process.env. */
  plaidEncryptionKey?: string;
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
  const plaidEncryptionKey = input.plaidEncryptionKey || process.env['PLAID_ENCRYPTION_KEY'];
  try {
    writeRecoveryFile(
      recoveryKey,
      {
        encryptionKey: input.encryptionKey,
        jwtSecret: input.jwtSecret,
        databaseUrl: input.databaseUrl,
        ...(plaidEncryptionKey ? { plaidEncryptionKey } : {}),
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
