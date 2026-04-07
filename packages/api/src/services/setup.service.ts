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

export interface SetupStatus {
  envFileExists: boolean;
  databaseReachable: boolean;
  databaseInitialized: boolean;
  hasAdminUser: boolean;
  smtpConfigured: boolean;
  setupComplete: boolean;
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const envFileExists = fs.existsSync(path.join(CONFIG_DIR, '.env')) || !!process.env['JWT_SECRET'];

  let databaseReachable = false;
  let databaseInitialized = false;
  let hasAdminUser = false;

  try {
    const result = await db.execute(sql`SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'tenants') as exists`);
    databaseReachable = true;
    databaseInitialized = (result.rows as any[])[0]?.exists === true;

    if (databaseInitialized) {
      const userCount = await db.execute(sql`SELECT COUNT(*) as cnt FROM users`);
      hasAdminUser = parseInt((userCount.rows as any[])[0]?.cnt || '0') > 0;
    }
  } catch {
    // DB not reachable
  }

  const smtpConfigured = !!(process.env['SMTP_HOST'] && process.env['SMTP_HOST'].length > 0);

  return {
    envFileExists,
    databaseReachable,
    databaseInitialized,
    hasAdminUser,
    smtpConfigured,
    setupComplete: envFileExists && databaseReachable && databaseInitialized && hasAdminUser,
  };
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
  fs.writeFileSync(filePath, envContent);

  return filePath;
}

export async function createAdminUser(input: { email: string; password: string; displayName: string; companyName: string; industry?: string; entityType?: string; businessType?: string }) {
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
