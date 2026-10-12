# Copyright 2026 Kisaes LLC
# Licensed under the PolyForm Small Business License 1.0.0.
# Free for small businesses; see LICENSE for terms.
"""Reference calculator (test oracle) for the Phase 14 golden scenarios, batch 2 — tax year 2026.

Independent of the app engine (nothing under packages/ is imported). Run:
    python3 -I scenarios2_fixture.py
Prints the expected values and rewrites scenarios2_expected.json next to this file.
`npm run test:tax-oracle` regenerates every oracle file and fails when the committed JSON differs.
The engine golden test that reads this file is
packages/shared/src/tax-estimator/engine/oracle.scenarios2.golden.test.ts.

Scenarios (R7-06 — the oracles PHASES.md Phase 14 lists that batch 1 did not deliver):
  ccorp_fye_june     fiscal-year (Jul–Jun) C corporation, a LARGE corporation by the three-year lookback
                     (§6655(g)(2)): the prior-year rule may be used for the first installment only and the
                     shortfall is recaptured in the second (§6655(d)(2), Form 2220 Schedule A not used);
                     installments on the 15th of the 4th / 6th / 9th / 12th fiscal months with the §7503 roll;
                     state apportionment; a non-large variant (lesser-of) and a below-$500 variant (§6655(f)).
  farmer_prior_year  farmer who FAILS the two-thirds gross-income test in the current year and PASSES it on the
                     prior year (§6654(i)(2)(B)): one installment of 100% due Jan 15, 66⅔% of current-year tax
                     vs 100% of prior-year tax with the 110% high-AGI rule switched off (§6654(i)(1)(C)); the
                     Mar 1 file-and-pay relief (§6654(i)(1)(D)) is a note, not assumed.
  passive_ebl        single wage earner with a start-up Sch C loss and an active-participation rental loss:
                     §469(i) $25,000 allowance phased out 50% of MAGI over $100,000 (MAGI = AGI without passive
                     losses, §469(i)(3)(F) — which carries the §461(l) add-back on the nonpassive loss), the rest
                     suspended; then §461(l) excess business loss above the 2026 threshold disallowed and carried
                     as an NOL (§461(l)(2)); Additional Medicare on wages.
  senior_sch1a       MFJ, both 65+ (one born Jan 1, 1962 — "born before January 2, 1962"): Schedule 1-A Part V
                     senior deduction in its 6% phase-out, Part IV car-loan interest with a FRACTIONAL $1,000
                     step (rounded UP, line 28), Parts II / III tips and overtime below their threshold; a second
                     column above $300,000 where tips / overtime phase out with a fractional step (rounded DOWN,
                     lines 11 / 19) and the seniors keep a reduced deduction.
  multistate         MO resident, two nonresident states (KS at a higher rate than MO → credit limited to the MO
                     rate on the sourced income; AR at a lower rate → full credit), MO / KS / AR estimate gates,
                     MO and KS vouchers with a late KS Q1 at the KS 8% rate; plus an AZ resident with GA / PA
                     nonresident rows exercising the AZ two-year gross-income gate, the GA gross-over-
                     exemptions gate and the PA non-withheld-income gate.

Form / statute references: Form 2220 (2025) Part I and §6655(c), (d), (f), (g); Form 2210-F (2025) and §6654(i);
Form 8582 (2025) Part II / Worksheet 1 and §469(i); Form 461 (2025) and §461(l); 2025 Schedule 1-A (Form 1040)
Parts II–VI and §151(d)(5), §224, §225, §163(h)(4); Form MO-CR / MO-1040ES, KS Schedule S / K-40ES, AR AR1000ES,
AZ Form 140ES / A.R.S. 43-581(A), GA Form 500-ES / O.C.G.A. 48-7-114(b), PA REV-413 (I) for the state rules
(values as shipped in packages/api/src/db/seeds/tax-estimator/state-rules/*.ts, 2026 rows).
"""
import json, math, os, sys
sys.dont_write_bytecode = True                                    # keep the sibling imports from writing __pycache__ next to the oracles
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # python3 -I leaves the script dir off sys.path
from rivera_fixture import penalty_schedule, r                      # the fixed §6654 ledger (Q35); nothing from the app
from scenarios_fixture import P, form_1040, safe_harbor             # Form 1040 arithmetic (batch 1), 2026 parameters

