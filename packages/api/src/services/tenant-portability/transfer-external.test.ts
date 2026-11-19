// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// The engine side of ClientLedger's CI transfer round trip (U-284, P32
// Q-74, Q-P32d; `cargo xtask transfer-roundtrip`). Skipped unless the
// desktop harness hands over a real transfer file:
//   CL_TRANSFER_FILE        absolute path of the .clxfer
//   CL_TRANSFER_PASSPHRASE  its (synthetic) passphrase
//   CL_TRANSFER_EXPECTED    expected.json: {definition, asOf, companies:
//                           [{totalAssets, totalLiabilities, totalEquity,
//                           netIncome, accountsReceivable, accountsPayable,
//                           trialBalanceDebits, trialBalanceCredits}], counts}
//   CL_TRANSFER_CANARIES    optional, comma-separated extra canaries
// In server mode, through the HTTP routes, as firm staff who are not super
// admins: import with transferOnly, compare expected = actual = the file,
// scan every table of the database and the upload folder for the planted
// canaries, then export the new company as an ordinary archive and import
// that as another firm user (names-only people stay allowed, B1/T1).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import * as authService from '../auth.service.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { tenantArchivesRouter } from '../../routes/tenant-archives.routes.js';
import { tenantsRouter } from '../../routes/tenants.routes.js';
import { archiveDir } from './export.service.js';
import { getSetting, setSetting } from '../admin.service.js';
import { SystemSettingsKeys } from '../../constants/system-settings-keys.js';
import { VT_COUNT_FIELDS, type VerificationTotals } from './verification-totals.js';

const FILE = process.env['CL_TRANSFER_FILE'];
const PASSPHRASE = process.env['CL_TRANSFER_PASSPHRASE'] ?? '';
const EXPECTED = process.env['CL_TRANSFER_EXPECTED'];
/** Planted by the desktop harness (crates/cl-company/tests/transfer_live.rs): the owner's sign-in and the backup passphrase. */
const BUILT_IN_CANARIES = ['transfer-owner@example.test', 'backup-canary-passphrase-2026'];

interface Expected {
  definition: string;
  asOf: string;
  companies: Array<Record<'totalAssets' | 'totalLiabilities' | 'totalEquity' | 'netIncome' | 'accountsReceivable' | 'accountsPayable' | 'trialBalanceDebits' | 'trialBalanceCredits', string>>;
  counts: Record<string, number>;
}

interface Comparison { definition: string; expected: VerificationTotals | null; actual: VerificationTotals; matches: boolean | null; differences: unknown[] }

let server: Server | undefined;
let port = 0;
let work = '';
const tenants: string[] = [];
const userIds: string[] = [];
const savedSettings: Array<[string, string | null]> = [];

async function firmStaff(label: string): Promise<{ token: string; userId: string }> {
  const reg = await authService.register({
    email: `transfer-external-${label}-${Date.now()}@cpa.example.test`, password: 'firm staff password 2026', displayName: `Firm ${label}`, companyName: `Firm ${label}`,
  });
  tenants.push(reg.user.tenantId);
  userIds.push(reg.user.id);
  return { token: reg.tokens.accessToken, userId: reg.user.id };
}

async function call(method: string, p: string, token: string, body?: unknown, form?: FormData): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let payload: FormData | string | undefined;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: payload });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

async function job(jobId: string, token: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 6000; i++) {
    const r = await call('GET', `/api/v1/tenant-archives/jobs/${jobId}`, token);
    expect(r.status).toBe(200);
    if (r.json['status'] === 'succeeded' || r.json['status'] === 'failed') return r.json;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('job timeout');
}

async function importFile(file: string, token: string, transferOnly: boolean): Promise<{ tenantId: string; verificationTotals: Comparison; transfer: boolean; warnings: string[] }> {
  const form = new FormData();
  form.append('passphrase', PASSPHRASE);
  form.append('transferOnly', String(transferOnly));
  form.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
  const started = await call('POST', '/api/v1/tenant-archives/import', token, undefined, form);
  expect(started.status, JSON.stringify(started.json)).toBe(202);
  const done = await job(started.json['jobId'] as string, token);
  expect(done['status'], JSON.stringify(done['error'] ?? null)).toBe('succeeded');
  const result = done['result'] as { tenantId: string; verificationTotals: Comparison; transfer: boolean; warnings: string[] };
  tenants.push(result.tenantId);
  return result;
}

/** Every row of every table of the database, as text, that contains `needle` (case-insensitive). */
async function tablesContaining(needle: string): Promise<string[]> {
  const t = await db.execute(sql`SELECT quote_ident(table_name) AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
  const hits: string[] = [];
  for (const { t: name } of t.rows as Array<{ t: string }>) {
    const r = await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${name} x WHERE strpos(lower(row_to_json(x)::text), lower('${needle.replace(/'/g, "''")}')) > 0`));
    if ((r.rows[0] as { n: number }).n > 0) hits.push(name);
  }
  return hits;
}

function filesContaining(dir: string, needles: string[]): string[] {
  const hits: string[] = [];
  if (!fs.existsSync(dir)) return hits;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const full = path.join(e.parentPath, e.name);
    const text = fs.readFileSync(full).toString('latin1').toLowerCase();
    for (const n of needles) if (text.includes(n.toLowerCase())) hits.push(`${path.relative(dir, full)}: ${n}`);
  }
  return hits;
}

