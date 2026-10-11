# Copyright 2026 Kisaes LLC
# Licensed under the PolyForm Small Business License 1.0.0.
# Free for small businesses; see LICENSE for terms.
"""Reference calculator (test oracle) for the Rivera golden fixture — tax year 2026, MFJ.

Independent of the app engine. Run:  python3 rivera_fixture.py
Prints the expected values and rewrites rivera_expected.json next to this file.

All parameters are listed at the top; values marked [VERIFY] must match the
Phase 1 verified seeds (see OPEN-QUESTIONS.md "Parameters to verify").

v2.1 → v2.2 (2026-10-11, repo adaptation review, both logged in OPEN-QUESTIONS.md):
  * The nine-month "prorated" case prorated the standard deduction and credits
    and scaled the brackets. Form 2210 Schedule AI does none of that. It is
    replaced by a real Schedule AI column — period 3 (Jan 1 – Aug 31,
    annualization factor 1.5, applicable percentage 67.5%) — computed the way
    Schedule AI does: annualize income and adjustments, use the FULL-YEAR
    standard deduction, figure tax on the annualized taxable income, subtract
    full-year credits, apply the applicable percentage. SE tax follows Part II:
    period net earnings against the PRORATED wage base, then annualized.
  * The §6654 penalty is now event-driven: payments (withholding treated as
    paid evenly on each due date, estimates on their dates) are applied to the
    EARLIEST unpaid installment; each installment's unpaid balance accrues at
    the quarterly rate from its due date to the earlier of the date it is paid
    or the return due date (Apr 15, 2027). The Q3 shortfall is cured by the
    Jan 15 payment, so the fixture's penalty is unchanged (~$11) — but it is
    now derived from the right rule.
"""
import json, math
from datetime import date

P = dict(
  se_nese=0.9235, se_ss=0.124, se_med=0.029, ss_wage_base=184500, se_half=0.5,
  std_mfj=32200,
  brackets_mfj=[(24800,.10),(100800,.12),(211400,.22),(403550,.24),(512450,.32),(768700,.35),(math.inf,.37)],
  qbi_rate=0.20, qbi_threshold_mfj=403500, qbi_ti_limit=0.20,
  addl_med_rate=0.009, addl_med_thr_mfj=250000, niit_rate=0.038, niit_thr_mfj=250000,
  sep_pct_of_net=0.20,
  sh_current=0.90, sh_prior_high=1.10, sh_high_agi=150000,
  # Form 2210 Schedule AI (individual): period ends, annualization factors, applicable percentages
  sch_ai_period_ends=['03-31','05-31','08-31','12-31'],
  sch_ai_factors=[4, 2.4, 1.5, 1],
  sch_ai_applicable_pcts=[0.225, 0.45, 0.675, 0.90],
  sch_ai_months=[3, 5, 8, 12],
  # §6654 underpayment rate by calendar quarter: list of (from, to, annual rate). [VERIFY] placeholder 7%
  # Quarterly §6654 rates, mirrors seeds/federal/2026.ts penalty.underpayment_rate
  # (Q2 2026 = 6%; 2027 quarters are unpublished placeholders at 7%). [VERIFY 2027]
  underpayment_rates=[
    (date(2026,1,1), date(2026,3,31), 0.07), (date(2026,4,1), date(2026,6,30), 0.06),
    (date(2026,7,1), date(2026,9,30), 0.07), (date(2026,10,1), date(2026,12,31), 0.07),
    (date(2027,1,1), date(2027,3,31), 0.07), (date(2027,4,1), date(2027,6,30), 0.07),
  ],
  return_due=date(2027,4,15),
  installment_due=[date(2026,4,15), date(2026,6,15), date(2026,9,15), date(2027,1,15)],
)

def r(x): return int(math.floor(x+0.5))

def brackets(ti):
    t=0; lo=0
    for hi,rate in P['brackets_mfj']:
        if ti>lo: t+=(min(ti,hi)-lo)*rate
        lo=hi
    return t

