// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Migration 0218 (mybooks_strip_secret_keys): the SQL strip agrees with
// utils/secret-keys.ts stripSecretKeys on the same documents (the audit
// content digest depends on it), is additive, and rolls back cleanly. The
// forward file is re-applied at the end so the rest of the suite sees it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { SECRET_KEY_PATTERN, stripSecretKeys } from '../../utils/secret-keys.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

async function run(file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await db.execute(sql.raw(body));
  }
}

async function functionExists(): Promise<boolean> {
  const r = await db.execute(sql`SELECT 1 FROM pg_proc WHERE proname = 'mybooks_strip_secret_keys'`);
  return r.rows.length === 1;
}

async function strip(doc: unknown): Promise<unknown> {
  const r = await db.execute(sql`SELECT mybooks_strip_secret_keys(${JSON.stringify(doc)}::jsonb, ${SECRET_KEY_PATTERN}) AS d`);
  return (r.rows[0] as { d: unknown }).d;
}

describe('migration 0218 mybooks_strip_secret_keys', () => {
  it('strips the same keys as stripSecretKeys at every depth, and is NULL-strict', async () => {
    expect(await functionExists()).toBe(true);
    const docs: unknown[] = [
      { business_name: 'Co', smtp_pass: 'p1', nested: { stripe: { secretKeyEncrypted: 'p2', mode: 'live' } }, list: [{ apiKey: 'p3', n: 1 }, 'x', 2, null], remote_backup_config: { token: 'p4' }, inputTokens: 12, nothing: null },
      { smtpPass: 'only' },
      { fileHash: 'abc', file_hash: 'abc', numbersHash: 'n', tokenExpiresAt: 'x', monthlyTokenLimit: 5, credentialId: 'c', fileHashSecret: 'drop', passwordHash: 'drop' },
      {},
      [],
      [{ password_hash: 'h' }, [{ refresh_token: 't', ok: true }]],
      'scalar',
      42,
      true,
    ];
    for (const doc of docs) {
      expect(await strip(doc), JSON.stringify(doc)).toEqual(stripSecretKeys(doc));
    }
    const nul = await db.execute(sql`SELECT mybooks_strip_secret_keys(NULL::jsonb, ${SECRET_KEY_PATTERN}) AS d`);
    expect((nul.rows[0] as { d: unknown }).d).toBeNull();
    // Key order inside an object does not matter: jsonb output is canonical.
    expect(await strip({ b: 1, a: { smtp_pass: 'x', c: 2 } })).toEqual({ a: { c: 2 }, b: 1 });
    // A JSON string holding a serialized object (how middleware/audit.ts rows are stored) is
    // stripped inside and stays a string; other strings are untouched.
    const wrapped = await strip(JSON.stringify({ smtp_pass: 'p', nested: [{ apiKey: 'k', n: 1 }], kept: 'v' }));
    expect(typeof wrapped).toBe('string');
    expect(JSON.parse(wrapped as string)).toEqual({ nested: [{ n: 1 }], kept: 'v' });
    expect(await strip('plain text')).toBe('plain text');
    expect(await strip('{not json')).toBe('{not json');
    expect(await strip('"smtp_pass"')).toBe('"smtp_pass"');
    expect(await strip('12')).toBe('12');
  });

  it('is forward-only additive and rolls back cleanly', async () => {
    const fwd = readFileSync(path.join(MIGRATIONS, '0218_strip_secret_keys.sql'), 'utf8');
    expect(fwd).not.toMatch(/migration-policy: non-additive-exception/);
    expect(fwd).not.toMatch(/drop\s+(table|column)/i);
    expect(fwd).not.toMatch(/\b(update|delete|alter)\b/i);
    await run('0218_strip_secret_keys.rollback.sql');
    try {
      expect(await functionExists()).toBe(false);
    } finally {
      await run('0218_strip_secret_keys.sql');
    }
    expect(await functionExists()).toBe(true);
    await run('0218_strip_secret_keys.sql');
    expect(await functionExists()).toBe(true);
  });
});
