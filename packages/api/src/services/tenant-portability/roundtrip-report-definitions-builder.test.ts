// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// U-118 / U-119 (report-defs-builder-v1): a Report Builder definition
// travels in a transfer archive with every id at its id paths (a filter's
// ids at any children depth, a group-by tag group) pointing at the
// importing tenant's copy of the same row, a deactivated ("deleted")
// contact included; node ids and everything else are left untouched, and
// the import verifies. Runs in server mode against the test database.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { BUILDER_STARTERS, type BuilderDefinition } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { accounts, companies, contacts, tagGroups } from '../../db/schema/index.js';
import * as authService from '../auth.service.js';
import * as defs from '../report-definitions.service.js';
import { runExport } from './export.service.js';
import { runImport } from './import.service.js';
import { buildPortabilityPlan, scopeSql, type PortabilityPlan } from './plan.js';

const PHRASE = `builder round trip ${crypto.randomUUID()}`;
const stamp = crypto.randomUUID().slice(0, 8);
let plan: PortabilityPlan;
let archiveRoot = '';
const createdTenants: string[] = [];
const createdUsers: string[] = [];
let tenantId = '';
let callerId = '';
let original: BuilderDefinition;

async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.execute(sql.raw(text.replace(/\$(\d+)/g, (_m, n) => {
    const v = params[Number(n) - 1];
    if (v === null || v === undefined) return 'NULL';
    return `'${String(v).replace(/'/g, "''")}'`;
  })));
  return r.rows as T[];
}

/** The definition with each id replaced by the name of the row it points at in tenant `tid`. */
async function named(tid: string, d: BuilderDefinition): Promise<string> {
  let text = JSON.stringify(d);
  const ids = [...new Set(text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [])];
  for (const id of ids) {
    const r = await q<{ name: string }>(`
      SELECT name FROM accounts WHERE tenant_id = $1 AND id = $2
      UNION ALL SELECT display_name FROM contacts WHERE tenant_id = $1 AND id = $2
      UNION ALL SELECT name FROM tag_groups WHERE tenant_id = $1 AND id = $2`, [tid, id]);
    text = text.split(id).join(r[0] ? `<${r[0].name}>` : `MISSING ${id}`);
  }
  return text;
}

beforeAll(async () => {
  plan = await buildPortabilityPlan(db);
  archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-archives-rbdefs-'));
  process.env['CL_ARCHIVE_DIR'] = archiveRoot;
  const reg = await authService.register({
    email: `rtb-${stamp}@example.test`, password: crypto.randomUUID(), displayName: 'Owner', companyName: `RTB ${stamp}`,
  });
  tenantId = reg.user.tenantId;
  createdTenants.push(tenantId);
  callerId = crypto.randomUUID();
  await q(`INSERT INTO users (id, tenant_id, email, password_hash, display_name, role, is_super_admin, is_active)
           VALUES ($1, $2, $3, 'x', 'Caller', 'owner', true, true)`, [callerId, tenantId, `rtb-caller-${stamp}@example.test`]);
  createdUsers.push(callerId);

  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const companyId = company!.id;
  const revenue = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue')) }))!;
  const [kept] = await db.insert(contacts).values({ tenantId, companyId, contactType: 'customer', displayName: 'Hartley Residence' }).returning();
  const [gone] = await db.insert(contacts).values({ tenantId, companyId, contactType: 'customer', displayName: 'Old Client' }).returning();
  const [crews] = await db.insert(tagGroups).values({ tenantId, companyId, name: 'Crews' }).returning();

  const base = BUILDER_STARTERS.find((s) => s.key === 'sales_by_client')!.definition;
  const sales = base.nodes[0] as Extract<BuilderDefinition['nodes'][number], { type: 'section' }>;
  original = {
    ...base,
    nodes: [
      { type: 'text', id: 'intro', text: 'Sales by crew' },
      { type: 'group', id: 'crew-sales', caption: 'By crew', showTotal: true, children: [{
        ...sales,
        id: 'sales_by_crew',
        filters: [{ field: 'contact', op: 'in', ids: [kept!.id, gone!.id] }, { field: 'account', op: 'not_in', ids: [revenue.id] }],
        groupBy: [{ key: 'tag', tagGroupId: crews!.id }, { key: 'contact' }],
      }] },
    ],
  };
  await defs.createDefinition(tenantId, companyId, { userId: reg.user.id, userRole: 'owner' }, { name: 'Crew sales', definition: original });
  // The contact is deleted (deactivated) after the report was saved.
  await db.update(contacts).set({ isActive: false }).where(eq(contacts.id, gone!.id));
}, 300_000);

afterAll(async () => {
  for (const id of createdTenants) {
    for (const t of [...plan.scoped].reverse()) {
      const where = scopeSql(plan, t, 'a').replace('$1', `'${id}'::uuid`);
      await q(`DELETE FROM "${t}" a WHERE ${where}`).catch(() => undefined);
    }
    await q(`DELETE FROM tenant_archive_imports WHERE tenant_id = $1`, [id]).catch(() => undefined);
    await q(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)`, [id]).catch(() => undefined);
    await q(`DELETE FROM user_tenant_access WHERE tenant_id = $1`, [id]).catch(() => undefined);
    await q(`DELETE FROM users WHERE tenant_id = $1`, [id]).catch(() => undefined);
  }
  for (const u of createdUsers) await q(`DELETE FROM users WHERE id = $1`, [u]).catch(() => undefined);
  for (const id of createdTenants) await q(`DELETE FROM tenants WHERE id = $1`, [id]).catch(() => undefined);
  fs.rmSync(archiveRoot, { recursive: true, force: true });
  delete process.env['CL_ARCHIVE_DIR'];
});

describe('builder definitions in tenant archives (report-defs-builder-v1)', () => {
  it('a transfer archive remaps every id at the builder id paths; node ids are untouched; the import verifies', async () => {
    const archive = await runExport(tenantId, callerId, { passphrase: PHRASE, host: { app: 'ClientLedger', kind: 'transfer' } });
    const imported = await runImport({ filePath: archive.path!, passphrase: PHRASE, callerUserId: callerId });
    createdTenants.push(imported.tenantId);
    expect(imported.verification).toMatchObject({ contentEqual: true });

    const [row] = await q<{ kind: string; def: BuilderDefinition }>(`SELECT kind, definition_json AS def FROM report_definitions WHERE tenant_id = $1`, [imported.tenantId]);
    expect(row!.kind).toBe('builder');
    const before = await named(tenantId, original);
    const after = await named(imported.tenantId, row!.def);
    expect(before).not.toMatch(/MISSING/);
    // jsonb orders keys its own way: compare the parsed values.
    expect(JSON.parse(after)).toEqual(JSON.parse(before));
    expect(after).toContain('<Old Client>');
    expect(after).toContain('<Crews>');
    // Node ids, captions and every non-id value are as saved.
    const strip = (d: BuilderDefinition) => JSON.stringify(d).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'ID');
    expect(JSON.parse(strip(row!.def))).toEqual(JSON.parse(strip(original)));
    // And no id of the old tenant is left.
    const oldIds = JSON.stringify(original).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)!;
    for (const id of oldIds) expect(JSON.stringify(row!.def)).not.toContain(id);
  }, 600_000);
});
