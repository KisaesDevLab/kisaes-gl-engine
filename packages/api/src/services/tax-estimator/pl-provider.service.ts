// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax-basis P&L provider (MODULE.md "Tax-treatment map", "Federal calculation
// order" steps 1-2, D3, D8). Books → engine input, applied BEFORE the engine:
//
//   P&L per month on the entity's EFFECTIVE tax method (report.service
//   buildProfitAndLoss — the same virtual cash ledger every report uses)
//   → character from TB account_tax_assignments (unassigned = ordinary + warning)
//   → estimator treatments (owner SEHI / retirement routed to the owner,
//     owner_personal dropped, estimated-tax payments removed and returned as
//     payment transactions, nondeductible % added back, tax depreciation
//     flagged) → non-recurring split (account flag OR transaction flag).
//
// This file never aggregates the ledger itself: month P&L comes from
// buildProfitAndLoss, line detail (payments, flagged transactions) from
// buildAccountDetailReport, TB tax RJEs from computeWorkpaper. Its own SQL
// reads only estimator / TB configuration rows, always pinned to the single
// tenant verified against the firm scope (D1).
//
// SIGN CONVENTION (see shared entities-api.ts): profit-positive amounts
// (income +, expense −); owner-level amounts, payments, add-backs, wages and
// farming gross income are positive magnitudes. Money is decimal.js in here
// and leaves as 4-place strings.

import { and, eq, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import type {
  AccountTreatment, CharacterAmounts, EntityTaxType, EstimatedTaxPaymentTxn, IncomeCharacter,
  ResolvedEntityTax, TaxBasisAccountLine, TaxBasisMonth, TaxBasisPl, TaxCodeRef, TaxEstimatorWarning,
  TaxMethod, TraceRow, TreatmentRoute,
} from '@kis-books/shared';
import { INCOME_CHARACTERS } from '@kis-books/shared';
import { db } from '../../db/index.js';
import {
  taxEstAccountTreatments, taxEstEntityYearInputs, taxEstTransactionFlags, transactions,
} from '../../db/schema/index.js';
import { buildAccountDetailReport, buildProfitAndLoss, type PLResult } from '../report.service.js';
import { computeWorkpaper, getGlVersionStamp, listAssignments } from '../tb/balance-engine.service.js';
import { listAvailableCodes } from '../tb/assignments.service.js';
import { taxYearOf } from '../tb/tax-profile.service.js';
import { tbCacheGet, tbCacheSet } from '../tb/tb-redis.js';
import { AppError } from '../../utils/errors.js';
import { log } from '../../utils/logger.js';
import type { FirmScope } from './firm-scope.service.js';
import { assertEntityInScope, resolveForCompany } from './entity-type.service.js';

const Decimal = DecimalLib.default || DecimalLib;
type Dec = InstanceType<typeof Decimal>;
const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);
const s4 = (d: Dec) => d.toFixed(4);
const dec = (x: string | number | null | undefined) => new Decimal(x ?? 0);

const PL_TYPES = ['revenue', 'cogs', 'expense', 'other_revenue', 'other_expense'] as const;
const INCOME_TYPES = new Set(['revenue', 'other_revenue']);
const ALL_ACCOUNT_TYPES = ['asset', 'liability', 'equity', ...PL_TYPES];
const FARM_ACTIVITIES = new Set(['farm', 'farm_rental']);
const CACHE_VERSION = 'v1';

// ── Pure helpers (exported for tests) ──────────────────────────────

export interface TaxYearWindow { start: string; end: string; startMonth: string; endMonth: string }

const pad2 = (n: number) => String(n).padStart(2, '0');
const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const monthEnd = (ym: string) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return `${ym}-${pad2(lastDayOf(y, m))}`;
};

/**
 * Individuals and pass-throughs use the calendar year; C corps use the entity
 * fiscal year whose LABEL is `taxYear` (TB10: the FY containing its end date).
 */
export function taxYearWindow(taxYear: number, entityType: EntityTaxType | null, fiscalYearStartMonth: number): TaxYearWindow {
  if (entityType !== 'c_corp' || fiscalYearStartMonth <= 1) {
    return { start: `${taxYear}-01-01`, end: `${taxYear}-12-31`, startMonth: `${taxYear}-01`, endMonth: `${taxYear}-12` };
  }
  const startMonth = `${taxYear - 1}-${pad2(fiscalYearStartMonth)}`;
  const endMonth = `${taxYear}-${pad2(fiscalYearStartMonth - 1)}`;
  return { start: `${startMonth}-01`, end: monthEnd(endMonth), startMonth, endMonth };
}

