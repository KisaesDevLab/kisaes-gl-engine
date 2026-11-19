// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Transfer files (U-284, ClientLedger P32): names-only people
// (transfer_user_names) on every import, the transfer omissions and scrubs,
// wrong-file refusals, all missing files in one run, 409 TENANT_BUSY, and
// the fail-closed plan rule for user references and omitted tables.
// T1 round trip and re-export (the source users exist here, so every
// archived id collides with a real user: the collision remap), T5 secrets,
// T6 signatures, T7 missing files, T8 a backup refused by transferOnly.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import archiver from 'archiver';
import * as unzipper from 'unzipper';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { encrypt } from '../../utils/encryption.js';
import { userDisplayNameSql } from '../../utils/user-display-name.js';
import { loadDesktopProfile, _resetDesktopProfileForTests } from '../../desktop/profile.js';
import { ArchiveReader } from './archive-reader.js';
import { encryptEntryBuffer, NoncePrefixRegistry, openEnvelope, validateEnvelope } from './archive-crypto.js';
import { ArchiveError } from './errors.js';
import { runExport, type ExportResult } from './export.service.js';
import { NOT_A_TRANSFER_FILE_MESSAGE, runImport } from './import.service.js';
import { ENVELOPE_ENTRY, IDENTITY_ENTRIES, MANIFEST_ENTRY, tablePartName, type ArchiveManifest } from './format.js';
import { _resetJobsForTests, assertArchiveJobAllowed, startJob, waitForJob } from './jobs.js';
import { OMITTABLE_COLUMNS, OMITTABLE_TABLES, buildPortabilityPlan, scopeSql, type PortabilityPlan } from './plan.js';

const PASS = 'transfer file passphrase 2026!';
const stamp = crypto.randomUUID().slice(0, 8);
const OWNER_EMAIL = `olive-${stamp}@owner.example.test`;
const BOOK_EMAIL = `bob-${stamp}@books.example.test`;
const SMTP_USER = `smtp-login-${stamp}@mail.example.test`;
const SMTP_HOST = `smtp-canary-${stamp}.example.test`;
const ROUTING = '011000015';
const ACCOUNT_NO = `9988${stamp.replace(/[^0-9]/g, '7').slice(0, 6)}`;
const HASH = `$2b$12$CANARYHASH${stamp}abcdefghijklmnopqrstuvwxyz0123`;
let plan: PortabilityPlan;
let work = '';
const tenants: string[] = [];
const users: string[] = [];
let s: { tenantId: string; ownerId: string; bookId: string; firmId: string; firm2Id: string; companyId: string; signatureId: string; checkId: string };
let transfer: ExportResult;

async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.execute(sql.raw(text.replace(/\$(\d+)/g, (_m, n) => {
    const v = params[Number(n) - 1];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  })));
  return r.rows as T[];
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

async function user(tenantId: string, email: string, name: string, superAdmin = false): Promise<string> {
  const id = crypto.randomUUID();
  await q(`INSERT INTO users (id, tenant_id, email, password_hash, display_name, role, is_super_admin, is_active) VALUES ($1, $2, $3, $4, $5, 'owner', $6, true)`,
    [id, tenantId, email, HASH, name, superAdmin]);
  users.push(id);
  return id;
}

