// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Equity roles (U-55, equity-roles-v1):
//   - a new company gets the roles of its entity type (the template's
//     Owner Withdraw / Owner Contribution are adopted, not duplicated);
//   - GET /company/equity-roles answers {entityType, roles: {role: id|null}};
//   - changing the entity type adds that type's roles; seeding is idempotent;
//   - equity-role accounts stay usable as categories;
//   - generic names (Common Stock, Distributions, Dividends) are not
//     adopted; a C corporation's exact "Dividends Paid" is;
//   - seeding runs under a per-tenant lock: concurrent seeds make no twins;
//   - migration 0223 tags and adds the roles for existing tenants, and
//     running it twice (or after its rollback) changes nothing more; its
//     rollback clears is_system on the role accounts and is refused while a
//     vendor refund link exists.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, systemSettings,
} from '../db/schema/index.js';
import { SystemSettingsKeys } from '../constants/system-settings-keys.js';
import { companyRouter } from './company.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as companyService from '../services/company.service.js';
import { ensureEquityRoleAccounts } from '../services/equity-roles.service.js';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(here, '../db/migrations/0223_deposit_links_equity_roles.sql');
const ROLLBACK = resolve(here, '../db/migrations/0223_deposit_links_equity_roles.rollback.sql');

function get(pathname: string, token: string): Promise<{ status: number; json: any }> {
  return new Promise((resolvePromise, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolvePromise({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function cleanTenant(tid: string) {
  await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  await db.delete(accounts).where(eq(accounts.tenantId, tid));
  await db.delete(companies).where(eq(companies.tenantId, tid));
  const staff = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tid));
  if (staff.length) await db.delete(sessions).where(inArray(sessions.userId, staff.map((u) => u.id)));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tid));
  await db.delete(users).where(eq(users.tenantId, tid));
  await db.delete(tenants).where(eq(tenants.id, tid));
}

async function register(label: string) {
  const reg = await authService.register({
    email: `eq-${label}-${suffix()}@example.com`, password: 'password123',
    displayName: `Owner ${label}`, companyName: `Equity ${label}`,
  });
  tenantIds.push(reg.user.tenantId);
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, reg.user.tenantId)).limit(1);
  return { tenantId: reg.user.tenantId, userId: reg.user.id, token: reg.tokens.accessToken, companyId: company!.id };
}

const tagged = (tenantId: string) => db.select({
  id: accounts.id, name: accounts.name, accountNumber: accounts.accountNumber, systemTag: accounts.systemTag, isSystem: accounts.isSystem,
}).from(accounts).where(and(eq(accounts.tenantId, tenantId), isNotNull(accounts.systemTag)));

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/company', companyRouter);
  app.use(errorHandler);
  await new Promise<void>((r) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; r(); });
  });
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