def calc(name, *, schc_books, schc_owner_hi_booked, schc_meals_nd, scorp_k1, wages, lp_rental, interest,
         sep, sehi, ar_source, credits_nr=2200, mo_rate=0.04, ar_rate=0.039):
    """Full-year computation (12 months). All inputs are annual amounts."""
    schc = schc_books + schc_owner_hi_booked + schc_meals_nd           # GL tax-treatment map reclass
    nese = schc*P['se_nese']
    se = min(nese,P['ss_wage_base'])*P['se_ss'] + nese*P['se_med']
    half = se*P['se_half']
    sep_cap = P['sep_pct_of_net']*(schc-half)
    sep_used = min(sep, sep_cap)
    sehi_used = min(sehi, schc-half-sep_used)                          # SEHI capped at earned income
    total_income = schc+scorp_k1+wages+lp_rental+interest
    agi = total_income-half-sep_used-sehi_used
    ded = P['std_mfj']
    ti_pre = agi-ded
    # QBI: Sch C (active) + S corp K-1 (active). LP rental: passive, not a trade or business -> no QBI.
    qbi_c = P['qbi_rate']*(schc-half-sehi_used-sep_used)
    qbi_s = P['qbi_rate']*scorp_k1
    qbi = min(qbi_c+qbi_s, P['qbi_ti_limit']*ti_pre)
    ti = ti_pre-qbi
    inc_tax = brackets(ti)
    nr = min(credits_nr, inc_tax)                                      # nonrefundable capped at income tax
    addl = max(0,(wages+nese)-P['addl_med_thr_mfj'])*P['addl_med_rate']
    nii = interest+lp_rental                                           # passive rental K-1 is NII
    niit = max(0,min(nii, agi-P['niit_thr_mfj']))*P['niit_rate']
    fed = inc_tax-nr+se+addl+niit
    ar = ar_source*ar_rate                                             # nonresident: sourced income only (flat effective rate — v1 simplification)
    mo_gross = agi*mo_rate                                             # resident: 100% of base
    mo_credit = min(ar, ar_source*mo_rate)                             # credit for tax paid to AR
    mo = mo_gross-mo_credit
    return dict(scenario=name, sch_c_tax_profit=r(schc), total_income=r(total_income), se_tax=r(se), half_se=r(half),
               sep_deducted=r(sep_used), sep_limit=r(sep_cap), sehi=r(sehi_used), agi=r(agi), std_deduction=r(ded),
               qbi=r(qbi), taxable_income=r(ti), income_tax_brackets=r(inc_tax), credits_nonrefundable=r(nr),
               addl_medicare=r(addl), niit=r(niit), federal_total=r(fed), mo_gross=r(mo_gross), mo_credit=r(mo_credit),
               mo=r(mo), ar=r(ar), state_total=r(mo+ar), total=r(fed+mo+ar))

def schedule_ai_column(period_idx, *, schc_books, schc_owner_hi_booked, schc_meals_nd, scorp_k1, wages, lp_rental,
                       interest, sep, sehi, credits_nr=2200):
    """One Form 2210 Schedule AI column. Inputs are the ACTUAL amounts for Jan 1 through the period end.

    Part I: annualize income (line 1 × factor), annualize adjustments (line 4 × factor), FULL-YEAR standard
    deduction (line 7), QBI figured on the annualized amounts [VERIFY: Sch AI line 9 instructions],
    tax on annualized taxable income (line 14), SE tax from Part II (line 15), other taxes annualized
    (line 17), FULL-YEAR credits (line 19) [VERIFY], × applicable percentage (line 21–22).
    Part II: period net earnings × 0.9235 against the PRORATED wage base (wage base × months/12),
    then × annualization factor.
    """
    f = P['sch_ai_factors'][period_idx]; months = P['sch_ai_months'][period_idx]; pct = P['sch_ai_applicable_pcts'][period_idx]
    schc_p = schc_books + schc_owner_hi_booked + schc_meals_nd          # period tax-basis Sch C profit
    # Part II — annualized SE tax
    nese_p = schc_p*P['se_nese']
    prorated_base = P['ss_wage_base']*months/12
    se_p = min(nese_p, max(0, prorated_base - 0))*P['se_ss'] + nese_p*P['se_med']   # no W-2 SS wages of the Sch C owner in this fixture
    se_a = se_p*f
    half_a = se_a*P['se_half']
    # Part I — annualized income and adjustments
    schc_a = schc_p*f; scorp_a = scorp_k1*f; wages_a = wages*f; rental_a = lp_rental*f; interest_a = interest*f
    sep_cap_a = P['sep_pct_of_net']*(schc_a-half_a)
    sep_a = min(sep*f, sep_cap_a)
    sehi_a = min(sehi*f, schc_a-half_a-sep_a)
    total_income_a = schc_a+scorp_a+wages_a+rental_a+interest_a
    agi_a = total_income_a-half_a-sep_a-sehi_a
    ded = P['std_mfj']                                                  # FULL-YEAR standard deduction (Sch AI line 7)
    ti_pre = agi_a-ded
    qbi_a = min(P['qbi_rate']*(schc_a-half_a-sehi_a-sep_a) + P['qbi_rate']*scorp_a, P['qbi_ti_limit']*ti_pre)
    ti_a = ti_pre-qbi_a
    inc_tax_a = brackets(ti_a)
    nr = min(credits_nr, inc_tax_a)                                     # full-year credits (Sch AI line 19)
    nese_a = nese_p*f
    addl_a = max(0,(wages_a+nese_a)-P['addl_med_thr_mfj'])*P['addl_med_rate']
    niit_a = max(0,min(interest_a+rental_a, agi_a-P['niit_thr_mfj']))*P['niit_rate']
    total_a = inc_tax_a-nr+se_a+addl_a+niit_a
    return dict(period=period_idx+1, period_end=f"2026-{P['sch_ai_period_ends'][period_idx]}", annualization_factor=f,
                applicable_pct=pct, annualized_agi=r(agi_a), std_deduction_full_year=r(ded), annualized_qbi=r(qbi_a),
                annualized_taxable_income=r(ti_a), annualized_income_tax=r(inc_tax_a), annualized_se_tax=r(se_a),
                annualized_total_tax=r(total_a), required_cumulative_through_period=r(total_a*pct))

