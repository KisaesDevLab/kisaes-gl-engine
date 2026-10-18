// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Round trip, fidelity, tamper, compatibility, encryption and identity
// (U-05 §4.5 groups B, C, D, G, H; MT9, MT10, MT15, MT19, MT22, MT27 and
// the export half of MT28). Runs in server mode against the test database.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import archiver from 'archiver';
import * as unzipper from 'unzipper';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { encryptBuffer, decryptBuffer } from '../../utils/encryption.js';
import { auditLog } from '../../middleware/audit.js';
import { ArchiveReader } from './archive-reader.js';
import { encryptEntryBuffer, NoncePrefixRegistry, openEnvelope, validateEnvelope } from './archive-crypto.js';
import { ArchiveError } from './errors.js';
import { _exportTestHooks, runExport, archiveDir, sweepPartialArchives, type ExportResult } from './export.service.js';
import { _importTestHooks, runImport, sweepImportPending } from './import.service.js';
import { computeTenantFingerprint, computeTrialBalance, fingerprintDiff } from './fingerprint.js';
import { ENVELOPE_ENTRY, MANIFEST_ENTRY, tablePartName, zipEntryName, type ArchiveManifest } from './format.js';
import { buildPortabilityPlan, scopeSql, type PortabilityPlan } from './plan.js';
import { IdMap } from './remap.js';
import { applyArchiveSession, withArchiveConnection } from './session.js';

const PASS = 'round trip passphrase 2026!';
const stamp = crypto.randomUUID().slice(0, 8);
let plan: PortabilityPlan;
let uploadDir = '';
let archiveRoot = '';
const createdTenants: string[] = [];
const createdUsers: string[] = [];

interface Seed {
  tenantId: string;
  ownerId: string;
  lanUserId: string;
  callerId: string;
  c1: string;
  c2: string;
  cash: string;
  sales: string;
  ar: string;
  customer: string;
  vendor: string;
  invoice: string;
  draft: string;
  attachmentIds: string[];
  signatureId: string;
  signatureBytes: Buffer;
  logoName: string;
  logoBytes: Buffer;
  reconciliationId: string;
}

async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.execute(sql.raw(text.replace(/\$(\d+)/g, (_m, n) => {
    const v = params[Number(n) - 1];
    if (v === null || v === undefined) return 'NULL';
    if (Buffer.isBuffer(v)) return `'\\x${v.toString('hex')}'::bytea`;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  })));
  return r.rows as T[];
}

