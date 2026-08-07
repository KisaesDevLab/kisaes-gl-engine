// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// TB five-column balance engine (Phase 4, ADR-TB-01, rule TB1).
// Balances are COMPUTED from the GL at request time — never stored.
//
// Column semantics per basis (identity: Adjusted ≡ raw GL trial balance):
//   BS accounts:  Unadjusted = non-AJE activity through periodEnd
//                              + AJE activity BEFORE fyStart (prior-year
//                              AJEs live in beginning balances);
//                 AJE        = 'aje' activity in [fyStart, periodEnd].
//   P&L accounts: only [fyStart, periodEnd] activity counts (virtual
//                 year-end close); split by AJE membership. Prior-year
//                 P&L net folds into the Retained Earnings row.
//   Tax RJE      = tb_tax_entries for the tax year (never in the GL).
//   Tax          = Adjusted + Tax RJE.
//
// Values are SIGNED nets per column (+ = debit). DR/CR presentation is
// a render concern. Tag→unit splits ride journal_lines.tag_id (D13);
// lines without a mapped tag fall to the default unit; splits sum to
// the account balance by construction (asserted in tests).

import { and, eq, inArray, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
// ESM/CJS interop quirk — same dance as report.service.ts.
const Decimal = DecimalLib.default || DecimalLib;
type Dec = InstanceType<typeof Decimal>;
import { db } from '../../db/index.js';
import {
  accountTaxAssignments, activityUnits, companies, glVersionStamps,
  tagActivityMap, tbTaxEntries, tbTaxEntryLines,
} from '../../db/schema/index.js';
import { cashBasisLinesWith } from '../report.service.js';
import { taxYearOf } from './tax-profile.service.js';
import { AppError } from '../../utils/errors.js';
import { log } from '../../utils/logger.js';
import { incCounter, setGauge } from '../../utils/metrics.js';
import { tbCacheGet, tbCacheSet } from './tb-redis.js';

export const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
// Sentinel row id for prior-years retained earnings when the company
// has no designated system Retained Earnings account.
export const VIRTUAL_RE_ID = '00000000-0000-0000-0000-00000000e001';

export type TbBasis = 'accrual' | 'cash';

export interface TbUnitSplit {
  unitId: string; // ZERO_UUID = default-unit bucket before resolution
  unadjusted: number;
  aje: number;
  adjusted: number;
  taxRje: number;
  tax: number;
}

export interface TbWorkpaperRow {
  accountId: string;
  accountNumber: string | null;
  name: string;
  accountType: string;
  detailType: string | null;
  isVirtualRe: boolean;
  unadjusted: number;
  aje: number;
  adjusted: number;
  taxRje: number;
  tax: number;
  units: TbUnitSplit[];
}

export interface TbWorkpaperTotals {
  unadjustedDr: number; unadjustedCr: number;
  ajeDr: number; ajeCr: number;
  adjustedDr: number; adjustedCr: number;
  taxRjeDr: number; taxRjeCr: number;
  taxDr: number; taxCr: number;
}

export interface TbWorkpaper {
  companyId: string;
  periodEnd: string;
  fyStart: string;
  taxYear: number;
  basis: TbBasis;
  glVersionStamp: number;
  cached: boolean;
  computeMs: number;
  rows: TbWorkpaperRow[];
  totals: TbWorkpaperTotals;
}

// Effective GL change stamp for a company: its own counter plus the
// zero-uuid sentinel that accumulates tenant-wide (NULL-company)
// mutations (rule TB6).
export async function getGlVersionStamp(tenantId: string, companyId: string): Promise<number> {
  const rows = await db.select({ counter: glVersionStamps.counter }).from(glVersionStamps)
    .where(and(
      eq(glVersionStamps.tenantId, tenantId),
      inArray(glVersionStamps.companyId, [companyId, ZERO_UUID]),
    ));
  return rows.reduce((acc, r) => acc + Number(r.counter), 0);
}

function fyStartFor(periodEnd: string, fyStartMonth: number): string {
  const endDt = new Date(periodEnd + 'T00:00:00Z');
  let fyStartYear = endDt.getUTCFullYear();
  if (endDt.getUTCMonth() + 1 < fyStartMonth) fyStartYear--;
  return `${fyStartYear}-${String(fyStartMonth).padStart(2, '0')}-01`;
}

interface RawSplit {
  account_id: string;
  account_number: string | null;
  name: string;
  account_type: string;
  detail_type: string | null;
  unit_id: string;
  unadjusted: string | number;
  aje: string | number;
  prior_pl: string | number; // pre-FY P&L net (folds to RE)
}

const n = (x: string | number | null | undefined) => Number(new Decimal(x ?? 0).toFixed(4));

export interface ComputeOptions {
  periodEnd: string;
  basis: TbBasis;
  // Defaults to the tax year of periodEnd under the company's fiscal
  // calendar; explicit for tests and cross-year workpapers.
  taxYear?: number;
  skipCache?: boolean;
}

export async function computeWorkpaper(tenantId: string, companyId: string, opts: ComputeOptions): Promise<TbWorkpaper> {
  const started = Date.now();
  const [company] = await db.select({ fyStartMonth: companies.fiscalYearStartMonth })
    .from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
    .limit(1);
  if (!company) throw AppError.notFound('Company not found');
  const fyStartMonth = company.fyStartMonth ?? 1;
  const fyStart = fyStartFor(opts.periodEnd, fyStartMonth);
  const taxYear = opts.taxYear ?? taxYearOf(opts.periodEnd, fyStartMonth);
  const stamp = await getGlVersionStamp(tenantId, companyId);

  const cacheKey = `tb:wp:${tenantId}:${companyId}:${opts.periodEnd}:${opts.basis}:${taxYear}:${stamp}`;
  if (!opts.skipCache) {
    const hit = await tbCacheGet<TbWorkpaper>(cacheKey);
    if (hit) {
      incCounter('tb_workpaper_requests_total', 'TB workpaper requests', { cached: 'true', basis: opts.basis });
      return { ...hit, cached: true, computeMs: Date.now() - started };
    }
  }

  // Tag→unit resolution happens in SQL: line unit = mapped unit of the
  // line's tag, else the default unit, else the ZERO_UUID bucket (no
  // units configured). Company scope is STRICT (= companyId, NULL
  // excluded) on both bases, matching cashBasisLinesWith and
  // buildTrialBalance — the Adjusted ≡ published-TB identity depends
  // on all three agreeing.
  const raw = opts.basis === 'cash'
    ? await db.execute(sql`
        WITH ${cashBasisLinesWith(tenantId, null, opts.periodEnd, companyId)}
        SELECT a.id AS account_id, a.account_number, a.name, a.account_type, a.detail_type,
          COALESCE(tam.activity_unit_id, du.id, ${ZERO_UUID}::uuid) AS unit_id,
          COALESCE(SUM(CASE
            WHEN a.account_type IN ('asset','liability','equity')
              THEN CASE WHEN cb.txn_type = 'aje' AND cb.txn_date >= ${fyStart} THEN 0 ELSE cb.debit - cb.credit END
            ELSE CASE WHEN cb.txn_date >= ${fyStart} AND cb.txn_type <> 'aje' THEN cb.debit - cb.credit ELSE 0 END
          END), 0) AS unadjusted,
          COALESCE(SUM(CASE
            WHEN cb.txn_type = 'aje' AND cb.txn_date >= ${fyStart} THEN cb.debit - cb.credit ELSE 0
          END), 0) AS aje,
          COALESCE(SUM(CASE
            WHEN a.account_type NOT IN ('asset','liability','equity') AND cb.txn_date < ${fyStart}
              THEN cb.debit - cb.credit ELSE 0
          END), 0) AS prior_pl
        FROM cb_lines cb
        JOIN accounts a ON a.id = cb.account_id AND a.tenant_id = ${tenantId}
        LEFT JOIN tag_activity_map tam
          ON tam.company_id = ${companyId} AND tam.tag_id = cb.tag_id
        LEFT JOIN activity_units du
          ON du.company_id = ${companyId} AND du.is_default = TRUE AND du.archived_at IS NULL
        GROUP BY 1, 2, 3, 4, 5, 6
      `)
    : await db.execute(sql`
        SELECT a.id AS account_id, a.account_number, a.name, a.account_type, a.detail_type,
          COALESCE(tam.activity_unit_id, du.id, ${ZERO_UUID}::uuid) AS unit_id,
          COALESCE(SUM(CASE
            WHEN a.account_type IN ('asset','liability','equity')
              THEN CASE WHEN t.txn_type = 'aje' AND t.txn_date >= ${fyStart} THEN 0 ELSE jl.debit - jl.credit END
            ELSE CASE WHEN t.txn_date >= ${fyStart} AND t.txn_type <> 'aje' THEN jl.debit - jl.credit ELSE 0 END
          END), 0) AS unadjusted,
          COALESCE(SUM(CASE
            WHEN t.txn_type = 'aje' AND t.txn_date >= ${fyStart} THEN jl.debit - jl.credit ELSE 0
          END), 0) AS aje,
          COALESCE(SUM(CASE
            WHEN a.account_type NOT IN ('asset','liability','equity') AND t.txn_date < ${fyStart}
              THEN jl.debit - jl.credit ELSE 0
          END), 0) AS prior_pl
        FROM journal_lines jl
        JOIN transactions t ON t.id = jl.transaction_id
          AND t.tenant_id = ${tenantId} AND t.status = 'posted'
          AND t.txn_date <= ${opts.periodEnd}
          AND t.basis <> 'cash'
          AND t.company_id = ${companyId}
        JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = ${tenantId}
        LEFT JOIN tag_activity_map tam
          ON tam.company_id = ${companyId} AND tam.tag_id = jl.tag_id
        LEFT JOIN activity_units du
          ON du.company_id = ${companyId} AND du.is_default = TRUE AND du.archived_at IS NULL
        WHERE jl.tenant_id = ${tenantId} AND jl.is_void_reversal = FALSE
        GROUP BY 1, 2, 3, 4, 5, 6
      `);
  // Tax RJEs for the tax year, per (account, unit-or-null).
  const rjeRows = await db.select({
    accountId: tbTaxEntryLines.accountId,
    unitId: tbTaxEntryLines.activityUnitId,
    debit: sql<string>`COALESCE(SUM(${tbTaxEntryLines.debit}), 0)`,
    credit: sql<string>`COALESCE(SUM(${tbTaxEntryLines.credit}), 0)`,
  }).from(tbTaxEntryLines)
    .innerJoin(tbTaxEntries, eq(tbTaxEntryLines.entryId, tbTaxEntries.id))
    .where(and(
      eq(tbTaxEntries.tenantId, tenantId),
      eq(tbTaxEntries.companyId, companyId),
      eq(tbTaxEntries.taxYear, taxYear),
    ))
    .groupBy(tbTaxEntryLines.accountId, tbTaxEntryLines.activityUnitId);

  // Default unit for bucketing account-level (NULL-unit) RJE lines.
  const [defaultUnit] = await db.select({ id: activityUnits.id }).from(activityUnits)
    .where(and(
      eq(activityUnits.companyId, companyId),
      eq(activityUnits.isDefault, true),
      sql`${activityUnits.archivedAt} IS NULL`,
    )).limit(1);
  const defaultUnitId = defaultUnit?.id ?? ZERO_UUID;

  // The designated Retained Earnings account (prior-years P&L folds
  // into it, mirroring buildBalanceSheet/buildTrialBalance).
  const reRow = await db.execute(sql`
    SELECT id, account_number, name FROM accounts
    WHERE tenant_id = ${tenantId} AND system_tag = 'retained_earnings'
      AND (company_id = ${companyId} OR company_id IS NULL)
    ORDER BY company_id NULLS LAST LIMIT 1
  `);
  const reAccount = (reRow.rows as Array<{ id: string; account_number: string | null; name: string }>)[0] ?? null;

  // ── Assemble rows ────────────────────────────────────────────────
  interface Acc {
    row: TbWorkpaperRow;
    unadj: Dec; aje: Dec; rje: Dec;
    units: Map<string, { unadj: Dec; aje: Dec; rje: Dec }>;
  }
  const byAccount = new Map<string, Acc>();
  let priorPl: Dec = new Decimal(0);
  const priorPlByUnit = new Map<string, Dec>();

  const ensure = (id: string, meta: { account_number: string | null; name: string; account_type: string; detail_type: string | null }, isVirtualRe = false): Acc => {
    let acc = byAccount.get(id);
    if (!acc) {
      acc = {
        row: {
          accountId: id,
          accountNumber: meta.account_number,
          name: meta.name,
          accountType: meta.account_type,
          detailType: meta.detail_type,
          isVirtualRe,
          unadjusted: 0, aje: 0, adjusted: 0, taxRje: 0, tax: 0,
          units: [],
        },
        unadj: new Decimal(0), aje: new Decimal(0), rje: new Decimal(0),
        units: new Map(),
      };
      byAccount.set(id, acc);
    }
    return acc;
  };
  const unitBucket = (acc: Acc, unitId: string) => {
    let u = acc.units.get(unitId);
    if (!u) {
      u = { unadj: new Decimal(0), aje: new Decimal(0), rje: new Decimal(0) };
      acc.units.set(unitId, u);
    }
    return u;
  };

  for (const r of raw.rows as unknown as RawSplit[]) {
    const acc = ensure(r.account_id, r);
    const u = unitBucket(acc, r.unit_id);
    acc.unadj = acc.unadj.plus(r.unadjusted ?? 0);
    acc.aje = acc.aje.plus(r.aje ?? 0);
    u.unadj = u.unadj.plus(r.unadjusted ?? 0);
    u.aje = u.aje.plus(r.aje ?? 0);
    const pl = new Decimal(r.prior_pl ?? 0);
    if (!pl.isZero()) {
      priorPl = priorPl.plus(pl);
      priorPlByUnit.set(r.unit_id, (priorPlByUnit.get(r.unit_id) ?? new Decimal(0)).plus(pl));
    }
  }

  // Fold prior-years P&L into Retained Earnings (its natural credit
  // balance arrives as a negative signed net, which is correct).
  if (!priorPl.isZero()) {
    const acc = reAccount
      ? ensure(reAccount.id, { account_number: reAccount.account_number, name: reAccount.name, account_type: 'equity', detail_type: 'retained_earnings' })
      : ensure(VIRTUAL_RE_ID, { account_number: '30120', name: 'Retained Earnings (Prior Years)', account_type: 'equity', detail_type: 'retained_earnings' }, true);
    acc.unadj = acc.unadj.plus(priorPl);
    for (const [unitId, amt] of priorPlByUnit) {
      const u = unitBucket(acc, unitId);
      u.unadj = u.unadj.plus(amt);
    }
  }

  for (const r of rjeRows) {
    const acc = byAccount.get(r.accountId) ?? await (async () => {
      const meta = await db.execute(sql`SELECT account_number, name, account_type, detail_type FROM accounts WHERE id = ${r.accountId} AND tenant_id = ${tenantId}`);
      const m = (meta.rows as Array<{ account_number: string | null; name: string; account_type: string; detail_type: string | null }>)[0];
      return ensure(r.accountId, m ?? { account_number: null, name: 'Unknown account', account_type: 'other', detail_type: null });
    })();
    const net = new Decimal(r.debit).minus(r.credit);
    acc.rje = acc.rje.plus(net);
    const u = unitBucket(acc, r.unitId ?? defaultUnitId);
    u.rje = u.rje.plus(net);
  }

  // Finalize rows, drop all-zero accounts, compute totals.
  const totals = {
    unadjustedDr: new Decimal(0), unadjustedCr: new Decimal(0),
    ajeDr: new Decimal(0), ajeCr: new Decimal(0),
    adjustedDr: new Decimal(0), adjustedCr: new Decimal(0),
    taxRjeDr: new Decimal(0), taxRjeCr: new Decimal(0),
    taxDr: new Decimal(0), taxCr: new Decimal(0),
  };
  const addTotal = (dr: keyof typeof totals, cr: keyof typeof totals, v: Dec) => {
    if (v.gt(0)) totals[dr] = totals[dr].plus(v);
    else totals[cr] = totals[cr].plus(v.neg());
  };

  const rows: TbWorkpaperRow[] = [];
  for (const acc of byAccount.values()) {
    const adjusted = acc.unadj.plus(acc.aje);
    const tax = adjusted.plus(acc.rje);
    if (acc.unadj.isZero() && acc.aje.isZero() && acc.rje.isZero()) continue;
    acc.row.unadjusted = n(acc.unadj.toString());
    acc.row.aje = n(acc.aje.toString());
    acc.row.adjusted = n(adjusted.toString());
    acc.row.taxRje = n(acc.rje.toString());
    acc.row.tax = n(tax.toString());
    acc.row.units = [...acc.units.entries()]
      .filter(([, u]) => !(u.unadj.isZero() && u.aje.isZero() && u.rje.isZero()))
      .map(([unitId, u]) => {
        const uAdj = u.unadj.plus(u.aje);
        return {
          unitId,
          unadjusted: n(u.unadj.toString()),
          aje: n(u.aje.toString()),
          adjusted: n(uAdj.toString()),
          taxRje: n(u.rje.toString()),
          tax: n(uAdj.plus(u.rje).toString()),
        };
      });
    addTotal('unadjustedDr', 'unadjustedCr', acc.unadj);
    addTotal('ajeDr', 'ajeCr', acc.aje);
    addTotal('adjustedDr', 'adjustedCr', adjusted);
    addTotal('taxRjeDr', 'taxRjeCr', acc.rje);
    addTotal('taxDr', 'taxCr', tax);
    rows.push(acc.row);
  }
  rows.sort((a, b) => (a.accountNumber ?? '').localeCompare(b.accountNumber ?? '') || a.name.localeCompare(b.name));

  const workpaper: TbWorkpaper = {
    companyId,
    periodEnd: opts.periodEnd,
    fyStart,
    taxYear,
    basis: opts.basis,
    glVersionStamp: stamp,
    cached: false,
    computeMs: Date.now() - started,
    rows,
    totals: Object.fromEntries(
      Object.entries(totals).map(([k, v]) => [k, n(v.toString())]),
    ) as unknown as TbWorkpaperTotals,
  };
  if (!opts.skipCache) await tbCacheSet(cacheKey, workpaper);
  incCounter('tb_workpaper_requests_total', 'TB workpaper requests', { cached: 'false', basis: opts.basis });
  setGauge('tb_workpaper_compute_ms', 'Last uncached TB workpaper compute time (ms)', workpaper.computeMs, { basis: opts.basis });
  log.debug({ component: 'tb', event: 'workpaper_computed', companyId, basis: opts.basis, rowCount: rows.length, ms: workpaper.computeMs });
  return workpaper;
}

// Resolved code assignments for the workpaper screen: one lookup per
// (account [, unit]) merged client-side with the balance rows.
export async function listAssignments(tenantId: string, companyId: string) {
  return db.select().from(accountTaxAssignments)
    .where(and(eq(accountTaxAssignments.tenantId, tenantId), eq(accountTaxAssignments.companyId, companyId)));
}
