// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Non-superuser owner role, with the durable queue: boots the real desktop
// engine (src/bootstrap.ts through tsx, CL_MODE=desktop, default
// QUEUE_BACKEND = pgboss, no Redis) against a fresh database owned by a
// NOSUPERUSER NOCREATEDB NOCREATEROLE role, with CL_REQUIRE_NON_SUPERUSER=1.
// Proves that, as that role:
//   - every migration applies and the engine serves /health 200 with
//     queueBackend "pgboss" and queue "ok";
//   - pg-boss creates its own schema (owned by the role, no extension);
//   - a job round trip works through the engine's in-process worker (a
//     report-pack job enqueued from outside is picked up and settled), and a
//     producer/consumer pair on the same schema works for the role too.
// Needs the test PostgreSQL with a role that may CREATE ROLE / DATABASE;
// skipped with a message otherwise. No Redis anywhere.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';
import { PgBossQueue, pgBossJobId } from '../queue/pgboss.adapter.js';
import { JOB_SPECS } from '../queue/specs.js';
import type { JobSpecTable } from '../queue/job-queue.js';

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKEN = crypto.randomBytes(32).toString('base64url');
const BOOT_TIMEOUT_MS = 240_000;
const PASS_THROUGH = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];

const baseUrl = process.env['DATABASE_URL'] || 'postgresql://kisbooks:kisbooks@localhost:5434/kisbooks_test';
function urlFor(db: string, user?: { name: string; password: string }): string {
  const u = new URL(baseUrl);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const role = { name: `cl_pgb_${process.pid}`, password: crypto.randomBytes(12).toString('hex') };
const DB = `cl_pgb_db_${process.pid}_${Date.now()}`;
let ready = false;

let proc: ChildProcess | undefined;
let dataDir = '';
const stdout: string[] = [];
const stderr: string[] = [];
let port = 0;

beforeAll(async () => {
  try {
    await withClient(urlFor('postgres'), async (c) => {
      await c.query(`CREATE ROLE ${role.name} LOGIN PASSWORD '${role.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      await c.query(`CREATE DATABASE ${DB} OWNER ${role.name}`);
    });
    ready = true;
  } catch (err) {
    console.warn(`[pgboss-owner-role] skipping: cannot create a role and database: ${(err as Error).message}`);
    return;
  }

  dataDir = mkdtempSync(path.join(os.tmpdir(), 'cl-pgboss-owner-'));
  const env: Record<string, string> = {};
  for (const k of PASS_THROUGH) if (process.env[k]) env[k] = process.env[k]!;
  Object.assign(env, {
    NODE_ENV: 'production',
    CL_MODE: 'desktop',
    CL_TOKEN: TOKEN,
    CL_BIND: '127.0.0.1:0',
    CL_DATA_DIR: dataDir,
    CL_REQUIRE_NON_SUPERUSER: '1',
    DATABASE_URL: urlFor(DB, role),
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    PLAID_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    BCRYPT_ROUNDS: '4',
  });
  proc = spawn(process.execPath, ['--import', 'tsx', 'src/bootstrap.ts'], { cwd: API_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const r = await new Promise<{ port: number } | { exitCode: number | null }>((resolve) => {
    let buf = '';
    proc!.stdout!.setEncoding('utf8');
    proc!.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        stdout.push(line);
        if (line.startsWith('{"event":"listening"')) resolve({ port: (JSON.parse(line) as { port: number }).port });
      }
    });
    proc!.stderr!.setEncoding('utf8');
    proc!.stderr!.on('data', (chunk: string) => stderr.push(...chunk.split('\n').filter((l) => l.trim() !== '')));
    proc!.on('exit', (code) => resolve({ exitCode: code }));
  });
  if (!('port' in r)) throw new Error(`engine did not start (exit ${r.exitCode}): ${stderr.slice(-30).join(' | ')}`);
  port = r.port;
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  if (proc && proc.exitCode === null) {
    const exited = new Promise((r) => proc!.once('exit', r));
    proc.kill();
    await exited;
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  if (!ready) return;
  await withClient(urlFor('postgres'), async (c) => {
    await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [DB]);
    await c.query(`DROP DATABASE IF EXISTS ${DB}`);
    await c.query(`DROP ROLE IF EXISTS ${role.name}`);
  }).catch(() => undefined);
}, 60_000);

async function get(p: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { 'x-cl-token': TOKEN } });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs: number, what: string): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('desktop engine as a NOSUPERUSER database owner, pg-boss backend', () => {
  it('serves /health 200 with the pg-boss queue ok and no superuser', async () => {
    if (!ready) return;
    const h = await waitFor(async () => {
      const r = await get('/health');
      return r.json['queue'] === 'ok' ? r : undefined;
    }, 30_000, 'queue ok on /health');
    expect(h.status).toBe(200);
    expect(h.json).toMatchObject({ status: 'ok', mode: 'desktop', queueBackend: 'pgboss', redis: 'disabled', queue: 'ok' });
    expect((h.json['checks'] as { db: { superuser: boolean } }).db.superuser).toBe(false);
    const info = await get('/api/v1/desktop/info');
    expect(info.json).toMatchObject({ queueBackend: 'pgboss', dbSuperuser: false });
    expect(stderr.join(' ')).not.toContain(role.password);
  });

  it('pg-boss created its schema owned by the role, and no extension was needed', async () => {
    if (!ready) return;
    await withClient(urlFor(DB), async (c) => {
      const owner = await c.query(
        `SELECT r.rolname, r.rolsuper FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = 'pgboss'`,
      );
      expect(owner.rows).toEqual([{ rolname: role.name, rolsuper: false }]);
      const ext = await c.query(`SELECT extname FROM pg_extension WHERE extname <> 'plpgsql'`);
      expect(ext.rows).toEqual([]);
    });
  });

  it('the in-process worker consumes a job enqueued as the role (round trip)', async () => {
    if (!ready) return;
    expect(stdout.some((l) => l.includes('[in-process-worker] started on pgboss'))).toBe(true);
    // A report-pack run that does not exist: the engine's handler settles it
    // (completed or failed). Either way the job left the queue through the
    // engine process, which is the round trip under test.
    const producer = new PgBossQueue(JOB_SPECS, { connectionString: urlFor(DB, role) });
    const runId = crypto.randomUUID();
    const jobId = `pack-${runId}`;
    try {
      await producer.enqueue('report-pack', { runId, tenantId: crypto.randomUUID() }, { jobId });
    } finally {
      await producer.close();
    }
    const id = pgBossJobId('report-pack', jobId);
    const state = await waitFor(
      () => withClient(urlFor(DB), async (c) => {
        const r = await c.query<{ state: string }>(`SELECT state FROM pgboss.job WHERE name = 'report-pack' AND id = $1`, [id]);
        const s = r.rows[0]?.state;
        return s === 'completed' || s === 'failed' ? s : undefined;
      }),
      30_000,
      'the engine to settle the report-pack job',
    );
    expect(['completed', 'failed']).toContain(state);
    // The engine's own report-pack handler ran it (the run row does not exist).
    await waitFor(async () => (stderr.some((l) => l.includes(`[report-pack] run ${runId} not found`)) ? true : undefined), 10_000, 'the handler log line');
  });

  it('a producer/consumer pair works for the role on the same schema', async () => {
    if (!ready) return;
    const specs: JobSpecTable<{ ping: { n: number } }> = {
      ping: { attempts: 1, keepCompleted: 1, keepFailed: 1, activeTimeoutSeconds: 60, concurrency: () => 1, bullmqJobName: 'ping', logLabel: 'ping', logCompleted: false },
    };
    const q = new PgBossQueue(specs, { connectionString: urlFor(DB, role), pollingIntervalSeconds: 0.5 });
    try {
      let got: { n: number } | undefined;
      await q.work('ping', async (d) => {
        got = d;
      });
      await q.enqueue('ping', { n: 7 }, { jobId: `ping-${crypto.randomUUID()}` });
      await waitFor(async () => got, 15_000, 'ping');
      expect(got).toEqual({ n: 7 });
    } finally {
      await q.close();
    }
  });
});
