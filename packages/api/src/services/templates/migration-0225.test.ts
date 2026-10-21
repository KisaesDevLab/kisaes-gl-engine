// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Migration 0225 (templates, U-62/U-63): rolled back and re-applied on a
// database holding schedules made the old way (invoice, bill, expense,
// check, journal entry, deposit; named, unnamed and clashing names). Every
// schedule gets a 'legacy' template with a unique name, its company and
// source transaction; running the file again changes nothing; the web list
// still renders. The rollback is refused while a template-only schedule
// exists. The forward file is applied again at the end so the rest of the
// suite sees the schema.

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { companies, accounts, transactions, journalLines, auditLog, tenants, users, userTenantAccess, sessions, userPermissions } from '../../db/schema/index.js';
import * as authService from '../auth.service.js';
import * as ledger from '../ledger.service.js';
import * as recurringService from '../recurring.service.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

async function run(file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await db.execute(sql.raw(body));
  }
}

async function q<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const chunks = text.split(/\$(\d+)/);
  const parts: ReturnType<typeof sql>[] = [];
  chunks.forEach((c, i) => {
    if (i % 2 === 0) parts.push(sql.raw(c));
    else parts.push(sql`${params[Number(c) - 1]}`);
  });
  const r = await db.execute(sql.join(parts, sql.raw('')));
  return r.rows as T[];
}

const tenantIds: string[] = [];

async function cleanTenant(tid: string) {
  await q('DELETE FROM recurring_schedules WHERE tenant_id = $1', [tid]);
  await q('DELETE FROM template_transactions WHERE tenant_id = $1', [tid]).catch(() => undefined);
  await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tid));
  await db.delete(transactions).where(eq(transactions.tenantId, tid));
  await db.delete(accounts).where(eq(accounts.tenantId, tid));
  await db.delete(companies).where(eq(companies.tenantId, tid));
  const staff = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tid));
  for (const u of staff) await db.delete(sessions).where(eq(sessions.userId, u.id));
  await db.delete(userPermissions).where(eq(userPermissions.tenantId, tid));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tid));
  await db.delete(users).where(eq(users.tenantId, tid));
  await db.delete(tenants).where(eq(tenants.id, tid));
}

