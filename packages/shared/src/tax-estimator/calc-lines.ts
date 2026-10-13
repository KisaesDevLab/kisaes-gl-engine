// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Pure builder for the Calculation view: reads the EstimateResultDTO and returns display lines.
// ONE source for the web Calculation table (features/tax-estimator/estimate/CalculationTable.tsx)
// and the estimate PDF's "Detailed calculation" page, so both print the same lines.
// YTD tax basis is filled only for income lines (the engine computes tax on the projection only,
// so the YTD column is blank for deduction and tax lines). No tax math here: every figure is a
// field of the DTO; the only arithmetic is the YTD column's sum of the entity's YTD characters
// and an owner's YTD share (entity YTD × allocated %). Q45 outside businesses: see the income block.
// Q46: an entity with a prior-year trend method carries the method sub-label and comparison chips.
// Q49: a business whose entity year overrides the entity type carries an info review chip
// ("Entity type overridden: S corp (TB profile says 1065)"); a client deliverable drops it.
import type { EstimateResultDTO } from './estimate-api.js';
import { entityTypeOverrideText } from './entity-type-override.js';
import { stateRowDetail } from './assumptions.js';

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
/** Fraction string -> "22%" / "18.8%" (same as the web's format.pct). */
function pct(v: string | number | null | undefined, places = 1): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(places).replace(/\.0+$/, '')}%`;
}

export type TraceScope =
  | { kind: 'federal'; steps: string[]; idPrefix?: string }
  | { kind: 'state'; state?: string }
  | { kind: 'estimate'; jurisdiction: string };

export interface CalcLine {
  key: string;
  label: string;
  sub?: string;
  ytd?: string | null;
  projected: string | null;
  bold?: boolean;
  /** Context row shown for reference and NOT part of the section total (entity totals). */
  muted?: boolean;
  /** Child row of the line above (an owner's share of a business). */
  indent?: boolean;
  /** review = a preparer review marker ("Verify", "Rules unverified"); a client deliverable drops it. */
  chips?: Array<{ text: string; tone: 'warn' | 'info'; review?: boolean }>;
  trace?: TraceScope;
}
export interface CalcSection { key: string; title: string; lines: CalcLine[] }

const ENTITY_LABEL: Record<string, string> = {
  sch_c: 'Sch C', sch_f: 'Sch F', sole_prop: 'Sch C', single_member_llc: 'Sch C', s_corp: 'S corp', partnership: 'Partnership', c_corp: 'C corp', farm: 'Sch F', rental: 'Rental',
};
/** Short entity-type label the Calculation view uses ("S corp", "Sch C", ...); unknown types print as stored. */
export function calcEntityTypeLabel(entityType: string | null | undefined): string {
  if (!entityType) return 'unknown';
  return ENTITY_LABEL[entityType] ?? entityType.replace(/_/g, ' ');
}
const nonZero = (v: unknown) => Math.abs(num(v)) > 0;
const sum = (o: Record<string, string> | null | undefined) => Object.values(o ?? {}).reduce((a, v) => a + num(v), 0);

type EntityProjection = EstimateResultDTO['federal']['entities'][number]['projection'];
const dollars = (v: unknown) => `$${Math.round(num(v)).toLocaleString('en-US')}`;

/** Q46: the method sub-label of a business whose entity year selected a prior-year trend (absent = run rate, nothing printed). */
export function projectionSub(p: EntityProjection): string | null {
  if (!p) return null;
  if (p.applied === 'prior_year_scaled') return `Prior-year seasonal (scaled ×${num(p.factor).toFixed(2)})`;
  if (p.applied === 'prior_year_dollar') return 'Prior-year seasonal (prior-year dollars)';
  return p.fallbackReason ? 'Run rate (prior-year trend unavailable)' : 'Run rate';
}

function projectionChips(p: EntityProjection): NonNullable<CalcLine['chips']> {
  if (!p) return [];
  const out: NonNullable<CalcLine['chips']> = [];
  if (p.applied !== 'run_rate' && p.runRateProjectedProfit != null) out.push({ text: `Run rate would be ${dollars(p.runRateProjectedProfit)}`, tone: 'info' });
  if (p.capped) out.push({ text: `Scale factor capped at ×${num(p.factor).toFixed(2)} (was ×${num(p.rawFactor).toFixed(2)})`, tone: 'warn', review: true });
  if (p.fallbackReason) out.push({ text: 'Prior-year trend fell back to the run rate', tone: 'warn', review: true });
  return out;
}

export function buildCalcSections(r: EstimateResultDTO): CalcSection[] {
  const f = r.federal;
  const sections: CalcSection[] = [];

  // Each business prints as the entity total (context only, not added into income) followed by one
  // row per owner link with that person's share; the share rows are what Total income adds up.
  // YTD share = entity YTD × the allocated % (profit %, or loss % when the projection is a loss);
  // the projected share is the engine's allocation, which also carries link adjustments.
  // Q45 businesses outside MyBooks: sub-label "Outside MyBooks · entered"; full-year entries have no
  // YTD column; an owner's-share (K-1) entry prints the share row only, labelled with the stated %.
  const dtoByCompany = new Map((r.entities ?? []).map((d) => [d.companyId, d]));
  const income: CalcLine[] = f.entities.flatMap((e) => {
    const shares = e.shares;
    const dto = dtoByCompany.get(e.companyId);
    const outside = dto?.outside ?? null;
    const isOutside = e.source === 'outside' || dto?.source === 'outside';
    const ownerShare = isOutside && (e.amountBasis ?? outside?.amountBasis) === 'owner_share';
    const fullYear = isOutside && (e.entryMode ?? outside?.entryMode) !== 'ytd';
    const activity = [...new Set(shares.map((s) => s.activityType))].join(', ');
    const entityYtd = sum(e.ytd as unknown as Record<string, string>);
    const useLoss = num(e.projectedProfit) < 0;
    const owners = dto?.owners ?? [];
    const enteredSub = isOutside
      ? `Outside MyBooks · entered${fullYear ? ' (full year)' : outside?.throughMonth ? ` (YTD through month ${outside.throughMonth})` : ' (YTD)'}`
      : null;
    const ytdOf = (v: number): string | null => (fullYear ? null : String(Math.round(v * 100) / 100));
    if (ownerShare) {
      // The entered amounts ARE the owner's share: no entity-total row; the stated % is informational.
      const stated = useLoss ? (outside?.statedLossPct ?? outside?.statedProfitPct ?? null) : (outside?.statedProfitPct ?? null);
      return shares.map((s): CalcLine => {
        const name = owners.find((o) => o.personId === s.personId)?.displayName;
        return {
          key: `inc.${e.companyId}.${s.linkId}`,
          label: `${e.companyName} — ${name ? `${name}'s share` : 'Share'} (K-1 share${stated != null ? `, ${stated}% owned` : ''})`,
          sub: [calcEntityTypeLabel(e.entityType), activity, enteredSub].filter(Boolean).join(' · '),
          ytd: ytdOf(entityYtd),
          projected: String(sum(s.share as unknown as Record<string, string>)),
          trace: { kind: 'federal', steps: ['entity_income', 'allocation'], idPrefix: undefined },
        };
      });
    }
    const chips = projectionChips(e.projection);
    if (dto?.entityTypeOverride) chips.unshift({ text: entityTypeOverrideText(dto.entityTypeOverride), tone: 'info', review: true });
    const lines: CalcLine[] = [{
      key: `inc.${e.companyId}`, label: e.companyName,
      sub: [calcEntityTypeLabel(e.entityType), activity, 'Entity total (100%)', enteredSub, projectionSub(e.projection)].filter(Boolean).join(' · '),
      ytd: ytdOf(entityYtd), projected: e.projectedProfit, muted: true,
      ...(chips.length ? { chips } : {}),
      trace: { kind: 'federal', steps: ['entity_income', 'allocation'], idPrefix: undefined },
    }];
    for (const s of shares) {
      const fraction = num(useLoss ? s.lossFraction : s.profitFraction);
      const name = owners.find((o) => o.personId === s.personId)?.displayName;
      lines.push({
        key: `inc.${e.companyId}.${s.linkId}`,
        label: `${name ? `${name}'s share` : 'Share'} (${pct(fraction, 2)}${useLoss ? ' of loss' : ''})`,
        ytd: ytdOf(entityYtd * fraction),
        projected: String(sum(s.share as unknown as Record<string, string>)),
        indent: true,
      });
    }
    return lines;
  });
  const otherIncome: Array<[string, string, string]> = [
    ['wages', 'W-2 wages', f.income.wages], ['int', 'Interest', f.income.interest], ['div', 'Dividends', f.income.dividends],
    ['cg', 'Net capital gain', f.income.capitalGainNet], ['s1231', 'Net section 1231', f.income.section1231], ['oth', 'Other income', f.income.otherIncome],
  ];
  for (const [k, label, v] of otherIncome) if (nonZero(v)) income.push({ key: `inc.${k}`, label, projected: v, trace: { kind: 'federal', steps: ['entity_income', 'allocation'] } });
  income.push({ key: 'inc.total', label: 'Total income', projected: f.income.totalIncome, bold: true, trace: { kind: 'federal', steps: ['entity_income', 'allocation', 'loss_limits'] } });
  const ll = f.lossLimitations;
  if (nonZero(ll.suspendedPassiveLoss)) income[income.length - 1]!.chips = [{ text: `Passive loss suspended ${num(ll.suspendedPassiveLoss).toLocaleString('en-US')}`, tone: 'warn' }];
  if (nonZero(ll.excessBusinessLoss)) (income[income.length - 1]!.chips ??= []).push({ text: 'Excess business loss (NOL note)', tone: 'warn' });
  sections.push({ key: 'income', title: 'Income', lines: income });

  const a = f.adjustmentsToIncome;
  const retCapped = f.persons.filter((p) => p.retirement.capped);
  const adj: CalcLine[] = [];
  const adjRows: Array<[string, string, string, CalcLine['chips']]> = [
    ['se', 'Half of self-employment tax', a.halfSeTax, undefined],
    ['ret', 'Retirement contributions', a.retirement, retCapped.length ? [{ text: 'Capped at limit', tone: 'warn' as const }] : undefined],
    ['sehi', 'Self-employed health insurance', a.sehi, f.persons.some((p) => p.sehi.capped) ? [{ text: 'Capped at limit', tone: 'warn' as const }] : undefined],
    ['hsa', 'HSA', a.hsa, f.persons.some((p) => p.hsa.capped) ? [{ text: 'Capped at limit', tone: 'warn' as const }] : undefined],
    ['oth', 'Other adjustments', a.other, undefined],
  ];
  for (const [k, label, v, chips] of adjRows) if (nonZero(v)) adj.push({ key: `adj.${k}`, label, projected: v, chips, trace: { kind: 'federal', steps: ['owner_limits', 'se_tax'] } });
  adj.push({ key: 'adj.agi', label: 'Adjusted gross income', projected: f.agi, bold: true, trace: { kind: 'federal', steps: ['agi'] } });
  sections.push({ key: 'adjustments', title: 'Adjustments', lines: adj });

  const d = f.deductions;
  const other = d.chosen === 'standard' ? d.itemized.total : d.standard.total;
  const ded: CalcLine[] = [
    {
      key: 'ded.main', label: d.chosen === 'standard' ? 'Standard deduction' : 'Itemized deductions', projected: d.deduction,
      sub: `${d.chosen === 'standard' ? 'Itemized' : 'Standard'} would be ${num(other).toLocaleString('en-US')}${d.mode === 'auto' ? ' (auto)' : ' (forced)'}`,
      trace: { kind: 'federal', steps: ['deductions'] },
    },
  ];
  if (d.sch1a.inEffect && nonZero(d.sch1a.total)) ded.push({ key: 'ded.1a', label: 'Schedule 1-A deductions', projected: d.sch1a.total, trace: { kind: 'federal', steps: ['deductions'] } });
  ded.push({
    key: 'ded.qbi', label: 'Qualified business income deduction', projected: f.qbi.deduction,
    chips: f.qbi.method === 'manual' ? [{ text: 'Manual override', tone: 'info' }] : undefined, trace: { kind: 'federal', steps: ['qbi'] },
  });
  ded.push({ key: 'ded.ti', label: 'Taxable income', projected: f.taxableIncome, bold: true, trace: { kind: 'federal', steps: ['taxable_income'] } });
  sections.push({ key: 'deductions', title: 'Deductions', lines: ded });

  const tax: CalcLine[] = [
    {
      key: 'tax.regular', label: 'Regular income tax', projected: f.regularTax.tax,
      sub: f.regularTax.method === 'effective' ? 'Effective-rate override' : `Marginal rate ${pct(f.regularTax.marginalOrdinaryRate)}${
        // Q53 / Q39: the 25% / 28% worksheet buckets when present.
        f.regularTax.worksheet && (nonZero(f.regularTax.worksheet.unrecaptured1250) || nonZero(f.regularTax.worksheet.collectibles))
          ? `; unrecaptured §1250 ${num(f.regularTax.worksheet.unrecaptured1250).toLocaleString('en-US')} (25%), collectibles ${num(f.regularTax.worksheet.collectibles).toLocaleString('en-US')} (28%)` : ''}`,
      trace: { kind: 'federal', steps: ['regular_tax'] },
    },
  ];
  // Q44: the dependent credits are their own lines; "Nonrefundable credits" is then the other (manual) credits.
  const cr = f.credits;
  const split = cr.careCredit !== undefined;
  if (split && nonZero(cr.careCredit)) tax.push({ key: 'tax.cr.care', label: 'Child and dependent care credit', projected: `-${cr.careCredit}`, trace: { kind: 'federal', steps: ['credits'], idPrefix: 'credits.care' } });
  if (split && nonZero(cr.childTaxCredit)) tax.push({ key: 'tax.cr.ctc', label: 'Child tax credit / credit for other dependents', projected: `-${cr.childTaxCredit}`, trace: { kind: 'federal', steps: ['credits'], idPrefix: 'credits.ctc' } });
  const otherNonref = split ? cr.otherNonrefundableAllowed : cr.nonrefundableAllowed;
  if (nonZero(otherNonref)) tax.push({ key: 'tax.cr', label: split && (nonZero(cr.careCredit) || nonZero(cr.childTaxCredit)) ? 'Other nonrefundable credits' : 'Nonrefundable credits', projected: `-${otherNonref}`, trace: { kind: 'federal', steps: ['credits'], idPrefix: 'credits.nonrefundable' } });
  for (const p of f.persons) if (nonZero(p.seTax)) tax.push({ key: `tax.se.${p.personId}`, label: `Self-employment tax — ${p.displayName}`, projected: p.seTax, trace: { kind: 'federal', steps: ['se_tax'], idPrefix: `se_tax.${p.personId}` } });
  if (nonZero(f.additionalMedicareTax)) tax.push({ key: 'tax.am', label: 'Additional Medicare tax', projected: f.additionalMedicareTax, trace: { kind: 'federal', steps: ['other_taxes'] } });
  if (nonZero(f.niit)) tax.push({ key: 'tax.niit', label: 'Net investment income tax', projected: f.niit, trace: { kind: 'federal', steps: ['other_taxes'] } });
  if (split && nonZero(cr.additionalChildTaxCredit)) tax.push({ key: 'tax.rf.actc', label: 'Additional child tax credit (refundable)', projected: `-${cr.additionalChildTaxCredit}`, trace: { kind: 'federal', steps: ['credits'], idPrefix: 'credits.actc' } });
  const otherRef = split ? cr.otherRefundable : cr.refundable;
  if (nonZero(otherRef)) tax.push({ key: 'tax.rf', label: split && nonZero(cr.additionalChildTaxCredit) ? 'Other refundable credits' : 'Refundable credits', projected: `-${otherRef}`, trace: { kind: 'federal', steps: ['credits'], idPrefix: 'credits.refundable' } });
  tax.push({ key: 'tax.fed', label: 'Federal total', projected: f.federalTotal, bold: true, trace: { kind: 'federal', steps: ['federal_total'] } });
  sections.push({ key: 'federal', title: 'Federal tax', lines: tax });

  if (r.state && r.state.rows.length > 0) {
    const st: CalcLine[] = r.state.rows.map((s) => {
      const chips: NonNullable<CalcLine['chips']> = [];
      // QA D18: "Rules unverified" only when a rule the state used is not verified (or the federal
      // pattern stood in); other verify reasons (gate inputs missing) read "Verify".
      const rulesUnverified = s.usesFederalFallback || r.rulesUsed.some((u) => u.state === s.state && u.status !== 'verified');
      if (rulesUnverified) chips.push({ text: 'Rules unverified', tone: 'warn', review: true });
      else if (s.verify) chips.push({ text: 'Verify', tone: 'warn', review: true });
      return {
        key: `st.${s.rowId}`, label: `${s.state} — ${s.residency === 'resident' ? 'resident' : 'nonresident'}`,
        // Q53: "brackets" (the rate-schedule computation and, nonresident, the ratio formula) vs
        // "effective-rate override" — the same words as the assumptions page.
        sub: s.schedule
          ? `${s.schedule.capitalGainsTreatment === 'excise' ? '' : s.residency === 'resident' ? 'Brackets — ' : s.method === 'nonresident_ratio' ? 'Brackets, ratio method — ' : 'Brackets, sourced income — '}${stateRowDetail(s)}`
          : s.residency === 'resident'
            ? `${s.rateModeRequested === 'effective' ? 'Effective-rate override — ' : s.hasIncomeTax ? 'No rate schedule on file, effective rate — ' : ''}${s.exemptions && nonZero(s.exemptions) ? `Exemptions ${num(s.exemptions).toLocaleString('en-US')} off the base; ` : ''}${s.exemptionCredits && nonZero(s.exemptionCredits) ? `exemption credits ${num(s.exemptionCredits).toLocaleString('en-US')}; ` : ''}Gross ${num(s.grossTax).toLocaleString('en-US')} less ${num(s.creditForOtherStates).toLocaleString('en-US')} other-state credit`
            : `${s.rateModeRequested === 'effective' ? 'Effective-rate override — ' : s.nonresidentMode === 'sourced_rate' ? 'Sourced income × rate (chosen) — ' : ''}Sourced income ${num(s.sourcedIncome).toLocaleString('en-US')} × ${pct(s.effectiveRate, 2)} — effective-rate estimate; most states compute nonresident tax by ratio of the full return`,
        projected: s.netTax, chips: chips.length ? chips : undefined, trace: { kind: 'state', state: s.state },
      };
    });
    st.push({ key: 'st.total', label: 'State total', projected: r.state.stateTotal, bold: true, trace: { kind: 'state' } });
    sections.push({ key: 'state', title: 'State tax', lines: st });
  }
  sections.push({ key: 'total', title: 'Total', lines: [{ key: 'total', label: 'Total estimated tax', projected: r.summary.total, bold: true }] });
  return sections;
}