async function seed(): Promise<typeof s> {
  const tenantId = crypto.randomUUID();
  await q(`INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)`, [tenantId, `XFER ${stamp}`, `xfer-${stamp}`]);
  tenants.push(tenantId);
  const ownerId = await user(tenantId, OWNER_EMAIL, 'Olive Owner');
  const bookId = await user(tenantId, BOOK_EMAIL, 'Bob Books');
  await q(`INSERT INTO user_tenant_access (user_id, tenant_id, role) VALUES ($1, $3, 'owner'), ($2, $3, 'bookkeeper')`, [ownerId, bookId, tenantId]);
  // Firm staff of the accountant's MyBooks Online (not super admins), homed in their own tenants.
  const home = crypto.randomUUID();
  await q(`INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)`, [home, `XFER firm ${stamp}`, `xfer-firm-${stamp}`]);
  tenants.push(home);
  const firmId = await user(home, `firm-${stamp}@cpa.example.test`, 'Firm Staff');
  const firm2Id = await user(home, `firm2-${stamp}@cpa.example.test`, 'Firm Staff Two');
  const companyId = (await q<{ id: string }>(`INSERT INTO companies (tenant_id, business_name, entity_type, setup_complete, smtp_host, smtp_user, ai_disclosure_accepted_by, check_settings)
    VALUES ($1, 'XFER Co', 'llc', true, $2, $3, $4, $5::jsonb) RETURNING id`,
  [tenantId, SMTP_HOST, SMTP_USER, ownerId, JSON.stringify({ format: 'voucher', bankName: 'First Bank', routingNumber: ROUTING, accountNumber: ACCOUNT_NO, fractionalRouting: '1-2/110' })]))[0]!.id;
  await q(`INSERT INTO portal_settings_per_company (company_id, bill_pay_notify_user_id) VALUES ($1, $2)`, [companyId, bookId]);
  const acct = async (name: string, type: string, sensitive = false) =>
    (await q<{ id: string }>(`INSERT INTO accounts (tenant_id, company_id, name, account_type, is_sensitive) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [tenantId, companyId, name, type, sensitive]))[0]!.id;
  const cash = await acct('Checking', 'asset');
  const hidden = await acct('Owner draws (hidden)', 'equity', true);
  // A signature, its grant, and a check printed with it (T6).
  const signatureId = crypto.randomUUID();
  await q(`INSERT INTO check_signatures (id, tenant_id, label, file_path, mime_type, width, height, sha256, created_by) VALUES ($1, $2, 'Sig', $3, 'image/png', 10, 10, $4, $5)`,
    [signatureId, tenantId, path.join('signatures', tenantId, `${signatureId}.enc`), 'a'.repeat(64), ownerId]);
  await q(`INSERT INTO check_signature_users (signature_id, tenant_id, user_id, granted_by) VALUES ($1, $2, $3, $4)`, [signatureId, tenantId, bookId, ownerId]);
  const checkId = (await q<{ id: string }>(`INSERT INTO transactions (tenant_id, company_id, txn_type, txn_date, status, total, print_signature_id) VALUES ($1, $2, 'check', '2026-02-01', 'posted', 25, $3) RETURNING id`,
    [tenantId, companyId, signatureId]))[0]!.id;
  await q(`INSERT INTO journal_lines (tenant_id, transaction_id, company_id, account_id, debit, credit) VALUES ($1, $2, $3, $4, '25.0000', '0'), ($1, $2, $3, $5, '0', '25.0000')`,
    [tenantId, checkId, companyId, hidden, cash]);
  // Rows by both people (identity soft references).
  await q(`INSERT INTO budgets (tenant_id, company_id, name, fiscal_year, created_by) VALUES ($1, $2, 'B', 2026, $3)`, [tenantId, companyId, bookId]);
  // Left out of a transfer: the bank-file link key, AI chat, (MCP logs have no row here).
  await q(`INSERT INTO bank_link_keys (tenant_id, company_id, key_encrypted) VALUES ($1, $2, $3)`, [tenantId, companyId, encrypt('ab'.repeat(32))]);
  const conv = (await q<{ id: string }>(`INSERT INTO chat_conversations (tenant_id, user_id) VALUES ($1, $2) RETURNING id`, [tenantId, ownerId]))[0]!.id;
  await q(`INSERT INTO chat_messages (conversation_id, tenant_id, role, content) VALUES ($1, $2, 'user', 'CHAT-CANARY-${stamp}')`, [conv, tenantId]);
  // T5: every user audit action, plus an image that mentions an email in text.
  for (const [action, after] of [
    ['create', { email: BOOK_EMAIL, role: 'bookkeeper' }], ['update', { email: BOOK_EMAIL, displayName: 'Bob Books' }],
    ['update', { action: 'password_reset_email_sent' }], ['login', null], ['update', { tfaEnabled: true }], ['update', { tfaEnabled: false }],
    ['update', { isActive: false }], ['update', { role: 'readonly' }],
  ] as Array<[string, unknown]>) {
    await q(`INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, after_data) VALUES ($1, $2, $3, 'user', $4, $5::jsonb)`,
      [tenantId, ownerId, action, bookId, after === null ? null : JSON.stringify(after)]);
  }
  await q(`INSERT INTO audit_log (tenant_id, company_id, user_id, action, entity_type, entity_id, after_data) VALUES ($1, $2, $3, 'update', 'account', $4, to_jsonb($5::text))`,
    [tenantId, companyId, bookId, cash, JSON.stringify({ note: `Changed by ${OWNER_EMAIL.toUpperCase()} on request`, smtp_user: SMTP_USER })]);
  return { tenantId, ownerId, bookId, firmId, firm2Id, companyId, signatureId, checkId };
}

/** Every plaintext part of an archive, with the manifest, as one string. */
async function plaintext(file: string): Promise<string> {
  const reader = await ArchiveReader.open(file, PASS);
  const out: string[] = [JSON.stringify(reader.manifest)];
  for (const [name, p] of Object.entries(reader.manifest.identity.parts)) out.push((await reader.readPart(name, p.bytes)).toString('utf8'));
  for (const t of reader.manifest.tables) out.push((await reader.readPart(tablePartName(t.name), t.bytes)).toString('utf8'));
  return out.join('\n');
}

async function rewriteManifest(src: string, dst: string, mutate: (m: ArchiveManifest) => void): Promise<void> {
  const d = await unzipper.Open.file(src);
  const envelope = validateEnvelope(JSON.parse((await d.files.find((f) => f.path === ENVELOPE_ENTRY)!.buffer()).toString('utf8')));
  const key = openEnvelope(envelope, PASS);
  const manifest = JSON.parse(JSON.stringify((await ArchiveReader.open(src, PASS)).manifest)) as ArchiveManifest;
  mutate(manifest);
  const out = archiver('zip', { store: true });
  const stream = fs.createWriteStream(dst);
  const done = new Promise<void>((resolve, reject) => {
    stream.on('close', resolve);
    out.on('error', reject);
  });
  out.pipe(stream);
  for (const f of d.files) if (f.path !== MANIFEST_ENTRY) out.append(await f.buffer(), { name: f.path });
  out.append(encryptEntryBuffer(key, envelope.archiveId, MANIFEST_ENTRY.slice(0, -'.enc'.length), Buffer.from(JSON.stringify(manifest), 'utf8'), new NoncePrefixRegistry()), { name: MANIFEST_ENTRY });
  await out.finalize();
  await done;
}

beforeAll(async () => {
  plan = await buildPortabilityPlan(db);
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-xfer-'));
  process.env['CL_ARCHIVE_DIR'] = path.join(work, 'archives');
  s = await seed();
  transfer = await runExport(s.tenantId, s.ownerId, { passphrase: PASS, transfer: true, asOf: '2026-06-30', host: { app: 'ClientLedger', kind: 'transfer' } });
}, 180_000);

afterAll(async () => {
  _resetDesktopProfileForTests();
  _resetJobsForTests();
  for (const id of tenants) {
    for (const t of [...plan.scoped].reverse()) {
      await q(`DELETE FROM "${t}" a WHERE ${scopeSql(plan, t, 'a').replace('$1', `'${id}'::uuid`)}`).catch(() => undefined);
    }
    await q(`DELETE FROM transfer_user_names WHERE tenant_id = $1`, [id]).catch(() => undefined);
    await q(`DELETE FROM tenant_archive_imports WHERE tenant_id = $1`, [id]).catch(() => undefined);
    await q(`DELETE FROM user_tenant_access WHERE tenant_id = $1`, [id]).catch(() => undefined);
    await q(`DELETE FROM users WHERE tenant_id = $1 AND id <> ALL($2::uuid[])`, [id, `{${users.join(',')}}`]).catch(() => undefined);
  }
  for (const u of users) await q(`DELETE FROM users WHERE id = $1`, [u]).catch(() => undefined);
  for (const id of tenants) await q(`DELETE FROM tenants WHERE id = $1`, [id]).catch(() => undefined);
  fs.rmSync(work, { recursive: true, force: true });
  delete process.env['CL_ARCHIVE_DIR'];
});

describe('the plan has a transfer rule for every user reference and omitted table (fail closed)', () => {
  it('real FKs into users, and FKs or soft references into transfer-omitted tables, are nulled or their table is omitted', () => {
    const omittedTables = new Set(Object.entries(OMITTABLE_TABLES).filter(([, r]) => r.option === 'transfer').map(([k]) => k));
    const nulled = new Set(Object.entries(OMITTABLE_COLUMNS).filter(([, r]) => r.option === 'transfer' && r.replacement === 'NULL').map(([k]) => k));
    const missing: string[] = [];
    for (const fk of plan.live.fks) {
      if (!plan.byName.has(fk.table) || omittedTables.has(fk.table)) continue;
      const k = `${fk.table}.${fk.columns.join(',')}`;
      if ((fk.refTable === 'users' || omittedTables.has(fk.refTable)) && !nulled.has(k)) missing.push(k);
    }
    for (const t of plan.tables) {
      if (omittedTables.has(t.name)) continue;
      for (const sr of t.softRefs) {
        const target = sr.cls.includes(':') ? sr.cls.slice(sr.cls.indexOf(':') + 1) : '';
        if (omittedTables.has(target) && !nulled.has(`${t.name}.${sr.column}`)) missing.push(`${t.name}.${sr.column}`);
      }
    }
    expect(missing).toEqual([]);
    for (const t of omittedTables) expect(plan.byName.has(t), t).toBe(true);
  });
});

describe('transfer export (U-284)', () => {
  it('echoes the transfer option, carries no users, and lists what it leaves out', async () => {
    expect(transfer.manifestSummary.options).toMatchObject({ transfer: true, omitIntakeSettings: true, omitDocumentDrafts: true });
    const reader = await ArchiveReader.open(transfer.path, PASS);
    const m = reader.manifest;
    expect(m.options.transfer).toBe(true);
    expect(m.identity.parts[IDENTITY_ENTRIES.users]!.rows).toBe(0);
    expect(m.identity.parts[IDENTITY_ENTRIES.access]!.rows).toBe(0);
    for (const t of ['check_signatures', 'check_signature_users', 'bank_link_keys', 'chat_conversations', 'chat_messages', 'mcp_request_log',
      'companies.smtp_host', 'companies.smtp_user', 'transactions.print_signature_id']) expect(m.omitted).toContain(t);
    const names = (await reader.readPart(tablePartName('transfer_user_names'), m.tables.find((t) => t.name === 'transfer_user_names')!.bytes)).toString('utf8');
    expect(names).toContain('"display_name":"Olive Owner"');
    expect(names).toContain('"display_name":"Bob Books"');
    expect(m.tables.find((t) => t.name === 'check_signatures')!.rows).toBe(0);
  });

  it('holds no secret, login or email (T5)', async () => {
    const text = await plaintext(transfer.path);
    for (const canary of [OWNER_EMAIL, BOOK_EMAIL, SMTP_USER, SMTP_HOST, ROUTING, ACCOUNT_NO, HASH, `CHAT-CANARY-${stamp}`, 'ab'.repeat(32)]) {
      expect(text.toLowerCase().includes(canary.toLowerCase()), canary).toBe(false);
    }
    expect(text).not.toMatch(/\\?"password_hash\\?"/);
    expect(text).toContain('Changed by Olive Owner on request');
    // An ordinary backup carries them (the scan finds what it looks for).
    const backup = await runExport(s.tenantId, s.ownerId, { passphrase: PASS });
    const b = await plaintext(backup.path);
    expect(b).toContain(BOOK_EMAIL);
    expect(b).toContain(ROUTING);
  }, 120_000);
});

describe('transfer import (U-284)', () => {
  let imported = '';

  it('a firm user (not a super admin) imports it with transferOnly: names only, collisions remapped, totals match (T1, T6)', async () => {
    const r = await runImport({ filePath: transfer.path, passphrase: PASS, callerUserId: s.firmId, transferOnly: true });
    tenants.push(r.tenantId);
    imported = r.tenantId;
    expect(r.transfer).toBe(true);
    expect(r.verificationTotals.matches).toBe(true);
    expect(r.verification.identity).toEqual({ matched: 0, created: 0 });
    expect(r.warnings.some((w) => w.startsWith('USERS_NOT_CREATED'))).toBe(false);
    const access = await q<{ user_id: string; role: string }>(`SELECT user_id, role FROM user_tenant_access WHERE tenant_id = $1`, [r.tenantId]);
    expect(access).toEqual([{ user_id: s.firmId, role: 'owner' }]);
    // The archived ids belong to real users here: every one was given a fresh id.
    const leaked = await q<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND user_id IN ($2, $3)`, [r.tenantId, s.ownerId, s.bookId]);
    expect(leaked[0]!.n).toBe(0);
    const names = await q<{ name: string; real: boolean }>(`SELECT display_name AS name, EXISTS (SELECT 1 FROM users u WHERE u.id = n.user_id) AS real
      FROM transfer_user_names n WHERE n.tenant_id = $1 ORDER BY 1`, [r.tenantId]);
    expect(names).toEqual([{ name: 'Bob Books', real: false }, { name: 'Olive Owner', real: false }]);
    const audit = await q<{ who: string }>(`SELECT DISTINCT ${userDisplayNameSql('a.user_id', 'a.tenant_id')} AS who FROM audit_log a
      WHERE a.tenant_id = $1 AND a.entity_type IN ('user', 'account') ORDER BY 1`, [r.tenantId]);
    expect(audit.map((x) => x.who)).toEqual(['Bob Books (ClientLedger)', 'Olive Owner (ClientLedger)']);
    // T6: no signature, the check's reference nulled; hidden accounts travel.
    expect((await q(`SELECT 1 FROM check_signatures WHERE tenant_id = $1`, [r.tenantId])).length).toBe(0);
    expect((await q<{ p: string | null }>(`SELECT print_signature_id AS p FROM transactions WHERE tenant_id = $1 AND txn_type = 'check'`, [r.tenantId]))[0]!.p).toBeNull();
    expect((await q(`SELECT 1 FROM accounts WHERE tenant_id = $1 AND is_sensitive`, [r.tenantId])).length).toBe(1);
    expect((await q<{ s: string | null }>(`SELECT smtp_user AS s FROM companies WHERE tenant_id = $1`, [r.tenantId]))[0]!.s).toBeNull();
  }, 180_000);

  it('its normal export imports elsewhere for another non-super-admin and restores on a desktop; the names stay (T1)', async () => {
    expect(imported).not.toBe('');
    const again = await runExport(imported, s.firmId, { passphrase: PASS });
    const r2 = await runImport({ filePath: again.path, passphrase: PASS, callerUserId: s.firm2Id });
    tenants.push(r2.tenantId);
    expect(r2.verificationTotals.matches).toBe(true);
    const n2 = await q<{ name: string }>(`SELECT display_name AS name FROM transfer_user_names WHERE tenant_id = $1 ORDER BY 1`, [r2.tenantId]);
    expect(n2.map((x) => x.name)).toEqual(['Bob Books', 'Olive Owner']);
    const admin = await user(tenants[1]!, `xfer-admin-${stamp}@example.test`, 'Desktop Owner', true);
    loadDesktopProfile({ CL_MODE: 'desktop', CL_TOKEN: 'transfer-test-' + 't'.repeat(40), CL_BIND: '127.0.0.1:0', CL_DATA_DIR: work });
    try {
      const r3 = await runImport({ filePath: again.path, passphrase: PASS, callerUserId: admin });
      tenants.push(r3.tenantId);
      expect(r3.verificationTotals.matches).toBe(true);
      const who = await q<{ who: string }>(`SELECT DISTINCT ${userDisplayNameSql('a.user_id', 'a.tenant_id')} AS who FROM audit_log a WHERE a.tenant_id = $1 AND a.entity_type = 'user'`, [r3.tenantId]);
      expect(who.map((x) => x.who)).toEqual(['Olive Owner (ClientLedger)']);
      // A transfer file is refused by a desktop restore (Q-P32n).
      await expectCode(runImport({ filePath: transfer.path, passphrase: PASS, callerUserId: admin }), 'TRANSFER_NOT_A_BACKUP');
    } finally {
      _resetDesktopProfileForTests();
    }
  }, 240_000);

  it('refuses a backup with transferOnly (T8) and a "transfer" that carries users (ARCHIVE_CORRUPT)', async () => {
    const backup = await runExport(s.tenantId, s.ownerId, { passphrase: PASS });
    const err = await expectCode(runImport({ filePath: backup.path, passphrase: PASS, callerUserId: s.firmId, transferOnly: true }), 'NOT_A_TRANSFER_FILE');
    expect(err.statusCode).toBe(422);
    expect(err.message).toBe(NOT_A_TRANSFER_FILE_MESSAGE);
    const crafted = path.join(work, 'crafted.zip');
    await rewriteManifest(backup.path, crafted, (m) => { m.options.transfer = true; });
    await expectCode(runImport({ filePath: crafted, passphrase: PASS, callerUserId: s.firmId }), 'ARCHIVE_CORRUPT');
  }, 120_000);
});

