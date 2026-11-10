// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// U-118 (Q-312): saved report definitions and their groups travel in tenant
// archives — the ClientLedger backup and the transfer file. A definition
// naming one id of every kind at its fixed path (account, name, tag, item,
// tag group, budget) and placed in a group comes back with every id pointing
// at the importing tenant's copy of the same row, and the import verifies.
// Deleted (soft) rows travel as they are. Runs in server mode against the
// test database.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { accounts, budgets, companies, contacts, items, tagGroups, tags } from '../../db/schema/index.js';
import * as authService from '../auth.service.js';
import * as defs from '../report-definitions.service.js';
import { runExport, type ExportResult } from './export.service.js';
import { runImport } from './import.service.js';
import { buildPortabilityPlan, JSON_CONFIG_COLUMNS, SOFT_REFS, scopeSql, type PortabilityPlan } from './plan.js';
import { getSystemBackupTablePlan } from '../backup-table-plan.js';

const PASS = 'report definitions round trip passphrase 2026!';
const stamp = crypto.randomUUID().slice(0, 8);
let plan: PortabilityPlan;
let archiveRoot = '';
const createdTenants: string[] = [];
const createdUsers: string[] = [];
let tenantId = '';
let callerId = '';
let ownerId = '';
const archives: Record<'backup' | 'transfer', ExportResult | null> = { backup: null, transfer: null };

async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.execute(sql.raw(text.replace(/\$(\d+)/g, (_m, n) => {
    const v = params[Number(n) - 1];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  })));
  return r.rows as T[];
}

/** Every definition with its ids replaced by the names of the rows they point at. */
async function shape(tid: string) {
  const rows = await q<{ name: string; kind: string; version: number; deleted: boolean; grp: string | null; author: string | null; def: Record<string, unknown> }>(`
    SELECT d.name, d.kind, d.version, (d.deleted_at IS NOT NULL) AS deleted, g.name AS grp, u.email AS author, d.definition_json AS def
    FROM report_definitions d
    LEFT JOIN report_definition_groups g ON g.id = d.group_id
    LEFT JOIN users u ON u.id = d.created_by
    WHERE d.tenant_id = $1 ORDER BY d.name`, [tid]);
  const nameOf = async (table: string, id: string) => {
    const r = await q<{ name: string }>(`SELECT ${table === 'contacts' ? 'display_name' : 'name'} AS name FROM ${table} WHERE tenant_id = $1 AND id = $2`, [tid, id]);
    return r[0]?.name ?? `MISSING ${id}`;
  };
  const out = [];
  for (const r of rows) {
    const o = r.def['options'] as { filters?: Record<string, string[]>; tagSplit?: { tagGroupId: string }; budgetId?: string; basis?: string };
    const f = o.filters ?? {};
    out.push({
      name: r.name, kind: r.kind, version: r.version, deleted: r.deleted, group: r.grp, author: r.author?.replace(/@.*/, '') ?? null,
      reportKey: r.def['reportKey'], basis: o.basis ?? null,
      accounts: await Promise.all((f['accountIds'] ?? []).map((id) => nameOf('accounts', id))),
      contacts: await Promise.all((f['contactIds'] ?? []).map((id) => nameOf('contacts', id))),
      tags: await Promise.all((f['tagIds'] ?? []).map((id) => nameOf('tags', id))),
      items: await Promise.all((f['itemIds'] ?? []).map((id) => nameOf('items', id))),
      tagGroup: o.tagSplit ? await nameOf('tag_groups', o.tagSplit.tagGroupId) : null,
      budget: o.budgetId ? await nameOf('budgets', o.budgetId) : null,
    });
  }
  return out;
}