describe.skipIf(!FILE)('a ClientLedger transfer file in MyBooks Online (CI round trip, U-284)', () => {
  beforeAll(async () => {
    // Firm staff import as a new company: the appliance must allow self-service company creation (as an Online operator sets it).
    for (const [k, v] of [[SystemSettingsKeys.SELF_SERVICE_TENANT_CREATION, 'true'], [SystemSettingsKeys.SELF_SERVICE_TENANT_LIMIT, '50']] as const) {
      savedSettings.push([k, await getSetting(k)]);
      await setSetting(k, v);
    }
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-transfer-external-'));
    process.env['CL_ARCHIVE_DIR'] = path.join(work, 'archives');
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/v1/tenant-archives', tenantArchivesRouter);
    app.use('/api/v1/tenants', tenantsRouter);
    app.use(errorHandler);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
  });

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    fs.rmSync(work, { recursive: true, force: true });
    delete process.env['CL_ARCHIVE_DIR'];
    void userIds;
    for (const [k, v] of savedSettings) await setSetting(k, v ?? '');
  });

  it('imports with transferOnly as firm staff, totals equal expected.json, no canary anywhere, and re-exports for another firm user', async () => {
    const file = path.resolve(FILE!);
    expect(PASSPHRASE.length).toBeGreaterThanOrEqual(12);
    const expected = JSON.parse(fs.readFileSync(path.resolve(EXPECTED!), 'utf8')) as Expected;

    const a = await firmStaff('a');
    const r = await importFile(file, a.token, true);
    expect(r.transfer).toBe(true);
    const v = r.verificationTotals;
    expect(v.matches, JSON.stringify(v.differences)).toBe(true);
    // expected (the file) = actual (this import) = expected.json (the desktop's own figures).
    for (const t of [v.expected!, v.actual]) {
      expect(t.definition).toBe(expected.definition);
      expect(t.asOf).toBe(expected.asOf);
      for (const f of VT_COUNT_FIELDS) expect(t.counts[f], `counts.${f}`).toBe(expected.counts[f]);
      expect(t.companies).toHaveLength(expected.companies.length);
      t.companies.forEach((c, i) => {
        const e = expected.companies[i]!;
        expect({
          totalAssets: c.totalAssets, totalLiabilities: c.totalLiabilities, totalEquity: c.totalEquity, netIncome: c.netIncome.amount,
          accountsReceivable: c.accountsReceivable, accountsPayable: c.accountsPayable,
          trialBalanceDebits: c.trialBalance.debits, trialBalanceCredits: c.trialBalance.credits,
        }).toEqual(e);
      });
    }
    // Names only: no user was created, only the importer has access, the people are names.
    const access = await db.execute(sql`SELECT user_id::text AS u FROM user_tenant_access WHERE tenant_id = ${r.tenantId}`);
    expect((access.rows as Array<{ u: string }>).map((x) => x.u)).toEqual([a.userId]);
    const names = await db.execute(sql`SELECT count(*)::int AS n FROM transfer_user_names WHERE tenant_id = ${r.tenantId}`);
    expect((names.rows[0] as { n: number }).n).toBeGreaterThan(0);

    // The canaries: nowhere in the database, nowhere in the uploads.
    const canaries = [...BUILT_IN_CANARIES, PASSPHRASE, ...(process.env['CL_TRANSFER_CANARIES'] ?? '').split(',').map((x) => x.trim()).filter(Boolean)];
    for (const c of canaries) expect(await tablesContaining(c), `canary ${c === PASSPHRASE ? '(passphrase)' : c}`).toEqual([]);
    expect(filesContaining(process.env['UPLOAD_DIR'] || '/data/uploads', canaries)).toEqual([]);
    const hashes = await db.execute(sql`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = ${r.tenantId}
      AND (before_data::text ~ '\\$2[aby]\\$' OR after_data::text ~ '\\$2[aby]\\$' OR before_data::text LIKE '%password_hash%' OR after_data::text LIKE '%password_hash%')`);
    expect((hashes.rows[0] as { n: number }).n).toBe(0);

    // An ordinary export of the new company, imported by another firm user (not a super admin): it restores, totals equal.
    const started = await call('POST', `/api/v1/tenants/${r.tenantId}/archives`, a.token, { passphrase: PASSPHRASE, asOf: expected.asOf });
    expect(started.status, JSON.stringify(started.json)).toBe(202);
    const exp = await job(started.json['jobId'] as string, a.token);
    expect(exp['status'], JSON.stringify(exp['error'] ?? null)).toBe('succeeded');
    const again = path.join(archiveDir(), r.tenantId, `${started.json['archiveId'] as string}.zip`);
    const b = await firmStaff('b');
    const r2 = await importFile(again, b.token, false);
    expect(r2.transfer).toBe(false);
    expect(r2.verificationTotals.matches, JSON.stringify(r2.verificationTotals.differences)).toBe(true);
    expect(r2.warnings.filter((w) => w.startsWith('USERS_NOT_CREATED'))).toEqual([]);
    const names2 = await db.execute(sql`SELECT count(*)::int AS n FROM transfer_user_names WHERE tenant_id = ${r2.tenantId}`);
    expect((names2.rows[0] as { n: number }).n).toBe((names.rows[0] as { n: number }).n);
    // A backup is never accepted where a transfer file is expected (T8).
    const form = new FormData();
    form.append('passphrase', PASSPHRASE);
    form.append('transferOnly', 'true');
    form.append('file', new Blob([fs.readFileSync(again)]), 'backup.zip');
    const refused = await call('POST', '/api/v1/tenant-archives/import', b.token, undefined, form);
    expect(refused.status).toBe(202);
    const failed = await job(refused.json['jobId'] as string, b.token);
    expect((failed['error'] as { code: string }).code).toBe('NOT_A_TRANSFER_FILE');
  }, 900_000);
});