describe('equity roles (U-55)', () => {
  it('seeds the sole proprietor roles by adopting the template accounts', async () => {
    const t = await register('sole');
    const res = await get('/api/v1/company/equity-roles', t.token);
    expect(res.status).toBe(200);
    expect(res.json.entityType).toBe('sole_prop');
    expect(Object.keys(res.json.roles).sort()).toEqual([
      'owner_contribution', 'owner_draw', 'paid_in_capital', 'partner_contributions',
      'partner_draws', 'retained_earnings', 'shareholder_distributions',
    ]);
    expect(res.json.roles.owner_draw).not.toBeNull();
    expect(res.json.roles.owner_contribution).not.toBeNull();
    expect(res.json.roles.retained_earnings).not.toBeNull();
    expect(res.json.roles.partner_draws).toBeNull();
    expect(res.json.roles.paid_in_capital).toBeNull();

    const rows = await tagged(t.tenantId);
    const draw = rows.find((r) => r.systemTag === 'owner_draw')!;
    expect([draw.name, draw.accountNumber, draw.isSystem]).toEqual(['Owner Withdraw', '30170', false]);
    expect(rows.find((r) => r.systemTag === 'owner_contribution')!.name).toBe('Owner Contribution');
    // Adopted, not duplicated.
    const owners = await db.select().from(accounts).where(and(eq(accounts.tenantId, t.tenantId), eq(accounts.accountType, 'equity')));
    expect(owners.filter((a) => /owner/i.test(a.name) && /(draw|withdraw)/i.test(a.name))).toHaveLength(1);
  });

  it('adds the roles of a new entity type and is idempotent', async () => {
    const t = await register('scorp');
    await companyService.updateCompany(t.tenantId, t.companyId, { entityType: 's_corp' } as any, t.userId);
    const res = await get('/api/v1/company/equity-roles', t.token);
    expect(res.json.entityType).toBe('s_corp');
    expect(res.json.roles.shareholder_distributions).not.toBeNull();
    expect(res.json.roles.paid_in_capital).not.toBeNull();
    const rows = await tagged(t.tenantId);
    expect(rows.find((r) => r.systemTag === 'shareholder_distributions')!.name).toBe('Shareholder Distributions');
    expect(rows.find((r) => r.systemTag === 'paid_in_capital')).toMatchObject({ accountNumber: '30140', isSystem: true });

    const before = (await tagged(t.tenantId)).length;
    expect(await ensureEquityRoleAccounts(t.tenantId)).toEqual([]);
    expect((await tagged(t.tenantId)).length).toBe(before);
  });

  it('names the C corporation distributions account Dividends Paid', async () => {
    const t = await register('ccorp');
    await db.update(companies).set({ entityType: 'c_corp' }).where(eq(companies.id, t.companyId));
    await ensureEquityRoleAccounts(t.tenantId);
    const rows = await tagged(t.tenantId);
    expect(rows.find((r) => r.systemTag === 'shareholder_distributions')!.name).toBe('Dividends Paid');
  });

  it('adopts only role-specific names: not Common Stock or Distributions, but a C corporation\'s Dividends Paid', async () => {
    const s = await register('generic-s');
    await db.update(companies).set({ entityType: 's_corp' }).where(eq(companies.id, s.companyId));
    const [stock] = await db.insert(accounts).values({ tenantId: s.tenantId, name: 'Common Stock', accountType: 'equity', detailType: 'owners_equity' }).returning();
    const [dist] = await db.insert(accounts).values({ tenantId: s.tenantId, name: 'Distributions', accountType: 'equity', detailType: 'owners_equity' }).returning();
    const [divPaid] = await db.insert(accounts).values({ tenantId: s.tenantId, name: 'Dividends Paid', accountType: 'equity', detailType: 'owners_equity' }).returning();
    await ensureEquityRoleAccounts(s.tenantId);
    const sRows = await tagged(s.tenantId);
    for (const id of [stock!.id, dist!.id, divPaid!.id]) expect(sRows.find((r) => r.id === id)).toBeUndefined();
    expect(sRows.find((r) => r.systemTag === 'shareholder_distributions')!.name).toBe('Shareholder Distributions');
    expect(sRows.find((r) => r.systemTag === 'paid_in_capital')!.name).toBe('Paid-in Capital');

    const cc = await register('generic-c');
    await db.update(companies).set({ entityType: 'c_corp' }).where(eq(companies.id, cc.companyId));
    const [cDiv] = await db.insert(accounts).values({ tenantId: cc.tenantId, name: 'Dividends Paid', accountType: 'equity', detailType: 'owners_equity' }).returning();
    await ensureEquityRoleAccounts(cc.tenantId);
    const cRows = await tagged(cc.tenantId);
    expect(cRows.find((r) => r.systemTag === 'shareholder_distributions')).toMatchObject({ id: cDiv!.id, isSystem: false });
  });

  it('concurrent seeds of one tenant create each role once', async () => {
    const t = await register('race');
    await db.update(companies).set({ entityType: 'partnership' }).where(eq(companies.id, t.companyId));
    await Promise.all([1, 2, 3, 4].map(() => ensureEquityRoleAccounts(t.tenantId)));
    const rows = await tagged(t.tenantId);
    expect(rows.filter((r) => r.systemTag === 'partner_draws')).toHaveLength(1);
    expect(rows.filter((r) => r.systemTag === 'partner_contributions')).toHaveLength(1);
  });

  it('stores the entity type given at tenant creation and seeds its roles', async () => {
    const t = await register('owner');
    const key = SystemSettingsKeys.SELF_SERVICE_TENANT_CREATION;
    const [prev] = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
    await db.insert(systemSettings).values({ key, value: 'true', updatedAt: new Date() })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: 'true', updatedAt: new Date() } });
    let createdId = '';
    try {
      const created = await authService.createOwnedTenant(t.userId, 'owner', { companyName: `Partners ${suffix()}`, entityType: 'partnership' });
      createdId = created.tenantId;
      const company = await db.query.companies.findFirst({ where: eq(companies.id, created.companyId) });
      expect(company!.entityType).toBe('partnership');
      const rows = await tagged(created.tenantId);
      expect(rows.map((r) => r.systemTag)).toEqual(expect.arrayContaining(['partner_draws', 'partner_contributions']));
    } finally {
      if (prev) await db.update(systemSettings).set({ value: prev.value }).where(eq(systemSettings.key, key));
      else await db.delete(systemSettings).where(eq(systemSettings.key, key));
      if (createdId) {
        for (const table of ['je_template_lines', 'je_templates', 'audit_log', 'accounts', 'companies', 'tenant_feature_flags', 'user_tenant_access', 'tenant_firm_assignments']) {
          await db.execute(sql.raw(`DELETE FROM ${table} WHERE tenant_id = '${createdId}'`));
        }
        await db.delete(tenants).where(eq(tenants.id, createdId));
      }
    }
  });
});

