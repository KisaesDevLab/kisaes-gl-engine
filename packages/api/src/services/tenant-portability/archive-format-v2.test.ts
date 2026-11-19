// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Archive formatVersion 2 (U-282): writers emit 2, readers accept 1 and 2,
// a newer version is 409 ARCHIVE_TOO_NEW. fixtures/archive-v1.zip is a
// synthetic backup written by engine ef87c736 (formatVersion 1, schema
// 283): one company, six accounts, two contacts, four posted entries with
// 4-place amounts, one attachment and an audit row; passphrase below.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';
import * as unzipper from 'unzipper';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { ArchiveReader } from './archive-reader.js';
import { ArchiveError } from './errors.js';
import { runExport } from './export.service.js';
import { runImport } from './import.service.js';
import { ARCHIVE_FORMAT_VERSION, ARCHIVE_TOO_NEW_MESSAGE, ENVELOPE_ENTRY } from './format.js';
import { buildPortabilityPlan, scopeSql, type PortabilityPlan } from './plan.js';

const V1_FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'archive-v1.zip');
const V1_FIXTURE_PASSPHRASE = 'v1 fixture passphrase 2026!';
const PASS2 = 'format v2 test passphrase 2026!';

let plan: PortabilityPlan;
let work = '';
let callerId = '';
const tenants: string[] = [];

async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.execute(sql.raw(text.replace(/\$(\d+)/g, (_m, n) => {
    const v = params[Number(n) - 1];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  })));
  return r.rows as T[];
}

/** Copies an archive with envelope.json rewritten by `edit` (the other entries are copied raw). */
async function withEnvelope(src: string, dst: string, edit: (e: Record<string, unknown>) => void): Promise<void> {
  const d = await unzipper.Open.file(src);
  const out = archiver('zip', { store: true });
  const stream = fs.createWriteStream(dst);
  const done = new Promise<void>((resolve, reject) => {
    stream.on('close', resolve);
    out.on('error', reject);
  });
  out.pipe(stream);
  for (const f of d.files) {
    let bytes = await f.buffer();
    if (f.path === ENVELOPE_ENTRY) {
      const e = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      edit(e);
      bytes = Buffer.from(JSON.stringify(e), 'utf8');
    }
    out.append(bytes, { name: f.path });
  }
  await out.finalize();
  await done;
}

beforeAll(async () => {
  plan = await buildPortabilityPlan(db);
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-v2-'));
  process.env['CL_ARCHIVE_DIR'] = path.join(work, 'archives');
  callerId = crypto.randomUUID();
  const home = crypto.randomUUID();
  await q(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'v2 home', $2)`, [home, `v2-home-${home.slice(0, 8)}`]);
  tenants.push(home);
  await q(`INSERT INTO users (id, tenant_id, email, password_hash, display_name, role, is_super_admin, is_active)
           VALUES ($1, $2, $3, 'x', 'Caller', 'owner', true, true)`, [callerId, home, `v2-caller-${callerId.slice(0, 8)}@example.test`]);
});

afterAll(async () => {
  for (const id of tenants) {
    for (const t of [...plan.scoped].reverse()) {
      await q(`DELETE FROM "${t}" a WHERE ${scopeSql(plan, t, 'a').replace('$1', `'${id}'::uuid`)}`).catch(() => undefined);
    }
    await q(`DELETE FROM tenant_archive_imports WHERE tenant_id = $1`, [id]).catch(() => undefined);
    await q(`DELETE FROM user_tenant_access WHERE tenant_id = $1`, [id]).catch(() => undefined);
    await q(`DELETE FROM users WHERE tenant_id = $1 AND id <> $2`, [id, callerId]).catch(() => undefined);
  }
  await q(`DELETE FROM users WHERE id = $1`, [callerId]).catch(() => undefined);
  for (const id of tenants) await q(`DELETE FROM tenants WHERE id = $1`, [id]).catch(() => undefined);
  fs.rmSync(work, { recursive: true, force: true });
  delete process.env['CL_ARCHIVE_DIR'];
});

describe('archive formatVersion 2 (U-282)', () => {
  it('opens the committed v1 fixture, restores it, and a new export of it is version 2', async () => {
    const reader = await ArchiveReader.open(V1_FIXTURE, V1_FIXTURE_PASSPHRASE);
    expect(reader.envelope.formatVersion).toBe(1);
    expect(reader.manifest.formatVersion).toBe(1);
    await reader.verifyAll();

    const imported = await runImport({ filePath: V1_FIXTURE, passphrase: V1_FIXTURE_PASSPHRASE, callerUserId: callerId });
    tenants.push(imported.tenantId);
    expect(imported.verification.contentEqual).toBe(true);
    expect(imported.verification.files).toBe(1);
    const [tb] = await q<{ d: string; c: string }>(
      `SELECT sum(debit)::text AS d, sum(credit)::text AS c FROM journal_lines WHERE tenant_id = $1`, [imported.tenantId]);
    expect(tb!.d).toBe('8034.6928');
    expect(tb!.c).toBe('8034.6928');

    const again = await runExport(imported.tenantId, callerId, { passphrase: PASS2 });
    const r2 = await ArchiveReader.open(again.path, PASS2);
    expect(r2.envelope.formatVersion).toBe(ARCHIVE_FORMAT_VERSION);
    expect(r2.manifest.formatVersion).toBe(2);
    const back = await runImport({ filePath: again.path, passphrase: PASS2, callerUserId: callerId });
    tenants.push(back.tenantId);
    expect(back.verification.contentEqual).toBe(true);
  }, 180_000);

  it('refuses a newer formatVersion with 409 ARCHIVE_TOO_NEW and the update message, before the passphrase', async () => {
    const v3 = path.join(work, 'v3.zip');
    await withEnvelope(V1_FIXTURE, v3, (e) => { e['formatVersion'] = 3; });
    for (const pass of [V1_FIXTURE_PASSPHRASE, 'a wrong passphrase 123']) {
      let err: unknown;
      try {
        await runImport({ filePath: v3, passphrase: pass, callerUserId: callerId });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ArchiveError);
      expect((err as ArchiveError).code).toBe('ARCHIVE_TOO_NEW');
      expect((err as ArchiveError).statusCode).toBe(409);
      expect((err as ArchiveError).message).toBe(ARCHIVE_TOO_NEW_MESSAGE);
    }
  }, 60_000);

  it('refuses a manifest whose formatVersion differs from the envelope (ARCHIVE_CORRUPT)', async () => {
    // The v1 manifest under an envelope that says 2.
    const mixed = path.join(work, 'mixed.zip');
    await withEnvelope(V1_FIXTURE, mixed, (e) => { e['formatVersion'] = 2; });
    let err: unknown;
    try {
      await ArchiveReader.open(mixed, V1_FIXTURE_PASSPHRASE);
    } catch (e) {
      err = e;
    }
    expect((err as ArchiveError).code).toBe('ARCHIVE_CORRUPT');
  }, 60_000);
});