def penalty_schedule(required_per_installment, due_dates, withholding_per_q, payments, rates, return_due):
    """§6654 estimate. `payments` = [(date, amount)] estimated-tax payments. Withholding is treated as paid
    evenly on each due date. Every payment is applied to the EARLIEST installment with an unpaid balance.
    Each installment's unpaid balance accrues at the quarterly rate from its due date to the earlier of
    the date it is paid down or the return due date. Returns per-installment rows + total penalty."""
    n = len(required_per_installment)
    balance = [0.0]*n                       # unpaid balance per installment, created on its due date
    paid_on_due = [0.0]*n                   # withholding + estimates dated on/before the due date and applied
    events = []                             # (date, kind, amount, idx)
    for i,d in enumerate(due_dates):
        events.append((d, 'due', required_per_installment[i], i))
        events.append((d, 'pay', withholding_per_q, i))                 # even withholding on the due date
    for d,amt in payments:
        events.append((d, 'pay', amt, -1))
    events.append((return_due, 'end', 0, -1))
    events.sort(key=lambda e: (e[0], 0 if e[1]=='due' else 1 if e[1]=='pay' else 2))
    def rate_on(d):
        for a,b,rt in rates:
            if a <= d <= b: return rt
        raise ValueError(f'no underpayment rate for {d}')
    penalty = [0.0]*n; last = [None]*n; paid_dates = [None]*n; over = 0.0
    def accrue_to(d):
        for i in range(n):
            if balance[i] > 0 and last[i] is not None and d > last[i]:
                penalty[i] += balance[i]*rate_on(last[i])*(d-last[i]).days/365
            if last[i] is not None: last[i] = d
    for d,kind,amt,idx in events:
        accrue_to(d)
        if kind=='due':
            balance[idx] = amt - over; over = 0.0                        # earlier overpayment reduces this installment
            if balance[idx] < 0: over = -balance[idx]; balance[idx] = 0.0
            last[idx] = d
        elif kind=='pay':
            remaining = amt
            for i in range(n):                                          # earliest unpaid installment first
                if last[i] is None: break                               # not yet due
                take = min(balance[i], remaining); balance[i] -= take; remaining -= take
                if balance[i] == 0 and take > 0: paid_dates[i] = d
                if remaining <= 0: break
            over += remaining                                           # excess carries to the next installment
        elif kind=='end':
            pass
    rows = []
    for i in range(n):
        rows.append(dict(q=f"Q{i+1}", due=due_dates[i].isoformat(), required=r(required_per_installment[i]),
                         withholding=r(withholding_per_q), still_unpaid_at_return_due=r(balance[i]),
                         paid_in_full_on=paid_dates[i].isoformat() if paid_dates[i] else None, penalty=r(penalty[i])))
    return rows, r(sum(penalty))

