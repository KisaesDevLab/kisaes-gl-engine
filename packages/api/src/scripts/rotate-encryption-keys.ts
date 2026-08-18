// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Rotate the at-rest credential-encryption key (PLAID_ENCRYPTION_KEY).
 *
 * PLAID_ENCRYPTION_KEY wraps every secret the appliance stores: Plaid
 * access tokens + client creds, Twilio/TextLink SMS creds, TOTP secrets and
 * recovery codes, AI provider keys, Stripe keys, firm-integration creds,
 * portal 1099 TINs, storage-provider OAuth tokens/secrets, remote-backup
 * config, the scheduled-backup passphrase, and check-signature image files.
 * Ciphertexts live in three places, and this script covers all three:
 *
 *   1. text/varchar columns (any name — not just *_encrypted; e.g. the
 *      system_settings row `backup_scheduled_passphrase`),
 *   2. json/jsonb columns whose blobs embed ciphertext strings
 *      (system_settings.value JSON configs, storage_providers.config —
 *      including camelCase keys like `secretAccessKey`/`applicationKey`),
 *   3. `*.enc` files under $UPLOAD_DIR/signatures (encryptBuffer()).
 *
 * Detection is FORMAT + AUTHENTICATION based, not name based: a value is a
 * candidate when it matches iv:tag:ciphertext (base64, 12-byte iv, 16-byte
 * tag), and it is only ever rewritten when AES-256-GCM authentication
 * succeeds under the OLD key. GCM makes false positives cryptographically
 * impossible, so scanning every column is safe. Values that already open
 * under the NEW key are left alone (idempotent re-runs); values that open
 * under neither are reported and never modified.
 *
 * Usage (run with the api + worker STOPPED so nothing writes mid-rotation;
 * the script itself refuses to run when it can see the api's advisory
 * heartbeat unless --i-know-the-api-is-running is passed):
 *
 *   OLD_PLAID_ENCRYPTION_KEY=<old> PLAID_ENCRYPTION_KEY=<new> \
 *     npx tsx src/scripts/rotate-encryption-keys.ts            # dry run
 *   ... same env ...                                --apply    # write
 *
 * The NEW key is taken from PLAID_ENCRYPTION_KEY (so utils/encryption.ts
 * encrypt() produces new-key ciphertext); the OLD key from
 * OLD_PLAID_ENCRYPTION_KEY. All DB writes happen in ONE transaction; files
 * are rewritten atomically (each) before it. Re-running after a partial
 * failure is safe (already-current values are skipped). Signature FILES are
 * rewritten before the DB transaction so a crash can never leave the DB on
 * the new key while .env still holds the old one.
 *
 * ENCRYPTION_KEY (the sentinel/installation key) is rotated separately by
 * the operator runbook (change .env, move /data/.sentinel aside so preflight
 * regenerates it, then refresh the recovery file) — it holds no DB data.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { encrypt, encryptBuffer } from '../utils/encryption.js';
import { writeAtomicSync } from '../utils/atomic-write.js';

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--i-know-the-api-is-running');
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
// iv (12 bytes → 16 b64 chars) : tag (16 bytes → 24 b64 chars ending "==") : ciphertext
// Ciphertext body may be empty (encrypt('') is legal) — `*`, not `+`.
const CIPHERTEXT_RE = /^[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]{22}==:[A-Za-z0-9+/]*={0,2}$/;
const RUN_TS = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
// Same shape, but usable as a Postgres POSIX regex prefilter inside JSON text.
const PG_PREFILTER = '[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]{22}==:[A-Za-z0-9+/]+';

function deriveKey(keyMaterial: string): Buffer {
  if (keyMaterial.length === 64 && /^[0-9a-f]+$/i.test(keyMaterial)) return Buffer.from(keyMaterial, 'hex');
  return crypto.createHash('sha256').update(keyMaterial).digest();
}
function decryptWith(key: Buffer, ciphertext: string): Buffer {
  const [ivB, tagB, ctB] = ciphertext.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB!, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB!, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB!, 'base64')), decipher.final()]);
}

const oldRaw = process.env['OLD_PLAID_ENCRYPTION_KEY'];
const newRaw = process.env['PLAID_ENCRYPTION_KEY'];
if (!oldRaw || !newRaw) {
  console.error('Set OLD_PLAID_ENCRYPTION_KEY (current key) and PLAID_ENCRYPTION_KEY (new key).');
  process.exit(2);
}
if (newRaw.length < 32) { console.error('New key must be ≥32 chars (use 64 hex chars).'); process.exit(2); }
const OLD = deriveKey(oldRaw);
const NEW = deriveKey(newRaw);
if (OLD.equals(NEW)) { console.error('Old and new keys are identical — nothing to do.'); process.exit(2); }