async function insertUser(tenantId: string, email: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = crypto.randomUUID();
  await q(`INSERT INTO users (id, tenant_id, email, password_hash, display_name, role, is_super_admin, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [id, tenantId, email, extra['password_hash'] ?? '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', extra['display_name'] ?? 'User', extra['role'] ?? 'owner', extra['is_super_admin'] ?? false, extra['is_active'] ?? true]);
  createdUsers.push(id);
  return id;
}

async function seedTenant(): Promise<Seed> {
  const tenantId = crypto.randomUUID();
  const nested = crypto.randomUUID();
  await q(`INSERT INTO tenants (id, name, slug, report_settings, practice_settings) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
    [tenantId, `RT ${stamp}`, `rt-${stamp}-${tenantId.slice(0, 4)}`, JSON.stringify({ defaultCompanyId: nested, theme: 'x' }), JSON.stringify({ thresholds: { a: 1 } })]);
  createdTenants.push(tenantId);
  const ownerId = await insertUser(tenantId, `rt-owner-${stamp}-${tenantId.slice(0, 4)}@example.test`, { display_name: 'Owner' });
  const lanUserId = await insertUser(tenantId, `RT-Lan-${stamp}-${tenantId.slice(0, 4)}@Example.test`.toLowerCase(), { display_name: 'LAN', role: 'bookkeeper' });
  const callerId = await insertUser(tenantId, `rt-caller-${stamp}-${tenantId.slice(0, 4)}@example.test`, { display_name: 'Caller', is_super_admin: true });
  await q(`INSERT INTO user_tenant_access (user_id, tenant_id, role) VALUES ($1, $2, 'owner'), ($3, $2, 'bookkeeper')`, [ownerId, tenantId, lanUserId]);
  const [c1] = await q<{ id: string }>(`INSERT INTO companies (tenant_id, business_name, entity_type, setup_complete, lock_date, smtp_pass, remote_backup_config, logo_url, check_settings)
    VALUES ($1, 'RT Co One', 'llc', true, '2025-12-31', 'SMTP-CANARY-${stamp}', $2::jsonb, $3, $4::jsonb) RETURNING id`,
  [tenantId, JSON.stringify({ token: `REMOTE-CANARY-${stamp}` }), `/uploads/logos/rt-logo-${stamp}.png`, JSON.stringify({ format: 'voucher', defaultBankAccountId: null, routingNumber: '011000015' })]);
  const [c2] = await q<{ id: string }>(`INSERT INTO companies (tenant_id, business_name, entity_type, setup_complete, lock_date) VALUES ($1, 'RT Co Two', 'sole_prop', true, '2025-06-30') RETURNING id`, [tenantId]);
  // Nested id in report_settings points at company one (MT9).
  await q(`UPDATE tenants SET report_settings = $2::jsonb WHERE id = $1`, [tenantId, JSON.stringify({ defaultCompanyId: c1!.id, theme: 'x' })]);
  const logoBytes = crypto.randomBytes(300);
  fs.mkdirSync(path.join(uploadDir, 'logos'), { recursive: true });
  fs.writeFileSync(path.join(uploadDir, 'logos', `rt-logo-${stamp}.png`), logoBytes);

  const acct = async (company: string, name: string, type: string, num: string) =>
    (await q<{ id: string }>(`INSERT INTO accounts (tenant_id, company_id, name, account_type, account_number) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [tenantId, company, name, type, num]))[0]!.id;
  const cash = await acct(c1!.id, `Cash CANARY-ACCT-${stamp}`, 'asset', `10${stamp.slice(0, 2)}`);
  const sales = await acct(c1!.id, 'Sales', 'income', `40${stamp.slice(0, 2)}`);
  const ar = await acct(c1!.id, 'Accounts Receivable', 'asset', `12${stamp.slice(0, 2)}`);
  const cash2 = await acct(c2!.id, 'Cash Two', 'asset', `11${stamp.slice(0, 2)}`);
  const sales2 = await acct(c2!.id, 'Sales Two', 'income', `41${stamp.slice(0, 2)}`);
  await q(`UPDATE accounts SET parent_id = $2 WHERE id = $1`, [ar, cash]);

  const [customer] = await q<{ id: string }>(`INSERT INTO contacts (tenant_id, company_id, contact_type, display_name, default_expense_account_id) VALUES ($1, $2, 'customer', 'Cust', $3) RETURNING id`, [tenantId, c1!.id, cash]);
  const [vendor] = await q<{ id: string }>(`INSERT INTO contacts (tenant_id, company_id, contact_type, display_name) VALUES ($1, $2, 'vendor', 'Vend') RETURNING id`, [tenantId, c1!.id]);
  const txn = async (company: string, type: string, date: string, status: string, memo: string | null, contact: string | null) =>
    (await q<{ id: string }>(`INSERT INTO transactions (tenant_id, company_id, txn_type, txn_date, status, memo, contact_id, total) VALUES ($1, $2, $3, $4, $5, $6, $7, 100) RETURNING id`, [tenantId, company, type, date, status, memo, contact]))[0]!.id;
  const line = async (t: string, company: string, account: string, debit: string, credit: string, extra = '') =>
    (await q<{ id: string }>(`INSERT INTO journal_lines (tenant_id, transaction_id, company_id, account_id, debit, credit, tax_amount${extra ? ', contact_id' : ''}) VALUES ($1, $2, $3, $4, $5, $6, '1.2500'${extra ? `, '${extra}'` : ''}) RETURNING id`, [tenantId, t, company, account, debit, credit]))[0]!.id;
  const invoice = await txn(c1!.id, 'invoice', '2026-01-10', 'posted', `MEMO-CANARY-${stamp}`, customer!.id);
  const l1 = await line(invoice, c1!.id, ar, '999999999999999.9999', '0', customer!.id);
  await line(invoice, c1!.id, sales, '0', '999999999999999.9999');
  const payment = await txn(c1!.id, 'payment', '2026-01-20', 'posted', null, customer!.id);
  const l3 = await line(payment, c1!.id, cash, '0.0001', '0');
  await line(payment, c1!.id, ar, '0', '0.0001');
  const t2 = await txn(c2!.id, 'journal', '2026-02-01', 'posted', 'co two', null);
  await line(t2, c2!.id, cash2, '50.0000', '0');
  await line(t2, c2!.id, sales2, '0', '50.0000');
  const draft = await txn(c1!.id, 'journal', '2026-03-01', 'draft', 'unbalanced', null);
  await line(draft, c1!.id, cash, '7.0000', '0');
  const deposit = await txn(c1!.id, 'deposit', '2026-01-21', 'posted', null, null);
  await line(deposit, c1!.id, cash, '0.0001', '0');
  await line(deposit, c1!.id, ar, '0', '0.0001');
  await q(`INSERT INTO deposit_lines (deposit_id, source_transaction_id, amount) VALUES ($1, $2, '0.0001')`, [deposit, payment]);
  await q(`INSERT INTO payment_applications (tenant_id, company_id, payment_id, invoice_id, amount) VALUES ($1, $2, $3, $4, '0.0001')`, [tenantId, c1!.id, payment, invoice]);
  await q(`INSERT INTO recurring_schedules (tenant_id, company_id, template_transaction_id, frequency, start_date, next_occurrence) VALUES ($1, $2, $3, 'monthly', '2026-01-01', '2027-01-01')`, [tenantId, c1!.id, invoice]);

  const [tag] = await q<{ id: string }>(`INSERT INTO tags (tenant_id, company_id, name) VALUES ($1, $2, 'rt-tag') RETURNING id`, [tenantId, c1!.id]);
  await q(`INSERT INTO transaction_tags (tenant_id, company_id, transaction_id, tag_id) VALUES ($1, $2, $3, $4), ($1, $2, $5, $4)`, [tenantId, c1!.id, invoice, tag!.id, payment]);
  await q(`INSERT INTO tb_aje_sequences (tenant_id, company_id, fiscal_year, next_number) VALUES ($1, $2, 2026, 7)`, [tenantId, c1!.id]);

  const [budget] = await q<{ id: string }>(`INSERT INTO budgets (tenant_id, company_id, name, fiscal_year, period_type, status, created_by) VALUES ($1, $2, 'B', 2026, 'monthly', 'active', $3) RETURNING id`, [tenantId, c1!.id, ownerId]);
  await q(`INSERT INTO budget_lines (budget_id, account_id, month_1) VALUES ($1, $2, '12.3400')`, [budget!.id, sales]);
  await q(`INSERT INTO budget_periods (budget_id, account_id, period_index, amount) VALUES ($1, $2, 1, '99.9900')`, [budget!.id, sales]);
  const [rec] = await q<{ id: string }>(`INSERT INTO reconciliations (tenant_id, company_id, account_id, statement_date, statement_ending_balance, beginning_balance, status) VALUES ($1, $2, $3, '2026-01-31', '0.0001', '0', 'in_progress') RETURNING id`, [tenantId, c1!.id, cash]);
  await q(`INSERT INTO reconciliation_lines (reconciliation_id, journal_line_id, is_cleared, cleared_at) VALUES ($1, $2, true, '2026-02-01T10:11:12.123456Z'), ($1, $3, false, NULL)`, [rec!.id, l3, l1]);

  // Attachments through the local layout: UPLOAD_DIR/<tenant>/attachments/<id>.ext
  const attachmentIds: string[] = [];
  const attDir = path.join(uploadDir, tenantId, 'attachments');
  fs.mkdirSync(attDir, { recursive: true });
  for (const [i, size] of [0, 1234, 5 * 1024 * 1024].entries()) {
    const id = crypto.randomUUID();
    const bytes = size === 0 ? Buffer.alloc(0) : crypto.randomBytes(size);
    fs.writeFileSync(path.join(attDir, `${id}.bin`), bytes);
    const key = `${tenantId}/attachments/${id}.bin`;
    await q(`INSERT INTO attachments (id, tenant_id, company_id, file_name, file_path, storage_key, file_size, attachable_type, attachable_id, local_cache_path)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'transaction', $8, $9)`,
    [id, tenantId, c1!.id, `f${i}.bin`, `/uploads/${key}`, i === 1 ? null : key, size, invoice, i === 0 ? '/tmp/cache' : null]);
    attachmentIds.push(id);
  }
  // Check signature: AES ciphertext under this install's key.
  const signatureBytes = crypto.randomBytes(777);
  const signatureId = crypto.randomUUID();
  fs.mkdirSync(path.join(uploadDir, 'signatures', tenantId), { recursive: true });
  const sigRel = path.join('signatures', tenantId, `${signatureId}-abcd.enc`);
  fs.writeFileSync(path.join(uploadDir, sigRel), encryptBuffer(signatureBytes));
  await q(`INSERT INTO check_signatures (id, tenant_id, label, file_path, mime_type, width, height, sha256, created_by) VALUES ($1, $2, 'Sig', $3, 'image/png', 10, 10, $4, $5)`,
    [signatureId, tenantId, sigRel, crypto.createHash('sha256').update(signatureBytes).digest('hex'), ownerId]);
  await q(`INSERT INTO check_signature_users (signature_id, tenant_id, user_id, granted_by) VALUES ($1, $2, $3, $4)`, [signatureId, tenantId, lanUserId, ownerId]);
  // Audit rows in a known order (MT27).
  for (let i = 0; i < 5; i++) {
    await q(`INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, after_data) VALUES ($1, $2, 'update', 'account', $3, $4::jsonb)`, [tenantId, ownerId, cash, JSON.stringify({ i })]);
  }
  // H3 canaries: a raw audit row image carrying secrets at several depths (as
  // older engines wrote them), and one written through auditLog() today.
  await q(`INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, before_data, after_data) VALUES ($1, $2, 'update', 'company', $3, $4::jsonb, $5::jsonb)`,
    [tenantId, ownerId, c1!.id, JSON.stringify({ smtp_pass: `AUDIT-CANARY-A-${stamp}`, business_name: 'RT Co One' }), JSON.stringify({
      smtpPass: `AUDIT-CANARY-B-${stamp}`, nested: { stripe: { secretKeyEncrypted: `AUDIT-CANARY-C-${stamp}` } }, list: [{ apiKey: `AUDIT-CANARY-D-${stamp}` }, 'x'],
      remote_backup_config: { token: `AUDIT-CANARY-E-${stamp}` }, kept: 'plain', inputTokens: 12,
    })]);
  await auditLog(tenantId, 'update', 'company', c1!.id, { smtpPass: `AUDIT-CANARY-F-${stamp}` }, { smtp_pass: `AUDIT-CANARY-G-${stamp}`, business_name: 'RT Co One' }, ownerId);
  // A row in the shape auditLog() wrote before it stripped (a JSON string holding the image).
  await q(`INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, after_data) VALUES ($1, $2, 'update', 'company', $3, to_jsonb($4::text))`,
    [tenantId, ownerId, c1!.id, JSON.stringify({ smtp_pass: `AUDIT-CANARY-H-${stamp}`, business_name: 'RT Co One', stripe: { secretKeyEncrypted: `AUDIT-CANARY-I-${stamp}` } })]);
  return {
    tenantId, ownerId, lanUserId, callerId, c1: c1!.id, c2: c2!.id, cash, sales, ar, customer: customer!.id, vendor: vendor!.id,
    invoice, draft, attachmentIds, signatureId, signatureBytes, logoName: `rt-logo-${stamp}.png`, logoBytes, reconciliationId: rec!.id,
  };
}

async function fingerprintOf(tenantId: string) {
  return withArchiveConnection(async (c) => {
    await c.query('BEGIN');
    await applyArchiveSession(c);
    try {
      return await computeTenantFingerprint(c, plan, tenantId);
    } finally {
      await c.query('ROLLBACK');
    }
  });
}

async function countRows(table: string, tenantId: string): Promise<number> {
  const where = scopeSql(plan, table, 'a').replace('$1', `'${tenantId}'::uuid`);
  return Number((await q<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}" a WHERE ${where}`))[0]!.n);
}