describe('migration 0223 (equity roles backfill, journal line columns)', () => {
  const statements = (file: string) => readFileSync(file, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.replace(/--.*$/gm, '').trim().length > 0);

  it('tags and adds roles for existing tenants, idempotently, and survives rollback + re-run', async () => {
    const client = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
    await client.connect();
    try {
      await client.query('BEGIN');
      // An "existing" tenant as it looked before 0223: template accounts,
      // no equity tags; a partnership and an S corporation company.
      const tn = await client.query(
        `INSERT INTO tenants (name, slug) VALUES ('Mig 0223', $1) RETURNING id`, [`mig-0223-${suffix()}`],
      );
      const tenantId = tn.rows[0].id as string;
      await client.query(`INSERT INTO companies (tenant_id, business_name, entity_type) VALUES ($1, 'P', 'partnership'), ($1, 'S', 's_corp')`, [tenantId]);
      await client.query(`INSERT INTO accounts (tenant_id, account_number, name, account_type, detail_type)
        VALUES ($1, '30160', 'Owner Contribution', 'equity', 'owners_equity'),
               ($1, '30170', 'Owner Withdraw', 'equity', 'owners_equity'),
               ($1, '30140', 'Common Stock', 'equity', 'owners_equity'),
               ($1, NULL, 'Distributions', 'equity', 'owners_equity'),
               ($1, '30180', 'Something Else', 'equity', 'owners_equity')`, [tenantId]);

      const snapshot = async () => (await client.query(
        `SELECT name, account_number, system_tag, is_system FROM accounts WHERE tenant_id = $1 ORDER BY name`, [tenantId],
      )).rows;

      for (const s of statements(MIGRATION)) await client.query(s);
      const first = await snapshot();
      const tagOf = (name: string) => first.find((r) => r.name === name)?.system_tag ?? null;
      expect(tagOf('Owner Withdraw')).toBe('owner_draw');
      expect(tagOf('Owner Contribution')).toBe('owner_contribution');
      // Generic names are not adopted; Paid-in Capital is created (30140 is
      // taken by Common Stock, so it has no number).
      expect(tagOf('Common Stock')).toBeNull();
      expect(tagOf('Distributions')).toBeNull();
      expect(first.find((r) => r.system_tag === 'paid_in_capital')).toMatchObject({ name: 'Paid-in Capital', account_number: null, is_system: true });
      // Partnership roles created; 30180 was taken, so Partner Draws has no number.
      expect(first.find((r) => r.system_tag === 'partner_draws')).toMatchObject({ name: 'Partner Draws', account_number: null, is_system: true });
      // Adopted accounts keep their flag.
      expect(first.find((r) => r.name === 'Owner Withdraw')!.is_system).toBe(false);
      expect(first.find((r) => r.system_tag === 'partner_contributions')).toMatchObject({ name: 'Partner Contributions', account_number: '30190' });
      expect(first.find((r) => r.system_tag === 'shareholder_distributions')).toMatchObject({ name: 'Shareholder Distributions', account_number: '30200' });
      expect(first.filter((r) => r.system_tag === 'paid_in_capital')).toHaveLength(1);
      const cols = await client.query(`SELECT column_name FROM information_schema.columns
        WHERE table_name = 'journal_lines' AND column_name IN ('source_transaction_id', 'line_role') ORDER BY column_name`);
      expect(cols.rows.map((r) => r.column_name)).toEqual(['line_role', 'source_transaction_id']);

      for (const s of statements(MIGRATION)) await client.query(s);
      expect(await snapshot()).toEqual(first);

      // Rollback is refused while a vendor refund link exists.
      const credit = await client.query(
        `INSERT INTO transactions (tenant_id, txn_type, txn_date, total) VALUES ($1, 'vendor_credit', '2026-08-01', 10) RETURNING id`, [tenantId],
      );
      const dep = await client.query(
        `INSERT INTO transactions (tenant_id, txn_type, txn_date, total) VALUES ($1, 'deposit', '2026-08-02', 10) RETURNING id`, [tenantId],
      );
      await client.query(`INSERT INTO deposit_lines (deposit_id, source_transaction_id, amount) VALUES ($1, $2, 10)`,
        [dep.rows[0].id, credit.rows[0].id]);
      await client.query('SAVEPOINT before_rollback');
      await expect((async () => { for (const s of statements(ROLLBACK)) await client.query(s); })())
        .rejects.toThrow(/0223 rollback refused/);
      await client.query('ROLLBACK TO SAVEPOINT before_rollback');
      await client.query(`DELETE FROM deposit_lines WHERE deposit_id = $1`, [dep.rows[0].id]);

      for (const s of statements(ROLLBACK)) await client.query(s);
      const rolledBack = await snapshot();
      expect(rolledBack.filter((r) => r.system_tag)).toEqual([]);
      // The role accounts 0223 created are ordinary accounts again.
      expect(rolledBack.filter((r) => r.is_system)).toEqual([]);
      for (const s of statements(MIGRATION)) await client.query(s);
      // Re-run adopts the accounts it created the first time (same names),
      // so nothing is duplicated; they keep the cleared flag.
      const rerun = await snapshot();
      expect(rerun.map((r) => [r.name, r.account_number, r.system_tag])).toEqual(first.map((r) => [r.name, r.account_number, r.system_tag]));
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
});