type Verdict = 'rotate' | 'current' | 'unreadable';
function classify(value: string): { verdict: Verdict; plaintext?: Buffer } {
  try { decryptWith(NEW, value); return { verdict: 'current' }; } catch { /* not new */ }
  try { return { verdict: 'rotate', plaintext: decryptWith(OLD, value) }; } catch { return { verdict: 'unreadable' }; }
}

const totals = { rotate: 0, current: 0, unreadable: 0 };
const perSite: Record<string, { rotate: number; current: number; unreadable: number }> = {};
const bump = (site: string, v: Verdict) => {
  perSite[site] ??= { rotate: 0, current: 0, unreadable: 0 };
  perSite[site]![v] += 1; totals[v] += 1;
};

/** Walk a parsed JSON value; return a rewritten copy + whether anything changed. */
function rewriteJson(site: string, node: unknown): { value: unknown; changed: boolean } {
  if (typeof node === 'string') {
    if (!CIPHERTEXT_RE.test(node)) return { value: node, changed: false };
    const c = classify(node);
    bump(site, c.verdict);
    if (c.verdict === 'rotate') return { value: encrypt(c.plaintext!.toString('utf8')), changed: true };
    return { value: node, changed: false };
  }
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((n) => { const r = rewriteJson(site, n); changed ||= r.changed; return r.value; });
    return { value: out, changed };
  }
  if (node && typeof node === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const r = rewriteJson(site, v); changed ||= r.changed; out[k] = r.value;
    }
    return { value: out, changed };
  }
  return { value: node, changed: false };
}

async function listColumns(): Promise<Array<{ table: string; column: string; type: string }>> {
  const res = await db.execute(sql`
    SELECT c.table_name, c.column_name, c.data_type
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND c.data_type IN ('text', 'character varying', 'json', 'jsonb')
      AND c.table_name NOT LIKE '\\_\\_drizzle%'
    ORDER BY c.table_name, c.column_name
  `);
  return (res.rows as Array<{ table_name: string; column_name: string; data_type: string }>)
    .filter((r) => IDENT_RE.test(r.table_name) && IDENT_RE.test(r.column_name))
    .map((r) => ({ table: r.table_name, column: r.column_name, type: r.data_type }));
}

async function apiLooksAlive(): Promise<boolean> {
  // Worker heartbeats + api sessions are the cheapest liveness proxies we
  // can read from SQL alone; pg_stat_activity is the authoritative one.
  const res = await db.execute(sql`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid()
      AND application_name NOT ILIKE '%psql%' AND state IS NOT NULL
      AND backend_type = 'client backend'
  `);
  const n = (res.rows[0] as { n: number } | undefined)?.n ?? 0;
  // The api + worker keep pools of ~10-20 idle connections each; a lone
  // script sees only itself (0 others) or a psql session.
  return n > 2;
}

