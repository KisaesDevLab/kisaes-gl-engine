// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Phase 12 — the assumptions block (MODULE.md "Scenarios, snapshots,
// standards"). A PURE function of the assembled estimate: it only reads the engine
// results and trace already on the EstimateResultDTO and turns them into labelled
// lines; it never computes tax. The UI summary, the standalone PDF / Report Pack
// assumptions page and the immutable snapshot all print this same block.
//
// Every section in ASSUMPTION_SECTION_IDS is always present, in order (an empty
// section says "None"), so a reader can tell "nothing to report" from "not checked".

import type {
  AssumptionItemDTO, AssumptionSectionDTO, AssumptionSectionId, EstimateAssumptionsDTO, EstimateEntityReclassDTO,
  EstimateResultDTO,
} from './estimate-api.js';
import { ASSUMPTION_SECTION_IDS } from './estimate-api.js';
import type { CharacterAmounts, ThroughMonthSource } from './entities-api.js';
import type { JurisdictionEstimate } from './engine/vouchers.js';
import { NONRESIDENT_FLAT_RATE_LABEL } from './engine/state-types.js';
import { dIsZero, dRound, dRoundDollars, dSum } from './decimal.js';
import { DEFAULT_DISCLAIMER_TEXT } from '../schemas/tax-estimator-years.js';
import { presentEngineText, presentParameterValue, presentWarningMessage } from './format-text.js';

/**
 * Shipped default disclaimer (MODULE.md "License and gating"); firms may replace it (D4).
 * ONE constant: an alias of DEFAULT_DISCLAIMER_TEXT so the screen, PDF, snapshot and portal agree.
 */
export const DEFAULT_ASSUMPTIONS_DISCLAIMER = DEFAULT_DISCLAIMER_TEXT;

const SECTION_TITLES: Record<AssumptionSectionId, string> = {
  rate_mode: 'Rate mode',
  projection: 'Projection method and months',
  non_recurring: 'Non-recurring exclusions',
  reclass: 'Reclassifications from the books',
  adjustments: 'Adjustments',
  safe_harbor: 'Safe harbor and installments',
  state_methods: 'State methods',
  parameters: 'Unverified and provisional parameters',
  readiness: 'Readiness warnings',
  engine_notes: 'Engine approximations',
  disclaimer: 'Disclaimer',
};

/**
 * D12b: state penalty add-ons the engine does not model — shown with an
 * "estimate may differ" badge (OPEN-QUESTIONS Q26).
 */
export const STATE_PENALTY_ADDON_NOTES: Readonly<Record<string, string>> = {
  MI: 'Michigan adds a 10% penalty (minimum $10) on top of interest; not included.',
  VT: 'Vermont adds 1% per month on the underpayment; not included.',
  IN: 'Indiana assesses a flat 10% penalty on the underpayment; not included.',
  UT: 'Utah applies its own penalty rate with a six-month cap and stops accrual at filing; not modelled.',
  ID: 'Idaho caps and stops the penalty at filing; not modelled.',
  DC: 'The District of Columbia compounds the penalty daily; simple interest was used.',
  CT: 'Connecticut charges a per-month rate; the daily method was used.',
  DE: 'Delaware charges a per-month rate; the daily method was used.',
  AZ: 'Arizona caps the penalty at 10% of the underpayment; the cap is not applied.',
};