export function monthsBetween(startMonth: string, endMonth: string): string[] {
  const out: string[] = [];
  let [y, m] = startMonth.split('-').map(Number) as [number, number];
  const [ey, em] = endMonth.split('-').map(Number) as [number, number];
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${pad2(m)}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** Default range end: the window's last month, clipped to the current month. */
export function resolveThroughMonth(window: TaxYearWindow, requested: string | undefined, today = new Date()): string {
  if (requested) {
    if (requested < window.startMonth || requested > window.endMonth) {
      throw AppError.badRequest(`through must be between ${window.startMonth} and ${window.endMonth}`, 'TE_THROUGH_OUT_OF_RANGE');
    }
    return requested;
  }
  const current = `${today.getUTCFullYear()}-${pad2(today.getUTCMonth() + 1)}`;
  if (current < window.startMonth) return window.startMonth;
  return current > window.endMonth ? window.endMonth : current;
}

export interface CacheKeyParts {
  tenantId: string; companyId: string; taxYear: number; basis: TaxMethod;
  throughMonth: string; glVersionStamp: number; configVersion: string;
}

/** TB1/TB6 pattern: the GL stamp + estimator config version make invalidation exact. */
export function taxBasisCacheKey(p: CacheKeyParts): string {
  return `te:pl:${CACHE_VERSION}:${p.tenantId}:${p.companyId}:${p.taxYear}:${p.basis}:${p.throughMonth}:${p.glVersionStamp}:${p.configVersion}`;
}

/**
 * Income character from a TB tax code. Rental activities (Sch E / 8825 /
 * 4835) are `rental`; capital gain / §1231 lines keep their character on any
 * P&L account (losses included); interest and dividends only on income
 * accounts (an interest EXPENSE code is an ordinary deduction). Everything
 * else is ordinary. Exported for tests.
 */
export function characterForCode(code: TaxCodeRef, accountType: string): IncomeCharacter {
  if (code.activityType === 'rental' || code.activityType === 'farm_rental') return 'rental';
  const d = code.description.toLowerCase();
  if (/capital gain/.test(d) && !/capital gain property/.test(d)) {
    return /short[-\s]?term/.test(d) ? 'capital_gain_st' : 'capital_gain_lt';
  }
  if (/\b1231\b|\b4797\b/.test(d)) return 'section_1231';
  if (INCOME_TYPES.has(accountType)) {
    if (/qualified dividend/.test(d)) return 'dividends_qualified';
    if (/dividend/.test(d) && !/distribution/.test(d)) return 'dividends_ordinary';
    if (/interest/.test(d)) return 'interest';
  }
  return 'ordinary';
}

export function isTaxExemptCode(code: TaxCodeRef): boolean {
  return /tax[-\s]?exempt/.test(code.description.toLowerCase());
}

const emptyChars = (): Record<IncomeCharacter, Dec> =>
  Object.fromEntries(INCOME_CHARACTERS.map((c) => [c, ZERO])) as Record<IncomeCharacter, Dec>;
const charsOut = (c: Record<IncomeCharacter, Dec>): CharacterAmounts =>
  Object.fromEntries(INCOME_CHARACTERS.map((k) => [k, s4(c[k])])) as CharacterAmounts;
const sumChars = (c: Record<IncomeCharacter, Dec>) => INCOME_CHARACTERS.reduce((acc, k) => acc.plus(c[k]), ZERO);

interface TreatmentRow {
  accountId: string;
  treatment: AccountTreatment | null;
  pct: string | null;
  paymentTaxpayerId: string | null;
  paymentPersonId: string | null;
  paymentJurisdiction: string | null;
  nonRecurring: boolean;
}

/** Entity-profit share of a book amount under a treatment (linear in x). */
export function entityShare(x: Dec, t: TreatmentRow | undefined, taxExempt: boolean): Dec {
  if (taxExempt) return ZERO;
  switch (t?.treatment) {
    case 'owner_sehi':
    case 'owner_retirement':
    case 'owner_personal':
    case 'estimated_tax_payment':
      return ZERO;
    case 'nondeductible_pct':
      return x.minus(x.times(dec(t.pct)).dividedBy(HUNDRED));
    default:
      return x;
  }
}

function routeOf(t: TreatmentRow | undefined, taxExempt: boolean): TreatmentRoute {
  if (taxExempt) return 'dropped';
  switch (t?.treatment) {
    case 'owner_sehi': return 'owner_sehi';
    case 'owner_retirement': return 'owner_retirement';
    case 'owner_personal': return 'dropped';
    case 'estimated_tax_payment': return 'payment';
    default: return 'entity';
  }
}

const isoDate = (v: unknown): string => {
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

// ── Config version (estimator + TB configuration that the GL stamp misses) ──

/**
 * Hash of everything besides the GL that changes the result: estimator
 * treatments, transaction flags, settings and year inputs (so treatment and
 * entity-setting writes invalidate the cache explicitly by changing the key),
 * TB assignments / profile / tax RJEs, and account + company metadata.
 */
export async function loadConfigVersion(tenantId: string, companyId: string, taxYear: number): Promise<string> {
  const res = await db.execute<{ v: string }>(sql`
    SELECT md5(concat_ws('|',
      (SELECT count(*)::text || ':' || coalesce(max(updated_at)::text, '') FROM tax_est_account_treatments
        WHERE tenant_id = ${tenantId} AND company_id = ${companyId}),
      (SELECT count(*)::text || ':' || coalesce(max(f.updated_at)::text, '') FROM tax_est_transaction_flags f
        JOIN transactions t ON t.id = f.transaction_id AND t.tenant_id = ${tenantId}
        WHERE f.tenant_id = ${tenantId} AND t.company_id = ${companyId}),
      (SELECT coalesce(max(updated_at)::text, '') FROM tax_est_entity_settings
        WHERE tenant_id = ${tenantId} AND company_id = ${companyId}),
      (SELECT coalesce(max(updated_at)::text, '') FROM tax_est_entity_year_inputs
        WHERE tenant_id = ${tenantId} AND company_id = ${companyId} AND tax_year = ${taxYear}),
      (SELECT count(*)::text || ':' || coalesce(max(updated_at)::text, '') FROM account_tax_assignments
        WHERE tenant_id = ${tenantId} AND company_id = ${companyId}),
      (SELECT coalesce(max(updated_at)::text, '') FROM company_tax_profiles
        WHERE tenant_id = ${tenantId} AND company_id = ${companyId}),
      (SELECT count(*)::text || ':' || coalesce(max(updated_at)::text, '') FROM tb_tax_entries
        WHERE tenant_id = ${tenantId} AND company_id = ${companyId}),
      (SELECT count(*)::text || ':' || coalesce(max(updated_at)::text, '') FROM accounts
        WHERE tenant_id = ${tenantId}),
      (SELECT coalesce(max(updated_at)::text, '') FROM companies
        WHERE tenant_id = ${tenantId} AND id = ${companyId})
    )) AS v
  `);
  return (res.rows as Array<{ v: string }>)[0]?.v ?? 'none';
}

// ── Code + assignment lookup ───────────────────────────────────────

interface AccountMeta { accountId: string; accountNumber: string | null; name: string; accountType: string }

async function loadCharacterMap(tenantId: string, companyId: string, returnForm: string | null): Promise<Map<string, TaxCodeRef>> {
  const assignments = await listAssignments(tenantId, companyId);
  if (assignments.length === 0) return new Map();
  // Descriptions come from the TB filtered code surface (never the raw seed
  // table). No profile / no seed → codes resolve with an empty description
  // (activity-type rules still apply).
  const seedDesc = new Map<string, { description: string; returnForm: string }>();
  const firmDesc = new Map<string, { description: string; activityType: string; code: string }>();
  try {
    const codes = await listAvailableCodes(tenantId, companyId);
    for (const c of codes.seedCodes) seedDesc.set(`${c.activityType}|${c.code}`, { description: c.description, returnForm: c.returnForm });
    for (const c of codes.firmCodes) firmDesc.set(c.id, { description: c.description, activityType: c.activityType, code: c.code });
  } catch (err) {
    log.debug({ component: 'tax-estimator', event: 'codes_unavailable', companyId, message: (err as Error).message });
  }
  // Account-level row wins; else any unit row (unit mapping mode).
  const byAccount = new Map<string, TaxCodeRef>();
  const sorted = [...assignments].sort((a, b) => (a.activityUnitId === null ? -1 : 0) - (b.activityUnitId === null ? -1 : 0));
  for (const a of sorted) {
    if (byAccount.has(a.accountId)) continue;
    if (a.seedCode && a.seedActivityType) {
      const d = seedDesc.get(`${a.seedActivityType}|${a.seedCode}`);
      byAccount.set(a.accountId, {
        returnForm: d?.returnForm ?? returnForm ?? '', activityType: a.seedActivityType, code: a.seedCode, description: d?.description ?? '',
      });
    } else if (a.firmCodeId) {
      const d = firmDesc.get(a.firmCodeId);
      byAccount.set(a.accountId, {
        returnForm: returnForm ?? '', activityType: d?.activityType ?? 'business', code: d?.code ?? 'FIRM', description: d?.description ?? '',
      });
    }
  }
  return byAccount;
}

function addPl(pl: PLResult, into: Map<string, Dec>, meta: Map<string, AccountMeta>) {
  const sections: Array<[typeof pl.revenue, string, boolean]> = [
    [pl.revenue, 'revenue', true], [pl.otherRevenue, 'other_revenue', true],
    [pl.cogs, 'cogs', false], [pl.expenses, 'expense', false], [pl.otherExpenses, 'other_expense', false],
  ];
  for (const [entries, type, income] of sections) {
    for (const e of entries) {
      const v = income ? dec(e.amount) : dec(e.amount).negated();
      into.set(e.accountId, (into.get(e.accountId) ?? ZERO).plus(v));
      if (!meta.has(e.accountId)) meta.set(e.accountId, { accountId: e.accountId, accountNumber: e.accountNumber, name: e.name, accountType: type });
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────

export interface TaxBasisPlRequest {
  tenantId: string;
  companyId: string;
  taxYear: number;
  /** 'YYYY-MM'; defaults to the window's last month clipped to the current month. */
  throughMonth?: string;
}

export interface TaxBasisPlOptions { skipCache?: boolean; today?: Date }

export async function getTaxBasisPl(scope: FirmScope, req: TaxBasisPlRequest, opts: TaxBasisPlOptions = {}): Promise<TaxBasisPl> {
  // D1: scope guard BEFORE any books query.
  const company = await assertEntityInScope(scope, req.tenantId, req.companyId);
  const resolved = await resolveForCompany(company);
  const window = taxYearWindow(req.taxYear, resolved.entityType, resolved.fiscalYearStartMonth);
  const throughMonth = resolveThroughMonth(window, req.throughMonth, opts.today);
  const [glVersionStamp, configVersion] = await Promise.all([
    getGlVersionStamp(req.tenantId, req.companyId),
    loadConfigVersion(req.tenantId, req.companyId, req.taxYear),
  ]);
  const key = taxBasisCacheKey({
    tenantId: req.tenantId, companyId: req.companyId, taxYear: req.taxYear, basis: resolved.taxMethod,
    throughMonth, glVersionStamp, configVersion,
  });
  if (!opts.skipCache) {
    const hit = await tbCacheGet<TaxBasisPl>(key);
    if (hit) return { ...hit, cached: true };
  }
  const result = await compute(resolved, req.taxYear, window, throughMonth, glVersionStamp, configVersion);
  if (!opts.skipCache) await tbCacheSet(key, result);
  return result;
}

async function compute(
  resolved: ResolvedEntityTax, taxYear: number, window: TaxYearWindow, throughMonth: string,
  glVersionStamp: number, configVersion: string,
): Promise<TaxBasisPl> {
  const { tenantId, companyId, taxMethod: basis } = resolved;
  const throughDate = monthEnd(throughMonth);
  const months = monthsBetween(window.startMonth, throughMonth);
  const warnings: TaxEstimatorWarning[] = [...resolved.warnings];
  const trace: TraceRow[] = [];

  // 1. Month-by-month P&L on the effective tax method (existing builder).
  const meta = new Map<string, AccountMeta>();
  const monthly: Array<Map<string, Dec>> = [];
  for (const m of months) {
    const pl = await buildProfitAndLoss(tenantId, `${m}-01`, monthEnd(m), basis, companyId);
    const map = new Map<string, Dec>();
    addPl(pl, map, meta);
    monthly.push(map);
  }

  // 2. Configuration: TB character, estimator treatments, flags, year inputs.
  const [charMap, treatmentRows, flaggedRows, [yearInputs]] = await Promise.all([
    loadCharacterMap(tenantId, companyId, resolved.tbReturnForm),
    db.select().from(taxEstAccountTreatments)
      .where(and(eq(taxEstAccountTreatments.tenantId, tenantId), eq(taxEstAccountTreatments.companyId, companyId))),
    db.select({ transactionId: taxEstTransactionFlags.transactionId })
      .from(taxEstTransactionFlags)
      .innerJoin(transactions, and(eq(transactions.id, taxEstTransactionFlags.transactionId), eq(transactions.tenantId, tenantId)))
      .where(and(
        eq(taxEstTransactionFlags.tenantId, tenantId),
        eq(taxEstTransactionFlags.nonRecurring, true),
        eq(transactions.companyId, companyId),
      )),
    db.select().from(taxEstEntityYearInputs)
      .where(and(
        eq(taxEstEntityYearInputs.tenantId, tenantId),
        eq(taxEstEntityYearInputs.companyId, companyId),
        eq(taxEstEntityYearInputs.taxYear, taxYear),
      ))
      .limit(1),
  ]);
  const treatments = new Map<string, TreatmentRow>(treatmentRows.map((t) => [t.accountId, {
    accountId: t.accountId,
    treatment: (t.treatment as AccountTreatment | null) ?? null,
    pct: t.pct,
    paymentTaxpayerId: t.paymentTaxpayerId,
    paymentPersonId: t.paymentPersonId,
    paymentJurisdiction: t.paymentJurisdiction,
    nonRecurring: t.nonRecurring,
  }]));
  const monthIdx = new Map(months.map((m, i) => [m, i]));

  // 3. Transaction-flag non-recurring portions: the flagged transactions' P&L
  //    lines on the same basis (cash basis: the PAYMENT carries the recognized
  //    lines, so flag the payment, not the invoice).
  const flagged = new Set(flaggedRows.map((r) => r.transactionId));
  const txnNonRec: Array<Map<string, Dec>> = months.map(() => new Map());
  if (flagged.size > 0) {
    const detail = await buildAccountDetailReport(tenantId, window.start, throughDate, {
      title: 'tax-estimator', accountTypes: [...PL_TYPES], normalSide: 'debit', companyId, detail: true, basis,
    });
    if ('groups' in detail) {
      for (const g of detail.groups) {
        for (const line of g.lines) {
          if (!flagged.has(line.transactionId)) continue;
          const i = monthIdx.get(isoDate(line.date).slice(0, 7));
          if (i === undefined) continue;
          const v = dec(line.credit).minus(dec(line.debit)); // profit effect
          txnNonRec[i]!.set(g.accountId, (txnNonRec[i]!.get(g.accountId) ?? ZERO).plus(v));
        }
      }
    }
  }

  // 4. Apply character + treatments per account per month.
  const totals = { recurring: emptyChars(), nonRecurring: emptyChars() };
  let bookNet = ZERO;
  let ownerSehi = ZERO;
  let ownerRetirement = ZERO;
  let ownerPersonal = ZERO;
  let addBack = ZERO;
  let w2Books = ZERO;
  let farmingCurrent = ZERO;
  const monthsOut: TaxBasisMonth[] = [];
  const perAccount = new Map<string, { book: Dec; tax: Dec; nonRec: Dec }>();

  const accountIds = [...meta.keys()];
  for (let i = 0; i < months.length; i++) {
    const map = monthly[i]!;
    const rec = emptyChars();
    const non = emptyChars();
    let mBook = ZERO;
    let mSehi = ZERO;
    let mRet = ZERO;
    let mW2 = ZERO;
    for (const accountId of accountIds) {
      const x = map.get(accountId) ?? ZERO;
      const txnPart = txnNonRec[i]!.get(accountId) ?? ZERO;
      if (x.isZero() && txnPart.isZero()) continue;
      const m = meta.get(accountId)!;
      const t = treatments.get(accountId);
      const code = charMap.get(accountId) ?? null;
      const character: IncomeCharacter = code ? characterForCode(code, m.accountType) : 'ordinary';
      const taxExempt = code ? isTaxExemptCode(code) : false;
      const n = t?.nonRecurring ? x : txnPart;
      const r = x.minus(n);
      const eR = entityShare(r, t, taxExempt);
      const eN = entityShare(n, t, taxExempt);
      rec[character] = rec[character].plus(eR);
      non[character] = non[character].plus(eN);
      mBook = mBook.plus(x);
      const removed = x.negated(); // positive magnitude of a removed expense
      switch (t?.treatment) {
        case 'owner_sehi': mSehi = mSehi.plus(removed); break;
        case 'owner_retirement': mRet = mRet.plus(removed); break;
        case 'owner_personal': ownerPersonal = ownerPersonal.plus(removed); break;
        case 'nondeductible_pct': addBack = addBack.plus(eR.plus(eN).minus(x)); break;
        case 'w2_wages': mW2 = mW2.plus(removed); break;
        default: break;
      }
      if (code && FARM_ACTIVITIES.has(code.activityType) && INCOME_TYPES.has(m.accountType)) {
        farmingCurrent = farmingCurrent.plus(x);
      }
      const acc = perAccount.get(accountId) ?? { book: ZERO, tax: ZERO, nonRec: ZERO };
      acc.book = acc.book.plus(x);
      acc.tax = acc.tax.plus(eR).plus(eN);
      acc.nonRec = acc.nonRec.plus(n);
      perAccount.set(accountId, acc);
    }
    for (const c of INCOME_CHARACTERS) {
      totals.recurring[c] = totals.recurring[c].plus(rec[c]);
      totals.nonRecurring[c] = totals.nonRecurring[c].plus(non[c]);
    }
    bookNet = bookNet.plus(mBook);
    ownerSehi = ownerSehi.plus(mSehi);
    ownerRetirement = ownerRetirement.plus(mRet);
    w2Books = w2Books.plus(mW2);
    const both = emptyChars();
    for (const c of INCOME_CHARACTERS) both[c] = rec[c].plus(non[c]);
    monthsOut.push({
      month: months[i]!,
      bookNetIncome: s4(mBook),
      byCharacter: charsOut(both),
      recurring: charsOut(rec),
      nonRecurring: charsOut(non),
      ownerSehi: s4(mSehi),
      ownerRetirement: s4(mRet),
      w2Wages: s4(mW2),
    });
  }

  // 5. TB tax RJEs (informational; never applied — see report notes).
  const rjeByAccount = new Map<string, Dec>();
  try {
    const wp = await computeWorkpaper(tenantId, companyId, {
      periodEnd: throughDate, basis, taxYear: taxYearOf(throughDate, resolved.fiscalYearStartMonth),
    });
    let wpNet = ZERO;
    for (const row of wp.rows) {
      if (!(PL_TYPES as readonly string[]).includes(row.accountType)) continue;
      wpNet = wpNet.plus(dec(row.adjusted).negated());
      if (row.taxRje !== 0) rjeByAccount.set(row.accountId, dec(row.taxRje).negated());
    }
    // Identity check (TB1): the workpaper's Adjusted P&L and the month P&L
    // must agree when both cover the same window.
    if (wp.fyStart === window.start && !wpNet.minus(bookNet).abs().lessThan('0.01')) {
      warnings.push({
        code: 'TE_TB_IDENTITY_MISMATCH', severity: 'warning',
        message: 'The Trial Balance workpaper and the P&L disagree for this range; review the books before relying on the estimate.',
        details: { workpaperNet: s4(wpNet), plNet: s4(bookNet) },
      });
    }
  } catch (err) {
    log.debug({ component: 'tax-estimator', event: 'workpaper_unavailable', companyId, message: (err as Error).message });
  }
  if (rjeByAccount.size > 0) {
    warnings.push({
      code: 'TE_TB_RJE_NOT_APPLIED', severity: 'info',
      message: 'Trial Balance tax adjustments (RJEs) exist for this year. They are shown per account but not applied; enter them as estimator adjustments if they should change the estimate.',
      details: { total: s4([...rjeByAccount.values()].reduce((a, b) => a.plus(b), ZERO)) },
    });
  }

  // 6. Estimated-tax payments: lines on payment-mapped accounts (any type).
  const paymentAccountIds = [...treatments.values()].filter((t) => t.treatment === 'estimated_tax_payment').map((t) => t.accountId);
  const estimatedPayments: EstimatedTaxPaymentTxn[] = [];
  if (paymentAccountIds.length > 0) {
    const detail = await buildAccountDetailReport(tenantId, window.start, throughDate, {
      title: 'tax-estimator-payments', accountTypes: ALL_ACCOUNT_TYPES, normalSide: 'debit', companyId,
      accountIds: paymentAccountIds, detail: true, basis,
    });
    if ('groups' in detail) {
      for (const g of detail.groups) {
        const t = treatments.get(g.accountId);
        for (const line of g.lines) {
          const amount = dec(line.debit).minus(dec(line.credit));
          if (amount.isZero()) continue;
          estimatedPayments.push({
            transactionId: line.transactionId,
            date: isoDate(line.date),
            amount: s4(amount),
            accountId: g.accountId,
            accountName: g.name,
            taxpayerId: t?.paymentTaxpayerId ?? null,
            personId: t?.paymentPersonId ?? null,
            jurisdiction: t?.paymentJurisdiction ?? null,
            memo: line.memo || null,
          });
        }
      }
    }
    estimatedPayments.sort((a, b) => a.date.localeCompare(b.date));
    const unassigned = [...treatments.values()].filter((t) => t.treatment === 'estimated_tax_payment' && !t.paymentTaxpayerId);
    if (unassigned.length > 0) {
      warnings.push({
        code: 'TE_PAYMENT_ACCOUNT_UNASSIGNED', severity: 'info',
        message: 'Some estimated-tax payment accounts are not tied to a taxpayer; their payments are listed but cannot be credited automatically.',
        details: { accountIds: unassigned.map((t) => t.accountId) },
      });
    }
  }

  // 7. Prior-year gross farming income (farmer test), only when farm codes exist.
  let farmingPrior = ZERO;
  const farmAccounts = [...charMap.entries()].filter(([, c]) => FARM_ACTIVITIES.has(c.activityType)).map(([id]) => id);
  if (farmAccounts.length > 0) {
    const prior = taxYearWindow(taxYear - 1, resolved.entityType, resolved.fiscalYearStartMonth);
    const pl = await buildProfitAndLoss(tenantId, prior.start, prior.end, basis, companyId);
    const farmSet = new Set(farmAccounts);
    for (const e of [...pl.revenue, ...pl.otherRevenue]) {
      if (farmSet.has(e.accountId)) farmingPrior = farmingPrior.plus(dec(e.amount));
    }
  }

  // 8. Account lines + trace (source 'gl_map' for every reclass).
  const accountLines: TaxBasisAccountLine[] = [];
  const unmapped: Array<{ accountId: string; name: string }> = [];
  const taxDep: TaxBasisPl['taxDepreciationDiffers'] = [];
  const label = (m: AccountMeta) => (m.accountNumber ? `${m.accountNumber} ${m.name}` : m.name);
  for (const [accountId, acc] of perAccount) {
    const m = meta.get(accountId)!;
    const t = treatments.get(accountId);
    const code = charMap.get(accountId) ?? null;
    const taxExempt = code ? isTaxExemptCode(code) : false;
    const character: IncomeCharacter = code ? characterForCode(code, m.accountType) : 'ordinary';
    const reclass = acc.tax.minus(acc.book);
    accountLines.push({
      accountId, accountNumber: m.accountNumber, name: m.name, accountType: m.accountType,
      character, characterSource: code ? 'tb_assignment' : 'unassigned', taxCode: code,
      treatment: t?.treatment ?? null, pct: t?.pct ?? null, route: routeOf(t, taxExempt),
      accountNonRecurring: t?.nonRecurring ?? false,
      bookAmount: s4(acc.book), taxAmount: s4(acc.tax), reclass: s4(reclass),
      nonRecurringBookAmount: s4(acc.nonRec),
      tbTaxRje: s4(rjeByAccount.get(accountId) ?? ZERO),
    });
    if (!code && !t?.treatment) unmapped.push({ accountId, name: label(m) });
    if (t?.treatment === 'tax_depreciation_differs') taxDep.push({ accountId, name: label(m), bookAmount: s4(acc.book) });

    const book = s4(acc.book);
    if (taxExempt) {
      trace.push({ label: `${label(m)}: tax-exempt code, excluded from entity profit`, amount: s4(reclass), formula: `book ${book} → 0`, source: 'gl_map' });
    }
    switch (t?.treatment) {
      case 'owner_sehi':
        trace.push({ label: `${label(m)} → owner self-employed health insurance (removed from entity profit)`, amount: s4(reclass), formula: `book ${book} → entity 0; owner SEHI ${s4(acc.book.negated())}`, source: 'gl_map' });
        break;
      case 'owner_retirement':
        trace.push({ label: `${label(m)} → owner retirement contribution (removed from entity profit)`, amount: s4(reclass), formula: `book ${book} → entity 0; owner retirement ${s4(acc.book.negated())}`, source: 'gl_map' });
        break;
      case 'owner_personal':
        trace.push({ label: `${label(m)}: owner personal, not deductible (dropped)`, amount: s4(reclass), formula: `book ${book} → 0`, source: 'gl_map' });
        break;
      case 'estimated_tax_payment':
        trace.push({ label: `${label(m)}: estimated tax payments removed from profit (payment ledger)`, amount: s4(reclass), formula: `book ${book} → 0`, source: 'gl_map' });
        break;
      case 'nondeductible_pct':
        trace.push({ label: `${label(m)}: ${dec(t.pct).toString()}% nondeductible add-back`, amount: s4(reclass), formula: `${s4(acc.book.negated())} × ${dec(t.pct).toString()}%`, source: 'gl_map' });
        break;
      case 'tax_depreciation_differs':
        trace.push({ label: `${label(m)}: book depreciation kept; tax amount comes from an adjustment`, amount: '0.0000', formula: `book ${book}`, source: 'gl_map' });
        break;
      default:
        break;
    }
    if (!acc.nonRec.isZero()) {
      trace.push({
        label: `${label(m)}: non-recurring, excluded from the run-rate`,
        amount: s4(acc.nonRec),
        formula: t?.nonRecurring ? 'account flagged non-recurring' : 'flagged transactions',
        source: 'gl_map',
      });
    }
  }
  accountLines.sort((a, b) => (a.accountNumber ?? '').localeCompare(b.accountNumber ?? '') || a.name.localeCompare(b.name));
  if (unmapped.length > 0) {
    warnings.push({
      code: 'TE_UNMAPPED_ACCOUNTS', severity: 'warning',
      message: `${unmapped.length} account(s) with activity have no TB tax-code assignment or estimator treatment; they are treated as ordinary income/expense.`,
      details: { accounts: unmapped },
    });
  }
  if (taxDep.length > 0) {
    warnings.push({
      code: 'TE_TAX_DEPRECIATION_ADJUSTMENT', severity: 'info',
      message: 'Book depreciation is used for accounts marked "tax depreciation differs"; enter the tax amount as an adjustment.',
      details: { accountIds: taxDep.map((d) => d.accountId) },
    });
  }

  const byCharacter = emptyChars();
  for (const c of INCOME_CHARACTERS) byCharacter[c] = totals.recurring[c].plus(totals.nonRecurring[c]);
  const taxBasisProfit = sumChars(byCharacter);
  trace.unshift({ label: 'Book net income', amount: s4(bookNet), formula: `P&L ${window.start} – ${throughDate}, ${basis} basis`, source: 'gl' });
  trace.push({ label: 'Tax-basis profit', amount: s4(taxBasisProfit), formula: 'book net income + reclasses', source: 'gl_map' });

  // 9. W-2 wages (D8): override wins when set.
  const override = yearInputs?.w2WagesOverride ?? null;
  if (override !== null) {
    trace.push({ label: 'QBI W-2 wages: per-year override', amount: s4(dec(override)), formula: `books ${s4(w2Books)}; reason: ${yearInputs?.w2WagesOverrideReason ?? ''}`, source: 'input' });
  } else if (!w2Books.isZero()) {
    trace.push({ label: 'QBI W-2 wages from w2_wages accounts', amount: s4(w2Books), source: 'gl_map' });
  }

  if (!yearInputs?.ubia) {
    warnings.push({
      code: 'TE_UBIA_MISSING', severity: 'info',
      message: `No UBIA entered for ${taxYear}; the QBI UBIA limb is not computed.`,
    });
  }

  return {
    tenantId, companyId, companyName: resolved.companyName, taxYear,
    periodStart: window.start, throughDate, throughMonth, monthsElapsed: months.length,
    basis, entityType: resolved.entityType, glVersionStamp, configVersion, cached: false,
    bookNetIncome: s4(bookNet),
    taxBasisProfit: s4(taxBasisProfit),
    byCharacter: charsOut(byCharacter),
    recurring: charsOut(totals.recurring),
    nonRecurring: charsOut(totals.nonRecurring),
    ownerLevel: { ownerSehi: s4(ownerSehi), ownerRetirement: s4(ownerRetirement), ownerPersonalDropped: s4(ownerPersonal) },
    nondeductibleAddBack: s4(addBack),
    taxDepreciationDiffers: taxDep,
    estimatedPayments,
    months: monthsOut,
    farmingGrossIncome: { currentYear: s4(farmingCurrent), priorYear: s4(farmingPrior) },
    w2Wages: {
      booksYtd: s4(w2Books),
      override,
      overrideReason: yearInputs?.w2WagesOverrideReason ?? null,
      effective: s4(override !== null ? dec(override) : w2Books),
      source: override !== null ? 'override' : 'books',
    },
    ubia: yearInputs?.ubia ?? null,
    accounts: accountLines,
    trace,
    warnings,
  };
}