async function auditRows(tenantId: string): Promise<Array<{ entity_id: string; after_data: Record<string, unknown> }>> {
  return q(`SELECT entity_id, after_data FROM audit_log WHERE tenant_id = $1 AND entity_type = 'tenant_archive' ORDER BY id`, [tenantId]);
}

/** Decrypts the manifest of an archive, applies `mutate`, and writes a new archive with the other entries copied raw. */
async function rewriteArchive(src: string, dst: string, mutate: (m: ArchiveManifest) => void, extraParts: Array<{ part: string; bytes: Buffer }> = [], omitEntries: string[] = []): Promise<void> {
  const d = await unzipper.Open.file(src);
  const envelope = validateEnvelope(JSON.parse((await d.files.find((f) => f.path === ENVELOPE_ENTRY)!.buffer()).toString('utf8')));
  const key = openEnvelope(envelope, PASS);
  const reader = await ArchiveReader.open(src, PASS);
  const manifest = JSON.parse(JSON.stringify(reader.manifest)) as ArchiveManifest;
  mutate(manifest);
  const out = archiver('zip', { store: true });
  const stream = fs.createWriteStream(dst);
  const done = new Promise<void>((resolve, reject) => {
    stream.on('close', resolve);
    out.on('error', reject);
  });
  out.pipe(stream);
  const registry = new NoncePrefixRegistry();
  for (const f of d.files) {
    if (f.path === MANIFEST_ENTRY || omitEntries.includes(f.path)) continue;
    out.append(await f.buffer(), { name: f.path });
  }
  for (const e of extraParts) out.append(encryptEntryBuffer(key, envelope.archiveId, e.part, e.bytes, registry), { name: zipEntryName(e.part) });
  out.append(encryptEntryBuffer(key, envelope.archiveId, MANIFEST_ENTRY.slice(0, -'.enc'.length), Buffer.from(JSON.stringify(manifest), 'utf8'), registry), { name: MANIFEST_ENTRY });
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

let seed: Seed;
let exported: ExportResult;
let capturedMap: IdMap | null = null;

beforeAll(async () => {
  plan = await buildPortabilityPlan(db);
  uploadDir = process.env['UPLOAD_DIR']!;
  archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-archives-'));
  process.env['CL_ARCHIVE_DIR'] = archiveRoot;
  seed = await seedTenant();
  _importTestHooks.beforeVerify = async ({ idMap }) => { capturedMap = idMap; };
  exported = await runExport(seed.tenantId, seed.ownerId, { passphrase: PASS, host: { app: 'ClientLedger', kind: 'backup' } });
}, 180_000);

afterEach(() => {
  _importTestHooks.beforeVerify = async ({ idMap }) => { capturedMap = idMap; };
  delete _exportTestHooks.beforeFinalize;
  delete _exportTestHooks.failAudit;
});

afterAll(async () => {
  delete _importTestHooks.beforeVerify;
  for (const id of createdTenants) {
    for (const t of [...plan.scoped].reverse()) {
      const where = scopeSql(plan, t, 'a').replace('$1', `'${id}'::uuid`);
      await q(`DELETE FROM "${t}" a WHERE ${where}`).catch(() => undefined);
    }
    await q(`DELETE FROM tenant_archive_imports WHERE tenant_id = $1`, [id]).catch(() => undefined);
    await q(`DELETE FROM user_tenant_access WHERE tenant_id = $1`, [id]);
    await q(`DELETE FROM users WHERE tenant_id = $1 AND id <> ALL($2::uuid[])`, [id, `{${createdUsers.join(',')}}`]).catch(() => undefined);
  }
  for (const u of createdUsers) await q(`DELETE FROM users WHERE id = $1`, [u]).catch(() => undefined);
  for (const id of createdTenants) await q(`DELETE FROM tenants WHERE id = $1`, [id]).catch(() => undefined);
  fs.rmSync(archiveRoot, { recursive: true, force: true });
  delete process.env['CL_ARCHIVE_DIR'];
});

describe('export', () => {
  it('writes a verified archive, hashes the file, records a success audit row and leaves the fingerprint unchanged', async () => {
    expect(fs.existsSync(exported.path!)).toBe(true);
    expect(exported.sha256).toBe(crypto.createHash('sha256').update(fs.readFileSync(exported.path!)).digest('hex'));
    expect(exported.warnings).toEqual([]);
    expect(exported.manifestSummary.unbalancedTransactions).toBe(1);
    expect(exported.manifestSummary.files).toBe(5); // 3 attachments, logo, signature
    const audit = await auditRows(seed.tenantId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.entity_id).toBe(exported.archiveId);
    expect(audit[0]!.after_data['sha256']).toBe(exported.sha256);
    const reader = await ArchiveReader.open(exported.path!, PASS);
    await reader.verifyAll();
    const m = reader.manifest;
    expect(m.host).toEqual({ app: 'ClientLedger', kind: 'backup' });
    expect(m.source.tenantId).toBe(seed.tenantId);
    expect(m.tables.find((t) => t.name === 'journal_lines')!.rows).toBe(9);
    expect(m.tables.find((t) => t.name === 'audit_log')!.rows).toBe(8);
    expect(m.trialBalance.rows.length).toBeGreaterThan(3);
    expect(m.redactedColumns['companies.smtp_pass']).toBeDefined();
    expect(m.redactedColumns['companies.remote_backup_config']).toBeDefined();
    expect(m.excludedTables['sessions']).toMatchObject({ category: 'session-token' });
    expect(fingerprintDiff(m.fingerprint, await fingerprintOf(seed.tenantId))).toEqual([]);
  }, 60_000);

  it('leaks no plaintext: canaries, amounts, hashes and secrets are absent from the raw zip and the redacted columns (MT10, H)', async () => {
    const raw = fs.readFileSync(exported.path!);
    for (const canary of [`CANARY-ACCT-${stamp}`, `MEMO-CANARY-${stamp}`, '999999999999999.9999', '$2b$12$', `SMTP-CANARY-${stamp}`, `REMOTE-CANARY-${stamp}`, PASS, 'RT Co One']) {
      expect(raw.includes(canary), canary).toBe(false);
    }
    const envelope = JSON.parse(raw.subarray(raw.indexOf('{"format"'), raw.indexOf('}}', raw.indexOf('{"format"')) + 2).toString('utf8')) as Record<string, unknown>;
    expect(JSON.stringify(envelope)).not.toContain('RT ');
    // Decrypted parts: the secrets are redacted, the hashes travel.
    const reader = await ArchiveReader.open(exported.path!, PASS);
    const companies: string[] = [];
    for await (const l of reader.lines(tablePartName('companies'))) companies.push(l);
    expect(companies.join('\n')).not.toContain(`SMTP-CANARY-${stamp}`);
    expect(companies.join('\n')).not.toContain(`REMOTE-CANARY-${stamp}`);
    expect(companies.join('\n')).toContain('011000015');
    const users: string[] = [];
    for await (const l of reader.lines('data/_users.ndjson')) users.push(l);
    expect(users.join('\n')).toContain('$2b$12$');
    expect(users.join('\n')).not.toContain('tenant_id');
    expect(users.join('\n')).not.toContain('tfa_');
    // H3: audit row images travel without any secret-looking key, at every depth; plain keys survive.
    expect(raw.includes('AUDIT-CANARY')).toBe(false);
    const audit: string[] = [];
    for await (const l of reader.lines(tablePartName('audit_log'))) audit.push(l);
    const auditText = audit.join('\n');
    expect(auditText).not.toContain('AUDIT-CANARY');
    for (const k of ['smtp_pass', 'smtpPass', 'secretKeyEncrypted', 'apiKey', 'remote_backup_config']) expect(auditText, k).not.toContain(k);
    expect(auditText).toContain('"kept": "plain"');
    expect(auditText).toContain('"inputTokens": 12');
    expect(auditText).toContain('"business_name": "RT Co One"');
    expect(reader.manifest.redactedColumns['audit_log.after_data']).toBeDefined();
    // auditLog() itself never stored the canary (it keeps writing the image as a JSON string, as before).
    const live = await q<{ before_data: unknown; after_data: unknown }>(
      `SELECT before_data, after_data FROM audit_log WHERE tenant_id = $1 AND entity_type = 'company' ORDER BY id`, [seed.tenantId]);
    expect(live).toHaveLength(3);
    expect(JSON.parse(live[1]!.before_data as string)).toEqual({});
    expect(JSON.parse(live[1]!.after_data as string)).toEqual({ business_name: 'RT Co One' });
    expect(JSON.stringify(live[0])).toContain('AUDIT-CANARY'); // raw rows keep their secrets live; the archive strips them
    expect(JSON.stringify(live[2])).toContain('AUDIT-CANARY');
  }, 60_000);

  it('a failed export leaves no file, no partial and no audit row; an audit failure gives AUDIT_NOT_WRITTEN (MT22)', async () => {
    _exportTestHooks.beforeFinalize = () => { throw new Error('disk full (test)'); };
    await expect(runExport(seed.tenantId, seed.ownerId, { passphrase: PASS })).rejects.toThrow('disk full');
    const dir = path.join(archiveDir(), seed.tenantId);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.partial'))).toEqual([]);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.zip'))).toEqual([exported.fileName]);
    expect(await auditRows(seed.tenantId)).toHaveLength(1);
    delete _exportTestHooks.beforeFinalize;
    _exportTestHooks.failAudit = true;
    const r = await runExport(seed.tenantId, seed.ownerId, { passphrase: PASS });
    expect(r.warnings).toEqual(['AUDIT_NOT_WRITTEN']);
    await (await ArchiveReader.open(r.path!, PASS)).verifyAll();
    expect(await auditRows(seed.tenantId)).toHaveLength(1);
    fs.rmSync(r.path!);
    // A stray .partial is swept at boot.
    fs.writeFileSync(path.join(dir, 'stray.partial'), 'x');
    expect(sweepPartialArchives()).toBe(1);
  }, 120_000);

  it('refuses a weak passphrase, an oversized host object and a missing tenant', async () => {
    await expectCode(runExport(seed.tenantId, seed.ownerId, { passphrase: 'short' }), 'PASSPHRASE_TOO_WEAK');
    await expect(runExport(seed.tenantId, seed.ownerId, { passphrase: PASS, host: { pad: 'x'.repeat(17 * 1024) } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(runExport(crypto.randomUUID(), seed.ownerId, { passphrase: PASS })).rejects.toMatchObject({ statusCode: 404 });
  }, 60_000);

  it('two exports of the same tenant run concurrently (MT28, export half)', async () => {
    const [a, b] = await Promise.all([runExport(seed.tenantId, seed.ownerId, { passphrase: PASS }), runExport(seed.tenantId, seed.ownerId, { passphrase: PASS })]);
    expect(a.archiveId).not.toBe(b.archiveId);
    expect((await auditRows(seed.tenantId)).length).toBe(3);
    fs.rmSync(a.path!);
    fs.rmSync(b.path!);
  }, 120_000);
});

describe('import', () => {
  let imported: Awaited<ReturnType<typeof runImport>>;
  let idMap: IdMap;

  beforeAll(async () => {
    imported = await runImport({ filePath: exported.path!, passphrase: PASS, callerUserId: seed.callerId });
    createdTenants.push(imported.tenantId);
    idMap = capturedMap!;
  }, 180_000);

  it('creates a new tenant whose rows, content digests, trial balance and files verify', async () => {
    expect(imported.tenantId).not.toBe(seed.tenantId);
    expect(imported.name).toMatch(/^RT .* \(restored \d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$/);
    expect(imported.verification).toMatchObject({ contentEqual: true, trialBalanceEqual: true, files: 5, identity: { matched: 2, created: 0 } });
    expect(imported.warnings).toEqual([]);
    expect(imported.host).toEqual({ app: 'ClientLedger', kind: 'backup' });
    const reader = await ArchiveReader.open(exported.path!, PASS);
    // The import audit row (tenant_import) is written after verification, so audit_log holds one row more.
    for (const t of reader.manifest.tables) expect(await countRows(t.name, imported.tenantId), t.name).toBe(t.rows + (t.name === 'audit_log' ? 1 : 0));
    // Report-level trial balance is equal once ids are mapped back (B9).
    const tbNew = await withArchiveConnection((c) => computeTrialBalance(c, imported.tenantId));
    const mapped = tbNew.rows.map((r) => ({ ...r, companyId: r.companyId && idMap.getOld(r.companyId), accountId: idMap.getOld(r.accountId) }));
    const key = (r: { companyId: string | null | undefined; accountId: string | undefined; status: string; basis: string }) => `${r.companyId}|${r.accountId}|${r.status}|${r.basis}`;
    expect(new Map(mapped.map((r) => [key(r), r]))).toEqual(new Map(reader.manifest.trialBalance.rows.map((r) => [key(r), r])));
    // gl_version_stamps rows exist for the new tenant's companies (MT15, S1).
    const stamps = await q<{ n: number }>(`SELECT count(*)::int AS n FROM gl_version_stamps WHERE tenant_id = $1`, [imported.tenantId]);
    expect(stamps[0]!.n).toBeGreaterThanOrEqual(2);
    // The source is untouched.
    expect(fingerprintDiff(reader.manifest.fingerprint, await fingerprintOf(seed.tenantId))).toEqual([]);
    // Provenance row.
    const prov = await q(`SELECT scratch, source_tenant_id, archive_id, archive_sha256, created_user_ids FROM tenant_archive_imports WHERE tenant_id = $1`, [imported.tenantId]);
    expect(prov[0]).toMatchObject({ scratch: false, source_tenant_id: seed.tenantId, archive_id: exported.archiveId, archive_sha256: exported.sha256, created_user_ids: [] });
    // Lock dates and nested settings survive, remapped (MT9, MT11).
    const cos = await q<{ lock_date: string; logo_url: string; smtp_pass: string | null }>(`SELECT lock_date::text AS lock_date, logo_url, smtp_pass FROM companies WHERE tenant_id = $1 ORDER BY business_name`, [imported.tenantId]);
    expect(cos.map((c) => c.lock_date)).toEqual(['2025-12-31', '2025-06-30']);
    expect(cos[0]!.smtp_pass).toBeNull();
    const t = await q<{ report_settings: { defaultCompanyId: string } }>(`SELECT report_settings FROM tenants WHERE id = $1`, [imported.tenantId]);
    expect(t[0]!.report_settings.defaultCompanyId).toBe(idMap.get(seed.c1));
    expect(t[0]!.report_settings.defaultCompanyId).not.toBe(seed.c1);
    // Audit chronology (MT27): the new tenant's audit rows ordered by id carry the same sequence.
    const audit = await q<{ after_data: { i: number } }>(`SELECT after_data FROM audit_log WHERE tenant_id = $1 AND entity_type = 'account' ORDER BY id`, [imported.tenantId]);
    expect(audit.map((a) => a.after_data.i)).toEqual([0, 1, 2, 3, 4]);
  }, 60_000);

  it('bundled files are equal after the round trip, the logo has a new name and the source logo is untouched (MT8)', async () => {
    const [co] = await q<{ logo_url: string }>(`SELECT logo_url FROM companies WHERE tenant_id = $1 AND business_name = 'RT Co One'`, [imported.tenantId]);
    expect(co!.logo_url).toMatch(/^\/uploads\/logos\/[0-9a-f-]{36}\.png$/);
    expect(co!.logo_url).not.toBe(`/uploads/logos/${seed.logoName}`);
    expect(fs.readFileSync(path.join(uploadDir, 'logos', path.posix.basename(co!.logo_url))).equals(seed.logoBytes)).toBe(true);
    expect(fs.readFileSync(path.join(uploadDir, 'logos', seed.logoName)).equals(seed.logoBytes)).toBe(true);
    const atts = await q<{ id: string; storage_key: string; file_path: string; file_size: number; local_cache_path: string | null }>(`SELECT id, storage_key, file_path, file_size, local_cache_path FROM attachments WHERE tenant_id = $1 ORDER BY file_name`, [imported.tenantId]);
    expect(atts).toHaveLength(3);
    for (const [i, a] of atts.entries()) {
      expect(a.storage_key).toBe(`${imported.tenantId}/attachments/${a.id}.bin`);
      expect(a.file_path).toBe(`/uploads/${a.storage_key}`);
      expect(a.local_cache_path).toBeNull();
      const bytes = fs.readFileSync(path.join(uploadDir, a.storage_key));
      expect(bytes.length).toBe(a.file_size);
      const src = fs.readFileSync(path.join(uploadDir, seed.tenantId, 'attachments', `${seed.attachmentIds[i]}.bin`));
      expect(bytes.equals(src)).toBe(true);
    }
    const [sig] = await q<{ id: string; file_path: string; sha256: string }>(`SELECT id, file_path, sha256 FROM check_signatures WHERE tenant_id = $1`, [imported.tenantId]);
    expect(sig!.file_path).toBe(path.join('signatures', imported.tenantId, `${sig!.id}.enc`));
    const plain = decryptBuffer(fs.readFileSync(path.join(uploadDir, sig!.file_path), 'utf8'));
    expect(plain.equals(seed.signatureBytes)).toBe(true);
    expect(crypto.createHash('sha256').update(plain).digest('hex')).toBe(sig!.sha256);
  });

  it('matches existing users by email, never modifies them, and maps the access rows (G, same DB)', async () => {
    const before = await q<{ j: string }>(`SELECT row_to_json(u)::text AS j FROM users u WHERE id = $1`, [seed.lanUserId]);
    const access = await q<{ user_id: string; role: string }>(`SELECT user_id, role FROM user_tenant_access WHERE tenant_id = $1 ORDER BY role, user_id`, [imported.tenantId]);
    expect(access).toEqual([
      { user_id: seed.lanUserId, role: 'bookkeeper' },
      { user_id: seed.ownerId, role: 'owner' },
      { user_id: seed.callerId, role: 'owner' },
    ].sort((a, b) => a.role.localeCompare(b.role) || a.user_id.localeCompare(b.user_id)));
    const after = await q<{ j: string }>(`SELECT row_to_json(u)::text AS j FROM users u WHERE id = $1`, [seed.lanUserId]);
    expect(after[0]!.j).toBe(before[0]!.j);
    const users = await q<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE tenant_id = $1`, [imported.tenantId]);
    expect(users[0]!.n).toBe(0);
    // The check-signature grant followed the LAN user through the identity map.
    const grant = await q<{ user_id: string }>(`SELECT user_id FROM check_signature_users WHERE tenant_id = $1`, [imported.tenantId]);
    expect(grant).toEqual([{ user_id: seed.lanUserId }]);
  });

  it('re-exporting the imported tenant gives the same canonical lines once ids are mapped back (full fidelity)', async () => {
    const again = await runExport(imported.tenantId, seed.callerId, { passphrase: PASS });
    const a = await ArchiveReader.open(exported.path!, PASS);
    const b = await ArchiveReader.open(again.path!, PASS);
    for (const t of a.manifest.tables) {
      const tb = b.manifest.tables.find((x) => x.name === t.name)!;
      const isAudit = t.name === 'audit_log';
      expect(tb.rows, t.name).toBe(t.rows + (isAudit ? 1 : 0));
      const canonical = a.manifest.canonical![t.name]!;
      const project = (line: string) => {
        const o = JSON.parse(line) as Record<string, unknown>;
        return JSON.stringify(Object.fromEntries(canonical.map((c) => [c, o[c]])));
      };
      const la: string[] = [];
      for await (const l of a.lines(tablePartName(t.name))) la.push(project(l));
      const lb: string[] = [];
      for await (const l of b.lines(tablePartName(t.name))) {
        if (isAudit && l.includes('"tenant_import"')) continue; // written by the import itself
        lb.push(project(idMap.inverse(l)));
      }
      expect(lb.sort(), t.name).toEqual(la.sort());
    }
    fs.rmSync(again.path!);
  }, 120_000);

  it('no row of the new tenant references a source id except matched identities and global rows (MT19 dangling oracle)', async () => {
    const sourceIds = new Set<string>();
    for (const t of plan.scoped) {
      const live = plan.live.tables.get(t)!;
      if (!live.pkColumns.includes('id')) continue;
      const where = scopeSql(plan, t, 'a').replace('$1', `'${seed.tenantId}'::uuid`);
      for (const r of await q<{ id: string }>(`SELECT a.id::text AS id FROM "${t}" a WHERE ${where}`)) sourceIds.add(r.id);
    }
    sourceIds.add(seed.tenantId);
    expect(sourceIds.size).toBeGreaterThan(40);
    const allowed = new Set<string>([seed.ownerId, seed.lanUserId, seed.callerId]);
    for (const [o, n] of idMap.entries()) if (o === n) allowed.add(o);
    const hits: string[] = [];
    for (const t of plan.tables) {
      const cols = t.columns.filter((c) => /^uuid(\[\])?$/.test(c.type)).map((c) => c.name);
      if (cols.length === 0) continue;
      const where = scopeSql(plan, t.name, 'a').replace('$1', `'${imported.tenantId}'::uuid`);
      const rows = await q<Record<string, string | string[] | null>>(`SELECT ${cols.map((c) => `a."${c}"::text AS "${c}"`).join(', ')} FROM "${t.name}" a WHERE ${where}`);
      for (const r of rows) {
        for (const c of cols) {
          const v = r[c];
          if (!v) continue;
          for (const id of String(v).replace(/[{}]/g, '').split(',')) {
            if (sourceIds.has(id) && !allowed.has(id)) hits.push(`${t.name}.${c}=${id}`);
          }
        }
      }
    }
    expect(hits).toEqual([]);
    // Identity rows too: the users projection of the new tenant's access rows.
    const access = await q<{ user_id: string }>(`SELECT user_id FROM user_tenant_access WHERE tenant_id = $1`, [imported.tenantId]);
    for (const a of access) expect(allowed.has(a.user_id)).toBe(true);
  }, 60_000);

  it('a second import of the same archive creates another independent tenant', async () => {
    const second = await runImport({ filePath: exported.path!, passphrase: PASS, name: `RT second ${stamp}`, callerUserId: seed.ownerId });
    createdTenants.push(second.tenantId);
    expect(second.name).toBe(`RT second ${stamp}`);
    expect(second.tenantId).not.toBe(imported.tenantId);
    expect(await countRows('journal_lines', second.tenantId)).toBe(9);
  }, 120_000);
});

describe('verification catches wrong-but-balanced data (C)', () => {
  async function expectVerifyFailure(table: string, edit: (ctx: { client: import('./session.js').ArchiveClient; newTenantId: string; idMap: IdMap }) => Promise<void>): Promise<void> {
    let newId = '';
    _importTestHooks.beforeVerify = async (ctx) => {
      newId = ctx.newTenantId;
      await edit(ctx);
    };
    const err = await expectCode(runImport({ filePath: exported.path!, passphrase: PASS, callerUserId: seed.ownerId }), 'ARCHIVE_VERIFY_FAILED');
    expect((err.details as { tables: string[] }).tables).toContain(table);
    expect(JSON.stringify(err.details)).not.toMatch(/999999999999999|CANARY/);
    expect(await q(`SELECT 1 FROM tenants WHERE id = $1`, [newId])).toEqual([]);
    expect(fs.existsSync(path.join(uploadDir, newId))).toBe(false);
    expect(fs.existsSync(path.join(uploadDir, 'signatures', newId))).toBe(false);
  }

  it('swapped journal lines between same-status transactions (MT6)', async () => {
    await expectVerifyFailure('journal_lines', async ({ client, newTenantId }) => {
      const lines = (await client.query(
        `SELECT jl.id, jl.transaction_id FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id
         WHERE jl.tenant_id = $1 AND t.status = 'posted' AND t.txn_type IN ('invoice', 'payment') ORDER BY jl.debit DESC LIMIT 2`, [newTenantId])).rows as Array<{ id: string; transaction_id: string }>;
      await client.query('UPDATE journal_lines SET transaction_id = $2 WHERE id = $1', [lines[0]!.id, lines[1]!.transaction_id]);
      await client.query('UPDATE journal_lines SET transaction_id = $2 WHERE id = $1', [lines[1]!.id, lines[0]!.transaction_id]);
    });
  }, 120_000);

  it('a changed contact_id, a flipped reconciliation flag, a budget period amount and a tax amount', async () => {
    await expectVerifyFailure('transactions', async ({ client, newTenantId }) => {
      await client.query(`UPDATE transactions SET contact_id = NULL WHERE tenant_id = $1 AND txn_type = 'invoice'`, [newTenantId]);
    });
    await expectVerifyFailure('reconciliation_lines', async ({ client, newTenantId }) => {
      await client.query(`UPDATE reconciliation_lines SET is_cleared = NOT is_cleared WHERE reconciliation_id IN (SELECT id FROM reconciliations WHERE tenant_id = $1)`, [newTenantId]);
    });
    await expectVerifyFailure('budget_periods', async ({ client, newTenantId }) => {
      await client.query(`UPDATE budget_periods SET amount = amount + 1 WHERE budget_id IN (SELECT id FROM budgets WHERE tenant_id = $1)`, [newTenantId]);
    });
    await expectVerifyFailure('journal_lines', async ({ client, newTenantId }) => {
      await client.query(`UPDATE journal_lines SET tax_amount = '1.2600' WHERE tenant_id = $1 AND debit = '0.0001'`, [newTenantId]);
    });
  }, 300_000);

  it('a journal line moved to the other company (MT11)', async () => {
    await expectVerifyFailure('journal_lines', async ({ client, newTenantId }) => {
      const cos = (await client.query('SELECT id FROM companies WHERE tenant_id = $1 ORDER BY business_name', [newTenantId])).rows as Array<{ id: string }>;
      await client.query(`UPDATE journal_lines SET company_id = $2 WHERE tenant_id = $1 AND company_id = $3 AND debit = '7.0000'`, [newTenantId, cos[1]!.id, cos[0]!.id]);
    });
  }, 120_000);
});

describe('integrity and compatibility (D)', () => {
  it('a wrong passphrase fails before any database access, a newer schema is refused, and an excluded table part is refused (MT15)', async () => {
    const before = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM tenants`))[0]!.n;
    await expectCode(runImport({ filePath: exported.path!, passphrase: 'wrong passphrase 12345', callerUserId: seed.ownerId }), 'ARCHIVE_PASSPHRASE_INVALID');
    const newer = path.join(archiveRoot, 'newer.zip');
    await rewriteArchive(exported.path!, newer, (m) => { m.schema.version += 1; });
    await expectCode(runImport({ filePath: newer, passphrase: PASS, callerUserId: seed.ownerId }), 'ARCHIVE_TOO_NEW');
    const stamps = path.join(archiveRoot, 'stamps.zip');
    const body = Buffer.from('{"tenant_id":"x"}\n');
    await rewriteArchive(exported.path!, stamps, (m) => {
      m.tables.push({ name: 'gl_version_stamps', bucket: 'tenant', pk: 'no-pk', rows: 1, sha256: crypto.createHash('sha256').update(body).digest('hex'), contentDigest: '0'.repeat(64), columns: [['tenant_id', 'uuid']], bytes: body.length });
    }, [{ part: tablePartName('gl_version_stamps'), bytes: body }]);
    await expectCode(runImport({ filePath: stamps, passphrase: PASS, callerUserId: seed.ownerId }), 'ARCHIVE_TABLE_UNKNOWN');
    // An unknown column fails closed; a NOT NULL column missing from the archive fails closed.
    const unknownCol = path.join(archiveRoot, 'unknown-col.zip');
    await rewriteArchive(exported.path!, unknownCol, (m) => { m.tables.find((t) => t.name === 'contacts')!.columns.push(['zz_gone', 'text']); });
    await expectCode(runImport({ filePath: unknownCol, passphrase: PASS, callerUserId: seed.ownerId }), 'ARCHIVE_COLUMN_UNKNOWN');
    const retyped = path.join(archiveRoot, 'retyped.zip');
    await rewriteArchive(exported.path!, retyped, (m) => {
      const t = m.tables.find((t) => t.name === 'journal_lines')!;
      t.columns = t.columns.map(([c, ty]) => (c === 'debit' ? [c, 'numeric(22,6)'] : [c, ty]));
    });
    await expectCode(runImport({ filePath: retyped, passphrase: PASS, callerUserId: seed.ownerId }), 'ARCHIVE_COLUMN_TYPE_CHANGED');
    // A tampered part is refused before the database is touched.
    const tampered = path.join(archiveRoot, 'tampered.zip');
    const d = await unzipper.Open.file(exported.path!);
    const out = archiver('zip', { store: true });
    const stream = fs.createWriteStream(tampered);
    const done = new Promise<void>((r) => stream.on('close', r));
    out.pipe(stream);
    for (const f of d.files) {
      const b = Buffer.from(await f.buffer());
      if (f.path === zipEntryName(tablePartName('journal_lines'))) b[b.length - 30] = b[b.length - 30]! ^ 0x55;
      out.append(b, { name: f.path });
    }
    await out.finalize();
    await done;
    await expectCode(runImport({ filePath: tampered, passphrase: PASS, callerUserId: seed.ownerId }), 'ARCHIVE_CORRUPT');
    // H2: a manifest may not redefine a table's pk shape or bucket (that would skip the file rewrite or the scope).
    const reshaped = path.join(archiveRoot, 'reshaped.zip');
    await rewriteArchive(exported.path!, reshaped, (m) => { m.tables.find((t) => t.name === 'attachments')!.pk = 'no-pk'; });
    const errShape = await expectCode(runImport({ filePath: reshaped, passphrase: PASS, callerUserId: seed.ownerId }), 'ARCHIVE_CORRUPT');
    expect(errShape.message).toContain('pk shape');
    const rebucketed = path.join(archiveRoot, 'rebucketed.zip');
    await rewriteArchive(exported.path!, rebucketed, (m) => { m.tables.find((t) => t.name === 'deposit_lines')!.bucket = 'tenant'; });
    expect((await expectCode(runImport({ filePath: rebucketed, passphrase: PASS, callerUserId: seed.ownerId }), 'ARCHIVE_CORRUPT')).message).toContain('bucket');
    // H2: a file column value whose file is not in the archive, with nothing in the manifest explaining it, is a damaged archive.
    const noSig = path.join(archiveRoot, 'no-signature-file.zip');
    const sigEntry = `files/check_signatures/file_path/${seed.signatureId}`;
    await rewriteArchive(exported.path!, noSig, (m) => { m.files = m.files.filter((f) => !(f.table === 'check_signatures' && f.rowId === seed.signatureId)); }, [], [zipEntryName(sigEntry)]);
    const errFile = await expectCode(runImport({ filePath: noSig, passphrase: PASS, callerUserId: seed.ownerId }), 'ARCHIVE_CORRUPT');
    expect(errFile.message).toContain('check_signatures.file_path');
    expect(errFile.message).not.toContain(seed.tenantId);
    const after = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM tenants`))[0]!.n;
    expect(after).toBe(before);
    expect(await sweepImportPending()).toBe(0);
  }, 300_000);

  it('an empty tenant round-trips with zero rows everywhere', async () => {
    const emptyId = crypto.randomUUID();
    await q(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'Empty', $2)`, [emptyId, `empty-${stamp}-${emptyId.slice(0, 4)}`]);
    createdTenants.push(emptyId);
    const e = await runExport(emptyId, seed.ownerId, { passphrase: PASS });
    const reader = await ArchiveReader.open(e.path!, PASS);
    expect(reader.manifest.tables.every((t) => t.rows === 0)).toBe(true);
    expect(reader.manifest.trialBalance).toEqual({ definition: expect.any(String), rows: [], totals: { debit: '0', credit: '0' } });
    const r = await runImport({ filePath: e.path!, passphrase: PASS, callerUserId: seed.ownerId });
    createdTenants.push(r.tenantId);
    expect(r.verification.rows).toBe(0);
    expect(r.verification.identity).toEqual({ matched: 0, created: 0 });
    const access = await q(`SELECT user_id FROM user_tenant_access WHERE tenant_id = $1`, [r.tenantId]);
    expect(access).toEqual([{ user_id: seed.ownerId }]);
  }, 120_000);
});

