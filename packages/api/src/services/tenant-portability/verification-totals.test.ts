// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Verification totals (U-283, vt1): the export's figures in the manifest
// and result, the preview, and the import's expected-vs-actual judgement
// (Q-P32o): strict on the same definition, backfill-attributed money
// differences only as a warning, the inventory re-walk a no-op (T2), audit
// entries counted before the import's own rows (T3).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import archiver from 'archiver';
import * as unzipper from 'unzipper';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { ArchiveReader } from './archive-reader.js';
import { encryptEntryBuffer, NoncePrefixRegistry, openEnvelope, validateEnvelope } from './archive-crypto.js';
import { ArchiveError } from './errors.js';
import { runExport, type ExportResult } from './export.service.js';
import { runImport } from './import.service.js';
import { ENVELOPE_ENTRY, MANIFEST_ENTRY, type ArchiveManifest } from './format.js';
import { buildPortabilityPlan, scopeSql, type PortabilityPlan } from './plan.js';
import { IdMap } from './remap.js';
import { applyArchiveSession, withArchiveConnection } from './session.js';
import {
  computeVerificationTotals, fiscalYearStartFor, resolveAsOf, validateManifestTotals, VERIFICATION_TOTALS_DEFINITION,
} from './verification-totals.js';
import { fileURLToPath } from 'node:url';

const V1_FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'archive-v1.zip');
const V1_FIXTURE_PASSPHRASE = 'v1 fixture passphrase 2026!';

const PASS = 'verification totals passphrase 2026!';
const AS_OF = '2026-06-30';
const stamp = crypto.randomUUID().slice(0, 8);
let plan: PortabilityPlan;
let work = '';
let tenantId = '';
let companyId = '';
let callerId = '';
let exported: ExportResult;
const tenants: string[] = [];
const users: string[] = [];

async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.execute(sql.raw(text.replace(/\$(\d+)/g, (_m, n) => {
    const v = params[Number(n) - 1];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  })));
  return r.rows as T[];
}

async function rewriteArchive(src: string, dst: string, pass: string, mutate: (m: ArchiveManifest) => void): Promise<void> {
  const d = await unzipper.Open.file(src);
  const envelope = validateEnvelope(JSON.parse((await d.files.find((f) => f.path === ENVELOPE_ENTRY)!.buffer()).toString('utf8')));
  const key = openEnvelope(envelope, pass);
  const manifest = JSON.parse(JSON.stringify((await ArchiveReader.open(src, pass)).manifest)) as ArchiveManifest;
  mutate(manifest);
  const out = archiver('zip', { store: true });
  const stream = fs.createWriteStream(dst);
  const done = new Promise<void>((resolve, reject) => {
    stream.on('close', resolve);
    out.on('error', reject);
  });
  out.pipe(stream);
  for (const f of d.files) {
    if (f.path === MANIFEST_ENTRY) continue;
    out.append(await f.buffer(), { name: f.path });
  }
  out.append(encryptEntryBuffer(key, envelope.archiveId, MANIFEST_ENTRY.slice(0, -'.enc'.length), Buffer.from(JSON.stringify(manifest), 'utf8'), new NoncePrefixRegistry()), { name: MANIFEST_ENTRY });
  await out.finalize();
  await done;
}

async function expectCode(p: Promise<unknown>, code: string): Promise<ArchiveError> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, `expected ${code}`).toBeInstanceOf(ArchiveError);
  expect((err as ArchiveError).code).toBe(code);
  return err as ArchiveError;
}

async function tenantCount(): Promise<number> {
  return Number((await q<{ n: number }>(`SELECT count(*)::int AS n FROM tenants`))[0]!.n);
}