beforeAll(async () => {
  plan = await buildPortabilityPlan(db);
  archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-archives-rdefs-'));
  process.env['CL_ARCHIVE_DIR'] = archiveRoot;
  const reg = await authService.register({
    email: `rtd-${stamp}@example.test`, password: 'password123', displayName: 'Owner', companyName: `RTD ${stamp}`,
  });
  tenantId = reg.user.tenantId;
  ownerId = reg.user.id;
  createdTenants.push(tenantId);
  callerId = crypto.randomUUID();
  await q(`INSERT INTO users (id, tenant_id, email, password_hash, display_name, role, is_super_admin, is_active)
           VALUES ($1, $2, $3, $4, 'Caller', 'owner', true, true)`,
  [callerId, tenantId, `rtd-caller-${stamp}@example.test`, '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789']);
  createdUsers.push(callerId);

  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const companyId = company!.id;
  const revenue = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue')) }))!;
  const [contact] = await db.insert(contacts).values({ tenantId, companyId, contactType: 'customer', displayName: 'Hartley Residence' }).returning();
  const [tagGroup] = await db.insert(tagGroups).values({ tenantId, companyId, name: 'Crews' }).returning();
  const [tag] = await db.insert(tags).values({ tenantId, companyId, name: 'North crew' }).returning();
  const [item] = await db.insert(items).values({ tenantId, companyId, name: 'Site visit', incomeAccountId: revenue.id }).returning();
  const [budget] = await db.insert(budgets).values({ tenantId, companyId, name: 'Plan 2026', fiscalYear: 2026 }).returning();

  const viewer = { userId: ownerId, userRole: 'owner' };
  const group = await defs.createGroup(tenantId, companyId, ownerId, { name: 'Month end', sort: 2 });
  await defs.createDefinition(tenantId, companyId, viewer, {
    name: 'Everything', groupId: group.id,
    definition: {
      schemaVersion: 1, kind: 'standard', reportKey: 'profit_and_loss',
      options: {
        basis: 'cash',
        filters: { accountIds: [revenue.id], contactIds: [contact!.id], tagIds: [tag!.id], itemIds: [item!.id] },
        tagSplit: { tagGroupId: tagGroup!.id }, budgetId: budget!.id,
      },
    },
  });
  const gone = await defs.createDefinition(tenantId, companyId, viewer, {
    name: 'Old one', definition: { schemaVersion: 1, kind: 'standard', reportKey: 'balance_sheet', options: {} },
  });
  await defs.deleteDefinition(tenantId, companyId, viewer, gone.id, 1);

  archives.backup = await runExport(tenantId, callerId, { passphrase: PASS, host: { app: 'ClientLedger', kind: 'backup' } });
  archives.transfer = await runExport(tenantId, callerId, { passphrase: PASS, host: { app: 'ClientLedger', kind: 'transfer' } });
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

describe('saved report definitions in tenant archives and backups (U-118)', () => {
  it('classifies the new tables and columns', async () => {
    expect(plan.byName.get('report_definitions')).toBeTruthy();
    expect(plan.byName.get('report_definition_groups')).toBeTruthy();
    expect(JSON_CONFIG_COLUMNS['report_definitions.definition_json']).toBe('contains-ids');
    expect(SOFT_REFS['report_definitions.created_by']).toBe('identity');
    // The system (DR) backup carries both tables through its tenant loop.
    const sys = await getSystemBackupTablePlan(db);
    expect(sys.tenantScoped).toEqual(expect.arrayContaining(['report_definitions', 'report_definition_groups']));
  });

  for (const kind of ['backup', 'transfer'] as const) {
    it(`a ${kind} archive carries them with every id remapped; the import verifies`, async () => {
      const before = await shape(tenantId);
      expect(before).toEqual([
        {
          name: 'Everything', kind: 'standard', version: 1, deleted: false, group: 'Month end', author: `rtd-${stamp}`,
          reportKey: 'profit_and_loss', basis: 'cash',
          accounts: [expect.any(String)], contacts: ['Hartley Residence'], tags: ['North crew'], items: ['Site visit'],
          tagGroup: 'Crews', budget: 'Plan 2026',
        },
        {
          name: 'Old one', kind: 'standard', version: 2, deleted: true, group: null, author: `rtd-${stamp}`,
          reportKey: 'balance_sheet', basis: null, accounts: [], contacts: [], tags: [], items: [], tagGroup: null, budget: null,
        },
      ]);
      const imported = await runImport({ filePath: archives[kind]!.path!, passphrase: PASS, callerUserId: callerId });
      createdTenants.push(imported.tenantId);
      expect(imported.verification).toMatchObject({ contentEqual: true });
      const after = await shape(imported.tenantId);
      // Same rows, every id now resolving to the new tenant's copy (shape() looks them up in the new tenant).
      expect(after.map((r) => ({ ...r, author: r.author === null ? null : 'x' })))
        .toEqual(before.map((r) => ({ ...r, author: r.author === null ? null : 'x' })));
      expect(after.flatMap((r) => [...r.accounts, ...r.contacts, ...r.tags, ...r.items, r.tagGroup ?? '', r.budget ?? '']).join(' ')).not.toMatch(/MISSING/);
      // No definition of the new tenant points at an old-tenant row.
      const leaked = await q<{ n: number }>(`SELECT count(*)::int AS n FROM report_definitions d
        WHERE d.tenant_id = $1 AND (d.definition_json::text ~ ANY (SELECT id::text FROM accounts WHERE tenant_id = $2)
          OR d.group_id IN (SELECT id FROM report_definition_groups WHERE tenant_id = $2))`, [imported.tenantId, tenantId]);
      expect(leaked[0]!.n).toBe(0);
      const groups = await q<{ name: string; sort: number }>(`SELECT name, sort FROM report_definition_groups WHERE tenant_id = $1`, [imported.tenantId]);
      expect(groups).toEqual([{ name: 'Month end', sort: 2 }]);
    }, 600_000);
  }
});
