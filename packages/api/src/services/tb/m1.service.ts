// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Schedule M-1 & M-2 previews (Phase 9, D16/D18).
//
// M-1: book income → tax income bridge. Every P&L account's book-tax
// delta (tax − adjusted, signed nets) is categorized into the four M-1
// buckets by account side and delta direction. Because the deltas come
// from the same engine that computes both columns, book income + M-1
// lines ≡ tax income BY CONSTRUCTION — the "unreconciled difference"
// diagnostic (9.3) instead lists deltas on accounts whose assigned
// code is NOT flagged is_m1_adjustment (a book-tax difference riding
// an unflagged code is the thing a reviewer must explain).
//
// M-2: beginning equity (by role) + book income − distributions +
// contributions ± other = computed ending, tied against the GL equity
// ending balance. Roles default by heuristic and are configurable per
// entity (company_tax_profiles.equity_roles).

import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { companies, companyTaxProfiles } from '../../db/schema/index.js';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../middleware/audit.js';
import { computeWorkpaper, type TbBasis, type TbWorkpaperRow } from './balance-engine.service.js';
import { fiscalYearEnd } from './tax-profile.service.js';
import { m1FlaggedAccountIds } from './tax-entries.service.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

export type M1Category =
  | 'income_on_return_not_books'
  | 'income_on_books_not_return'
  | 'deductions_on_return_not_books'
  | 'expenses_on_books_not_return';

export interface M1Line {
  accountId: string;
  accountNumber: string | null;
  name: string;
  category: M1Category;
  amount: number; // positive magnitude in its bucket
  flagged: boolean; // assigned code carries is_m1_adjustment
}


export async function buildM1(tenantId: string, companyId: string, opts: { taxYear: number; basis: TbBasis }) {
  const [company] = await db.select({ m: companies.fiscalYearStartMonth }).from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId))).limit(1);
  if (!company) throw AppError.notFound('Company not found');
  const periodEnd = fiscalYearEnd(opts.taxYear, company.m ?? 1);
  const wp = await computeWorkpaper(tenantId, companyId, { periodEnd, basis: opts.basis, taxYear: opts.taxYear });
  const flagged = await m1FlaggedAccountIds(tenantId, companyId);

  // Signed nets: + = debit. P&L net income = −Σ(adjusted of P&L rows).
  let bookIncome = 0;
  let taxIncome = 0;
  const lines: M1Line[] = [];
  for (const row of wp.rows) {
    if (!isPl(row)) continue;
    bookIncome -= row.adjusted;
    taxIncome -= row.tax;
    const delta = round2(row.tax - row.adjusted);
    if (Math.abs(delta) < 0.005) continue;
    let category: M1Category;
    if (row.accountType === 'revenue') {
      // More credit (delta<0) = more income on the return.
      category = delta < 0 ? 'income_on_return_not_books' : 'income_on_books_not_return';
    } else {
      // More debit (delta>0) = more deduction on the return.
      category = delta > 0 ? 'deductions_on_return_not_books' : 'expenses_on_books_not_return';
    }
    lines.push({
      accountId: row.accountId,
      accountNumber: row.accountNumber,
      name: row.name,
      category,
      amount: Math.abs(delta),
      flagged: flagged.has(row.accountId),
    });
  }

  const sum = (cat: M1Category) => round2(lines.filter((l) => l.category === cat).reduce((s, l) => s + l.amount, 0));
  const additions = round2(sum('income_on_return_not_books') + sum('expenses_on_books_not_return'));
  const subtractions = round2(sum('income_on_books_not_return') + sum('deductions_on_return_not_books'));
  const computedTaxIncome = round2(bookIncome + additions - subtractions);
  // 9.3: book-tax movement riding codes NOT flagged M-1.
  const unexplained = lines.filter((l) => !l.flagged);

  return {
    taxYear: opts.taxYear,
    periodEnd,
    basis: opts.basis,
    glVersionStamp: wp.glVersionStamp,
    bookIncome: round2(bookIncome),
    taxIncome: round2(taxIncome),
    computedTaxIncome,
    reconciles: Math.abs(computedTaxIncome - round2(taxIncome)) < 0.01,
    additions,
    subtractions,
    lines,
    unexplained,
  };
}

// ── M-2 rollforward (9.4) ──────────────────────────────────────────

export type EquityRole = 'retained' | 'distributions' | 'contributions' | 'other';

// Sensible defaults by name/detail heuristics; the per-entity map in
// company_tax_profiles.equity_roles overrides account-by-account.
export function defaultEquityRole(name: string, detailType: string | null): EquityRole {
  const n = name.toLowerCase();
  const d = detailType ?? '';
  if (/distribut|draw|dividend/.test(n) || /distribution/.test(d)) return 'distributions';
  if (/contribut|paid.?in|capital stock|common stock|preferred/.test(n) || /paid_in|capital_stock/.test(d)) return 'contributions';
  if (/retained|accumulated adjustments|aaa|members.? equity|partners.? capital|owner.?s equity/.test(n) || d === 'retained_earnings') return 'retained';
  return 'other';
}

export async function getEquityRoles(tenantId: string, companyId: string): Promise<Record<string, EquityRole>> {
  const [profile] = await db.select({ roles: companyTaxProfiles.equityRoles }).from(companyTaxProfiles)
    .where(and(eq(companyTaxProfiles.tenantId, tenantId), eq(companyTaxProfiles.companyId, companyId)))
    .limit(1);
  return (profile?.roles as Record<string, EquityRole> | null) ?? {};
}