# ---------------------------------------------------------------- scenarios
base_in = dict(schc_books=115400, schc_owner_hi_booked=10800, schc_meals_nd=1800, scorp_k1=40000, wages=54000,
               lp_rental=8000, interest=2400, sep=15000, sehi=10800, ar_source=8000)
res = {}
res['base'] = calc('Base', **base_in)
res['truck'] = calc('Buy truck in December', **{**base_in, 'schc_books':115400-60000})
extra=18000; fica=extra*0.0765
res['raise'] = calc("Raise Maria's wages", **{**base_in, 'wages':72000, 'scorp_k1':40000-(extra+fica)*0.5})

# Schedule AI, period 3 (Jan 1 – Aug 31): actual YTD = 8/12 of annual because the fixture's income is level.
p3 = {k: v*8/12 for k,v in base_in.items() if k != 'ar_source'}
res['schedule_ai_period3'] = schedule_ai_column(2, **p3)
res['schedule_ai_period3']['note'] = ("Level income, so the annualized column reproduces the full-year figures and the "
    "required cumulative amount through Q3 (67.5%) equals three regular installments. A seasonal fixture "
    "(Phase 14) is where Schedule AI lowers the early installments.")

# Safe harbor + vouchers (federal), firm default = lesser-of; show both
fed = res['base']['federal_total']; prior_tax=31500; prior_agi=182000
cur = P['sh_current']*fed; pri = (P['sh_prior_high'] if prior_agi>P['sh_high_agi'] else 1.0)*prior_tax
req = min(cur,pri); inst=req/4; wh_q=6000/4
pays = [6600,6600,6000]; carry=0; sched=[]; q4_need_exact=0.0
due = [d.isoformat() for d in P['installment_due']]
for i in range(4):
    need = inst-wh_q-carry
    paid = pays[i] if i<3 else 0
    diff = paid-need
    sched.append(dict(q=f"Q{i+1}", due=due[i], required=r(inst), withholding=r(wh_q), from_estimates=r(need),
                      paid=paid if i<3 else None, short=r(-diff) if diff<0 and i<3 else 0, over=r(diff) if diff>0 and i<3 else 0))
    carry = diff if i<3 else 0   # overpayment reduces, shortfall increases, the next installment's need
    if i==3: q4_need_exact = need
q4_from_estimates = sched[3]['from_estimates']
# Payments as dated events; the Q4 voucher is assumed paid in full on its due date.
payments = list(zip(P['installment_due'][:3], pays)) + [(P['installment_due'][3], q4_need_exact)]
pen_rows, pen_total = penalty_schedule([inst]*4, P['installment_due'], wh_q, payments, P['underpayment_rates'], P['return_due'])
res['safe_harbor'] = dict(current_90=r(cur), prior_110=r(pri), required_lesser_of=r(req), installment=r(inst),
                          withholding_per_q=r(wh_q), schedule=sched, q4_due_from_estimates=q4_from_estimates,
                          penalty_by_installment=pen_rows, penalty_total_if_q4_paid_on_time=pen_total,
                          penalty_rule=("Each installment's unpaid balance accrues at the quarterly §6654 rate from its due date to the "
                                        "earlier of the date it is paid (payments applied to the earliest unpaid installment) or the "
                                        "return due date; withholding counted evenly on each due date."))
# Consistency check: level income => Schedule AI cumulative through Q3 == 3 regular installments (within rounding)
assert abs(res['schedule_ai_period3']['required_cumulative_through_period'] - 3*inst) <= 2, \
    (res['schedule_ai_period3']['required_cumulative_through_period'], 3*inst)

# Missouri estimate (state rules: 90% current or 100% prior; threshold $100 [VERIFY])
mo = res['base']['mo']; mo_req=min(0.9*mo, 7050); mo_wh=2000
res['missouri'] = dict(current_90=r(0.9*mo), prior_100=7050, required=r(mo_req), withholding=mo_wh,
                       per_installment_from_estimates=r((mo_req-mo_wh)/4))
res['truck_delta'] = res['base']['total']-res['truck']['total']
res['raise_delta'] = res['raise']['total']-res['base']['total']
print(json.dumps(res, indent=2))
import os
json.dump(res, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'rivera_expected.json'),'w'), indent=2)
