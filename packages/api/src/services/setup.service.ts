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
import * as accountsService from './accounts.service.js';

const CONFIG_DIR = process.env['CONFIG_DIR'] || '/data/config';
const INITIALIZED_MARKER = path.join(CONFIG_DIR, '.initialized');
const SETUP_TOKEN_FILE = path.join(CONFIG_DIR, '.setup-token');

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
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const payload = { initializedAt: new Date().toISOString(), ...extra };
  fs.writeFileSync(INITIALIZED_MARKER, JSON.stringify(payload, null, 2), { mode: 0o600 });
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
 * First-run setup token. Generated on startup when the system is not yet
 * initialized, printed to the server console, and required as an
 * `X-Setup-Token` header on `/initialize` and `/restore/execute`. This
 * binds the ability to complete setup to console access — an anonymous
 * caller on the network cannot reach those endpoints even if the guard
 * misfires.
 *
 * The token is consumed (deleted) on successful initialization.
 */
export function ensureSetupToken(): string | null {
  if (isInitialized()) {
    // Stale token from an aborted run? Clean it up.
    if (fs.existsSync(SETUP_TOKEN_FILE)) {
      try { fs.unlinkSync(SETUP_TOKEN_FILE); } catch { /* best-effort */ }
    }
    return null;
  }

  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

  if (fs.existsSync(SETUP_TOKEN_FILE)) {
    try {
      const existing = fs.readFileSync(SETUP_TOKEN_FILE, 'utf-8').trim();
      if (existing.length >= 48) return existing;
    } catch {
      // fall through and regenerate
    }
  }

  const token = crypto.randomBytes(24).toString('hex'); // 48 hex chars
  fs.writeFileSync(SETUP_TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

export function validateSetupToken(provided: string | undefined | null): boolean {
  if (!provided || typeof provided !== 'string') return false;
  if (!fs.existsSync(SETUP_TOKEN_FILE)) return false;
  let stored: string;
  try {
    stored = fs.readFileSync(SETUP_TOKEN_FILE, 'utf-8').trim();
  } catch {
    return false;
  }
  if (stored.length < 48) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function consumeSetupToken(): void {
  if (fs.existsSync(SETUP_TOKEN_FILE)) {
    try { fs.unlinkSync(SETUP_TOKEN_FILE); } catch { /* best-effort */ }
  }
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
  return {
    dbPassword: generateSecurePassword(20),
    jwtSecret: generateJwtSecret(),
    backupKey: crypto.randomBytes(32).toString('hex'),
  };
}

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
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
  const passwordHash = await bcrypt.hash(input.password, 12);
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
