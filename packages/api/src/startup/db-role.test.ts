// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// The role query against a real PostgreSQL. Each case creates throwaway
// roles and evaluates DB_ROLE_QUERY under SET ROLE, so current_user is the
// role under test without a login. Needs a superuser test connection (the
// engine CI and `cargo xtask engine-test` both have one); skipped otherwise.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { DB_ROLE_QUERY, classifyDbRole, type RoleRow } from './db-role.js';

const suffix = `${process.pid}_${Date.now()}`;
const R = {
  plain: `cl_role_plain_${suffix}`,
  mid: `cl_role_mid_${suffix}`,
  viaSuper: `cl_role_via_super_${suffix}`,
  superGroup: `cl_role_super_${suffix}`,
  files: `cl_role_files_${suffix}`,
  attrs: `cl_role_attrs_${suffix}`,
};

let client: pg.Client | null = null;
let isSuper = false;

async function reportFor(role: string | null) {
  const c = client!;
  await c.query(role ? `SET ROLE ${role}` : 'RESET ROLE');
  try {
    const res = await c.query(DB_ROLE_QUERY);
    return classifyDbRole(res.rows[0] as RoleRow);
  } finally {
    await c.query('RESET ROLE');
  }
}

beforeAll(async () => {
  client = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
  await client.connect();
  isSuper = (await client.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rows[0]?.rolsuper === true;
  if (!isSuper) return;
  await client.query(`CREATE ROLE ${R.plain} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  await client.query(`CREATE ROLE ${R.superGroup} NOLOGIN SUPERUSER`);
  // viaSuper -> mid -> superGroup: membership is transitive.
  await client.query(`CREATE ROLE ${R.mid} NOLOGIN NOSUPERUSER`);
  await client.query(`CREATE ROLE ${R.viaSuper} NOLOGIN NOSUPERUSER`);
  await client.query(`GRANT ${R.superGroup} TO ${R.mid}`);
  await client.query(`GRANT ${R.mid} TO ${R.viaSuper}`);
  await client.query(`CREATE ROLE ${R.files} NOLOGIN NOSUPERUSER`);
  await client.query(`GRANT pg_read_server_files TO ${R.files}`);
  await client.query(`GRANT pg_execute_server_program TO ${R.files}`);
  await client.query(`CREATE ROLE ${R.attrs} NOLOGIN NOSUPERUSER CREATEROLE REPLICATION BYPASSRLS`);
}, 60_000);

afterAll(async () => {
  if (!client) return;
  if (isSuper) {
    for (const r of [R.viaSuper, R.mid, R.superGroup, R.plain, R.files, R.attrs]) {
      await client.query(`DROP ROLE IF EXISTS ${r}`).catch(() => undefined);
    }
  }
  await client.end();
}, 60_000);

describe('DB_ROLE_QUERY', () => {
  it('a plain NOSUPERUSER role: nothing to report', async () => {
    if (!isSuper) return;
    expect(await reportFor(R.plain)).toEqual({ superuser: false, dangerous: [], warnings: [] });
  });

  it('membership in a superuser role, through another role, counts as superuser', async () => {
    if (!isSuper) return;
    const r = await reportFor(R.viaSuper);
    expect(r.superuser).toBe(true);
    expect(r.dangerous).toContain('member_of_superuser');
    expect(r.dangerous).not.toContain('superuser');
  });

  it('server-file role membership is dangerous', async () => {
    if (!isSuper) return;
    const r = await reportFor(R.files);
    expect(r).toEqual({
      superuser: false,
      dangerous: ['pg_execute_server_program', 'pg_read_server_files'],
      warnings: [],
    });
  });

  it('CREATEROLE, REPLICATION, BYPASSRLS are warnings only', async () => {
    if (!isSuper) return;
    expect(await reportFor(R.attrs)).toEqual({
      superuser: false,
      dangerous: [],
      warnings: ['createrole', 'replication', 'bypassrls'],
    });
  });

  it('the superuser test connection itself', async () => {
    if (!isSuper) return;
    const r = await reportFor(null);
    expect(r.superuser).toBe(true);
    expect(r.dangerous[0]).toBe('superuser');
  });
});

describe('classifyDbRole', () => {
  it('orders findings and ignores unknown roles', () => {
    expect(
      classifyDbRole({
        rolsuper: false,
        rolcreaterole: true,
        rolreplication: false,
        rolbypassrls: true,
        member_of_superuser: false,
        server_file_roles: ['pg_write_server_files', 'something_else', 'pg_read_server_files'],
      }),
    ).toEqual({
      superuser: false,
      dangerous: ['pg_read_server_files', 'pg_write_server_files'],
      warnings: ['createrole', 'bypassrls'],
    });
  });
});
