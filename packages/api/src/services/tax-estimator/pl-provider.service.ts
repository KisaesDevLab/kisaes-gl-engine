// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax-basis P&L provider (MODULE.md "Tax-treatment map", "Federal calculation
// order" steps 1-2, D3, D8, D10). Books → engine input, applied BEFORE the engine:
//
//   P&L per month on the entity's EFFECTIVE tax method (report.service
//   buildProfitAndLoss — the same virtual cash ledger every report uses)
//   → character from TB account_tax_assignments by seed CODE identity
//     (unassigned = ordinary + warning; an estimator character treatment wins)
//   → estimator treatments, entity-type aware (below); a TB code that already
//     says owner SEHI (887/888 Sch C, 689/690 Sch F) is honoured when no
//     estimator treatment is set (the estimator treatment wins when both exist)
//   → non-recurring split (account flag OR transaction flag).
//
// OWNER ITEMS BY ENTITY TYPE (R1 F1-F3, D10 "S corp >2% health as officer W-2 + SEHI"):
//   sch_c / sch_f / partnership / unknown:
//     owner_sehi, owner_retirement → removed from entity profit, owner level
//     (person target optional; Sch C has one owner).
//   s_corp (person target REQUIRED):
//     owner_sehi → KEPT as the S corp's deduction; the officer gets the amount
//       as W-2 box 1 wages (`sehiAsW2Wages`, not SS / Medicare wages) AND an
//       SEHI deduction (`ownerSehi`).
//     owner_retirement → KEPT as the corporation's deduction; reported per
//       officer as `employerRetirement` (informational; no owner deduction).
//   partnership: guaranteed_payment (partner REQUIRED) → KEPT as the
//     partnership's deduction AND emitted in `guaranteedPayments[]` as
//     ordinary (SE) income of that partner. TB 1065 GP codes (business 201 /
//     267 / 268, farm 684 / 635 / 636, farm rental 780 / 778 / 779, rental 584
//     / 588 / 589) are SUGGESTED (never auto-applied) and warned loudly
//     (TE_GP_CODE_WITHOUT_TREATMENT) while the account has no GP treatment.
//   c_corp: owner items stay in entity profit (no owner level), with a warning.
//
// CHARACTER MAP (R1 F6) — 2025 seed codes by (return form | activity | code);
// verified against tax_codes in kisbooks_test. Interest / dividends apply on
// income accounts only (an interest EXPENSE code is an ordinary deduction);
// gains keep their character on any P&L account.
//   any form, activity rental / farm_rental ...................... rental
//   1065 common 110 Interest income, 115 U.S. interest ........... interest
//   1065 common 111 Ordinary dividends ........................... dividends_ordinary
//   1065 common 399 Sch D L14 Capital gain distributions ......... capital_gain_lt
//   1065 common 155 Tax-exempt interest, 482 M-1 tax-exempt inc .. excluded (tax-exempt)
//   1065 common 491 M-1 4797 gain/loss - book .................... ordinary + TE_M1_CODE_ON_PL_ACCOUNT
//   1120S common 150 / 151 Non-US / US interest .................. interest
//   1120S common 156 Ordinary dividends .......................... dividends_ordinary
//   1120S common 104 / 105 Capital gain distribution (105 = 28%) . capital_gain_lt (28% rate not modelled)
//   1120S common 485 / 486 / 487 M-1 income not on Sch K ......... excluded (tax-exempt)
//   1120S common 482 / 483 / 484 M-1 expenses not on Sch K ....... excluded (nondeductible)
//   1120S common 488 M-1 4797 gain/loss - book ................... ordinary + TE_M1_CODE_ON_PL_ACCOUNT
//   1120 business 105 / 106 interest; common 107-122 dividends;
//        125 capital gain distribution; 487 / 488 excluded (tax-exempt);
//        484 / 485 excluded (nondeductible); 489 M-1 book gain ..... as above (C corp: informational)
//   any other is_m1_adjustment seed code on a P&L account ......... ordinary + TE_M1_CODE_ON_PL_ACCOUNT
//   everything else (incl. every 1040 code) ...................... ordinary
// The seed has NO short-term capital gain, §1231, qualified-dividend code and
// no 1040 interest / dividend code at all: those characters come only from the
// estimator character treatments (capital_gain_lt / _st, section_1231,
// interest, dividends_ordinary / _qualified) on income accounts. FIRM: codes
// have no stable identity, so they alone fall back to their description
// (firm_tax_codes edits are in the config hash, R1 F13).
//
// RANGE END (R1 F5): a requested month wins; otherwise the LAST CLOSED month
// (closed-month.service), else the last COMPLETE calendar month — never the
// current partial month. The payment ledger is ALWAYS read on a cash basis
// (R1 F4): a bill to the IRS is a payment only when paid, at the payment date.
//
// This file never aggregates the ledger itself: month P&L comes from
// buildProfitAndLoss, line detail (payments, flagged transactions) from
// buildAccountDetailReport, TB tax RJEs from computeWorkpaper — all with
// exact decimal strings (R1 F15). Its own SQL reads only estimator / TB
// configuration rows, always pinned to the single tenant verified against the
// firm scope (D1).
//
// SIGN CONVENTION (see shared entities-api.ts): profit-positive amounts
// (income +, expense −); owner-level amounts, GPs, payments, add-backs, wages
// and farming gross income are positive magnitudes. Money is decimal.js in
// here and leaves as 4-place strings.

