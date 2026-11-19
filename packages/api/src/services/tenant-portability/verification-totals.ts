// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Verification totals (U-283, definition `vt1`): readable figures an owner
 * and an accountant can compare, taken by the export from its snapshot,
 * offered as a preview, written to the manifest, and recomputed by the
 * import (expected vs actual).
 *
 * vt1, per company and accrual basis, posted entries only
 * (`transactions.status = 'posted'`, `basis IN ('both','accrual')`), dated
 * on or before `asOf`:
 *   totalAssets       = Σ(debit − credit), account_type asset
 *   totalLiabilities  = Σ(credit − debit), account_type liability
 *   totalEquity       = Σ(credit − debit), every other account type (equity
 *                       plus every income and expense type, so current and
 *                       unclosed earnings are in it and A = L + E exactly)
 *   netIncome         = Σ(credit − debit) over revenue, other_revenue, cogs,
 *                       expense and other_expense from `fiscalYearStart` to `asOf`
 *   accountsReceivable= Σ(debit − credit), accounts with system_tag accounts_receivable
 *   accountsPayable   = Σ(credit − debit), accounts with system_tag accounts_payable
 *   trialBalance      = {Σ debit, Σ credit} of the same lines
 * Amounts are SQL numeric rounded to 4 places, as decimal strings (never
 * JSON numbers). `fiscalYearStart` is the start of the company's fiscal
 * year (companies.fiscal_year_start_month) containing `asOf`.
 *
 * Counts (per company, and tenant-wide including rows with no company) are
 * the rows that travel: accounts, clients (contacts customer|both), vendors
 * (vendor|both), items, transactions (every status), postedTransactions,
 * attachments and attachmentBytes (Σ attachments.file_size), auditEntries.
 * In a tenant with one company, rows with no company_id count for it (money
 * too); with several, they count in the tenant-wide counts only.
 * A `scope` function gives the row scope, so an export counts through its
 * own omissions (exportScopeSql) and the import counts what it inserted.
 *
 * Every query is plain SQL on the caller's connection: no viewer filter
 * applies, so hidden (sensitive) accounts always count.
 */

import { AppError } from '../../utils/errors.js';
import { ArchiveError } from './errors.js';
import type { ArchiveClient } from './session.js';

export const VERIFICATION_TOTALS_DEFINITION = 'vt1';

export const VT_MONEY_FIELDS = [
  'totalAssets', 'totalLiabilities', 'totalEquity', 'netIncome', 'accountsReceivable', 'accountsPayable', 'trialBalanceDebits', 'trialBalanceCredits',
] as const;
export type VtMoneyField = typeof VT_MONEY_FIELDS[number];

export const VT_COUNT_FIELDS = [
  'accounts', 'clients', 'vendors', 'items', 'transactions', 'postedTransactions', 'attachments', 'attachmentBytes', 'auditEntries',
] as const;
export type VtCountField = typeof VT_COUNT_FIELDS[number];

export type VerificationCounts = Record<VtCountField, number>;

export interface CompanyVerificationTotals {
  companyId: string;
  name: string;
  fiscalYearStart: string;
  totalAssets: string;
  totalLiabilities: string;
  totalEquity: string;
  netIncome: { from: string; to: string; amount: string };
  accountsReceivable: string;
  accountsPayable: string;
  trialBalance: { debits: string; credits: string };
  counts: VerificationCounts;
}

export interface VerificationTotals {
  definition: typeof VERIFICATION_TOTALS_DEFINITION;
  basis: 'accrual';
  asOf: string;
  /** Every company of the tenant, by id. */
  companies: CompanyVerificationTotals[];
  /** Tenant-wide counts (rows with no company included). */
  counts: VerificationCounts;
}

/** Row scope over `alias` for a table; binds the tenant id as $1. */
export type ScopeFn = (table: string, alias: string) => string;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The as-of date of a request: the caller's (the owner's local date) or
 * the server's today (UTC). A date later than the server's tomorrow is 400
 * VALIDATION_ERROR (a clock a day ahead of UTC is still accepted).
 */
