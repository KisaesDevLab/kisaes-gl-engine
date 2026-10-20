// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Tenant fingerprint `fp1` (U-05, B3): a change detector over every
 * archived table's fingerprint projection F(T), the tenants row and the
 * trial balance by company. It is not a security hash. All arithmetic
 * happens in Postgres as exact numeric sums of md5 halves; JS only
 * concatenates text.
 */

import crypto from 'node:crypto';
import { ARCHIVE_AUDIT_ENTITY_TYPE, scopeSql, type PortabilityPlan, type TablePlan } from './plan.js';
import type { ArchiveClient } from './session.js';
import type { TenantFingerprint, TrialBalance, TrialBalanceRow } from './format.js';

export const TRIAL_BALANCE_DEFINITION =
  'journal_lines JOIN transactions, all statuses, grouped by company_id, account_id, status, basis; SUM(debit)::text, SUM(credit)::text, COUNT(*)';

/** Row scope of the fingerprint projection: S(T), minus the archive audit rows (S-e). */
export function fingerprintScopeSql(plan: PortabilityPlan, table: TablePlan, alias: string): string {
  const base = scopeSql(plan, table.name, alias);
  if (table.name === 'audit_log') return `${base} AND ${alias}."entity_type" <> '${ARCHIVE_AUDIT_ENTITY_TYPE}'`;
  return base;
}

export async function fingerprintTable(client: ArchiveClient, plan: PortabilityPlan, table: TablePlan, tenantId: string): Promise<{ rows: number; digest: string }> {
  const cols = table.fingerprint.map((c) => `a."${c}"`).join(', ');
  const r = await client.query(
    `SELECT count(*)::text AS n,
            COALESCE(sum(('x' || substr(h, 1, 15))::bit(60)::bigint), 0)::text || ':' ||
            COALESCE(sum(('x' || substr(h, 16, 15))::bit(60)::bigint), 0)::text AS d
     FROM (SELECT md5(row_to_json(f)::text) AS h
           FROM (SELECT ${cols} FROM "${table.name}" a WHERE ${fingerprintScopeSql(plan, table, 'a')}) f) s`,
    [tenantId],
  );
  const row = r.rows[0] as { n: string; d: string };
  return { rows: Number(row.n), digest: row.d };
}

/** Digest of the tenants row minus its volatile label columns (name, slug, updated_at). */
export async function fingerprintTenantRow(client: ArchiveClient, plan: PortabilityPlan, tenantId: string): Promise<string> {
  const cols = plan.live.tables.get('tenants')!.columns
    .map((c) => c.name)
    .filter((c) => !['name', 'slug', 'updated_at'].includes(c))
    .map((c) => `t."${c}"`)
    .join(', ');
  const r = await client.query(`SELECT md5(row_to_json(f)::text) AS h FROM (SELECT ${cols} FROM tenants t WHERE t.id = $1) f`, [tenantId]);
  return (r.rows[0] as { h: string } | undefined)?.h ?? '';
}

export async function computeTrialBalance(client: ArchiveClient, tenantId: string): Promise<TrialBalance> {
  const r = await client.query(
    `SELECT jl.company_id AS "companyId", jl.account_id AS "accountId", t.status, t.basis,
            sum(jl.debit)::text AS debit, sum(jl.credit)::text AS credit, count(*)::int AS lines
     FROM journal_lines jl
     JOIN transactions t ON t.id = jl.transaction_id
     WHERE jl.tenant_id = $1
     GROUP BY 1, 2, 3, 4
     ORDER BY 1 NULLS FIRST, 2, 3, 4`,
    [tenantId],
  );
  const rows = r.rows as TrialBalanceRow[];
  const totals = await client.query(
    `SELECT COALESCE(sum(debit), 0)::text AS debit, COALESCE(sum(credit), 0)::text AS credit FROM journal_lines WHERE tenant_id = $1`,
    [tenantId],
  );
  const t = totals.rows[0] as { debit: string; credit: string };
  return { definition: TRIAL_BALANCE_DEFINITION, rows, totals: { debit: t.debit, credit: t.credit } };
}

export async function countUnbalancedTransactions(client: ArchiveClient, tenantId: string): Promise<number> {
  const r = await client.query(
    `SELECT count(*)::int AS n FROM (
       SELECT transaction_id FROM journal_lines WHERE tenant_id = $1
       GROUP BY transaction_id HAVING sum(debit) <> sum(credit)) s`,
    [tenantId],
  );
  return (r.rows[0] as { n: number }).n;
}

/** SUM of the tenant's gl_version_stamps counters (informational, B3). */
export async function ledgerVersionSum(client: ArchiveClient, tenantId: string): Promise<string> {
  const r = await client.query('SELECT COALESCE(sum(counter), 0)::text AS v FROM gl_version_stamps WHERE tenant_id = $1', [tenantId]);
  return (r.rows[0] as { v: string }).v;
}

export function trialBalanceDigest(tb: TrialBalance): string {
  return crypto.createHash('sha256').update(JSON.stringify(tb.rows)).digest('hex');
}

export async function computeTenantFingerprint(
  client: ArchiveClient,
  plan: PortabilityPlan,
  tenantId: string,
  trialBalance?: TrialBalance,
): Promise<TenantFingerprint> {
  const tables: TenantFingerprint['tables'] = {};
  for (const t of plan.tables) tables[t.name] = await fingerprintTable(client, plan, t, tenantId);
  const tb = trialBalance ?? await computeTrialBalance(client, tenantId);
  return {
    algorithm: 'fp1',
    tenantRow: await fingerprintTenantRow(client, plan, tenantId),
    tables,
    trialBalance: trialBalanceDigest(tb),
  };
}

/** Names of the parts that differ between two fingerprints (table names, `tenantRow`, `trialBalance`). */
export function fingerprintDiff(a: TenantFingerprint, b: TenantFingerprint): string[] {
  const out: string[] = [];
  if (a.tenantRow !== b.tenantRow) out.push('tenantRow');
  if (a.trialBalance !== b.trialBalance) out.push('trialBalance');
  for (const t of new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])) {
    const x = a.tables[t];
    const y = b.tables[t];
    if (!x || !y || x.rows !== y.rows || x.digest !== y.digest) out.push(t);
  }
  return out.sort();
}
