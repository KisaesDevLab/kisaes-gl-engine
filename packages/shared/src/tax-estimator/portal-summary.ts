// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Q51 — the client portal's calculation summary (OPEN-QUESTIONS Q51, MODULE.md D5 / D10).
//
// An ALLOW-LIST projection of the staff EstimateResultDTO into PortalTaxCalcSummaryDTO, run
// SERVER-side only (portal-estimates.service). It reads named figures of the result and
// rounds them to whole dollars; it never copies an object through, so nothing new in the
// engine result can reach the portal by accident. What it leaves out on purpose:
//   - entity totals (the business's 100% figure), other owners, ownership %, link ids,
//   - adjustment detail (only the adjustments-to-income TOTAL is shown),
//   - rates (marginal / effective / state rates), traces, formulas, parameters,
//   - preparer review chips, warnings, readiness, safe-harbor workings, prior-year figures.
// Not the shared calc-lines builder: its lines carry entity totals, owner %, rates in
// sub-labels, review chips and trace scopes, which would all have to be filtered back out.
import type { EstimateResultDTO } from './estimate-api.js';
import type { PortalTaxCalcSummaryDTO } from './portal-api.js';
import { dAdd, dRoundDollars, dSum, type Dec } from './decimal.js';
import { STATE_NAMES } from './stateRuleKeys.js';

/** A figure as a whole-dollar string; a missing or malformed figure (older snapshots) reads 0. */
function R(v: unknown): Dec {
  if (typeof v === 'number' && Number.isFinite(v)) return dRoundDollars(String(v));
  if (typeof v !== 'string' || !/^-?\d+(\.\d+)?$/.test(v.trim())) return '0';
  return dRoundDollars(v.trim());
}
const isZero = (v: Dec) => v === '0' || v === '-0';
const num = (v: unknown): Dec => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? v.trim() : '0');

/** Build the portal calculation summary from an estimate result (live or a frozen snapshot's). */
export function buildPortalCalcSummary(r: EstimateResultDTO): PortalTaxCalcSummaryDTO {
  const f = r.federal;

  // The taxpayer's own share of each business: the sum of its links' allocated shares (the
  // same "share" figure the staff Calculation view adds into Total income). Two links into one
  // business (taxpayer + spouse) combine into one row; the entity total is never read.
  const byBusiness = new Map<string, { name: string; amount: Dec }>();
  for (const e of f.entities ?? []) {
    const share = dSum((e.shares ?? []).flatMap((s) => Object.values(s.share ?? {}).map(num)));
    const key = e.companyId;
    const prev = byBusiness.get(key);
    byBusiness.set(key, { name: String(e.companyName ?? ''), amount: prev ? dAdd(prev.amount, share) : share });
  }
  const businesses = [...byBusiness.values()].map((b) => ({ name: b.name, amount: R(b.amount) }));

  const other: Array<[string, unknown]> = [
    ['Wages', f.income?.wages], ['Interest', f.income?.interest], ['Dividends', f.income?.dividends],
    ['Capital gains', f.income?.capitalGainNet], ['Section 1231 gains', f.income?.section1231], ['Other income', f.income?.otherIncome],
  ];
  const otherIncome = other.map(([label, v]) => ({ label, amount: R(v) })).filter((x) => !isZero(x.amount));

  const cr = f.credits;
  const credits = R(dAdd(num(cr?.nonrefundableAllowed), num(cr?.refundable)));
  const sch1a = f.deductions?.sch1a;

  // State: one row per state (a resident and a nonresident row of one state combine).
  const byState = new Map<string, Dec>();
  for (const s of r.state?.rows ?? []) byState.set(s.state, dAdd(byState.get(s.state) ?? '0', num(s.netTax)));
  const states = [...byState.entries()].map(([state, amount]) => ({
    state, label: (STATE_NAMES as Record<string, string>)[state] ?? state, amount: R(amount),
  }));

  return {
    businesses,
    otherIncome,
    totalIncome: R(f.income?.totalIncome),
    adjustmentsTotal: R(f.adjustmentsToIncome?.total),
    agi: R(f.agi),
    deduction: { kind: f.deductions?.chosen === 'itemized' ? 'itemized' : 'standard', amount: R(f.deductions?.deduction) },
    additionalDeductions: sch1a?.inEffect ? R(sch1a.total) : '0',
    qbiDeduction: R(f.qbi?.deduction),
    taxableIncome: R(f.taxableIncome),
    regularTax: R(f.regularTax?.tax),
    credits,
    selfEmploymentTax: R(f.seTax),
    additionalMedicareTax: R(f.additionalMedicareTax),
    niit: R(f.niit),
    federalTotal: R(f.federalTotal),
    states,
    stateTotal: R(r.state?.stateTotal ?? r.summary?.stateTotal),
    total: R(r.summary?.total),
  };
}