export function resolveAsOf(raw: string | undefined | null, now = new Date()): string {
  if (raw === undefined || raw === null || raw === '') return ymd(now);
  if (!isValidDate(raw)) throw AppError.badRequest('asOf must be a date (YYYY-MM-DD).', 'VALIDATION_ERROR', { field: 'asOf' });
  const tomorrow = ymd(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  if (raw > tomorrow) throw AppError.badRequest('asOf may not be later than tomorrow.', 'VALIDATION_ERROR', { field: 'asOf' });
  return raw;
}

/** First day of the fiscal year (start month 1-12) that contains `asOf`. */
export function fiscalYearStartFor(asOf: string, startMonth: number): string {
  const m = Number.isInteger(startMonth) && startMonth >= 1 && startMonth <= 12 ? startMonth : 1;
  const year = Number(asOf.slice(0, 4));
  const month = Number(asOf.slice(5, 7));
  const y = month < m ? year - 1 : year;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
}

function zeroCounts(): VerificationCounts {
  return Object.fromEntries(VT_COUNT_FIELDS.map((f) => [f, 0])) as VerificationCounts;
}

const NO_COMPANY = '';

async function countBy(client: ArchiveClient, tenantId: string, sql: string): Promise<Map<string, number>> {
  const r = await client.query(sql, [tenantId]);
  const out = new Map<string, number>();
  for (const row of r.rows as Array<{ c: string | null; n: string }>) out.set(row.c ?? NO_COMPANY, Number(row.n));
  return out;
}

/**
 * Computes vt1 for a tenant on `client` (inside the caller's transaction,
 * so an export's snapshot gives the figures of the file). `fiscalYearStart`
 * per company overrides the derived start (the import passes the archive's,
 * so both sides use the same window).
 */
export async function computeVerificationTotals(
  client: ArchiveClient,
  tenantId: string,
  opts: { asOf: string; scope: ScopeFn; fiscalYearStart?: (companyId: string) => string | undefined; mapCompanyId?: (companyId: string) => string },
): Promise<VerificationTotals> {
  const { asOf, scope } = opts;
  if (!isValidDate(asOf)) throw new ArchiveError('ARCHIVE_CORRUPT', 'The verification totals date is not a date.');
  const companies = (await client.query(
    `SELECT a.id::text AS id, a.business_name AS name, a.fiscal_year_start_month AS m FROM companies a WHERE ${scope('companies', 'a')} ORDER BY a.id`,
    [tenantId],
  )).rows as Array<{ id: string; name: string | null; m: number | null }>;

  // Counts, grouped by company ('' = no company).
  const countSql = (table: string, extra = '', what = 'count(*)') =>
    `SELECT a.company_id::text AS c, ${what}::text AS n FROM "${table}" a WHERE ${scope(table, 'a')}${extra} GROUP BY 1`;
  const counts: Record<VtCountField, Map<string, number>> = {
    accounts: await countBy(client, tenantId, countSql('accounts')),
    clients: await countBy(client, tenantId, countSql('contacts', ` AND a.contact_type IN ('customer','both')`)),
    vendors: await countBy(client, tenantId, countSql('contacts', ` AND a.contact_type IN ('vendor','both')`)),
    items: await countBy(client, tenantId, countSql('items')),
    transactions: await countBy(client, tenantId, countSql('transactions')),
    postedTransactions: await countBy(client, tenantId, countSql('transactions', ` AND a.status = 'posted'`)),
    attachments: await countBy(client, tenantId, countSql('attachments')),
    attachmentBytes: await countBy(client, tenantId, countSql('attachments', '', 'COALESCE(sum(a.file_size), 0)')),
    auditEntries: await countBy(client, tenantId, countSql('audit_log')),
  };
  const tenantCounts = zeroCounts();
  for (const f of VT_COUNT_FIELDS) for (const n of counts[f].values()) tenantCounts[f] += n;

  // Money, per company, from the ledger lines of posted accrual entries. In a
  // one-company tenant, rows with no company (tenant-wide accounts, older
  // lines) are that company's; with several companies they count tenant-wide only.
  const single = companies.length === 1;
  const out: CompanyVerificationTotals[] = [];
  for (const co of companies) {
    const fyStart = opts.fiscalYearStart?.(co.id) ?? fiscalYearStartFor(asOf, co.m ?? 1);
    if (!isValidDate(fyStart)) throw new ArchiveError('ARCHIVE_CORRUPT', 'The verification totals window is not a date.');
    const r = await client.query(
      `SELECT
         round(COALESCE(sum(jl.debit - jl.credit) FILTER (WHERE ac.account_type = 'asset'), 0), 4)::text AS assets,
         round(COALESCE(sum(jl.credit - jl.debit) FILTER (WHERE ac.account_type = 'liability'), 0), 4)::text AS liabilities,
         round(COALESCE(sum(jl.credit - jl.debit) FILTER (WHERE ac.account_type NOT IN ('asset', 'liability')), 0), 4)::text AS equity,
         round(COALESCE(sum(jl.credit - jl.debit) FILTER (WHERE ac.account_type IN ('revenue', 'other_revenue', 'cogs', 'expense', 'other_expense')
                                                         AND t.txn_date >= $4::date), 0), 4)::text AS net_income,
         round(COALESCE(sum(jl.debit - jl.credit) FILTER (WHERE ac.system_tag = 'accounts_receivable'), 0), 4)::text AS ar,
         round(COALESCE(sum(jl.credit - jl.debit) FILTER (WHERE ac.system_tag = 'accounts_payable'), 0), 4)::text AS ap,
         round(COALESCE(sum(jl.debit), 0), 4)::text AS debits,
         round(COALESCE(sum(jl.credit), 0), 4)::text AS credits
       FROM journal_lines jl
       JOIN transactions t ON t.id = jl.transaction_id
       JOIN accounts ac ON ac.id = jl.account_id
       WHERE jl.tenant_id = $1 AND (jl.company_id = $2::uuid OR ($5::boolean AND jl.company_id IS NULL))
         AND t.status = 'posted' AND t.basis IN ('both', 'accrual') AND t.txn_date <= $3::date`,
      [tenantId, co.id, asOf, fyStart, single],
    );
    const m = r.rows[0] as Record<string, string>;
    const c = zeroCounts();
    for (const f of VT_COUNT_FIELDS) c[f] = (counts[f].get(co.id) ?? 0) + (single ? counts[f].get(NO_COMPANY) ?? 0 : 0);
    out.push({
      companyId: opts.mapCompanyId ? opts.mapCompanyId(co.id) : co.id,
      name: co.name ?? '',
      fiscalYearStart: fyStart,
      totalAssets: m['assets']!,
      totalLiabilities: m['liabilities']!,
      totalEquity: m['equity']!,
      netIncome: { from: fyStart, to: asOf, amount: m['net_income']! },
      accountsReceivable: m['ar']!,
      accountsPayable: m['ap']!,
      trialBalance: { debits: m['debits']!, credits: m['credits']! },
      counts: c,
    });
  }
  out.sort((a, b) => a.companyId.localeCompare(b.companyId));
  return { definition: VERIFICATION_TOTALS_DEFINITION, basis: 'accrual', asOf, companies: out, counts: tenantCounts };
}

// ── Comparison (import, Q-P32o) ──────────────────────────────────────

export interface TotalsDifference {
  /** The company's id in the archive, or null for tenant-wide counts. */
  companyId: string | null;
  field: string;
  expected: string | number | null;
  actual: string | number | null;
}

export interface TotalsComparison {
  definition: string;
  /** The archive's totals (null when the archive carries none, e.g. formatVersion 1). */
  expected: VerificationTotals | null;
  actual: VerificationTotals;
  /** null when there is nothing to compare against. */
  matches: boolean | null;
  differences: TotalsDifference[];
  /** Upgrade backfills that ran in this import and the money fields they changed. */
  backfills: Array<{ name: string; fields: string[] }>;
}

function moneyOf(c: CompanyVerificationTotals, f: VtMoneyField): string {
  switch (f) {
    case 'netIncome': return c.netIncome.amount;
    case 'trialBalanceDebits': return c.trialBalance.debits;
    case 'trialBalanceCredits': return c.trialBalance.credits;
    default: return c[f];
  }
}

/** Money fields that differ between two computations of the same tenant (backfill attribution). */
export function changedMoneyFields(before: VerificationTotals, after: VerificationTotals): string[] {
  const out = new Set<string>();
  const byId = new Map(after.companies.map((c) => [c.companyId, c]));
  for (const b of before.companies) {
    const a = byId.get(b.companyId);
    if (!a) continue;
    for (const f of VT_MONEY_FIELDS) if (moneyOf(a, f) !== moneyOf(b, f)) out.add(f);
  }
  return [...out].sort();
}

/**
 * Differences between the archive's totals and the import's: counts
 * strictly, money by exact decimal string, company by company (ids in the
 * archive's terms). With another definition only the counts are compared.
 */
export function diffTotals(expected: VerificationTotals, actual: VerificationTotals): { counts: TotalsDifference[]; money: TotalsDifference[] } {
  const counts: TotalsDifference[] = [];
  const money: TotalsDifference[] = [];
  for (const f of VT_COUNT_FIELDS) {
    if (expected.counts[f] !== actual.counts[f]) counts.push({ companyId: null, field: `counts.${f}`, expected: expected.counts[f] ?? null, actual: actual.counts[f] ?? null });
  }
  const act = new Map(actual.companies.map((c) => [c.companyId, c]));
  const exp = new Map(expected.companies.map((c) => [c.companyId, c]));
  for (const e of expected.companies) {
    const a = act.get(e.companyId);
    if (!a) {
      counts.push({ companyId: e.companyId, field: 'company', expected: e.companyId, actual: null });
      continue;
    }
    for (const f of VT_COUNT_FIELDS) {
      if (e.counts[f] !== a.counts[f]) counts.push({ companyId: e.companyId, field: `counts.${f}`, expected: e.counts[f] ?? null, actual: a.counts[f] ?? null });
    }
    if (expected.definition === actual.definition) {
      for (const f of VT_MONEY_FIELDS) {
        const x = moneyOf(e, f);
        const y = moneyOf(a, f);
        if (x !== y) money.push({ companyId: e.companyId, field: f, expected: x, actual: y });
      }
    }
  }
  for (const a of actual.companies) {
    if (!exp.has(a.companyId)) counts.push({ companyId: a.companyId, field: 'company', expected: null, actual: a.companyId });
  }
  return { counts, money };
}

// ── Manifest shape check ─────────────────────────────────────────────

const AMOUNT_RE = /^-?\d{1,20}\.\d{4}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validCounts(v: unknown): boolean {
  return isObj(v) && VT_COUNT_FIELDS.every((f) => Number.isSafeInteger(v[f]) && (v[f] as number) >= 0);
}

/**
 * Shape check of a manifest's `verificationTotals` (absent before U-283).
 * A definition this engine does not know passes with its counts checked
 * only; its money is shown, never compared.
 */
export function validateManifestTotals(raw: unknown): boolean {
  if (!isObj(raw) || typeof raw['definition'] !== 'string' || !/^vt\d{1,4}$/.test(raw['definition'])) return false;
  if (typeof raw['asOf'] !== 'string' || !isValidDate(raw['asOf'])) return false;
  if (!validCounts(raw['counts']) || !Array.isArray(raw['companies']) || raw['companies'].length > 10_000) return false;
  for (const c of raw['companies'] as unknown[]) {
    if (!isObj(c) || typeof c['companyId'] !== 'string' || !UUID_RE.test(c['companyId']) || !validCounts(c['counts'])) return false;
    if (typeof c['name'] !== 'string' || c['name'].length > 255) return false;
    if (raw['definition'] !== VERIFICATION_TOTALS_DEFINITION) continue;
    if (typeof c['fiscalYearStart'] !== 'string' || !isValidDate(c['fiscalYearStart'])) return false;
    for (const f of ['totalAssets', 'totalLiabilities', 'totalEquity', 'accountsReceivable', 'accountsPayable'] as const) {
      if (typeof c[f] !== 'string' || !AMOUNT_RE.test(c[f] as string)) return false;
    }
    const ni = c['netIncome'];
    if (!isObj(ni) || typeof ni['amount'] !== 'string' || !AMOUNT_RE.test(ni['amount'])) return false;
    const tb = c['trialBalance'];
    if (!isObj(tb) || typeof tb['debits'] !== 'string' || !AMOUNT_RE.test(tb['debits']) || typeof tb['credits'] !== 'string' || !AMOUNT_RE.test(tb['credits'])) return false;
  }
  return true;
}