/** Engine approximations (OPEN-QUESTIONS Q28–Q34) a reviewer must know about. */
const ENGINE_NOTES: ReadonlyArray<AssumptionItemDTO & { when?: (r: EstimateResultDTO) => boolean }> = [
  { code: 'Q28', label: 'Retirement plan type', detail: 'A person with no recorded retirement plan type was figured as a SEP.', badge: 'verify', when: (r) => hasWarning(r, 'TE_RETIREMENT_PLAN_ASSUMED') },
  { code: 'Q29', label: 'Age thresholds', detail: 'Age-based amounts (65 / 50 / 55 / 60–63) come from parameters that are still awaiting verification.', badge: 'verify' },
  { code: 'Q30', label: 'SIMPLE catch-up', detail: 'The SIMPLE IRA age 60–63 super catch-up is not applied.' },
  { code: 'Q30', label: 'Itemized limits', detail: 'The charitable 60%-of-AGI limit and the mortgage-interest debt limits are not applied.' },
  { code: 'Q30', label: 'MAGI', detail: 'Modified AGI is taken as AGI for the SALT phase-down, Schedule 1-A and the §469(i) allowance.' },
  { code: 'Q30', label: 'Car-loan interest', detail: 'The Schedule 1-A car-loan interest phase-out is applied linearly.' },
  { code: 'Q30', label: 'Self-employed health insurance', detail: 'For an S corporation shareholder the SEHI cap is the officer wages; the cap is pooled across businesses.' },
  { code: 'Q30', label: 'Owner items', detail: 'Owner-level items (health insurance, retirement) are run-rated as recurring; items not tied to a person go to the primary taxpayer.' },
  { code: 'Q33', label: 'QBI minimum', detail: 'The §199A(i) minimum deduction is applied after the overall limitation.' },
  { code: 'Q33', label: 'Passive / excess business loss', detail: '§469(i) MAGI is AGI without passive losses; the §461(l) aggregate is ordinary + rental + §1231 of non-investment activities plus guaranteed payments after §469.' },
  { code: 'Q33', label: 'NIIT', detail: 'Gains are treated as net investment income without a trade-or-business carve-out.' },
  { code: 'Q34', label: 'Prior-year return', detail: 'A prior-year overpayment is credited on the original due date; a late-filed prior return is not modelled.' },
  { code: 'Q34', label: 'Penalty method', detail: 'Underpayment penalties are figured per Form 2210 / state worksheets with periods split at rate changes; actual assessments may differ.', badge: 'estimate_may_differ' },
  { code: 'Q34', label: 'C corporations', detail: 'Short years (§6655(i)), Form 2220 annualized installments, the large-corporation +2% rate and the $500 minimum are not modelled; prior-year tax and state apportionment are not stored.', badge: 'verify', when: (r) => r.ccorps.length > 0 },
];

function hasWarning(r: EstimateResultDTO, code: string): boolean {
  return r.warnings.some((w) => w.code === code);
}

