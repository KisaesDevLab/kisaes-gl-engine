// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Migration 0291 (U-297, agent principals): the widened users CHECK takes
// 'agent', the rollback fails closed (agent users, keys and access turned
// off, kept as inactive staff rows) and the forward migration re-applies
// cleanly. Everything runs in transactions that are rolled back.

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';
import { WIDENED_CHECKS } from './tenant-portability/compat.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const FORWARD = '0291_agent_principal.sql';
const ROLLBACK = '0291_agent_principal.rollback.sql';

async function run(tx: Tx, file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await tx.execute(sql.raw(body));
  }
}

async function auditColumns(tx: Tx): Promise<string[]> {
  const r = await tx.execute(sql`SELECT column_name FROM information_schema.columns
    WHERE table_name = 'audit_log' AND column_name IN ('origin', 'action_id') ORDER BY column_name`);
  return (r.rows as Array<{ column_name: string }>).map((x) => x.column_name);
}

class RolledBack extends Error {}

async function inRolledBackTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await expect(db.transaction(async (tx) => {
    await fn(tx);
    throw new RolledBack('rollback');
  })).rejects.toBeInstanceOf(RolledBack);
}

describe('migration 0291 agent principals', () => {
  it('carries the policy marker, a journal entry and a WIDENED_CHECKS entry', () => {
    const fwd = readFileSync(path.join(MIGRATIONS, FORWARD), 'utf8');
    expect(fwd.split('\n').slice(0, 10).join('\n')).toContain('-- migration-policy: non-additive-exception');
    expect(fwd).not.toMatch(/drop\s+(table|column)/i);
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((e) => e.tag === '0291_agent_principal')?.idx).toBe(291);
    expect(WIDENED_CHECKS['users.users_user_type_check']).toEqual({ widenedIn: 292 });
  });

  it('the rollback turns agents off and restores the old CHECK; the forward migration re-applies', async () => {
    await inRolledBackTx(async (tx) => {
      const tenant = crypto.randomUUID();
      await tx.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${tenant}, 'u297 mig', ${'u297-' + tenant})`);
      const [agent] = (await tx.execute(sql`INSERT INTO users (tenant_id, email, password_hash, role, user_type)
        VALUES (${tenant}, ${`agent-${tenant}@agents.invalid`}, 'x', 'owner', 'agent') RETURNING id`)).rows as Array<{ id: string }>;
      await tx.execute(sql`INSERT INTO user_tenant_access (user_id, tenant_id, role) VALUES (${agent!.id}, ${tenant}, 'owner')`);
      await tx.execute(sql`INSERT INTO api_keys (tenant_id, user_id, name, key_prefix, key_hash, role)
        VALUES (${tenant}, ${agent!.id}, 'k', 'sk_live_xxxx', ${crypto.randomUUID()}, 'readonly')`);
      expect(await auditColumns(tx)).toEqual(['action_id', 'origin']);

      await run(tx, ROLLBACK);
      const [u] = (await tx.execute(sql`SELECT user_type, is_active FROM users WHERE id = ${agent!.id}`)).rows as Array<{ user_type: string; is_active: boolean }>;
      expect(u).toEqual({ user_type: 'staff', is_active: false });
      const [k] = (await tx.execute(sql`SELECT is_active FROM api_keys WHERE user_id = ${agent!.id}`)).rows as Array<{ is_active: boolean }>;
      expect(k!.is_active).toBe(false);
      const [a] = (await tx.execute(sql`SELECT is_active FROM user_tenant_access WHERE user_id = ${agent!.id}`)).rows as Array<{ is_active: boolean }>;
      expect(a!.is_active).toBe(false);
      expect(await auditColumns(tx)).toEqual([]);
      await tx.execute(sql`SAVEPOINT s1`);
      await expect(tx.execute(sql`UPDATE users SET user_type = 'agent' WHERE id = ${agent!.id}`)).rejects.toThrow();
      await tx.execute(sql`ROLLBACK TO SAVEPOINT s1`);

      await run(tx, FORWARD);
      await run(tx, FORWARD); // idempotent
      await tx.execute(sql`UPDATE users SET user_type = 'agent' WHERE id = ${agent!.id}`);
      expect(await auditColumns(tx)).toEqual(['action_id', 'origin']);
    });
  });
});