describe('identity on a different install (G)', () => {
  it('creates an unmatched user with the archived id, or a fresh id on collision, never as super admin', async () => {
    // Rewrite the archived LAN user to an email nobody has, keeping its id: created with the archived id.
    const freshId = crypto.randomUUID();
    const d = await unzipper.Open.file(exported.path!);
    const envelope = validateEnvelope(JSON.parse((await d.files.find((f) => f.path === ENVELOPE_ENTRY)!.buffer()).toString('utf8')));
    const key = openEnvelope(envelope, PASS);
    const reader = await ArchiveReader.open(exported.path!, PASS);
    const userLines: string[] = [];
    for await (const l of reader.lines('data/_users.ndjson')) userLines.push(l);
    const accessLines: string[] = [];
    for await (const l of reader.lines('data/_user_tenant_access.ndjson')) accessLines.push(l);
    /** Rewrites the users part (mapLine) and renames user ids in the access part (idRename: old -> new). */
    const rewriteUsers = async (dst: string, mapLine: (u: Record<string, unknown>) => Record<string, unknown>, idRename: Record<string, string>) => {
      const users = userLines.map((l) => JSON.stringify(mapLine(JSON.parse(l) as Record<string, unknown>)));
      const access = accessLines.map((l) => l.replace(/[0-9a-f-]{36}/g, (m) => idRename[m] ?? m));
      const parts = {
        'data/_users.ndjson': Buffer.from(users.map((l) => `${l}\n`).join(''), 'utf8'),
        'data/_user_tenant_access.ndjson': Buffer.from(access.map((l) => `${l}\n`).join(''), 'utf8'),
      };
      await rewriteArchive(exported.path!, dst, (m) => {
        for (const [name, body] of Object.entries(parts)) {
          m.identity.parts[name] = { sha256: crypto.createHash('sha256').update(body).digest('hex'), bytes: body.length, rows: body.length === 0 ? 0 : body.toString().trim().split('\n').length };
        }
      }, []);
      const d2 = await unzipper.Open.file(dst);
      const out = archiver('zip', { store: true });
      const tmp = `${dst}.tmp`;
      const stream = fs.createWriteStream(tmp);
      const done = new Promise<void>((r) => stream.on('close', r));
      out.pipe(stream);
      const registry = new NoncePrefixRegistry();
      for (const f of d2.files) {
        if (Object.keys(parts).some((p) => f.path === zipEntryName(p))) continue;
        out.append(await f.buffer(), { name: f.path });
      }
      for (const [name, body] of Object.entries(parts)) out.append(encryptEntryBuffer(key, envelope.archiveId, name, body, registry), { name: zipEntryName(name) });
      await out.finalize();
      await done;
      fs.renameSync(tmp, dst);
    };
    const email = `rt-fresh-${stamp}@example.test`;
    const archiveA = path.join(archiveRoot, 'fresh-user.zip');
    await rewriteUsers(archiveA, (u) => (u['id'] === seed.lanUserId ? { ...u, id: freshId, email, is_active: true } : u), { [seed.lanUserId]: freshId });
    const rA = await runImport({ filePath: archiveA, passphrase: PASS, callerUserId: seed.callerId });
    createdTenants.push(rA.tenantId);
    expect(rA.verification.identity).toEqual({ matched: 1, created: 1 }); // the owner matched; the caller had no access row in the archive
    const created = await q<{ id: string; tenant_id: string; is_super_admin: boolean; tfa_enabled: boolean; is_active: boolean; preferred_login_method: string }>(
      `SELECT id, tenant_id, is_super_admin, tfa_enabled, is_active, preferred_login_method FROM users WHERE email = $1`, [email]);
    createdUsers.push(freshId);
    expect(created).toEqual([{ id: freshId, tenant_id: rA.tenantId, is_super_admin: false, tfa_enabled: false, is_active: true, preferred_login_method: 'password' }]);
    const prov = await q<{ created_user_ids: string[] }>(`SELECT created_user_ids FROM tenant_archive_imports WHERE tenant_id = $1`, [rA.tenantId]);
    expect(prov[0]!.created_user_ids).toEqual([freshId]);
    // Id collision: the archived id belongs to a different email -> a new id, access rows mapped to it.
    const email2 = `rt-collide-${stamp}@example.test`;
    const takenId = await insertUser(seed.tenantId, `rt-taken-${stamp}@example.test`, { display_name: 'Taken' });
    const archiveB = path.join(archiveRoot, 'collide-user.zip');
    await rewriteUsers(archiveB, (u) => (u['id'] === seed.lanUserId ? { ...u, id: takenId, email: email2 } : u), { [seed.lanUserId]: takenId });
    const rB = await runImport({ filePath: archiveB, passphrase: PASS, callerUserId: seed.callerId });
    createdTenants.push(rB.tenantId);
    const collided = await q<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email2]);
    expect(collided).toHaveLength(1);
    expect(collided[0]!.id).not.toBe(takenId);
    createdUsers.push(collided[0]!.id);
    const access = await q<{ user_id: string; role: string }>(`SELECT user_id, role FROM user_tenant_access WHERE tenant_id = $1 AND role = 'bookkeeper'`, [rB.tenantId]);
    expect(access).toEqual([{ user_id: collided[0]!.id, role: 'bookkeeper' }]);

    // H1: a caller who is not a super admin never creates users; the unmatched
    // user and its access row are skipped, matched users keep their rows.
    const email3 = `rt-skipped-${stamp}@example.test`;
    const skippedId = crypto.randomUUID();
    const archiveC = path.join(archiveRoot, 'skipped-user.zip');
    await rewriteUsers(archiveC, (u) => (u['id'] === seed.lanUserId ? { ...u, id: skippedId, email: email3 } : u), { [seed.lanUserId]: skippedId });
    const rC = await runImport({ filePath: archiveC, passphrase: PASS, callerUserId: seed.ownerId });
    createdTenants.push(rC.tenantId);
    expect(rC.verification.identity).toEqual({ matched: 1, created: 0 });
    expect(rC.warnings).toContain('USERS_NOT_CREATED:1');
    expect(await q(`SELECT 1 FROM users WHERE email = $1 OR id = $2`, [email3, skippedId])).toHaveLength(0);
    const accessC = await q<{ user_id: string; role: string }>(`SELECT user_id, role FROM user_tenant_access WHERE tenant_id = $1 ORDER BY role`, [rC.tenantId]);
    expect(accessC).toEqual([{ user_id: seed.ownerId, role: 'owner' }]);

    // H1: an archived role or user_type outside the closed lists is refused before any insert.
    for (const [patch, what] of [[{ role: 'superuser' }, 'role'], [{ user_type: 'robot' }, 'user_type']] as const) {
      const bad = path.join(archiveRoot, `bad-${what}.zip`);
      await rewriteUsers(bad, (u) => (u['id'] === seed.lanUserId ? { ...u, ...patch } : u), {});
      const err = await expectCode(runImport({ filePath: bad, passphrase: PASS, callerUserId: seed.callerId }), 'ARCHIVE_CORRUPT');
      expect(err.message).toContain(what);
    }
    // An access row whose role is outside the closed list is refused too.
    const accessPatched = accessLines.map((l) => l.replace('"role":"bookkeeper"', '"role":"superuser"'));
    expect(accessPatched.join('\n')).toContain('superuser');
    const partsD = { 'data/_user_tenant_access.ndjson': Buffer.from(accessPatched.map((l) => `${l}\n`).join(''), 'utf8') };
    const archiveD = path.join(archiveRoot, 'bad-access-role-2.zip');
    await rewriteArchive(exported.path!, archiveD, (m) => {
      for (const [name, body] of Object.entries(partsD)) {
        m.identity.parts[name] = { sha256: crypto.createHash('sha256').update(body).digest('hex'), bytes: body.length, rows: accessPatched.length };
      }
    }, []);
    {
      const d2 = await unzipper.Open.file(archiveD);
      const out = archiver('zip', { store: true });
      const tmp = `${archiveD}.tmp`;
      const stream = fs.createWriteStream(tmp);
      const done = new Promise<void>((r) => stream.on('close', r));
      out.pipe(stream);
      const registry = new NoncePrefixRegistry();
      for (const f of d2.files) {
        if (f.path === zipEntryName('data/_user_tenant_access.ndjson')) continue;
        out.append(await f.buffer(), { name: f.path });
      }
      out.append(encryptEntryBuffer(key, envelope.archiveId, 'data/_user_tenant_access.ndjson', partsD['data/_user_tenant_access.ndjson'], registry), { name: zipEntryName('data/_user_tenant_access.ndjson') });
      await out.finalize();
      await done;
      fs.renameSync(tmp, archiveD);
    }
    const errD = await expectCode(runImport({ filePath: archiveD, passphrase: PASS, callerUserId: seed.callerId }), 'ARCHIVE_CORRUPT');
    expect(errD.message).toContain('access rows: role');
  }, 300_000);
});