describe('missing files are all refused in one run (T7, Q-P32k)', () => {
  it('three missing attachment files: one FILE_MISSING listing all three; a server backup only warns', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = crypto.randomUUID();
      const key = `${s.tenantId}/attachments/${id}.bin`;
      await q(`INSERT INTO attachments (id, tenant_id, company_id, file_name, file_path, storage_key, file_size, attachable_type, attachable_id)
               VALUES ($1, $2, $3, 'gone.bin', $4, $5, 10, 'transaction', $6)`, [id, s.tenantId, s.companyId, `/uploads/${key}`, key, s.checkId]);
      ids.push(id);
    }
    try {
      const err = await expectCode(runExport(s.tenantId, s.ownerId, { passphrase: PASS, transfer: true }), 'FILE_MISSING');
      const files = (err.details as { files: Array<{ table: string; rowId: string; reason: string }> }).files;
      expect(files.map((f) => f.rowId).sort()).toEqual([...ids].sort());
      expect(files.every((f) => f.table === 'attachments' && f.reason === 'FILE_MISSING')).toBe(true);
      const backup = await runExport(s.tenantId, s.ownerId, { passphrase: PASS });
      expect(backup.warnings.filter((w) => w.startsWith('FILE_MISSING:attachments.'))).toHaveLength(3);
    } finally {
      await q(`DELETE FROM attachments WHERE id IN ($1, $2, $3)`, ids);
    }
  }, 120_000);
});