/** Whole-dollar display: "$12,345" / "−$1,200". Formatting only. */
export function formatDollars(v: string | number | null | undefined): string {
  if (v == null || v === '') return '—';
  const whole = dRoundDollars(String(v));
  const neg = whole.startsWith('-');
  const digits = neg ? whole.slice(1) : whole;
  return `${neg ? '−' : ''}$${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/** Fraction string → "4%", "7.25%". Formatting only. */
export function formatPct(fraction: string | number | null | undefined): string {
  if (fraction == null || fraction === '') return '—';
  const pct = Math.round(Number(fraction) * 1_000_000) / 10_000;
  return `${pct}%`;
}

const CHARACTER_LABELS: Record<keyof CharacterAmounts, string> = {
  ordinary: 'ordinary', capital_gain_st: 'short-term gain', capital_gain_lt: 'long-term gain', section_1231: '§1231',
  interest: 'interest', dividends_ordinary: 'ordinary dividends', dividends_qualified: 'qualified dividends', rental: 'rental',
};

const RECLASS_LABELS: Record<keyof EstimateEntityReclassDTO, string> = {
  ownerSehi: 'Owner health insurance moved to the owner (SEHI)',
  ownerRetirement: 'Owner retirement contributions moved to the owner',
  ownerPersonalDropped: 'Personal expenses removed',
  sehiAsW2Wages: '>2% shareholder health insurance added to W-2 box 1',
  guaranteedPayments: 'Guaranteed payments to partners',
  nondeductibleAddBack: 'Nondeductible portion added back',
  estimatedTaxPayments: 'Estimated tax payments removed from expenses',
  taxDepreciationBook: 'Book depreciation replaced by the tax-depreciation adjustment',
};

const SOURCE_LABELS: Record<string, string> = {
  year: 'set on this year\'s annual settings',
  taxpayer: 'the taxpayer\'s override',
  firm_default: 'the firm default',
};

const RULE_LABELS: Record<string, string> = {
  lesser_of: 'lesser of current-year and prior-year',
  current_year: 'current-year',
  prior_year: 'prior-year',
};

const THROUGH_SOURCE_LABELS: Record<ThroughMonthSource, string> = {
  requested: 'requested',
  last_closed_month: 'last closed month',
  last_complete_month: 'last complete month',
};

const LONG_DECIMAL = /(?<![\w.])-?\d+\.\d{3,}(?![\w.])/g;
const HARBOR_FRACTION = /harbor is (\d+(?:\.\d+)?) of prior-year tax/g;
const DOUBLED_PREFIX = /^([A-Z]{2}|[A-Za-z]+): (?:\1: )+/;

/**
 * Engine prose tidied for the assumptions page (Phase 13 follow-up): decimals with more
 * than two places are rounded to cents (state gate notes carry unrounded figures), the
 * prior-year harbor fraction reads as a percent, and a doubled "AR: AR: " prefix collapses.
 */
export function tidyNote(text: string): string {
  // QA D19: plus the shared presentation (comparison words, grouped numbers).
  return presentEngineText(text
    .replace(DOUBLED_PREFIX, '$1: ')
    .replace(HARBOR_FRACTION, (_m, f: string) => `harbor is ${formatPct(f)} of prior-year tax`)
    .replace(LONG_DECIMAL, (m) => dRound(m, 2)));
}

/** Drop a leading "<label>: " the engine already put on a message shown under that label. */
function withoutLabel(text: string, label: string): string {
  return text.startsWith(`${label}: `) ? text.slice(label.length + 2) : text;
}

function nonZero(v: string | null | undefined): boolean {
  return v != null && v !== '' && !dIsZero(v);
}

function section(id: AssumptionSectionId, items: AssumptionItemDTO[], emptyText = 'None.'): AssumptionSectionDTO {
  return { id, title: SECTION_TITLES[id], items: items.length ? items : [{ label: 'None', detail: emptyText }] };
}

function rateModeSection(r: EstimateResultDTO): AssumptionSectionDTO {
  const rt = r.federal.regularTax;
  const items: AssumptionItemDTO[] = [];
  if (rt.method === 'effective') {
    items.push({ label: 'Federal income tax', detail: `Effective-rate override: ${formatPct(rt.effectiveRate)} of taxable income ${formatDollars(rt.taxableIncome)} (brackets not used).`, badge: 'verify' });
  } else {
    items.push({ label: 'Federal income tax', detail: `${r.taxYear} brackets for ${r.filingStatus.toUpperCase()}${rt.worksheet ? ' with the qualified dividends and capital gain worksheet' : ''}; marginal ordinary rate ${formatPct(rt.marginalOrdinaryRate)}, effective ${formatPct(dRound(rt.effectiveRate, 4))}.` });
  }
  for (const row of r.state?.rows ?? []) {
    items.push({ label: `${row.state} (${row.residency})`, detail: `User-entered effective rate ${formatPct(row.effectiveRate)} on ${row.method === 'nonresident_flat' ? 'income sourced to the state' : `base ${baseLabel(row.base)}`}.` });
  }
  return section('rate_mode', items);
}

function projectionSection(r: EstimateResultDTO): AssumptionSectionDTO {
  const items: AssumptionItemDTO[] = [];
  for (const e of r.entities) {
    if (e.path === 'skipped') {
      items.push({ label: e.companyName, detail: `Left out of the estimate: ${e.skippedReason ?? 'no reason recorded'}.`, badge: 'verify' });
      continue;
    }
    // A requested range end needs no reason ("requested: Range end requested explicitly." said it twice).
    const reason = e.throughMonthReason && e.throughMonthSource !== 'requested' ? `: ${e.throughMonthReason}` : '';
    const through = e.throughMonth
      ? `books through ${e.throughMonth} (${e.throughMonthSource ? THROUGH_SOURCE_LABELS[e.throughMonthSource] : 'default'}${reason})`
      : 'no month range';
    const method = e.monthsRemaining > 0
      ? `${e.monthsElapsed} months actual + ${e.monthsRemaining} projected (year-to-date + recurring ÷ ${e.monthsElapsed} × ${e.monthsRemaining})`
      : `${e.monthsElapsed} months actual (year closed; no projection)`;
    const basis = e.basis ? `, ${e.basis} basis` : '';
    const path = e.path === 'c_corp' ? ' — C corporation, estimated at entity level and not in the taxpayer totals' : '';
    items.push({ label: e.companyName, detail: `${through}; ${method}${basis}${path}.` });
  }
  return section('projection', items, 'No linked entities were included.');
}

function nonRecurringSection(r: EstimateResultDTO): AssumptionSectionDTO {
  const items: AssumptionItemDTO[] = [];
  for (const e of r.entities) {
    const nr = e.nonRecurringYtd;
    if (!nr) continue;
    const parts = (Object.keys(CHARACTER_LABELS) as Array<keyof CharacterAmounts>)
      .filter((k) => nonZero(nr[k])).map((k) => `${CHARACTER_LABELS[k]} ${formatDollars(nr[k])}`);
    if (parts.length) items.push({ label: e.companyName, detail: `Year-to-date amounts flagged non-recurring, kept at actual and not run-rated: ${parts.join(', ')}.` });
  }
  for (const a of r.adjustments ?? []) {
    if (a.nonRecurring) items.push({ label: a.label || a.typeName || 'Adjustment', detail: `Adjustment flagged non-recurring: ${formatDollars(a.fullYearAmount)}.` });
  }
  return section('non_recurring', items, 'No amounts were flagged non-recurring.');
}

function reclassSection(r: EstimateResultDTO): AssumptionSectionDTO {
  const items: AssumptionItemDTO[] = [];
  for (const e of r.entities) {
    if (!e.reclass) continue;
    for (const k of Object.keys(RECLASS_LABELS) as Array<keyof EstimateEntityReclassDTO>) {
      const v = e.reclass[k];
      if (nonZero(v)) items.push({ label: `${e.companyName} — ${RECLASS_LABELS[k]}`, detail: `${formatDollars(k === 'taxDepreciationBook' ? String(v).replace(/^-/, '') : v)} year to date.` });
    }
    // Q41 (CPA decision): say which §199A W-2 wage treatment of the >2% shareholder health add-on was used.
    if (e.entityType === 's_corp' && e.path === 'individual') {
      items.push({
        code: 'Q41', label: `${e.companyName} — §199A W-2 wages`,
        detail: e.includeSehiInW2Wages
          ? '>2% shareholder health insurance (W-2 box 1) is INCLUDED in the W-2 wages for the §199A wage limit (entity-year switch on).'
          : '>2% shareholder health insurance (W-2 box 1) is EXCLUDED from the W-2 wages for the §199A wage limit (default; switch per entity year on Entity tax setup).',
      });
    }
  }
  return section('reclass', items, 'No GL amounts were reclassified by the treatment map.');
}

function adjustmentsSection(r: EstimateResultDTO): AssumptionSectionDTO {
  const items: AssumptionItemDTO[] = [];
  if (r.adjustments) {
    for (const a of r.adjustments) {
      const how = a.glLinked ? 'GL-linked (actuals to date + plan)' : (a.cadence ?? 'manual');
      items.push({ label: a.label || a.typeName || 'Adjustment', detail: `${a.kind} ${formatDollars(a.fullYearAmount)} for the year; ${how}.` });
    }
  } else {
    const seen = new Set<string>();
    for (const t of r.federal.trace) {
      if (t.source !== 'adjustment' || seen.has(t.id)) continue;
      seen.add(t.id);
      items.push({ label: t.label, detail: `${formatDollars(t.amount)}${t.formula ? ` (${t.formula})` : ''}.` });
    }
  }
  return section('adjustments', items, 'No scenario adjustments.');
}

function harborItems(e: JurisdictionEstimate, label: string, ruleSourceText: string | null): AssumptionItemDTO[] {
  const sh = e.safeHarbor;
  const items: AssumptionItemDTO[] = [];
  const chosen = `${RULE_LABELS[sh.rule] ?? sh.rule} rule (${ruleSourceText ?? SOURCE_LABELS[sh.ruleSource] ?? sh.ruleSource})`;
  const why = sh.appliedRule !== sh.rule
    ? `; ${RULE_LABELS[sh.appliedRule] ?? sh.appliedRule} applied because ${sh.priorYear.unavailableDetail ?? 'the prior-year amount is unavailable'}`
    : '';
  const prior = sh.priorYear.available && sh.priorYear.amount != null
    ? `prior-year ${formatPct(sh.priorYear.pct)} = ${formatDollars(sh.priorYear.amount)}${sh.priorYear.highAgiApplied ? ' (high-AGI rate)' : ''}`
    : `prior-year unavailable${sh.priorYear.unavailableDetail ? ` (${sh.priorYear.unavailableDetail})` : ''}`;
  items.push({
    label: `${label} safe harbor`,
    detail: `${chosen}${why}. Current-year ${formatPct(sh.currentYear.pct)} = ${formatDollars(sh.currentYear.amount)}; ${prior}. Required annual payment ${formatDollars(sh.requiredAnnualPayment)}.`,
    badge: sh.verify || sh.priorYear.highAgiUntested ? 'verify' : null,
  });
  if (sh.noPenaltyReason === 'prior_year_zero_tax') items.push({ label: `${label} penalty`, detail: 'No underpayment penalty: the prior-year return showed zero tax for a full 12-month year.' });
  if (!e.estimatesRequired) items.push({ label: `${label} estimates`, detail: `Not required: ${tidyNote(withoutLabel(e.estimatesRequiredReason, label))}` });
  if (e.usesFederalFallback) items.push({ label: `${label} rules`, detail: 'No verified state rules: the federal pattern was used.', badge: 'verify' });
  // The safe-harbor notes are repeated on the estimate (and the penalty): list each once.
  const notes = new Set<string>();
  for (const n of [...sh.notes, ...e.notes, ...(e.penalty?.notes ?? [])]) notes.add(tidyNote(withoutLabel(n, label)));
  for (const n of notes) items.push({ label: `${label} note`, detail: n });
  if (e.penalty && !e.penalty.computed) items.push({ label: `${label} penalty`, detail: 'The penalty method cannot be computed from a rate; no penalty is shown.', badge: 'verify' });
  return items;
}

function safeHarborSection(r: EstimateResultDTO): AssumptionSectionDTO {
  const items: AssumptionItemDTO[] = [];
  items.push(...harborItems(r.federalEstimates, 'Federal', SOURCE_LABELS[r.safeHarborRuleSource] ?? null));
  if (r.farmer) {
    items.push({
      label: 'Farmer / fisherman test',
      detail: r.farmer.qualifies
        ? `Qualifies as a ${r.farmer.label} (${r.farmer.basis.replace('_', ' ')} test): one installment, reduced safe-harbor percentage; ${r.farmer.fileAndPayNote}`
        : `Does not qualify as a ${r.farmer.label}; the regular quarterly rules apply.`,
    });
  }
  const ai = r.scheduleAi.filter((p) => p.source !== 'unavailable');
  if (r.federalEstimates.scheduleAi && ai.length) {
    items.push({ label: 'Annualized income (Schedule AI)', detail: `Periods ${r.scheduleAi.map((p) => `${p.periodEnd}: ${p.source}`).join('; ')}. Each installment is the lesser of the regular and annualized amounts.` });
  }
  for (const s of r.stateEstimates) items.push(...harborItems(s, s.jurisdiction, null));
  return section('safe_harbor', items);
}

function stateMethodsSection(r: EstimateResultDTO): AssumptionSectionDTO {
  const items: AssumptionItemDTO[] = [];
  const states = new Set<string>();
  for (const row of r.state?.rows ?? []) {
    states.add(row.state);
    if (!row.hasIncomeTax) {
      items.push({ label: row.state, detail: 'No broad-based individual income tax.' });
      continue;
    }
    if (row.method === 'nonresident_flat') {
      items.push({
        label: `${row.state} nonresident`,
        detail: `Sourced income ${formatDollars(row.sourcedIncome)} (${row.sourcedDerived ? 'derived from entity sourcing × share' : 'entered'}) × ${formatPct(row.effectiveRate)}: ${NONRESIDENT_FLAT_RATE_LABEL}${row.nonresidentMethod ? ` (the state's method: ${row.nonresidentMethod})` : ''}.`,
        badge: 'estimate_may_differ',
      });
    } else {
      const credit = nonZero(row.creditForOtherStates) ? `; credit for tax paid to other states ${formatDollars(row.creditForOtherStates)}` : '';
      items.push({ label: `${row.state} resident`, detail: `Base ${baseLabel(row.base)} ${formatDollars(row.baseAmount)} × ${formatPct(row.effectiveRate)}${credit}.` });
    }
    const g = row.gate;
    const required = g.required == null ? 'cannot be determined from the inputs' : g.required ? 'required' : 'not required';
    items.push({
      label: `${row.state} requirement test`,
      detail: tidyNote(`${g.method.replace(/_/g, ' ')}: estimates ${required}${g.notes.length ? ` — ${[...new Set(g.notes.map((n) => tidyNote(withoutLabel(n, row.state))))].join(' ')}` : ''}.`),
      badge: g.verify || row.verify || row.usesFederalFallback ? 'verify' : null,
    });
  }
  for (const s of r.stateEstimates) states.add(s.jurisdiction);
  for (const st of [...states].sort()) {
    const note = STATE_PENALTY_ADDON_NOTES[st];
    if (note) items.push({ label: `${st} penalty`, detail: note, badge: 'estimate_may_differ' });
  }
  return section('state_methods', items, 'No state rows on this scenario.');
}

/** QA D19: a parameter value never prints as JSON (a rate table reads "a table of 12 rows"). */
/** QA D19: a state base in words ("federal AGI"), never its key. */
const BASE_LABELS: Record<string, string> = { federal_agi: 'federal AGI', federal_taxable: 'federal taxable income', custom: 'entered amount' };
function baseLabel(base: string): string {
  return BASE_LABELS[base] ?? base;
}

function shortValue(v: unknown): string {
  const s = presentParameterValue(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

function parametersSection(r: EstimateResultDTO): AssumptionSectionDTO {
  const items: AssumptionItemDTO[] = [];
  for (const p of r.parametersUsed) {
    if (p.status === 'verified') continue;
    items.push({ code: p.key, label: `Federal ${p.key}`, detail: `${shortValue(p.value)} (${p.status}).`, badge: p.status });
  }
  for (const u of r.rulesUsed) {
    if (u.status === 'verified') continue;
    items.push({ code: `${u.state}.${u.key}`, label: `${u.state} ${u.key}`, detail: `${shortValue(u.value)} (${u.status}).`, badge: u.status });
  }
  return section('parameters', items, 'Every parameter and state rule used is verified.');
}

function readinessSection(r: EstimateResultDTO): AssumptionSectionDTO {
  const ordered = [...r.warnings.filter((w) => w.severity === 'warning'), ...r.warnings.filter((w) => w.severity !== 'warning')];
  return section('readiness', ordered.map((w) => ({ code: w.code, label: w.code, detail: tidyNote(presentWarningMessage(w)), badge: w.severity === 'warning' ? 'verify' as const : null })),
    'No readiness warnings.');
}

function engineNotesSection(r: EstimateResultDTO): AssumptionSectionDTO {
  return section('engine_notes', ENGINE_NOTES.filter((n) => !n.when || n.when(r)).map(({ when: _w, ...n }) => ({ ...n, badge: n.badge ?? null })));
}

/**
 * Build the assumptions block from an assembled estimate. `disclaimerText` is the
 * firm's text in effect (blank → the shipped default).
 */
export function buildEstimateAssumptions(result: EstimateResultDTO, opts: { disclaimerText?: string | null } = {}): EstimateAssumptionsDTO {
  const disclaimerText = opts.disclaimerText?.trim() ? opts.disclaimerText.trim() : DEFAULT_ASSUMPTIONS_DISCLAIMER;
  const byId: Record<AssumptionSectionId, AssumptionSectionDTO> = {
    rate_mode: rateModeSection(result),
    projection: projectionSection(result),
    non_recurring: nonRecurringSection(result),
    reclass: reclassSection(result),
    adjustments: adjustmentsSection(result),
    safe_harbor: safeHarborSection(result),
    state_methods: stateMethodsSection(result),
    parameters: parametersSection(result),
    readiness: readinessSection(result),
    engine_notes: engineNotesSection(result),
    disclaimer: { id: 'disclaimer', title: SECTION_TITLES.disclaimer, items: [{ label: 'Disclaimer', detail: disclaimerText }] },
  };
  return { version: 1, sections: ASSUMPTION_SECTION_IDS.map((id) => byId[id]), disclaimerText };
}

/** Σ of a CharacterAmounts record (display helper for callers). */
export function characterTotal(c: CharacterAmounts): string {
  return dSum(Object.values(c));
}