# ---------------------------------------------------------------- 2026 parameters not in batch 1 (packages/api/src/db/seeds/tax-estimator/federal/2026.ts)
P2 = dict(
  # C corporations (§6655; Form 2220)
  ccorp_rate=0.21, ccorp_large_threshold=1000000, ccorp_lookback_years=3, ccorp_installment_months=[4, 6, 9, 12],
  ccorp_installment_pcts=[0.25, 0.25, 0.25, 0.25], ccorp_sh_current=1.0, ccorp_sh_prior=1.0, ccorp_installment_day=15, ccorp_min_tax=500,
  # Farmers / fishermen (§6654(i); Form 2210-F). The seed stores 2/3 as 0.6666666666 (test) / 0.6666666667 (harbor pct).
  farmer_ratio=0.6666666666, farmer_sh_current=0.6666666667, farmer_sh_prior=1.0, farmer_due=date(2027, 1, 15), farmer_file_by=date(2027, 3, 1),
  # Legal holidays (DC) for the §7503 roll, 2026–2027, as seeded. [VERIFY 2027 observed dates]
  holidays={'2026-01-01', '2026-01-19', '2026-02-16', '2026-04-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25',
            '2027-01-01', '2027-01-18', '2027-02-15', '2027-04-16', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-12-24', '2027-12-31'},
)

# State rule values the scenarios read (2026 rows of the shipped seeds). Rates on the rows are the FIRM's effective-rate inputs
# (the engine's v1 flat-rate simplification, OPEN-QUESTIONS Q17), not statutory rates.
STATES = dict(
  MO=dict(required_threshold=100, comparison='at_least', sh_current=0.9, sh_prior=1.0, high_agi_rule=None, credit=True, penalty_rate=0.07, min_balance=500,
          due=[date(2026,4,15), date(2026,6,15), date(2026,9,15), date(2027,1,15)], q4_file_and_pay=date(2027,2,1), return_due=date(2027,4,15)),
  KS=dict(required_threshold=500, comparison='at_least', sh_current=0.9, sh_prior=1.0, high_agi_rule=None, credit=True, penalty_rate=0.08, min_balance=None,
          due=[date(2026,4,15), date(2026,6,15), date(2026,9,15), date(2027,1,15)], q4_file_and_pay=None, return_due=None),   # return_due null → federal 2027-04-15
  AR=dict(required_threshold=1000, comparison='more_than', sh_current=0.9, sh_prior=1.0, high_agi_rule=None, credit=True, penalty_rate=0.10, min_balance=None,
          due=[date(2026,4,15), date(2026,6,15), date(2026,9,15), date(2027,1,15)], q4_file_and_pay=date(2027,2,1), return_due=date(2027,4,15)),
  AZ=dict(required_threshold=1000, comparison='at_least', gate=dict(kind='gross_income_both_years', threshold=75000, threshold_mfj=150000)),
  GA=dict(required_threshold=0, comparison='at_least', gate=dict(kind='gross_over_exemptions_deductions', non_withheld_floor=1000)),
  PA=dict(required_threshold=430, comparison='at_least', gate=dict(kind='non_withheld_income', threshold=11000)),
)

# ---------------------------------------------------------------- helpers

def next_business_day(d, holidays):
    """§7503: a due date on a Saturday, Sunday or legal holiday moves to the next day that is none of those."""
    while d.weekday() >= 5 or d.isoformat() in holidays: d += timedelta(days=1)
    return d

def meets(measured, threshold, comparison):
    return measured > threshold if comparison == 'more_than' else measured >= threshold

# ---------------------------------------------------------------- C corporation (§6655, Form 2220)

def ccorp(name, *, tax_year, fy_start_month, taxable_income, prior_tax, prior_full_year, prior_years_taxable_income, large_flag=False, states=()):
    """Form 2220 (2025) Part I–II arithmetic for a fiscal-year corporation whose year BEGINS in `tax_year` (Form 1120 year):
      tax = 21% × max(0, taxable income)                                             §11(b)
      large corporation = taxable income ≥ $1,000,000 in any of the 3 preceding years   §6655(g)(2)(A)
      required annual payment = lesser of 100% current / 100% prior (prior unavailable: no return, short year, zero tax)
                                                                                      §6655(d)(1)(B), (d)(1)(B)(ii) (flush)
      large corporation: the prior-year amount may be used for the FIRST installment only; the reduction is added to
      the second installment                                                          §6655(d)(2)(A)-(B)
      installments: 15th day of the 4th, 6th, 9th, 12th months of the taxable year, §7503 roll      §6655(c)(2)
      no addition when the tax is less than $500                                     §6655(f)"""
    tax = P2['ccorp_rate'] * max(0.0, taxable_income)
    large = large_flag or any(ti >= P2['ccorp_large_threshold'] for ti in prior_years_taxable_income[:P2['ccorp_lookback_years']])
    prior_ok = prior_tax is not None and prior_full_year and prior_tax > 0
    rap_current = P2['ccorp_sh_current'] * tax
    rap_prior = P2['ccorp_sh_prior'] * prior_tax if prior_ok else None
    rap = min(rap_current, rap_prior) if (rap_prior is not None and not large) else rap_current
    rows = []; recapture = 0.0; cumulative = 0.0
    for idx, (m, pct) in enumerate(zip(P2['ccorp_installment_months'], P2['ccorp_installment_pcts'])):
        cal = (fy_start_month - 1) + (m - 1)
        statutory = date(tax_year + cal // 12, cal % 12 + 1, P2['ccorp_installment_day'])
        due = next_business_day(statutory, P2['holidays'])
        cur = pct * rap_current
        prior_reaches = rap_prior is not None and (not large or idx == 0)
        pri = pct * rap_prior if prior_reaches else None
        base = min(cur, pri) if pri is not None else cur
        required = base + recapture
        this_recapture = recapture; recapture = 0.0
        if large and idx == 0 and pri is not None: recapture = max(0.0, cur - base)      # §6655(d)(2)(B): added to the next installment
        cumulative += required
        rows.append(dict(number=idx + 1, fiscal_month=m, statutory_due_date=statutory.isoformat(), due_date=due.isoformat(), pct=pct,
                         current_year_basis=r(cur), prior_year_basis=None if pri is None else r(pri), recapture=r(this_recapture), required=r(required),
                         cumulative_required=r(cumulative), basis='prior_year' if (pri is not None and pri < cur) else 'current_year'))
    st = [dict(state=s['state'], apportionment_pct=s['pct'], effective_rate=s['rate'], apportioned=r(max(0.0, taxable_income) * s['pct']), tax=r(max(0.0, taxable_income) * s['pct'] * s['rate'])) for s in states]
    state_total = sum(max(0.0, taxable_income) * s['pct'] * s['rate'] for s in states)
    return dict(company=name, tax_year=tax_year, fiscal_year_start=date(tax_year, fy_start_month, 1).isoformat(),
                fiscal_year_end=(date(tax_year + 1, fy_start_month, 1) - timedelta(days=1)).isoformat() if fy_start_month > 1 else date(tax_year, 12, 31).isoformat(),
                taxable_income=r(taxable_income), federal_tax=r(tax), states=st, state_total=r(state_total), total_tax=r(tax + state_total),
                large_corporation=large, large_corporation_source='flag' if large_flag else ('derived' if large else 'not_large'),
                estimates_required=tax >= P2['ccorp_min_tax'], prior_year_rule=dict(available=prior_ok, applies_to='none' if not prior_ok else ('first_installment' if large else 'all')),
                required_annual_payment=dict(current_year=r(rap_current), prior_year=None if rap_prior is None else r(rap_prior), required=r(rap)), installments=rows)

# ---------------------------------------------------------------- farmer (§6654(i), Form 2210-F)

def farmer_test(persons):
    """§6654(i)(2): gross income from farming (and fishing) ≥ 2/3 of total gross income; on a joint return both spouses' gross
    income is combined (Pub. 505 ch. 2 "Farmers and Fishermen")."""
    ff = sum(p['farming'] + p.get('fishing', 0.0) for p in persons); total = sum(p['total_gross'] for p in persons)
    ratio = ff / total if total > 0 else None
    return dict(farming_and_fishing=r(ff), total_gross=r(total), ratio=None if ratio is None else round(ratio, 12), passes=ratio is not None and ratio >= P2['farmer_ratio'])

# ---------------------------------------------------------------- §469(i) and §461(l)

def passive_and_ebl(fs, *, nonpassive_business_net, active_rental_loss, other_passive_income, nonpassive_agi_items):
    """Form 8582 Part II (special allowance for rental real estate with active participation) and Form 461:
      §469(i)(1)-(2): up to $25,000 of the net passive loss from active-participation rental real estate is allowed against
        nonpassive income; §469(i)(3)(A): reduced by 50% of MAGI over $100,000 (gone at $150,000). Other passive losses
        offset only passive income; the excess is suspended.
      §469(i)(3)(F): MAGI = AGI "determined without regard to" the listed items, among them "any passive activity loss"
        (Form 8582 line 6: "combine all the amounts used to figure adjusted gross income, except don't take into account
        any passive activity loss"). §461(l) is NOT on the disregard list, so in that hypothetical the Form 461 adjustment
        (Schedule 1 line 8p) is the excess business loss on the NONPASSIVE business loss alone — MAGI carries that add-back.
        (The practical alternative, Form 8582 before Form 461 with no add-back, has no statutory basis; it would make the
        allowance depend on the order the software fills the forms. CPA check — OPEN-QUESTIONS Q37.)
      §461(l)(1)-(3), (6): after §469, the aggregate trade-or-business loss (incl. the allowed rental loss) above the
        threshold is disallowed and treated as a net operating loss carryover (§461(l)(2))."""
    threshold = P['ebl_threshold'][fs]
    ebl_nonpassive_only = max(0.0, -nonpassive_business_net - threshold) if nonpassive_business_net < 0 else 0.0
    magi_without_passive_losses = nonpassive_agi_items + nonpassive_business_net + ebl_nonpassive_only
    excess_passive = max(0.0, active_rental_loss - other_passive_income)
    eligible = min(active_rental_loss, excess_passive)
    lo, hi = P['passive_phaseout']; maximum = P['passive_allowance']
    after_phaseout = maximum if magi_without_passive_losses <= lo else (0.0 if magi_without_passive_losses >= hi else maximum * (hi - magi_without_passive_losses) / (hi - lo))
    assert abs(after_phaseout - max(0.0, maximum - 0.5 * max(0.0, magi_without_passive_losses - lo))) < 1e-9, '§469(i)(3)(A): 50% of the excess = linear to the end point'
    used = min(eligible, after_phaseout)
    suspended = excess_passive - used
    rental_allowed = -(active_rental_loss - suspended) + other_passive_income            # net passive result reaching the return
    business_net = nonpassive_business_net + rental_allowed
    ebl = max(0.0, -business_net - threshold) if business_net < 0 else 0.0
    return dict(magi=r(magi_without_passive_losses), magi_ebl_addback=r(ebl_nonpassive_only), allowance_maximum=maximum, phaseout=dict(start=lo, end=hi), allowance_after_phaseout=r(after_phaseout),
                eligible_loss=r(eligible), allowance_used=r(used), suspended_passive_loss=r(suspended), rental_allowed=r(rental_allowed),
                business_net=r(business_net), ebl_threshold=threshold, excess_business_loss=r(ebl),
                nol_note=None if ebl == 0 else f'§461(l): {r(ebl)} of the business loss is disallowed in 2026 and becomes a net operating loss carryover (§461(l)(2)); the §199A loss carryforward is overstated by up to that amount (Reg. 1.199A-3(b)(1)(iv)).',
                _exact=dict(after_phaseout=after_phaseout, used=used, suspended=suspended, rental_allowed=rental_allowed, ebl=ebl))

# ---------------------------------------------------------------- states (resident credit, nonresident flat, gates, vouchers)

def state_rows(resident, nonresidents, *, agi, withholding_by_state, credits_by_state=None):
    """Resident tax = base (federal AGI) × rate − Σ min(other-state tax, resident rate × income sourced there) (MO-CR line 11
    pattern: the credit cannot exceed the resident tax on the same income); nonresident tax = sourced income × effective rate
    (v1 flat-rate simplification, Q17)."""
    credits_by_state = credits_by_state or {}
    rows = {}
    for s in nonresidents:
        tax = max(0.0, s['sourced']) * s['rate']
        rows[s['state']] = dict(state=s['state'], residency='nonresident', sourced_income=r(s['sourced']), effective_rate=s['rate'], gross_tax=r(tax), credit=0, net_tax=r(tax), _exact=tax)
    rate = resident['rate']; gross = max(0.0, agi) * rate
    details = []; credit = 0.0
    for s in nonresidents:
        on_sourced = max(0.0, s['sourced']) * rate; allowed = min(rows[s['state']]['_exact'], on_sourced)
        details.append(dict(state=s['state'], other_state_tax=r(rows[s['state']]['_exact']), resident_rate_on_sourced=r(on_sourced), allowed=r(allowed), limited=rows[s['state']]['_exact'] > on_sourced))
        credit += allowed
    net = gross - credit
    rows[resident['state']] = dict(state=resident['state'], residency='resident', base=r(agi), effective_rate=rate, gross_tax=r(gross), credit=r(credit), credit_details=details, net_tax=r(net), _exact=net)
    for st, row in rows.items():
        rules = STATES[st]
        wh = withholding_by_state.get(st, 0.0); cr = credits_by_state.get(st, 0.0)
        measured = row['_exact'] - wh - cr
        row['gate'] = dict(method='threshold', measured=round(measured, 6), threshold=rules['required_threshold'], comparison=rules['comparison'],
                           required=meets(measured, rules['required_threshold'], rules['comparison']), withholding=r(wh))
    return rows

def state_vouchers(st, net_tax_rounded, *, prior_tax, withholding, payments, penalty_until=None):
    """State safe harbor = lesser of current_pct × current tax and prior_pct × prior tax (no high-AGI rule for MO / KS / AR), four
    equal installments, withholding credited evenly; penalty at the state's flat rate (daily simple, no add-ons) — the
    engine's state pattern (MODULE.md "State calculation")."""
    rules = STATES[st]
    cur = rules['sh_current'] * net_tax_rounded
    pri = rules['sh_prior'] * prior_tax if prior_tax is not None else None
    req = min(cur, pri) if pri is not None else cur
    inst = req / 4; wh_q = withholding / 4
    return_due = rules['return_due'] or date(2027, 4, 15)
    rates = [(date(2026, 1, 1), date(2027, 12, 31), rules['penalty_rate'])]
    rows, total = penalty_schedule([inst] * 4, rules['due'], wh_q, payments, rates, return_due)
    balance_after_wh = net_tax_rounded - withholding
    floor = rules['min_balance'] if rules['min_balance'] is not None else rules['required_threshold']
    waived = not meets(balance_after_wh, floor, rules['comparison'])
    return dict(current=r(cur), prior=None if pri is None else r(pri), required=r(req), installment=r(inst), withholding_per_q=r(wh_q), net_per_installment=r(max(0.0, inst - wh_q)),
                due_dates=[d.isoformat() for d in rules['due']], return_due=return_due.isoformat(), penalty_rate=rules['penalty_rate'],
                payments=[dict(date=d.isoformat(), amount=a) for d, a in payments], penalty_by_installment=rows, penalty_total=0 if waived else total,
                penalty_waived_below_min_balance=waived, penalty_total_before_waiver=total)

def income_gate(st, *, state_tax, withholding, federal_total_income, federal_deduction, fs, gross_income=None, prior_year_gross=None, exemptions=None, deductions=None, non_withheld=None):
    """D12b requirement gates: AZ (A.R.S. 43-581(A), Form 140ES): gross income > $75,000 ($150,000 MFJ) in BOTH years AND tax
    after withholding ≥ $1,000; GA (O.C.G.A. 48-7-114(b)): gross income > exemptions + deductions + $1,000 REPLACES the
    tax-due test; PA (REV-413 (I)): income not subject to withholding > $11,000 REPLACES the tax-due test."""
    rules = STATES[st]; g = rules['gate']; after = state_tax - withholding
    base_required = meets(after, rules['required_threshold'], rules['comparison'])
    if g['kind'] == 'gross_income_both_years':
        t = g['threshold_mfj'] if fs == 'mfj' else g['threshold']
        gross = federal_total_income if gross_income is None else gross_income
        satisfied = gross > t and prior_year_gross > t
        return dict(method=g['kind'], measured=round(after, 6), threshold=rules['required_threshold'], gate_satisfied=satisfied, required=base_required and satisfied, gross_income=r(gross), prior_year_gross=r(prior_year_gross))
    if g['kind'] == 'gross_over_exemptions_deductions':
        ded = federal_deduction if deductions is None else deductions
        t = exemptions + ded + g['non_withheld_floor']
        gross = federal_total_income if gross_income is None else gross_income
        return dict(method=g['kind'], measured=r(gross), threshold=r(t), gate_satisfied=gross > t, required=gross > t)
    if g['kind'] == 'non_withheld_income':
        nw = (federal_total_income - 0.0) if non_withheld is None else non_withheld
        return dict(method=g['kind'], measured=r(nw), threshold=g['threshold'], gate_satisfied=nw > g['threshold'], required=nw > g['threshold'])
    raise ValueError(g['kind'])

# ---------------------------------------------------------------- scenarios
res = {}

def main():
    fed_due = P['installment_due']; fed_rates = P['underpayment_rates']; fed_ret = P['return_due']

    # ── ccorp_fye_june: Ozark Fabrication Inc., FY Jul 1, 2026 – Jun 30, 2027 (2026 Form 1120 year) ──────────
    # Taxable income 2,400,000 → tax 504,000; prior-year tax 300,000 (12-month year); taxable income of the three preceding
    # years 1,100,000 / 800,000 / 600,000 → large corporation by the lookback (flag off); MO 60% @ 4%, KS 15% @ 3.5%.
    large = ccorp('Ozark Fabrication Inc.', tax_year=2026, fy_start_month=7, taxable_income=2400000.0, prior_tax=300000.0, prior_full_year=True,
                  prior_years_taxable_income=[1100000.0, 800000.0, 600000.0], states=[dict(state='MO', pct=0.6, rate=0.04), dict(state='KS', pct=0.15, rate=0.035)])
    assert large['large_corporation'] and large['installments'][0]['basis'] == 'prior_year' and large['installments'][1]['recapture'] == 51000
    assert sum(i['required'] for i in large['installments']) == large['required_annual_payment']['required'] == 504000
    # Non-large variant: 400,000 → 84,000 tax vs 60,000 prior → lesser-of 60,000 in four 15,000 installments.
    small = ccorp('Ozark Fabrication Inc. (non-large variant)', tax_year=2026, fy_start_month=7, taxable_income=400000.0, prior_tax=60000.0, prior_full_year=True,
                  prior_years_taxable_income=[300000.0, 200000.0, 250000.0])
    assert not small['large_corporation'] and all(i['required'] == 15000 for i in small['installments'])
    # §6655(f): tax 420 < 500 → no installments required (schedule still shown).
    tiny = ccorp('Ozark Fabrication Inc. (below the $500 minimum)', tax_year=2026, fy_start_month=7, taxable_income=2000.0, prior_tax=None, prior_full_year=True, prior_years_taxable_income=[])
    assert not tiny['estimates_required'] and tiny['prior_year_rule'] == dict(available=False, applies_to='none')
    res['ccorp_fye_june'] = dict(large=large, non_large=small, below_minimum=tiny,
                                 note=('§6655(d)(2): a large corporation (taxable income ≥ 1,000,000 in one of the three preceding years) may base only its FIRST '
                                       'installment on the prior year (25% × 300,000 = 75,000 instead of 126,000); the 51,000 reduction is added to the second '
                                       'installment (177,000); installments 3–4 are 126,000; Σ = 504,000 = 100% of the current-year tax. Due dates: the 15th of '
                                       'the 4th / 6th / 9th / 12th fiscal months (Oct 15, Dec 15, 2026; Mar 15, Jun 15, 2027), none of which falls on a weekend or holiday.'))

    # ── farmer_prior_year: the Lindqvists (MFJ) ──────────────────────────────────────────────────────────────
    # Erik: Sch F gross 150,000 (net profit 90,000 tax basis). Anna: wages 95,000 (federal withholding 9,000). Joint interest 5,000.
    # Prior year: Sch F gross 210,000, Anna 45,000 wages, interest 5,000 — tax 24,000, AGI 190,000.
    cur_test = farmer_test([dict(farming=150000.0, total_gross=150000.0 + 5000.0), dict(farming=0.0, total_gross=95000.0)])
    prior_test = farmer_test([dict(farming=210000.0, total_gross=210000.0 + 5000.0), dict(farming=0.0, total_gross=45000.0)])
    assert not cur_test['passes'] and prior_test['passes'], 'design: qualifies on the prior year only'
    fed = form_1040('mfj', wages=95000, wages_are_spouses=True, se_businesses=[dict(profit=90000.0)], interest=5000)
    rap_cur = P2['farmer_sh_current'] * fed['federal_total']; rap_pri = P2['farmer_sh_prior'] * 24000.0; rap = min(rap_cur, rap_pri)
    assert rap == rap_cur, 'design: the 66 2/3% current-year rule binds'
    withholding = 9000.0; net = rap - withholding
    due = next_business_day(P2['farmer_due'], P2['holidays']); assert due == P2['farmer_due'], 'Jan 15, 2027 is a Friday'
    paid_on_time = penalty_schedule([rap], [due], withholding, [(due, float(math.ceil(net)))], fed_rates, fed_ret)
    paid_mar_1 = penalty_schedule([rap], [due], withholding, [(P2['farmer_file_by'], float(math.ceil(net)))], fed_rates, fed_ret)
    regular = safe_harbor(fed['federal_total'], prior_tax=24000, prior_agi=190000, fs='mfj', withholding=withholding)      # for contrast only (110% would apply)
    res['farmer_prior_year'] = dict(
        gross_income_test=dict(current=cur_test, prior=prior_test, qualifies=True, basis='prior_year', joint_test=True, required_ratio=P2['farmer_ratio']),
        federal=fed,
        safe_harbor=dict(regime='farmer', current_pct=P2['farmer_sh_current'], prior_pct=P2['farmer_sh_prior'], high_agi_rule_applies=False,
                         current=r(rap_cur), prior=r(rap_pri), required=r(rap), installment=r(rap), withholding=r(withholding), net_required=r(net)),
        installments=[dict(number=1, due_date=due.isoformat(), pct=1.0)], file_and_pay_by=P2['farmer_file_by'].isoformat(),
        paid_jan_15=dict(payment=math.ceil(net), penalty_by_installment=paid_on_time[0], penalty_total=paid_on_time[1]),
        paid_mar_1=dict(payment=math.ceil(net), penalty_by_installment=paid_mar_1[0], penalty_total=paid_mar_1[1],
                        relief='§6654(i)(1)(D): no addition to tax if the return is filed and the tax paid in full by Mar 1, 2027 — a note on the estimate, not assumed (the penalty shown accrues Jan 15 → Mar 1 at the 2027 Q1 rate).'),
        regular_rules_for_contrast=regular,
        note=('§6654(i)(2)(B): the two-thirds test is met on the PRIOR year (210,000 ÷ 260,000 = 80.8%) although the current year fails (150,000 ÷ 250,000 = '
              '60%), so the farmer rules apply: one installment of 100% due Jan 15, 2027; required annual payment = lesser of 66⅔% of the current-year tax and '
              '100% of the prior-year tax (24,000) — the 110% rule for prior-year AGI over 150,000 does not apply (§6654(i)(1)(C)); 66⅔% × 31,778 = 21,185 binds.'))

    # ── passive_ebl: Marcus Bell, single ─────────────────────────────────────────────────────────────────────
    # Wages 380,000 (withholding 10,000); Bell Robotics (Sch C, start-up) −300,000; Cedar Lane Rentals LLC (rental, active participation) −30,000.
    ll = passive_and_ebl('single', nonpassive_business_net=-300000.0, active_rental_loss=30000.0, other_passive_income=0.0, nonpassive_agi_items=380000.0)
    assert ll['magi'] == 124000 and ll['allowance_after_phaseout'] == 13000 and ll['suspended_passive_loss'] == 17000 and ll['excess_business_loss'] == 57000
    fed3 = form_1040('single', wages=380000, se_businesses=[dict(profit=-300000.0)], rental=ll['_exact']['rental_allowed'], suspended_passive_loss=ll['_exact']['suspended'], ebl_addback=ll['_exact']['ebl'])
    assert fed3['agi'] == 124000 and fed3['addl_medicare'] == r(0.009 * (380000 - 200000))
    res['passive_ebl'] = dict(loss_limits={k: v for k, v in ll.items() if k != '_exact'}, federal=fed3,
                              safe_harbor=safe_harbor(fed3['federal_total'], prior_tax=90000, prior_agi=450000, fs='single', withholding=10000),
                              note=('§469(i): MAGI = AGI without passive losses = 380,000 − 300,000 + 44,000 (the §461(l) add-back on the nonpassive loss alone, '
                                    'which is what AGI contains when the passive loss is disregarded) = 124,000 → allowance 25,000 − 50% × 24,000 = 13,000 of the '
                                    '30,000 active-participation rental loss; 17,000 suspended. §461(l) after §469: business loss 300,000 + 13,000 = 313,000 exceeds '
                                    'the 2026 single threshold 256,000 by 57,000, which is disallowed and added back (NOL carryover). AGI = 380,000 − 300,000 '
                                    '− 13,000 + 57,000 = 124,000; Additional Medicare on wages over 200,000; no NIIT (AGI < 200,000).'))

    # ── senior_sch1a: the Haddads (MFJ) — Samir born 1959-05-10 (67), Leila born 1962-01-01 (65: "born before January 2, 1962") ──
    # (a) in the senior band: Samir wages 40,000 incl. 4,300 qualified tips, car-loan interest 3,700 (withholding 3,000); Leila wages 150,000 incl.
    #     7,500 qualified overtime (withholding 9,000); interest 6,000; qualified dividends 7,400; cash gifts 3,000 → AGI 203,400.
    a = form_1040('mfj', wages=190000, interest=6000, qualified_dividends=7400, seniors=2, charitable_cash_nonitemizer=3000, sch1a=dict(tips=4300.0, overtime=7500.0, car=3700.0))
    assert a['agi'] == 203400 and a['sch1a'] == dict(senior=8796, tips=4300, overtime=7500, car_loan_interest=2900, total=23496, steps=dict(tips=0, overtime=0, car=4))
    # (b) above the tips / overtime threshold: Samir 45,000 incl. 6,200 tips (withholding 3,500); Leila 240,000 incl. 21,000 overtime (withholding 26,500);
    #     interest 10,000; qualified dividends 7,350; gifts 3,000 → AGI 302,350: excess 2,350 → 2 whole steps (DOWN) for tips and overtime; car 103 steps (UP) → 0.
    b = form_1040('mfj', wages=285000, interest=10000, qualified_dividends=7350, seniors=2, charitable_cash_nonitemizer=3000, sch1a=dict(tips=6200.0, overtime=21000.0, car=3700.0))
    assert b['agi'] == 302350 and b['sch1a'] == dict(senior=2859, tips=6000, overtime=20800, car_loan_interest=0, total=29659, steps=dict(tips=2, overtime=2, car=103))
    res['senior_sch1a'] = dict(
        persons=dict(samir=dict(dob='1959-05-10', age_2026=67), leila=dict(dob='1962-01-01', age_rule='born before January 2, 1962 → 65 for 2026 (2025 Schedule 1-A line 36b wording shifted one year)')),
        in_band=dict(inputs=dict(wages_samir=40000, tips=4300, car_loan_interest=3700, wages_leila=150000, overtime=7500, interest=6000, qualified_dividends=7400, cash_gifts=3000, withholding=12000),
                     federal=a, safe_harbor=safe_harbor(a['federal_total'], prior_tax=30000, prior_agi=190000, fs='mfj', withholding=12000)),
        above_tips_threshold=dict(inputs=dict(wages_samir=45000, tips=6200, car_loan_interest=3700, wages_leila=240000, overtime=21000, interest=10000, qualified_dividends=7350, cash_gifts=3000, withholding=30000),
                                  federal=b, safe_harbor=safe_harbor(b['federal_total'], prior_tax=30000, prior_agi=190000, fs='mfj', withholding=30000),
                                  if_rounded_up_instead=dict(tips=6200 - 300, overtime=21000 - 300, note='what a round-UP reading of §224(b)(2) / §225(b)(2) would give — the 2025 Schedule 1-A lines 11 / 19 say round DOWN')),
        note=('Schedule 1-A (2025 form): Part V seniors 2 × 6,000 less 6% of MAGI over 150,000 (linear, lines 33–35); Part IV car-loan interest 3,700 less $200 per '
              '$1,000 "or portion thereof" of MAGI over 200,000 (line 28 rounds UP: 3,400 → 4 steps → 800); Parts II / III tips and overtime less $100 per WHOLE '
              '$1,000 over 300,000 (lines 11 / 19 round DOWN: 2,350 → 2 steps → 200). Standard deduction 32,200 + 2 × 1,650 + 2,000 §170(p).'))

    # ── multistate: the Okafors (MFJ, Missouri residents) ───────────────────────────────────────────────────
    # Chidi: Okafor Consulting (Sch C, MO) 120,000; Okafor KC-Kansas (Sch C sourced to KS) 40,000; Riverbend Flats LP (AR rental, passive) 12,000.
    # Ngozi: wages 60,000 (federal withholding 5,000; MO withholding 2,400). Interest 2,000. Prior year: federal tax 28,000 / AGI 200,000; MO tax 6,000; KS unknown.
    fed5 = form_1040('mfj', wages=60000, wages_are_spouses=True, se_businesses=[dict(profit=120000.0), dict(profit=40000.0)], interest=2000, rental=12000)
    rows = state_rows(dict(state='MO', rate=0.04), [dict(state='KS', sourced=40000.0, rate=0.057), dict(state='AR', sourced=12000.0, rate=0.039)], agi=fed5['agi'], withholding_by_state=dict(MO=2400.0))
    assert rows['MO']['credit_details'][0]['limited'] and not rows['MO']['credit_details'][1]['limited']
    assert rows['MO']['gate']['required'] and rows['KS']['gate']['required'] and not rows['AR']['gate']['required']
    mo_v = state_vouchers('MO', rows['MO']['net_tax'], prior_tax=6000.0, withholding=2400.0, payments=[(d, float(math.ceil(0))) for d in []])
    ks_inst = 0.9 * rows['KS']['net_tax'] / 4
    ks_v = state_vouchers('KS', rows['KS']['net_tax'], prior_tax=None, withholding=0.0, payments=[(date(2026, 7, 1), 2 * ks_inst)])     # Q1 + Q2 paid together on Jul 1
    state_total = sum(row['_exact'] for row in rows.values())
    res['multistate'] = dict(
        federal=fed5, safe_harbor=safe_harbor(fed5['federal_total'], prior_tax=28000, prior_agi=200000, fs='mfj', withholding=5000),
        states={k: {kk: vv for kk, vv in v.items() if kk != '_exact'} for k, v in rows.items()}, state_total=r(state_total),
        sourcing=dict(KS=dict(company='Okafor KC-Kansas', income=40000), AR=dict(company='Riverbend Flats LP', income=12000)),
        vouchers=dict(MO=mo_v, KS=ks_v),
        note=('MO resident: AGI × 4% less the credit for taxes paid to KS and AR, each limited to the MO rate on the income sourced there — KS 40,000 × 5.7% = 2,280 '
              'is limited to 1,600, AR 12,000 × 3.9% = 468 is allowed in full (480 limit). Gates: MO ≥ 100 after 2,400 withholding → required; KS 2,280 ≥ 500 → '
              'required; AR 468 is not more than 1,000 → not required. KS vouchers: no prior-year KS tax → 90% of current, 513 per installment; Q1 and Q2 paid '
              'together on Jul 1, 2026 → penalty at the KS 8% rate for 77 and 16 days; Q3 and Q4 unpaid accrue to Apr 15, 2027 across Dec 31.'))

    # ── multistate_gates: Kenji Nakamura, single, Arizona resident ───────────────────────────────────────────
    # Wages 90,000 (AZ withholding 1,000); Sch C sourced to GA 9,000; PA partnership (general partner) 15,000. Prior-year gross income 80,000.
    fed6 = form_1040('single', wages=90000, se_businesses=[dict(profit=9000.0), dict(profit=15000.0)])
    rows6 = dict()
    ga_tax = 9000.0 * 0.0539; pa_tax = 15000.0 * 0.0307
    az_gross = fed6['agi'] * 0.025; az_credit = min(ga_tax, 9000.0 * 0.025) + min(pa_tax, 15000.0 * 0.025); az_net = az_gross - az_credit
    rows6['AZ'] = dict(residency='resident', effective_rate=0.025, gross_tax=r(az_gross), credit=r(az_credit), net_tax=r(az_net),
                       gate=income_gate('AZ', state_tax=az_net, withholding=1000.0, federal_total_income=fed6['total_income'], federal_deduction=fed6['deduction'], fs='single', prior_year_gross=80000.0))
    rows6['GA'] = dict(residency='nonresident', effective_rate=0.0539, sourced_income=9000, net_tax=r(ga_tax),
                       gate=income_gate('GA', state_tax=ga_tax, withholding=0.0, federal_total_income=fed6['total_income'], federal_deduction=fed6['deduction'], fs='single', gross_income=9000.0, exemptions=0.0))
    rows6['PA'] = dict(residency='nonresident', effective_rate=0.0307, sourced_income=15000, net_tax=r(pa_tax),
                       gate=income_gate('PA', state_tax=pa_tax, withholding=0.0, federal_total_income=fed6['total_income'], federal_deduction=fed6['deduction'], fs='single', non_withheld=24000.0))
    assert rows6['AZ']['gate']['required'] and not rows6['GA']['gate']['required'] and rows6['PA']['gate']['required']
    res['multistate_gates'] = dict(federal=dict(total_income=fed6['total_income'], agi=fed6['agi'], deduction=fed6['deduction'], federal_total=fed6['federal_total']), states=rows6,
                                   note=('AZ (A.R.S. 43-581(A)): gross income over 75,000 in both 2025 (80,000) and 2026 (federal total income) AND tax after withholding ≥ 1,000 → '
                                         'required. GA (O.C.G.A. 48-7-114(b)): the gross-income test replaces the tax-due test — 9,000 GA-source gross is not more than exemptions 0 + '
                                         'deductions (federal 16,100 used when state deductions are blank) + 1,000 → not required. PA (REV-413): income not subject to withholding '
                                         '24,000 exceeds 11,000 → required.'))

    print(json.dumps(res, indent=2))
    json.dump(res, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scenarios2_expected.json'), 'w'), indent=2)

if __name__ == '__main__':
    main()