import { and, eq, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import type {
  AccountTreatment, CharacterAmounts, EntityTaxType, EstimatedTaxPaymentTxn, GuaranteedPaymentDto, IncomeCharacter,
  OwnerLevelPerson, ResolvedEntityTax, TaxBasisAccountLine, TaxBasisMonth, TaxBasisPl, TaxCodeRef, TaxEstimatorWarning,
  TaxMethod, ThroughMonthSource, TraceRow, TreatmentRoute,
} from '@kis-books/shared';
import { INCOME_CHARACTERS, isCharacterTreatment } from '@kis-books/shared';
import { db } from '../../db/index.js';
import {
  taxEstAccountTreatments, taxEstEntitySettings, taxEstEntityYearInputs, taxEstTransactionFlags, transactions,
} from '../../db/schema/index.js';
import { buildAccountDetailReport, buildProfitAndLoss, type PLResult } from '../report.service.js';
import { computeWorkpaper, getGlVersionStamp, listAssignments } from '../tb/balance-engine.service.js';
import { listAvailableCodes } from '../tb/assignments.service.js';
import { tbCacheGet, tbCacheSet } from '../tb/tb-redis.js';
import { log } from '../../utils/logger.js';
import type { FirmScope } from './firm-scope.service.js';
import { assertEntityInScope, resolveForCompany } from './entity-type.service.js';
import { chooseThroughMonth } from './closed-month.service.js';
import { currentMonth, monthEnd, monthsBetween, taxYearWindow, type TaxYearWindow } from './periods.js';

// Pure period helpers live in periods.ts; re-exported for existing callers.
export { monthEnd, monthsBetween, resolveThroughMonth, taxYearWindow, type TaxYearWindow } from './periods.js';

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
// v2: R1 DTO (GPs, per-person owner level, W-2 projection, through source).
const CACHE_VERSION = 'v2';

export interface CacheKeyParts {
  tenantId: string; companyId: string; taxYear: number; basis: TaxMethod;
  throughMonth: string; glVersionStamp: number; configVersion: string;
}

/** TB1/TB6 pattern: the GL stamp + estimator config version make invalidation exact. */
export function taxBasisCacheKey(p: CacheKeyParts): string {
  return `te:pl:${CACHE_VERSION}:${p.tenantId}:${p.companyId}:${p.taxYear}:${p.basis}:${p.throughMonth}:${p.glVersionStamp}:${p.configVersion}`;
}

// ── TB code identity (R1 F1, F3, F6) — see the table in the header ──

type CodeMeaning = IncomeCharacter | 'tax_exempt' | 'nondeductible' | 'm1_book_gain';

const codeKey = (returnForm: string, activityType: string, code: string) => `${returnForm}|${activityType}|${code}`;
const many = (prefix: string, codes: string[], meaning: CodeMeaning): Array<[string, CodeMeaning]> =>
  codes.map((c) => [`${prefix}|${c}`, meaning]);

/** Seed code → meaning. Exported for the seed-tied test. */
export const SEED_CODE_MEANING: ReadonlyMap<string, CodeMeaning> = new Map<string, CodeMeaning>([
  ...many('1065|common', ['110', '115'], 'interest'),
  ...many('1065|common', ['111'], 'dividends_ordinary'),
  ...many('1065|common', ['399'], 'capital_gain_lt'),
  ...many('1065|common', ['155', '482'], 'tax_exempt'),
  ...many('1065|common', ['491'], 'm1_book_gain'),
  ...many('1120S|common', ['150', '151'], 'interest'),
  ...many('1120S|common', ['156'], 'dividends_ordinary'),
  ...many('1120S|common', ['104', '105'], 'capital_gain_lt'),
  ...many('1120S|common', ['485', '486', '487'], 'tax_exempt'),
  ...many('1120S|common', ['482', '483', '484'], 'nondeductible'),
  ...many('1120S|common', ['488'], 'm1_book_gain'),
  ...many('1120|business', ['105', '106'], 'interest'),
  ...many('1120|common', ['107', '108', '109', '112', '113', '118', '121', '122'], 'dividends_ordinary'),
  ...many('1120|common', ['125'], 'capital_gain_lt'),
  ...many('1120|common', ['487', '488'], 'tax_exempt'),
  ...many('1120|common', ['484', '485'], 'nondeductible'),
  ...many('1120|common', ['489'], 'm1_book_gain'),
]);

/** 1040 codes that already say "owner SEHI" (Sch 1 L17, incl. long-term care premiums). */
export const SEHI_SEED_CODES: ReadonlySet<string> = new Set([
  codeKey('1040', 'business', '887'), codeKey('1040', 'business', '888'),
  codeKey('1040', 'farm', '689'), codeKey('1040', 'farm', '690'),
]);

/** 1065 guaranteed-payment codes (all activities). Suggested + warned, never auto-applied. */
export const GP_SEED_CODES: ReadonlySet<string> = new Set([
  codeKey('1065', 'business', '201'), codeKey('1065', 'business', '267'), codeKey('1065', 'business', '268'),
  codeKey('1065', 'farm', '684'), codeKey('1065', 'farm', '635'), codeKey('1065', 'farm', '636'),
  codeKey('1065', 'farm_rental', '780'), codeKey('1065', 'farm_rental', '778'), codeKey('1065', 'farm_rental', '779'),
  codeKey('1065', 'rental', '584'), codeKey('1065', 'rental', '588'), codeKey('1065', 'rental', '589'),
]);

const isSeed = (code: TaxCodeRef) => code.source !== 'firm';

/** Treatment a TB code implies: 'owner_sehi' (honoured automatically) or 'guaranteed_payment' (suggested only). */
export function impliedTreatmentForCode(code: TaxCodeRef | null): 'owner_sehi' | 'guaranteed_payment' | null {
  if (!code || !isSeed(code)) return null;
  const k = codeKey(code.returnForm, code.activityType, code.code);
  if (SEHI_SEED_CODES.has(k)) return 'owner_sehi';
  if (GP_SEED_CODES.has(k)) return 'guaranteed_payment';
  return null;
}

export interface CodeClassification {
  character: IncomeCharacter;
  /** Excluded from entity profit by the code (tax-exempt income / nondeductible M-1 expense). */
  exclusion: 'tax_exempt' | 'nondeductible' | null;
  /** An M-1 (book-tax reconciling) code kept as ordinary: warn. */
  m1Warning: boolean;
}

function firmCodeMeaning(code: TaxCodeRef): CodeMeaning | null {
  const d = code.description.toLowerCase();
  if (/tax[-\s]?exempt/.test(d)) return 'tax_exempt';
  if (code.isM1Adjustment) return null;
  if (/capital gain/.test(d) && !/capital gain property/.test(d)) return /short[-\s]?term/.test(d) ? 'capital_gain_st' : 'capital_gain_lt';
  if (/\b1231\b/.test(d)) return 'section_1231';
  if (/qualified dividend/.test(d)) return 'dividends_qualified';
  if (/dividend/.test(d) && !/distribution/.test(d)) return 'dividends_ordinary';
  if (/interest/.test(d)) return 'interest';
  return null;
}

/** Classification of a TB code on an account of `accountType`. Exported for tests. */
export function classifyCode(code: TaxCodeRef, accountType: string): CodeClassification {
  if (code.activityType === 'rental' || code.activityType === 'farm_rental') {
    return { character: 'rental', exclusion: null, m1Warning: false };
  }
  const meaning = isSeed(code) ? SEED_CODE_MEANING.get(codeKey(code.returnForm, code.activityType, code.code)) ?? null : firmCodeMeaning(code);
  if (meaning === 'tax_exempt' || meaning === 'nondeductible') return { character: 'ordinary', exclusion: meaning, m1Warning: false };
  if (meaning === 'm1_book_gain' || (meaning === null && code.isM1Adjustment)) {
    return { character: 'ordinary', exclusion: null, m1Warning: true };
  }
  if (meaning === null) return { character: 'ordinary', exclusion: null, m1Warning: false };
  if ((meaning === 'interest' || meaning === 'dividends_ordinary' || meaning === 'dividends_qualified') && !INCOME_TYPES.has(accountType)) {
    return { character: 'ordinary', exclusion: null, m1Warning: false };
  }
  return { character: meaning, exclusion: null, m1Warning: false };
}

/** Income character of a TB code (see classifyCode). Exported for tests. */
export function characterForCode(code: TaxCodeRef, accountType: string): IncomeCharacter {
  return classifyCode(code, accountType).character;
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

/** The treatment actually applied to an account and where its amount goes. */
export interface AppliedTreatment {
  treatment: AccountTreatment | null;
  source: 'estimator' | 'tb_code' | null;
  route: TreatmentRoute;
  personId: string | null;
  character: IncomeCharacter;
  characterSource: TaxBasisAccountLine['characterSource'];
  exclusion: CodeClassification['exclusion'];
  m1Warning: boolean;
  /** Set when the treatment does not apply to the entity type (kept in entity profit). */
  notForEntity: boolean;
  pct: string | null;
}

const OWNER_REMOVED_TYPES = new Set<EntityTaxType | null>(['sch_c', 'sch_f', 'partnership', null]);

/** Entity-type-aware routing (header "OWNER ITEMS BY ENTITY TYPE"). Exported for tests. */
export function applyTreatment(
  t: TreatmentRow | undefined, code: TaxCodeRef | null, accountType: string, entityType: EntityTaxType | null,
): AppliedTreatment {
  const cls = code ? classifyCode(code, accountType) : { character: 'ordinary' as IncomeCharacter, exclusion: null, m1Warning: false };
  const implied = impliedTreatmentForCode(code);
  let treatment: AccountTreatment | null = t?.treatment ?? null;
  let source: AppliedTreatment['source'] = treatment ? 'estimator' : null;
  if (!treatment && implied === 'owner_sehi') { treatment = 'owner_sehi'; source = 'tb_code'; }
  const personId = source === 'estimator' ? t?.paymentPersonId ?? null : null;
  const base: AppliedTreatment = {
    treatment, source, route: 'entity', personId,
    character: code ? cls.character : 'ordinary',
    characterSource: code ? 'tb_assignment' : 'unassigned',
    exclusion: cls.exclusion, m1Warning: cls.m1Warning, notForEntity: false,
    pct: treatment === 'nondeductible_pct' ? t?.pct ?? null : null,
  };
  if (isCharacterTreatment(treatment)) {
    // The CPA's explicit character wins over the code (and over a code exclusion).
    return { ...base, character: treatment, characterSource: 'treatment', exclusion: null, m1Warning: false };
  }
  if (base.exclusion) return { ...base, route: 'dropped' };
  switch (treatment) {
    case 'owner_sehi':
    case 'owner_retirement': {
      if (OWNER_REMOVED_TYPES.has(entityType)) return { ...base, route: treatment };
      if (entityType === 's_corp') return { ...base, route: treatment === 'owner_sehi' ? 'officer_sehi' : 'officer_retirement' };
      return { ...base, notForEntity: true }; // c_corp: no owner level
    }
    case 'guaranteed_payment':
      return entityType === 'partnership' ? { ...base, route: 'guaranteed_payment' } : { ...base, notForEntity: true };
    case 'owner_personal': return { ...base, route: 'dropped' };
    case 'estimated_tax_payment': return { ...base, route: 'payment' };
    default: return base;
  }
}

const REMOVED_ROUTES = new Set<TreatmentRoute>(['owner_sehi', 'owner_retirement', 'dropped', 'payment']);

/** Entity-profit share of a book amount under an applied treatment (linear in x). */
export function entityShare(x: Dec, a: AppliedTreatment): Dec {
  if (REMOVED_ROUTES.has(a.route)) return ZERO;
  if (a.treatment === 'nondeductible_pct' && a.route === 'entity') return x.minus(x.times(dec(a.pct)).dividedBy(HUNDRED));
  return x;
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
 * TB assignments / profile / tax RJEs, the FIRM codes those assignments use
 * (a description edit can change character, R1 F13), and account + company
 * metadata, and the reconciliation state (it moves the default range end, R3-03).
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
      (SELECT count(*)::text || ':' || coalesce(max(fc.updated_at)::text, '') FROM firm_tax_codes fc
        WHERE fc.id IN (SELECT ata.firm_code_id FROM account_tax_assignments ata
          WHERE ata.tenant_id = ${tenantId} AND ata.company_id = ${companyId} AND ata.firm_code_id IS NOT NULL)),
      (SELECT coalesce(max(updated_at)::text, '') FROM company_tax_profiles
        WHERE tenant_id = ${tenantId} AND company_id = ${companyId}),
      (SELECT count(*)::text || ':' || coalesce(max(updated_at)::text, '') FROM tb_tax_entries
        WHERE tenant_id = ${tenantId} AND company_id = ${companyId}),
      (SELECT count(*)::text || ':' || coalesce(max(updated_at)::text, '') FROM accounts
        WHERE tenant_id = ${tenantId}),
      (SELECT coalesce(max(updated_at)::text, '') FROM companies
        WHERE tenant_id = ${tenantId} AND id = ${companyId}),
      -- R3-03: reconciliation state moves the default range end (last CLOSED month) and
      -- the readiness warnings; a completed / reopened / deleted reconciliation changes it.
      (SELECT count(*)::text || ':' || coalesce(md5(string_agg(
          id::text || ':' || coalesce(status, '') || ':' || statement_date::text || ':' || coalesce(completed_at::text, '') || ':' || coalesce(updated_at::text, ''),
          ',' ORDER BY id)), '')
        FROM reconciliations WHERE tenant_id = ${tenantId})
    )) AS v
  `);
  return (res.rows as Array<{ v: string }>)[0]?.v ?? 'none';
}

// ── Code + assignment lookup ───────────────────────────────────────

interface AccountMeta { accountId: string; accountNumber: string | null; name: string; accountType: string }

async function loadCharacterMap(tenantId: string, companyId: string, returnForm: string | null): Promise<Map<string, TaxCodeRef>> {
  const assignments = await listAssignments(tenantId, companyId);
  if (assignments.length === 0) return new Map();
  // Descriptions / M-1 flags come from the TB filtered code surface (never the
  // raw seed table). Seed codes are mapped by CODE identity, so a missing
  // description does not change the character.
  const seedDesc = new Map<string, { description: string; returnForm: string; isM1: boolean }>();
  const firmDesc = new Map<string, { description: string; activityType: string; code: string; isM1: boolean }>();
  try {
    const codes = await listAvailableCodes(tenantId, companyId);
    for (const c of codes.seedCodes) {
      seedDesc.set(`${c.activityType}|${c.code}`, { description: c.description, returnForm: c.returnForm, isM1: c.isM1Adjustment });
    }
    for (const c of codes.firmCodes) {
      firmDesc.set(c.id, { description: c.description, activityType: c.activityType, code: c.code, isM1: c.isM1Adjustment });
    }
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
        returnForm: d?.returnForm ?? returnForm ?? '', activityType: a.seedActivityType, code: a.seedCode,
        description: d?.description ?? '', source: 'seed', isM1Adjustment: d?.isM1 ?? false,
      });
    } else if (a.firmCodeId) {
      const d = firmDesc.get(a.firmCodeId);
      byAccount.set(a.accountId, {
        returnForm: returnForm ?? '', activityType: d?.activityType ?? 'business', code: d?.code ?? 'FIRM',
        description: d?.description ?? '', source: 'firm', isM1Adjustment: d?.isM1 ?? false,
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
      const amt = dec(e.amountExact ?? e.amount);
      const v = income ? amt : amt.negated();
      into.set(e.accountId, (into.get(e.accountId) ?? ZERO).plus(v));
      if (!meta.has(e.accountId)) meta.set(e.accountId, { accountId: e.accountId, accountNumber: e.accountNumber, name: e.name, accountType: type });
    }
  }
}

const plExact = (tenantId: string, start: string, end: string, basis: TaxMethod, companyId: string) =>
  buildProfitAndLoss(tenantId, start, end, basis, companyId, null, null, { exactAmounts: true });

const lineDebit = (l: { debit: number; debitExact?: string }) => dec(l.debitExact ?? l.debit);
const lineCredit = (l: { credit: number; creditExact?: string }) => dec(l.creditExact ?? l.credit);

// ── Public API ─────────────────────────────────────────────────────

export interface TaxBasisPlRequest {
  tenantId: string;
  companyId: string;
  taxYear: number;
  /** 'YYYY-MM'; default = last closed month, else the last complete calendar month (never the current one). */
  throughMonth?: string;
}

export interface TaxBasisPlOptions { skipCache?: boolean; today?: Date }

export async function getTaxBasisPl(scope: FirmScope, req: TaxBasisPlRequest, opts: TaxBasisPlOptions = {}): Promise<TaxBasisPl> {
  // D1: scope guard BEFORE any books query.
  const company = await assertEntityInScope(scope, req.tenantId, req.companyId);
  const resolved = await resolveForCompany(company);
  const today = opts.today ?? new Date();
  const window = taxYearWindow(req.taxYear, resolved.entityType, resolved.fiscalYearStartMonth);
  const choice = await chooseThroughMonth(req.tenantId, req.companyId, window, req.throughMonth, today);
  const throughMonth = choice.throughMonth;
  const [glVersionStamp, configVersion] = await Promise.all([
    getGlVersionStamp(req.tenantId, req.companyId),
    loadConfigVersion(req.tenantId, req.companyId, req.taxYear),
  ]);
  const key = taxBasisCacheKey({
    tenantId: req.tenantId, companyId: req.companyId, taxYear: req.taxYear, basis: resolved.taxMethod,
    throughMonth, glVersionStamp, configVersion,
  });
  let result: TaxBasisPl | null = null;
  if (!opts.skipCache) {
    const hit = await tbCacheGet<TaxBasisPl>(key);
    if (hit) result = { ...hit, cached: true };
  }
  if (!result) {
    result = await compute(resolved, req.taxYear, window, throughMonth, glVersionStamp, configVersion);
    if (!opts.skipCache) await tbCacheSet(key, result);
  }
  // Request-specific fields (not part of the cached computation).
  const warnings = [...result.warnings];
  if (throughMonth >= currentMonth(today)) {
    warnings.push({
      code: 'TE_RANGE_PARTIAL_MONTH', severity: 'warning',
      message: `The range runs through ${throughMonth}, which is not over yet; it is counted as a whole month in the run-rate.`,
    });
  }
  return { ...result, throughMonthSource: choice.source, throughMonthReason: choice.reason, warnings };
}

interface PersonAcc { sehi: Dec; ret: Dec; w2: Dec; empRet: Dec; trace: TraceRow[] }
interface GpAcc { amount: Dec; accounts: Map<string, { name: string; amount: Dec }>; trace: TraceRow[] }

async function compute(
  resolved: ResolvedEntityTax, taxYear: number, window: TaxYearWindow, throughMonth: string,
  glVersionStamp: number, configVersion: string,
): Promise<TaxBasisPl> {
  const { tenantId, companyId, taxMethod: basis, entityType } = resolved;
  const throughDate = monthEnd(throughMonth);
  const months = monthsBetween(window.startMonth, throughMonth);
  const monthsRemaining = monthsBetween(window.startMonth, window.endMonth).length - months.length;
  const warnings: TaxEstimatorWarning[] = [...resolved.warnings];
  const trace: TraceRow[] = [];

  // 1. Month-by-month P&L on the effective tax method (existing builder, exact decimals).
  const meta = new Map<string, AccountMeta>();
  const monthly: Array<Map<string, Dec>> = [];
  for (const m of months) {
    const pl = await plExact(tenantId, `${m}-01`, monthEnd(m), basis, companyId);
    const map = new Map<string, Dec>();
    addPl(pl, map, meta);
    monthly.push(map);
  }

  // 2. Configuration: TB character, estimator treatments, flags, settings, year inputs.
  const [charMap, treatmentRows, flaggedRows, [yearInputs], [settings]] = await Promise.all([
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
    db.select({ farmerOverride: taxEstEntitySettings.farmerOverride }).from(taxEstEntitySettings)
      .where(and(eq(taxEstEntitySettings.tenantId, tenantId), eq(taxEstEntitySettings.companyId, companyId)))
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
  const appliedCache = new Map<string, AppliedTreatment>();
  const appliedFor = (accountId: string): AppliedTreatment => {
    let a = appliedCache.get(accountId);
    if (!a) {
      a = applyTreatment(treatments.get(accountId), charMap.get(accountId) ?? null, meta.get(accountId)!.accountType, entityType);
      appliedCache.set(accountId, a);
    }
    return a;
  };

  // 3. Transaction-flag non-recurring portions: the flagged transactions' P&L
  //    lines on the same basis (cash basis: the PAYMENT carries the recognized
  //    lines, so flag the payment, not the invoice).
  const flagged = new Set(flaggedRows.map((r) => r.transactionId));
  const txnNonRec: Array<Map<string, Dec>> = months.map(() => new Map());
  if (flagged.size > 0) {
    const detail = await buildAccountDetailReport(tenantId, window.start, throughDate, {
      title: 'tax-estimator', accountTypes: [...PL_TYPES], normalSide: 'debit', companyId, detail: true, basis, exactAmounts: true,
    });
    if ('groups' in detail) {
      for (const g of detail.groups) {
        for (const line of g.lines) {
          if (!flagged.has(line.transactionId)) continue;
          const i = monthIdx.get(isoDate(line.date).slice(0, 7));
          if (i === undefined) continue;
          const v = lineCredit(line).minus(lineDebit(line)); // profit effect
          txnNonRec[i]!.set(g.accountId, (txnNonRec[i]!.get(g.accountId) ?? ZERO).plus(v));
        }
      }
    }
  }

  // 4. Apply character + treatments per account per month.
  const totals = { recurring: emptyChars(), nonRecurring: emptyChars() };
  let bookNet = ZERO;
  let ownerPersonal = ZERO;
  let addBack = ZERO;
  let w2Rec = ZERO;
  let w2Non = ZERO;
  const w2ByPerson = new Map<string, Dec>();
  const persons = new Map<string | null, PersonAcc>();
  const gps = new Map<string | null, GpAcc>();
  const person = (id: string | null) => {
    let p = persons.get(id);
    if (!p) { p = { sehi: ZERO, ret: ZERO, w2: ZERO, empRet: ZERO, trace: [] }; persons.set(id, p); }
    return p;
  };
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
    let mSehiW2 = ZERO;
    let mGp = ZERO;
    let mW2 = ZERO;
    for (const accountId of accountIds) {
      const x = map.get(accountId) ?? ZERO;
      const txnPart = txnNonRec[i]!.get(accountId) ?? ZERO;
      if (x.isZero() && txnPart.isZero()) continue;
      const t = treatments.get(accountId);
      const a = appliedFor(accountId);
      const n = t?.nonRecurring ? x : txnPart;
      const r = x.minus(n);
      const eR = entityShare(r, a);
      const eN = entityShare(n, a);
      rec[a.character] = rec[a.character].plus(eR);
      non[a.character] = non[a.character].plus(eN);
      mBook = mBook.plus(x);
      const removed = x.negated(); // positive magnitude of an expense
      switch (a.route) {
        case 'owner_sehi': mSehi = mSehi.plus(removed); person(a.personId).sehi = person(a.personId).sehi.plus(removed); break;
        case 'owner_retirement': mRet = mRet.plus(removed); person(a.personId).ret = person(a.personId).ret.plus(removed); break;
        case 'officer_sehi': {
          // D10: S corp keeps the deduction; officer W-2 box 1 + owner SEHI.
          mSehi = mSehi.plus(removed);
          mSehiW2 = mSehiW2.plus(removed);
          const p = person(a.personId);
          p.sehi = p.sehi.plus(removed);
          p.w2 = p.w2.plus(removed);
          break;
        }
        case 'officer_retirement': person(a.personId).empRet = person(a.personId).empRet.plus(removed); break;
        case 'guaranteed_payment': {
          mGp = mGp.plus(removed);
          let g = gps.get(a.personId);
          if (!g) { g = { amount: ZERO, accounts: new Map(), trace: [] }; gps.set(a.personId, g); }
          g.amount = g.amount.plus(removed);
          const ga = g.accounts.get(accountId) ?? { name: meta.get(accountId)!.name, amount: ZERO };
          ga.amount = ga.amount.plus(removed);
          g.accounts.set(accountId, ga);
          break;
        }
        default: break;
      }
      if (a.treatment === 'owner_personal' && a.route === 'dropped') ownerPersonal = ownerPersonal.plus(removed);
      if (a.treatment === 'nondeductible_pct' && a.route === 'entity') addBack = addBack.plus(eR.plus(eN).minus(x));
      if (a.treatment === 'w2_wages') {
        mW2 = mW2.plus(removed);
        w2Rec = w2Rec.plus(r.negated());
        w2Non = w2Non.plus(n.negated());
        if (a.personId) w2ByPerson.set(a.personId, (w2ByPerson.get(a.personId) ?? ZERO).plus(removed));
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
      sehiAsW2Wages: s4(mSehiW2),
      guaranteedPayments: s4(mGp),
      w2Wages: s4(mW2),
    });
  }

  // 5. TB tax RJEs (informational; never applied — see report notes). The TB
  //    year label is the estimator tax year itself (R1 F14): pass-throughs use
  //    a calendar window even when the company's fiscal year differs.
  const rjeByAccount = new Map<string, Dec>();
  try {
    const wp = await computeWorkpaper(tenantId, companyId, { periodEnd: throughDate, basis, taxYear });
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
  //    ALWAYS cash basis (R1 F4), whatever the entity's tax method: a payment
  //    is a cash event, so an unpaid bill to the IRS is not a payment and a
  //    paid one counts at the payment date.
  const paymentAccountIds = [...treatments.values()].filter((t) => t.treatment === 'estimated_tax_payment').map((t) => t.accountId);
  const estimatedPayments: EstimatedTaxPaymentTxn[] = [];
  if (paymentAccountIds.length > 0) {
    const detail = await buildAccountDetailReport(tenantId, window.start, throughDate, {
      title: 'tax-estimator-payments', accountTypes: ALL_ACCOUNT_TYPES, normalSide: 'debit', companyId,
      accountIds: paymentAccountIds, detail: true, basis: 'cash', exactAmounts: true,
    });
    if ('groups' in detail) {
      for (const g of detail.groups) {
        const t = treatments.get(g.accountId);
        for (const line of g.lines) {
          const amount = lineDebit(line).minus(lineCredit(line));
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

  // 7. Gross farming income (farmer test). With TB farm codes: the income
  //    accounts carrying them. A Sch F entity (or farmer_override = true) with
  //    NO farm codes counts ALL income accounts as farming (R1 F8), warned.
  const farmAccounts = new Set([...charMap.entries()].filter(([, c]) => FARM_ACTIVITIES.has(c.activityType)).map(([id]) => id));
  const isFarmer = entityType === 'sch_f' || settings?.farmerOverride === true;
  const assumeAllIncome = isFarmer && farmAccounts.size === 0;
  const countsAsFarm = (accountId: string, accountType: string) =>
    INCOME_TYPES.has(accountType) && (assumeAllIncome || farmAccounts.has(accountId));
  let farmingCurrent = ZERO;
  for (const [accountId, acc] of perAccount) {
    if (countsAsFarm(accountId, meta.get(accountId)!.accountType)) farmingCurrent = farmingCurrent.plus(acc.book);
  }
  let farmingPrior = ZERO;
  if (farmAccounts.size > 0 || assumeAllIncome) {
    const prior = taxYearWindow(taxYear - 1, entityType, resolved.fiscalYearStartMonth);
    const pl = await plExact(tenantId, prior.start, prior.end, basis, companyId);
    for (const e of [...pl.revenue, ...pl.otherRevenue]) {
      if (assumeAllIncome || farmAccounts.has(e.accountId)) farmingPrior = farmingPrior.plus(dec(e.amountExact ?? e.amount));
    }
  }
  if (assumeAllIncome) {
    warnings.push({
      code: 'TE_FARM_INCOME_ASSUMED', severity: 'warning',
      message: 'No Trial Balance farm tax codes are assigned, so ALL income accounts are counted as gross farming income for the farmer test. Assign farm codes (or set the farmer override) to confirm.',
      details: { currentYear: s4(farmingCurrent), priorYear: s4(farmingPrior) },
    });
  } else if (isFarmer) {
    const unassignedIncome = [...perAccount.keys()]
      .filter((id) => INCOME_TYPES.has(meta.get(id)!.accountType) && !charMap.has(id) && !perAccount.get(id)!.book.isZero());
    if (unassignedIncome.length > 0) {
      warnings.push({
        code: 'TE_FARM_INCOME_UNASSIGNED', severity: 'warning',
        message: `${unassignedIncome.length} income account(s) have no TB tax code and are left out of gross farming income (farmer test).`,
        details: { accountIds: unassignedIncome },
      });
    }
  }

  // 8. Account lines + trace (source 'gl_map' for every reclass).
  const accountLines: TaxBasisAccountLine[] = [];
  const unmapped: Array<{ accountId: string; name: string }> = [];
  const gpCodeNoTreatment: Array<{ accountId: string; name: string; code: string; bookAmount: string }> = [];
  const m1Accounts: Array<{ accountId: string; name: string; code: string }> = [];
  const personMissing: Array<{ accountId: string; name: string; treatment: string }> = [];
  const notForEntity: Array<{ accountId: string; name: string; treatment: string }> = [];
  const impliedConflict: Array<{ accountId: string; name: string; code: string; treatment: string }> = [];
  const taxDep: TaxBasisPl['taxDepreciationDiffers'] = [];
  const label = (m: AccountMeta) => (m.accountNumber ? `${m.accountNumber} ${m.name}` : m.name);
  for (const [accountId, acc] of perAccount) {
    const m = meta.get(accountId)!;
    const t = treatments.get(accountId);
    const code = charMap.get(accountId) ?? null;
    const a = appliedFor(accountId);
    const reclass = acc.tax.minus(acc.book);
    accountLines.push({
      accountId, accountNumber: m.accountNumber, name: m.name, accountType: m.accountType,
      character: a.character, characterSource: a.characterSource, taxCode: code,
      treatment: t?.treatment ?? null, effectiveTreatment: a.treatment, treatmentSource: a.source, personId: a.personId,
      pct: a.pct, route: a.route,
      accountNonRecurring: t?.nonRecurring ?? false,
      bookAmount: s4(acc.book), taxAmount: s4(acc.tax), reclass: s4(reclass),
      nonRecurringBookAmount: s4(acc.nonRec),
      tbTaxRje: s4(rjeByAccount.get(accountId) ?? ZERO),
    });
    const lbl = label(m);
    if (!code && !a.treatment) unmapped.push({ accountId, name: lbl });
    const implied = impliedTreatmentForCode(code);
    if (implied === 'guaranteed_payment' && entityType === 'partnership' && a.treatment !== 'guaranteed_payment' && !acc.book.isZero()) {
      gpCodeNoTreatment.push({ accountId, name: lbl, code: code!.code, bookAmount: s4(acc.book) });
    }
    if (implied && t?.treatment && t.treatment !== implied && !isCharacterTreatment(t.treatment)) {
      impliedConflict.push({ accountId, name: lbl, code: code!.code, treatment: t.treatment });
    }
    if (a.m1Warning) m1Accounts.push({ accountId, name: lbl, code: code?.code ?? '' });
    if (a.notForEntity && a.treatment) notForEntity.push({ accountId, name: lbl, treatment: a.treatment });
    if (!a.personId && (a.route === 'guaranteed_payment' || a.route === 'officer_sehi' || a.route === 'officer_retirement')) {
      personMissing.push({ accountId, name: lbl, treatment: a.treatment ?? '' });
    }
    if (a.treatment === 'tax_depreciation_differs') taxDep.push({ accountId, name: lbl, bookAmount: s4(acc.book) });

    const book = s4(acc.book);
    const mag = s4(acc.book.negated());
    const fromCode = a.source === 'tb_code' ? `; from TB code ${code?.code ?? ''}` : '';
    if (a.exclusion) {
      trace.push({
        label: `${lbl}: ${a.exclusion === 'tax_exempt' ? 'tax-exempt' : 'nondeductible'} TB code ${code?.code ?? ''}, excluded from entity profit`,
        amount: s4(reclass), formula: `book ${book} → 0`, source: 'gl_map',
      });
    }
    if (a.characterSource === 'treatment') {
      trace.push({ label: `${lbl}: character set to ${a.character} by the estimator treatment`, amount: '0.0000', formula: `book ${book}`, source: 'gl_map' });
    }
    switch (a.route) {
      case 'owner_sehi': {
        const row: TraceRow = { label: `${lbl} → owner self-employed health insurance (removed from entity profit)`, amount: s4(reclass), formula: `book ${book} → entity 0; owner SEHI ${mag}${fromCode}`, source: 'gl_map' };
        trace.push(row);
        person(a.personId).trace.push(row);
        break;
      }
      case 'owner_retirement': {
        const row: TraceRow = { label: `${lbl} → owner retirement contribution (removed from entity profit)`, amount: s4(reclass), formula: `book ${book} → entity 0; owner retirement ${mag}${fromCode}`, source: 'gl_map' };
        trace.push(row);
        person(a.personId).trace.push(row);
        break;
      }
      case 'officer_sehi': {
        const row: TraceRow = { label: `${lbl} → S corp >2% shareholder health: kept as the S corp's deduction; officer W-2 box 1 + SEHI`, amount: mag, formula: `book ${book} stays in entity profit; officer W-2 box 1 +${mag} (not SS/Medicare wages); owner SEHI ${mag}${fromCode}`, source: 'gl_map' };
        trace.push(row);
        person(a.personId).trace.push(row);
        break;
      }
      case 'officer_retirement': {
        const row: TraceRow = { label: `${lbl} → S corp retirement contribution for the officer: the corporation's deduction (no owner deduction)`, amount: mag, formula: `book ${book} stays in entity profit`, source: 'gl_map' };
        trace.push(row);
        person(a.personId).trace.push(row);
        break;
      }
      case 'guaranteed_payment': {
        const row: TraceRow = { label: `${lbl} → guaranteed payment to the partner (deducted by the partnership; partner's ordinary SE income)`, amount: mag, formula: `book ${book} stays in entity profit; partner GP ${mag}`, source: 'gl_map' };
        trace.push(row);
        gps.get(a.personId)?.trace.push(row);
        break;
      }
      case 'dropped':
        if (a.treatment === 'owner_personal') {
          trace.push({ label: `${lbl}: owner personal, not deductible (dropped)`, amount: s4(reclass), formula: `book ${book} → 0`, source: 'gl_map' });
        }
        break;
      case 'payment':
        trace.push({ label: `${lbl}: estimated tax payments removed from profit (payment ledger)`, amount: s4(reclass), formula: `book ${book} → 0`, source: 'gl_map' });
        break;
      default:
        if (a.treatment === 'nondeductible_pct') {
          trace.push({ label: `${lbl}: ${dec(a.pct).toString()}% nondeductible add-back`, amount: s4(reclass), formula: `${mag} × ${dec(a.pct).toString()}%`, source: 'gl_map' });
        } else if (a.treatment === 'tax_depreciation_differs') {
          trace.push({ label: `${lbl}: book depreciation kept; tax amount comes from an adjustment`, amount: '0.0000', formula: `book ${book}`, source: 'gl_map' });
        }
        break;
    }
    if (!acc.nonRec.isZero()) {
      trace.push({
        label: `${lbl}: non-recurring, excluded from the run-rate`,
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
  if (gpCodeNoTreatment.length > 0) {
    warnings.push({
      code: 'TE_GP_CODE_WITHOUT_TREATMENT', severity: 'warning',
      message: `${gpCodeNoTreatment.length} account(s) carry a TB guaranteed-payment code but no "Guaranteed payment" treatment: the amount is deducted from partnership profit and NOT allocated to any partner, so it is MISSING from every partner's income. Set the Guaranteed payment treatment and pick the partner.`,
      details: { accounts: gpCodeNoTreatment },
    });
  }
  if (m1Accounts.length > 0) {
    warnings.push({
      code: 'TE_M1_CODE_ON_PL_ACCOUNT', severity: 'warning',
      message: 'P&L accounts carry a Schedule M-1 (book-tax reconciling) code; the BOOK amount is kept as ordinary. Set a character treatment (e.g. Section 1231) or enter the tax amount as an adjustment.',
      details: { accounts: m1Accounts },
    });
  }
  if (personMissing.length > 0) {
    warnings.push({
      code: 'TE_OWNER_PERSON_MISSING', severity: 'warning',
      message: 'Guaranteed-payment / S corp officer treatments without a person: the amount cannot be attributed to a partner or officer. Pick the person on the treatment.',
      details: { accounts: personMissing },
    });
  }
  if (notForEntity.length > 0) {
    warnings.push({
      code: 'TE_TREATMENT_NOT_FOR_ENTITY', severity: 'warning',
      message: `Treatments that do not apply to this entity type (${entityType ?? 'unknown'}) are ignored; the amounts stay in entity profit.`,
      details: { accounts: notForEntity },
    });
  }
  if (impliedConflict.length > 0) {
    warnings.push({
      code: 'TE_TB_CODE_IMPLIES_TREATMENT', severity: 'info',
      message: 'The TB tax code implies a different treatment than the estimator treatment; the estimator treatment is applied.',
      details: { accounts: impliedConflict },
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

  // 9. W-2 wages (D8): the year's total = YTD + run-rate on the recurring
  //    portion for the remaining months (R1 F7); the override wins when set.
  const w2Ytd = w2Rec.plus(w2Non);
  const w2Projected = months.length > 0 && monthsRemaining > 0
    ? w2Ytd.plus(w2Rec.dividedBy(months.length).times(monthsRemaining))
    : w2Ytd;
  const override = yearInputs?.w2WagesOverride ?? null;
  if (override !== null) {
    trace.push({ label: 'QBI W-2 wages: per-year override', amount: s4(dec(override)), formula: `books projected ${s4(w2Projected)} (YTD ${s4(w2Ytd)}); reason: ${yearInputs?.w2WagesOverrideReason ?? ''}`, source: 'input' });
  } else if (!w2Ytd.isZero()) {
    trace.push({
      label: 'QBI W-2 wages: year projected from w2_wages accounts', amount: s4(w2Projected),
      formula: `YTD ${s4(w2Ytd)} + recurring ${s4(w2Rec)} ÷ ${months.length} × ${monthsRemaining}`, source: 'gl_map',
    });
  }

  if (!yearInputs?.ubia) {
    warnings.push({
      code: 'TE_UBIA_MISSING', severity: 'info',
      message: `No UBIA entered for ${taxYear}; the QBI UBIA limb is not computed.`,
    });
  }

  const sum = (f: (p: PersonAcc) => Dec) => [...persons.values()].reduce((acc, p) => acc.plus(f(p)), ZERO);
  const byPerson: OwnerLevelPerson[] = [...persons.entries()]
    .map(([personId, p]) => ({
      personId, ownerSehi: s4(p.sehi), ownerRetirement: s4(p.ret), sehiAsW2Wages: s4(p.w2), employerRetirement: s4(p.empRet), trace: p.trace,
    }))
    .sort((a, b) => (a.personId ?? '').localeCompare(b.personId ?? ''));
  const guaranteedPayments: GuaranteedPaymentDto[] = [...gps.entries()]
    .map(([personId, g]) => ({
      personId, amount: s4(g.amount),
      accounts: [...g.accounts.entries()].map(([accountId, x]) => ({ accountId, name: x.name, amount: s4(x.amount) })),
      trace: g.trace,
    }))
    .sort((a, b) => (a.personId ?? '').localeCompare(b.personId ?? ''));

  const throughMonthSource: ThroughMonthSource = 'requested'; // overwritten per request by getTaxBasisPl
  return {
    tenantId, companyId, companyName: resolved.companyName, taxYear,
    periodStart: window.start, throughDate, throughMonth, throughMonthSource, throughMonthReason: '',
    monthsElapsed: months.length, monthsRemaining,
    basis, entityType, glVersionStamp, configVersion, cached: false,
    bookNetIncome: s4(bookNet),
    taxBasisProfit: s4(taxBasisProfit),
    byCharacter: charsOut(byCharacter),
    recurring: charsOut(totals.recurring),
    nonRecurring: charsOut(totals.nonRecurring),
    ownerLevel: {
      ownerSehi: s4(sum((p) => p.sehi)),
      ownerRetirement: s4(sum((p) => p.ret)),
      ownerPersonalDropped: s4(ownerPersonal),
      sehiAsW2Wages: s4(sum((p) => p.w2)),
      byPerson,
    },
    guaranteedPayments,
    nondeductibleAddBack: s4(addBack),
    taxDepreciationDiffers: taxDep,
    estimatedPayments,
    months: monthsOut,
    farmingGrossIncome: { currentYear: s4(farmingCurrent), priorYear: s4(farmingPrior) },
    w2Wages: {
      ytd: s4(w2Ytd),
      recurringYtd: s4(w2Rec),
      nonRecurringYtd: s4(w2Non),
      projectedYear: s4(w2Projected),
      override,
      overrideReason: yearInputs?.w2WagesOverrideReason ?? null,
      effective: s4(override !== null ? dec(override) : w2Projected),
      source: override !== null ? 'override' : 'books',
      includeSehiInW2Wages: yearInputs?.includeSehiInW2Wages ?? false,
      byPerson: [...w2ByPerson.entries()].map(([personId, v]) => ({ personId, ytd: s4(v) })).sort((x, y) => x.personId.localeCompare(y.personId)),
    },
    ubia: yearInputs?.ubia ?? null,
    accounts: accountLines,
    trace,
    warnings,
  };
}