/** A company with known vt1 figures as of AS_OF (fiscal year from January). */
async function seed(): Promise<void> {
  tenantId = crypto.randomUUID();
  await q(`INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)`, [tenantId, `VT ${stamp}`, `vt-${stamp}`]);
  tenants.push(tenantId);
  callerId = crypto.randomUUID();
  await q(`INSERT INTO users (id, tenant_id, email, password_hash, display_name, role, is_super_admin, is_active)
           VALUES ($1, $2, $3, 'x', 'Caller', 'owner', true, true)`, [callerId, tenantId, `vt-caller-${stamp}@example.test`]);
  users.push(callerId);
  await q(`INSERT INTO user_tenant_access (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`, [callerId, tenantId]);
  companyId = (await q<{ id: string }>(`INSERT INTO companies (tenant_id, business_name, entity_type, setup_complete, fiscal_year_start_month)
    VALUES ($1, 'VT Co', 'llc', true, 1) RETURNING id`, [tenantId]))[0]!.id;
  const acct = async (name: string, type: string, tag: string | null = null, sensitive = false) =>
    (await q<{ id: string }>(`INSERT INTO accounts (tenant_id, company_id, name, account_type, system_tag, is_sensitive) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, companyId, name, type, tag, sensitive]))[0]!.id;
  const cash = await acct('Checking', 'asset');
  const ar = await acct('Accounts Receivable', 'asset', 'accounts_receivable');
  const savings = await acct('Owner savings', 'asset', null, true);
  const ap = await acct('Accounts Payable', 'liability', 'accounts_payable');
  const capital = await acct('Capital', 'equity');
  const revenue = await acct('Consulting', 'revenue');
  const rent = await acct('Rent', 'expense');
  const cust = (await q<{ id: string }>(`INSERT INTO contacts (tenant_id, company_id, contact_type, display_name) VALUES ($1, $2, 'customer', 'C') RETURNING id`, [tenantId, companyId]))[0]!.id;
  await q(`INSERT INTO contacts (tenant_id, company_id, contact_type, display_name) VALUES ($1, $2, 'vendor', 'V'), ($1, $2, 'both', 'B')`, [tenantId, companyId]);
  const txn = async (type: string, date: string, lines: Array<[string, string, string]>, status = 'posted', basis = 'both') => {
    const id = (await q<{ id: string }>(`INSERT INTO transactions (tenant_id, company_id, txn_type, txn_date, status, basis, contact_id, total)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 0) RETURNING id`, [tenantId, companyId, type, date, status, basis, type === 'invoice' ? cust : null]))[0]!.id;
    for (const [a, d, c] of lines) await q(`INSERT INTO journal_lines (tenant_id, transaction_id, company_id, account_id, debit, credit) VALUES ($1, $2, $3, $4, $5, $6)`, [tenantId, id, companyId, a, d, c]);
  };
  await txn('journal_entry', '2025-12-01', [[cash, '5000.0000', '0'], [capital, '0', '5000.0000']]);
  await txn('journal_entry', '2025-06-01', [[cash, '100.0000', '0'], [revenue, '0', '100.0000']]);
  await txn('invoice', '2026-01-15', [[ar, '1234.5678', '0'], [revenue, '0', '1234.5678']]);
  await txn('bill', '2026-01-20', [[rent, '800.1250', '0'], [ap, '0', '800.1250']]);
  await txn('customer_payment', '2026-02-01', [[cash, '1000.0000', '0'], [ar, '0', '1000.0000']]);
  await txn('journal_entry', '2026-03-01', [[savings, '250.0001', '0'], [capital, '0', '250.0001']]);
  // Left out of the money: cash basis only, a draft, a void, and an entry after asOf.
  await txn('journal_entry', '2026-03-05', [[rent, '50.0000', '0'], [cash, '0', '50.0000']], 'posted', 'cash');
  await txn('journal_entry', '2026-03-06', [[cash, '7.0000', '0'], [revenue, '0', '7.0000']], 'draft');
  await txn('journal_entry', '2026-03-07', [[cash, '3.0000', '0'], [revenue, '0', '3.0000']], 'void');
  await txn('journal_entry', '2026-12-01', [[cash, '9.0000', '0'], [revenue, '0', '9.0000']]);
  const attDir = path.join(process.env['UPLOAD_DIR']!, tenantId, 'attachments');
  fs.mkdirSync(attDir, { recursive: true });
  for (const size of [10, 20]) {
    const id = crypto.randomUUID();
    fs.writeFileSync(path.join(attDir, `${id}.bin`), crypto.randomBytes(size));
    const k = `${tenantId}/attachments/${id}.bin`;
    await q(`INSERT INTO attachments (id, tenant_id, company_id, file_name, file_path, storage_key, file_size, attachable_type, attachable_id)
             VALUES ($1, $2, $3, 'f.bin', $4, $5, $6, 'contact', $7)`, [id, tenantId, companyId, `/uploads/${k}`, k, size, cust]);
  }
  for (let i = 0; i < 3; i++) {
    await q(`INSERT INTO audit_log (tenant_id, company_id, user_id, action, entity_type, entity_id, after_data) VALUES ($1, $2, $3, 'update', 'account', $4, '{}'::jsonb)`, [tenantId, companyId, callerId, cash]);
  }
}

beforeAll(async () => {
  plan = await buildPortabilityPlan(db);
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-vt-'));
  process.env['CL_ARCHIVE_DIR'] = path.join(work, 'archives');
  await seed();
  exported = await runExport(tenantId, callerId, { passphrase: PASS, asOf: AS_OF });
}, 180_000);

afterAll(async () => {
  for (const id of tenants) {
    for (const t of [...plan.scoped].reverse()) {
      await q(`DELETE FROM "${t}" a WHERE ${scopeSql(plan, t, 'a').replace('$1', `'${id}'::uuid`)}`).catch(() => undefined);
    }
    await q(`DELETE FROM tenant_archive_imports WHERE tenant_id = $1`, [id]).catch(() => undefined);
    await q(`DELETE FROM user_tenant_access WHERE tenant_id = $1`, [id]).catch(() => undefined);
    await q(`DELETE FROM users WHERE tenant_id = $1 AND id <> ALL($2::uuid[])`, [id, `{${users.join(',')}}`]).catch(() => undefined);
  }
  for (const u of users) await q(`DELETE FROM users WHERE id = $1`, [u]).catch(() => undefined);
  for (const id of tenants) await q(`DELETE FROM tenants WHERE id = $1`, [id]).catch(() => undefined);
  fs.rmSync(work, { recursive: true, force: true });
  delete process.env['CL_ARCHIVE_DIR'];
});

describe('vt1 helpers', () => {
  it('resolves asOf: today by default, a valid date up to tomorrow, never later', () => {
    const now = new Date('2026-05-10T23:30:00Z');
    expect(resolveAsOf(undefined, now)).toBe('2026-05-10');
    expect(resolveAsOf('2026-05-11', now)).toBe('2026-05-11');
    expect(resolveAsOf('2020-02-29', now)).toBe('2020-02-29');
    for (const bad of ['2026-05-12', '2026-02-30', '10/05/2026', '2026-5-1']) {
      let err: unknown;
      try {
        resolveAsOf(bad, now);
      } catch (e) {
        err = e;
      }
      expect((err as { code?: string }).code, bad).toBe('VALIDATION_ERROR');
    }
  });

  it('derives the fiscal year start that contains asOf', () => {
    expect(fiscalYearStartFor('2026-06-30', 1)).toBe('2026-01-01');
    expect(fiscalYearStartFor('2026-06-30', 7)).toBe('2025-07-01');
    expect(fiscalYearStartFor('2026-07-01', 7)).toBe('2026-07-01');
    expect(fiscalYearStartFor('2026-06-30', 0)).toBe('2026-01-01');
  });

  it('allocates new ids in the order of the old ones, leaving mapped ids alone (B2)', () => {
    const m = new IdMap();
    const pinned = crypto.randomUUID();
    m.set(pinned, '00000000-0000-4000-8000-000000000001');
    const olds = Array.from({ length: 200 }, () => crypto.randomUUID());
    m.freshOrdered([...olds, pinned, olds[0]!]);
    const sortedOld = [...olds].sort();
    const news = sortedOld.map((o) => m.get(o)!);
    expect([...news].sort()).toEqual(news);
    expect(m.get(pinned)).toBe('00000000-0000-4000-8000-000000000001');
    expect(new Set(news).size).toBe(olds.length);
  });
});

describe('export and preview (U-283)', () => {
  it('writes vt1 to the manifest and the result, with exact decimal strings; hidden accounts count', async () => {
    const vt = exported.manifestSummary.verificationTotals!;
    expect(vt.definition).toBe(VERIFICATION_TOTALS_DEFINITION);
    expect(vt.asOf).toBe(AS_OF);
    expect(vt.basis).toBe('accrual');
    expect(vt.companies).toHaveLength(1);
    const c = vt.companies[0]!;
    expect(c).toMatchObject({
      companyId, name: 'VT Co', fiscalYearStart: '2026-01-01',
      totalAssets: '6584.5679', totalLiabilities: '800.1250', totalEquity: '5784.4429',
      netIncome: { from: '2026-01-01', to: AS_OF, amount: '434.4428' },
      accountsReceivable: '234.5678', accountsPayable: '800.1250',
      trialBalance: { debits: '8384.6929', credits: '8384.6929' },
    });
    expect(c.counts).toEqual({
      accounts: 7, clients: 2, vendors: 2, items: 0, transactions: 10, postedTransactions: 8, attachments: 2, attachmentBytes: 30, auditEntries: 3,
    });
    expect(vt.counts).toEqual(c.counts);
    const reader = await ArchiveReader.open(exported.path, PASS);
    expect(reader.manifest.verificationTotals).toEqual(vt);
    expect(validateManifestTotals(reader.manifest.verificationTotals)).toBe(true);
    // Strings in the JSON, never numbers.
    expect(JSON.stringify(vt)).toContain('"totalAssets":"6584.5679"');
  });

  it('the preview of a quiet company equals the file made right after it', async () => {
    const preview = await withArchiveConnection(async (client) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      try {
        await applyArchiveSession(client);
        return await computeVerificationTotals(client, tenantId, { asOf: AS_OF, scope: (t, a) => scopeSql(plan, t, a) });
      } finally {
        await client.query('ROLLBACK');
      }
    });
    const r = await runExport(tenantId, callerId, { passphrase: PASS, asOf: AS_OF });
    expect(preview).toEqual(r.manifestSummary.verificationTotals);
  });

  it('counts only what travels: includeAudit=false leaves audit entries at 0', async () => {
    const r = await runExport(tenantId, callerId, { passphrase: PASS, asOf: AS_OF, includeAudit: false });
    expect(r.manifestSummary.verificationTotals!.counts.auditEntries).toBe(0);
    const imported = await runImport({ filePath: r.path, passphrase: PASS, callerUserId: callerId });
    tenants.push(imported.tenantId);
    expect(imported.verificationTotals.matches).toBe(true);
  }, 120_000);
});

describe('import expected vs actual (Q-P32o)', () => {
  it('matches on the same definition; audit entries counted before the import\'s own rows (T3)', async () => {
    const imported = await runImport({ filePath: exported.path, passphrase: PASS, callerUserId: callerId });
    tenants.push(imported.tenantId);
    const v = imported.verificationTotals;
    expect(v.definition).toBe('vt1');
    expect(v.matches).toBe(true);
    expect(v.differences).toEqual([]);
    expect(v.expected).toEqual(exported.manifestSummary.verificationTotals);
    // Actual is reported in the archive's company ids.
    expect(v.actual).toEqual(v.expected);
    const audit = await q<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1`, [imported.tenantId]);
    expect(audit[0]!.n).toBeGreaterThan(v.actual.counts.auditEntries);
  }, 120_000);

  it('a money difference on the same schema rolls back with ARCHIVE_TOTALS_MISMATCH and the figures', async () => {
    const bad = path.join(work, 'bad-money.zip');
    await rewriteArchive(exported.path, bad, PASS, (m) => { m.verificationTotals!.companies[0]!.totalAssets = '6584.5680'; });
    const before = await tenantCount();
    const err = await expectCode(runImport({ filePath: bad, passphrase: PASS, callerUserId: callerId }), 'ARCHIVE_TOTALS_MISMATCH');
    expect(err.statusCode).toBe(422);
    const d = err.details as { differences: Array<{ field: string; expected: string; actual: string; companyId: string }> };
    expect(d.differences).toEqual([{ companyId, field: 'totalAssets', expected: '6584.5680', actual: '6584.5679' }]);
    expect(await tenantCount()).toBe(before);
  }, 120_000);

  it('a count difference rolls back too', async () => {
    const bad = path.join(work, 'bad-count.zip');
    await rewriteArchive(exported.path, bad, PASS, (m) => { m.verificationTotals!.counts.vendors = 3; });
    const err = await expectCode(runImport({ filePath: bad, passphrase: PASS, callerUserId: callerId }), 'ARCHIVE_TOTALS_MISMATCH');
    expect((err.details as { differences: Array<{ field: string }> }).differences.map((x) => x.field)).toEqual(['counts.vendors']);
  }, 120_000);

  it('an older schema: the upgrade backfills that ran are reported; an unexplained money difference still rolls back (T12)', async () => {
    const older = path.join(work, 'older.zip');
    await rewriteArchive(exported.path, older, PASS, (m) => { m.schema.version = 252; });
    const imported = await runImport({ filePath: older, passphrase: PASS, callerUserId: callerId });
    tenants.push(imported.tenantId);
    const v = imported.verificationTotals;
    expect(v.backfills.map((b) => b.name)).toEqual(['sales_tax_backfill', 'sales_tax_liability_upgrade']);
    // The backfills post nothing on this company: the money is unchanged and still matches.
    expect(v.backfills.every((b) => b.fields.length === 0)).toBe(true);
    expect(v.matches).toBe(true);

    const olderBad = path.join(work, 'older-bad.zip');
    await rewriteArchive(exported.path, olderBad, PASS, (m) => { m.schema.version = 252; m.verificationTotals!.companies[0]!.netIncome.amount = '1.0000'; });
    await expectCode(runImport({ filePath: olderBad, passphrase: PASS, callerUserId: callerId }), 'ARCHIVE_TOTALS_MISMATCH');
  }, 180_000);

  it('another definition: counts compared strictly, money only shown (warning)', async () => {
    const vt2 = path.join(work, 'vt2.zip');
    await rewriteArchive(exported.path, vt2, PASS, (m) => {
      (m.verificationTotals as unknown as { definition: string }).definition = 'vt2';
      m.verificationTotals!.companies[0]!.totalAssets = '1.0000';
    });
    const imported = await runImport({ filePath: vt2, passphrase: PASS, callerUserId: callerId });
    tenants.push(imported.tenantId);
    expect(imported.verificationTotals.matches).toBe(true);
    expect(imported.warnings).toContain('TOTALS_DEFINITION_DIFFERS:vt2');
  }, 120_000);

  it('a formatVersion 1 archive has no expected totals', async () => {
    const imported = await runImport({ filePath: V1_FIXTURE, passphrase: V1_FIXTURE_PASSPHRASE, callerUserId: callerId });
    tenants.push(imported.tenantId);
    const v = imported.verificationTotals;
    expect(v.expected).toBeNull();
    expect(v.matches).toBeNull();
    expect(v.actual.definition).toBe('vt1');
    expect(v.actual.companies[0]!.trialBalance).toEqual({ debits: '8034.6928', credits: '8034.6928' });
  }, 120_000);

  it('a crafted totals block of the wrong shape is ARCHIVE_CORRUPT', async () => {
    const bad = path.join(work, 'bad-shape.zip');
    await rewriteArchive(exported.path, bad, PASS, (m) => { (m.verificationTotals!.companies[0] as unknown as Record<string, unknown>)['totalAssets'] = 6584.5679; });
    await expectCode(runImport({ filePath: bad, passphrase: PASS, callerUserId: callerId }), 'ARCHIVE_CORRUPT');
  }, 120_000);
});