async function main(): Promise<void> {
  console.log(`[rotate] mode=${APPLY ? 'APPLY' : 'DRY-RUN'} old=${oldRaw!.slice(0, 4)}… new=${newRaw!.slice(0, 4)}…`);
  if (APPLY && !FORCE && (await apiLooksAlive())) {
    console.error('[rotate] Other DB clients are connected (api/worker running?). Stop them first: `docker compose stop api worker`, or pass --i-know-the-api-is-running.');
    process.exit(3);
  }

  const columns = await listColumns();
  const unreadableSamples: string[] = [];
  // ── Files FIRST: check-signature images (encryptBuffer) ──────────────
  // Files are rewritten one-by-one (each atomic, each idempotent). Doing
  // them before the single DB transaction means the only possible partial
  // state after a crash is "some files already on the new key" — the DB is
  // still entirely on the old key, so the api keeps working on the old key
  // and a re-run finishes the job. The reverse order could leave the DB on
  // the new key with .env still old = every stored secret unreadable.
  const uploadDir = process.env['UPLOAD_DIR'] || '/data/uploads';
  const sigRoot = path.join(uploadDir, 'signatures');
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name.endsWith('.enc')) files.push(p);
    }
  };
  walk(sigRoot);
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8').trim();
    if (!CIPHERTEXT_RE.test(raw)) { bump('files:signatures', 'unreadable'); unreadableSamples.push(f); continue; }
    const c = classify(raw);
    bump('files:signatures', c.verdict);
    if (c.verdict === 'unreadable') unreadableSamples.push(f);
    if (c.verdict === 'rotate' && APPLY) {
      const st = fs.statSync(f);
      // Keep the OLD-key ciphertext beside the file: if the run dies after
      // this write and is (wrongly) restarted with a different new key, the
      // image is still recoverable from the copy. Never overwrite an
      // existing copy (a resume must not clobber the original backup).
      const bak = `${f}.pre-rotation-${RUN_TS}`;
      if (!fs.existsSync(bak)) fs.copyFileSync(f, bak);
      fs.chmodSync(bak, 0o600);
      writeAtomicSync(f, encryptBuffer(c.plaintext!), st.mode & 0o777);
    }
  }


  await db.transaction(async (tx) => {
    for (const { table, column, type } of columns) {
      const site = `${table}.${column}`;
      if (type === 'json' || type === 'jsonb') {
        const rows = await tx.execute(sql`
          SELECT ctid::text AS rid, ${sql.identifier(column)}::text AS value
          FROM ${sql.identifier(table)}
          WHERE ${sql.identifier(column)} IS NOT NULL AND ${sql.identifier(column)}::text ~ ${PG_PREFILTER}
        `);
        for (const row of rows.rows as Array<{ rid: string; value: string }>) {
          let parsed: unknown;
          try { parsed = JSON.parse(row.value); } catch { continue; }
          const r = rewriteJson(site, parsed);
          if (r.changed && APPLY) {
            const cast = type === 'jsonb' ? sql`::jsonb` : sql`::json`;
            await tx.execute(sql`
              UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${JSON.stringify(r.value)}${cast}
              WHERE ctid = ${row.rid}::tid
            `);
          }
        }
        continue;
      }
      // text/varchar: the value is either a bare ciphertext, or a JSON
      // document that embeds ciphertexts (system_settings.value holds JSON
      // configs as text), or unrelated. Prefilter unanchored, then decide.
      const rows = await tx.execute(sql`
        SELECT ctid::text AS rid, ${sql.identifier(column)} AS value
        FROM ${sql.identifier(table)}
        WHERE ${sql.identifier(column)} IS NOT NULL AND ${sql.identifier(column)} ~ ${PG_PREFILTER}
      `);
      for (const row of rows.rows as Array<{ rid: string; value: string }>) {
        if (CIPHERTEXT_RE.test(row.value)) {
          const c = classify(row.value);
          bump(site, c.verdict);
          if (c.verdict === 'unreadable' && unreadableSamples.length < 20) unreadableSamples.push(`${site} ctid=${row.rid}`);
          if (c.verdict === 'rotate' && APPLY) {
            await tx.execute(sql`
              UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${encrypt(c.plaintext!.toString('utf8'))}
              WHERE ctid = ${row.rid}::tid
            `);
          }
          continue;
        }
        let parsed: unknown;
        try { parsed = JSON.parse(row.value); } catch { continue; }
        if (!parsed || typeof parsed !== 'object') continue;
        const r = rewriteJson(`${site} (json)`, parsed);
        if (r.changed && APPLY) {
          await tx.execute(sql`
            UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${JSON.stringify(r.value)}
            WHERE ctid = ${row.rid}::tid
          `);
        }
      }
    }
    if (!APPLY) {
      // Nothing was written, but roll back explicitly for clarity.
      throw new Error('__DRY_RUN_ROLLBACK__');
    }
    console.log('[rotate] DB transaction committing…');
  }).catch((err: Error) => { if (err.message !== '__DRY_RUN_ROLLBACK__') throw err; });

  // ── Report ───────────────────────────────────────────────────────────
  console.log('\nsite                                          rotate  current  unreadable');
  for (const [site, c] of Object.entries(perSite).sort()) {
    console.log(`${site.padEnd(45)} ${String(c.rotate).padStart(6)}  ${String(c.current).padStart(7)}  ${String(c.unreadable).padStart(10)}`);
  }
  console.log(`${'TOTAL'.padEnd(45)} ${String(totals.rotate).padStart(6)}  ${String(totals.current).padStart(7)}  ${String(totals.unreadable).padStart(10)}`);
  if (unreadableSamples.length) {
    console.log('\nUnreadable under BOTH keys (left untouched — inspect before deleting):');
    for (const s of unreadableSamples) console.log('  ' + s);
  }
  console.log(APPLY
    ? '\n[rotate] APPLIED. Now set PLAID_ENCRYPTION_KEY=<new> in .env and start api + worker; then Admin → Security → refresh the recovery file.'
    : '\n[rotate] DRY RUN — nothing written. Re-run with --apply to rotate.');
}

main()
  .then(async () => { await pool.end(); process.exit(0); })
  .catch(async (err) => { console.error('[rotate] FAILED — nothing partially applied inside the DB transaction:', err?.message ?? err); try { await pool.end(); } catch { /* ignore */ } process.exit(1); });