async function tableExists(name: string): Promise<boolean> {
  const r = await q<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = $1`, [name]);
  return r[0]!.n === 1;
}

afterAll(async () => {
  // Whatever happened, leave the schema migrated.
  if (!(await tableExists('template_occurrences'))) await run('0225_templates.sql');
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

describe('migration 0225 templates', () => {
  it('declares its one non-additive step and rolls back only without template-only schedules', async () => {
    const fwd = readFileSync(path.join(MIGRATIONS, '0225_templates.sql'), 'utf8');
    expect(fwd.split('\n').slice(0, 10).join('\n')).toMatch(/migration-policy: non-additive-exception/);
    expect(fwd).not.toMatch(/drop\s+(table|column)/i);

    const reg = await authService.register({
      email: `m225-${Date.now()}@example.com`, password: 'password123', displayName: 'Owner', companyName: 'M225 Co',
    });
    const tenantId = reg.user.tenantId;
    tenantIds.push(tenantId);
    const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId));
    const tpl = await q<{ id: string }>(
      `INSERT INTO template_transactions (tenant_id, company_id, name, kind) VALUES ($1, $2, 'Desk', 'transfer') RETURNING id`,
      [tenantId, company!.id],
    );
    await q(
      `INSERT INTO recurring_schedules (tenant_id, company_id, template_id, frequency, start_date, next_occurrence)
       VALUES ($1, $2, $3, 'monthly', '2026-01-01', '2026-01-01')`,
      [tenantId, company!.id, tpl[0]!.id],
    );
    await expect(run('0225_templates.rollback.sql')).rejects.toThrow(/0225 rollback refused/);
    expect(await tableExists('template_transactions')).toBe(true);
    await q('DELETE FROM recurring_schedules WHERE tenant_id = $1', [tenantId]);
    await q('DELETE FROM template_transactions WHERE tenant_id = $1', [tenantId]);
  });

  it('gives every old schedule a legacy template, deduped and idempotent', async () => {
    const reg = await authService.register({
      email: `m225b-${Date.now()}@example.com`, password: 'password123', displayName: 'Owner', companyName: 'M225 B',
    });
    const tenantId = reg.user.tenantId;
    tenantIds.push(tenantId);
    const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId));
    const acct = async (type: string) => (await db.query.accounts.findFirst({
      where: (a, { and: andOp, eq: eqOp }) => andOp(eqOp(a.tenantId, tenantId), eqOp(a.accountType, type)),
    }))!.id;
    const bank = (await db.query.accounts.findFirst({
      where: (a, { and: andOp, eq: eqOp }) => andOp(eqOp(a.tenantId, tenantId), eqOp(a.detailType, 'bank')),
    }))!.id;
    const expense = await acct('expense');
    const revenue = await acct('revenue');
    const post = async (txnType: 'expense' | 'journal_entry' | 'deposit' | 'invoice' | 'bill', debitAcct: string, creditAcct: string) =>
      (await ledger.postTransaction(tenantId, {
        txnType, txnDate: '2026-01-15', total: '10.0000',
        lines: [{ accountId: debitAcct, debit: '10.0000', credit: '0' }, { accountId: creditAcct, debit: '0', credit: '10.0000' }],
      }, undefined, company!.id)).id;
    const sources = {
      invoice: await post('invoice', bank, revenue),
      bill: await post('bill', expense, bank),
      expense: await post('expense', expense, bank),
      check: await post('expense', expense, bank),
      je: await post('journal_entry', expense, bank),
      deposit: await post('deposit', bank, revenue),
    };

    await run('0225_templates.rollback.sql');
    expect(await tableExists('template_transactions')).toBe(false);
    const cols = await q<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'recurring_schedules'`,
    );
    expect(cols.find((c) => c.column_name === 'template_transaction_id')!.is_nullable).toBe('NO');
    expect(cols.some((c) => c.column_name === 'template_id')).toBe(false);

    // Old-style schedules (company_id never set by the old create).
    const names: Array<[string, string | null]> = [
      [sources.invoice, 'Rent'], [sources.bill, 'rent'], [sources.expense, null], [sources.check, null],
      [sources.je, '  '], [sources.deposit, 'Weekly deposit'],
    ];
    for (const [i, [txn, name]] of names.entries()) {
      await q(
        `INSERT INTO recurring_schedules (tenant_id, template_transaction_id, name, frequency, start_date, next_occurrence, created_at)
         VALUES ($1, $2, $3, 'monthly', '2026-02-01', '2026-02-01', $4)`,
        [tenantId, txn, name, `2026-01-20T10:0${i}:00Z`],
      );
    }

    await run('0225_templates.sql');
    const rows = await q<{ sid: string; src: string; tid: string; name: string; kind: string; company_id: string; template_transaction_id: string }>(
      `SELECT rs.id AS sid, rs.template_transaction_id, t.id AS tid, t.name, t.kind, t.company_id, t.source_transaction_id AS src
       FROM recurring_schedules rs JOIN template_transactions t ON t.id = rs.template_id
       WHERE rs.tenant_id = $1 ORDER BY t.name`,
      [tenantId],
    );
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r.kind).toBe('legacy');
      expect(r.src).toBe(r.template_transaction_id);
      expect(r.company_id).toBe(company!.id);
    }
    expect(rows.map((r) => r.name).sort()).toEqual([
      'Recurring 2026-01-20', 'Recurring 2026-01-20 (2)', 'Recurring 2026-01-20 (3)',
      'Rent', 'Weekly deposit', 'rent (2)',
    ].sort());

    // Idempotent: a second run adds nothing.
    await run('0225_templates.sql');
    const again = await q<{ n: number }>(`SELECT count(*)::int AS n FROM template_transactions WHERE tenant_id = $1`, [tenantId]);
    expect(again[0]!.n).toBe(6);

    // The web list still renders, with the template name.
    const list = await recurringService.list(tenantId);
    expect(list.total).toBe(6);
    expect(list.data.every((s) => typeof s.templateId === 'string')).toBe(true);
  });
});