export async function setEquityRoles(tenantId: string, companyId: string, roles: Record<string, EquityRole>, userId?: string) {
  const [profile] = await db.select().from(companyTaxProfiles)
    .where(and(eq(companyTaxProfiles.tenantId, tenantId), eq(companyTaxProfiles.companyId, companyId)))
    .limit(1);
  if (!profile) throw AppError.unprocessableEntity('Set the company tax profile first', 'TB_NOT_ASSIGNABLE');
  const [after] = await db.update(companyTaxProfiles).set({ equityRoles: roles, updatedAt: new Date() })
    .where(eq(companyTaxProfiles.id, profile.id)).returning();
  await auditLog(tenantId, 'update', 'tb_equity_roles', profile.id, { roles: profile.equityRoles }, { roles }, userId);
  return after;
}

export async function buildM2(tenantId: string, companyId: string, opts: { taxYear: number; basis: TbBasis }) {
  const [company] = await db.select({ m: companies.fiscalYearStartMonth }).from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId))).limit(1);
  if (!company) throw AppError.notFound('Company not found');
  const fyMonth = company.m ?? 1;
  const periodEnd = fiscalYearEnd(opts.taxYear, fyMonth);
  const priorEnd = fiscalYearEnd(opts.taxYear - 1, fyMonth);

  const [wp, prior, roleOverrides] = await Promise.all([
    computeWorkpaper(tenantId, companyId, { periodEnd, basis: opts.basis, taxYear: opts.taxYear }),
    computeWorkpaper(tenantId, companyId, { periodEnd: priorEnd, basis: opts.basis, taxYear: opts.taxYear - 1 }),
    getEquityRoles(tenantId, companyId),
  ]);

  const roleOf = (r: { accountId: string; name: string; detailType: string | null }): EquityRole =>
    roleOverrides[r.accountId] ?? defaultEquityRole(r.name, r.detailType);

  // Signed nets: + = debit; equity is naturally credit (negative).
  // Prior-year book income has NOT been folded into equity in the prior
  // workpaper (its P&L rows still carry it) — the current workpaper's
  // RE fold row carries it instead. Beginning equity therefore =
  // prior equity + prior book income, attributed to the fold row.
  let priorBookIncome = 0;
  for (const row of prior.rows) {
    if (isPl(row)) priorBookIncome -= row.adjusted;
  }
  const equityRows = wp.rows.filter((r) => r.accountType === 'equity');
  const priorEquity = prior.rows.filter((r) => r.accountType === 'equity');
  const priorByAccount = new Map(priorEquity.map((r) => [r.accountId, r.adjusted]));
  const foldRow = equityRows.find((r) => r.isVirtualRe)
    ?? equityRows.find((r) => r.detailType === 'retained_earnings');

  const ids = new Set<string>([...equityRows.map((r) => r.accountId), ...priorEquity.map((r) => r.accountId)]);
  let beginning = 0;
  let distributions = 0;
  let contributions = 0;
  let other = 0;
  const accounts: Array<{ accountId: string; accountNumber: string | null; name: string; role: EquityRole; beginning: number; activity: number; ending: number }> = [];
  for (const id of ids) {
    const currentRow = equityRows.find((r) => r.accountId === id);
    const priorRow = priorEquity.find((r) => r.accountId === id);
    const meta = currentRow ?? priorRow!;
    const endingSigned = currentRow?.adjusted ?? priorRow?.adjusted ?? 0;
    const beginningSigned = (priorByAccount.get(id) ?? 0) + (foldRow && id === foldRow.accountId ? -priorBookIncome : 0);
    const activitySigned = round2(endingSigned - beginningSigned);
    const role = roleOf(meta);
    accounts.push({
      accountId: id,
      accountNumber: meta.accountNumber,
      name: meta.name,
      role,
      beginning: round2(-beginningSigned),
      activity: round2(-activitySigned),
      ending: round2(-endingSigned),
    });
    beginning += -beginningSigned;
    if (role === 'distributions') distributions += activitySigned;      // debit-positive outflow
    else if (role === 'contributions') contributions += -activitySigned; // credit-positive inflow
    // 'retained' + 'other': direct-to-equity bookings ride ± other.
    else other += -activitySigned;
  }

  // Book income for the year from the same workpaper.
  let bookIncome = 0;
  for (const row of wp.rows) {
    if (isPl(row)) bookIncome -= row.adjusted;
  }

  const computedEnding = round2(beginning + bookIncome - distributions + contributions + other);
  // GL ending equity carries current-year income only after closing —
  // the engine folds P&L to RE only across FY boundaries, so tie out
  // against ending equity accounts + current-year net income.
  let glEndingEquity = 0;
  for (const row of wp.rows) {
    if (row.accountType === 'equity') glEndingEquity += -row.adjusted;
  }
  const glEndingWithIncome = round2(glEndingEquity + bookIncome);
  const unreconciled = round2(computedEnding - glEndingWithIncome);

  return {
    taxYear: opts.taxYear,
    periodEnd,
    basis: opts.basis,
    glVersionStamp: wp.glVersionStamp,
    beginning: round2(beginning),
    bookIncome: round2(bookIncome),
    distributions: round2(distributions),
    contributions: round2(contributions),
    other: round2(other),
    computedEnding,
    glEndingEquity: glEndingWithIncome,
    unreconciled,
    reconciles: Math.abs(unreconciled) < 0.01,
    accounts,
  };
}

function isPl(row: TbWorkpaperRow): boolean {
  return row.accountType === 'revenue' || row.accountType === 'expense';
}