describe('409 TENANT_BUSY (Q-P32u)', () => {
  it('server: a transfer and other archive jobs of the same tenant refuse each other; another tenant is not refused', async () => {
    _resetJobsForTests();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const other = crypto.randomUUID();
    const t = startJob('export', s.tenantId, s.ownerId, async () => { await gate; return null; }, [], { transfer: true });
    try {
      await expectCode(Promise.resolve().then(() => assertArchiveJobAllowed(s.tenantId, false)), 'TENANT_BUSY');
      expect(() => startJob('export', s.tenantId, s.ownerId, async () => null)).toThrow(ArchiveError);
      expect(() => assertArchiveJobAllowed(other, false)).not.toThrow();
      expect(() => assertArchiveJobAllowed(null, false)).not.toThrow();
    } finally {
      release();
      await waitForJob(t.id);
    }
    let release2!: () => void;
    const gate2 = new Promise<void>((r) => { release2 = r; });
    const b = startJob('export', s.tenantId, s.ownerId, async () => { await gate2; return null; });
    try {
      const e = await expectCode(Promise.resolve().then(() => assertArchiveJobAllowed(s.tenantId, true)), 'TENANT_BUSY');
      expect(e.statusCode).toBe(409);
      expect(() => assertArchiveJobAllowed(s.tenantId, false)).not.toThrow();
    } finally {
      release2();
      await waitForJob(b.id);
    }
  });

  it('desktop: any archive job is refused while a transfer runs or waits, and a transfer while anything runs', async () => {
    _resetJobsForTests();
    loadDesktopProfile({ CL_MODE: 'desktop', CL_TOKEN: 'transfer-busy-' + 'b'.repeat(40), CL_BIND: '127.0.0.1:0', CL_DATA_DIR: work });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const imp = startJob('import', null, s.ownerId, async () => { await gate; return null; });
    try {
      expect(() => assertArchiveJobAllowed(crypto.randomUUID(), true)).toThrow(ArchiveError);
      expect(() => assertArchiveJobAllowed(crypto.randomUUID(), false)).not.toThrow();
    } finally {
      release();
      await waitForJob(imp.id);
      _resetDesktopProfileForTests();
    }
  });
});
