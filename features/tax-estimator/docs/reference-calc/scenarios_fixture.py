# Copyright 2026 Kisaes LLC
# Licensed under the PolyForm Small Business License 1.0.0.
# Free for small businesses; see LICENSE for terms.
"""Reference calculator (test oracle) for the Phase 14 golden scenarios — tax year 2026.

Independent of the app engine (nothing under packages/ is imported). Run:
    python3 -I scenarios_fixture.py
Prints the expected values and rewrites scenarios_expected.json next to this file.
`npm run test:tax-oracle` regenerates both oracle files and fails when the committed
JSON differs. The engine golden test that reads this file is
packages/shared/src/tax-estimator/engine/oracle.scenarios.golden.test.ts.

Scenarios (R2 O-2 coverage gaps; OPEN-QUESTIONS Q35):
  seasonal         single Sch C with Q4-heavy income — Form 2210 Schedule AI lowers the first three
                   installments and recaptures the skipped regular amounts in column (d); a second payment
                   pattern (everything paid Jan 15) accrues the §6654 penalty across the Q2 6% leg.
  late_payments    pure payment-ledger case: even withholding cures the earliest unpaid installment, a late
                   catch-up crosses the Jun 30 rate change (6% → 7%), a Q3 shortfall runs across Dec 31 into
                   2027, the Q4 balance is paid Mar 1, 2027.
  mfs              married filing separately, age 68: no Schedule 1-A (joint return required for every
                   §151(d)(5) / §224 / §225 / §163(h)(4) deduction), $1,650 married 65 add-on, $1,000
                   non-itemizer charitable, qualified dividends at 15% on the MFS worksheet, §469(i)
                   allowance denied (spouses lived together, §469(i)(5)(B)), MFS $75,000 high-AGI test.
  high_income_mfj  itemizer above the 37% bracket: SALT cap at the $10,000 floor, §68 2/37 reduction,
                   QD / LTCG split 15% / 20% at $613,700, §199A fully phased in with the W-2 / UBIA limit
                   (25% W-2 + 2.5% UBIA limb wins), SSTB S corp excluded, SEP capped, Additional Medicare
                   (threshold used by wages first), NIIT on interest / dividends / gains / passive rental,
                   110% prior-year safe harbor.
  itemizer_salt    MFJ itemizer with MAGI inside the SALT phase-down band (cap = 40,400 − 30% × excess over
                   505,000), §199A in the phase-in range with a W-2 limit (partial phase-in), SEHI attributable
                   to the business, Additional Medicare and a small NIIT.

Form references: Form 1040 (2025) and Schedule D Tax Worksheet; Form 2210 (2025) Schedule AI lines 1–36
(2025 numbering: line 21 = annualized tax × applicable %, 22 = Σ previous line 27, 23 = annualized
installment, 24 = 25% of line 9, 25 = previous column's line 26 − line 27, 26 = 24 + 25, 27 = smaller of
23 / 26) and Part II (prorated Social Security limit = wage base × months ÷ 12); Instructions for Form 2210
(2025) Worksheet for Part III Section B (penalty legs). Statute: IRC §1(h), §1(j), §63(c)/(f), §68 (OBBBA),
§164(b)(6)-(7), §170(b)(1)(I), §170(p), §199A, §469(i), §1401–1402, §1411, §3101(b)(2), §6654.
"""
import json, math, os, sys
sys.dont_write_bytecode = True                                    # keep the sibling import from writing __pycache__ next to the oracles
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # python3 -I leaves the script dir off sys.path
from rivera_fixture import penalty_schedule, r                      # the fixed §6654 ledger (Q35); nothing from the app

INF = math.inf

# ---------------------------------------------------------------- 2026 parameters (packages/api/src/db/seeds/tax-estimator/federal/2026.ts)
P = dict(
  se_nese=0.9235, se_min=400, se_ss=0.124, se_med=0.029, ss_wage_base=184500, se_half=0.5,
  brackets=dict(
    single=[(12400,.10),(50400,.12),(105700,.22),(201775,.24),(256225,.32),(640600,.35),(INF,.37)],
    mfj=[(24800,.10),(100800,.12),(211400,.22),(403550,.24),(512450,.32),(768700,.35),(INF,.37)],
    mfs=[(12400,.10),(50400,.12),(105700,.22),(201775,.24),(256225,.32),(384350,.35),(INF,.37)],
  ),
  ltcg_breakpoints=dict(single=(49450, 545500), mfj=(98900, 613700), mfs=(49450, 306850)),
  ltcg_rates=(0.0, 0.15, 0.20),
  std=dict(single=16100, mfj=32200, mfs=16100),
  std_addl_65_married=1650, std_addl_65_unmarried=2050, age_65=65,
  charity_nonitemizer=dict(single=1000, mfj=2000, mfs=1000),
  charity_floor_pct=0.005,
  salt=dict(standard=dict(cap=40400, threshold=505000, floor=10000), mfs=dict(cap=20200, threshold=252500, floor=5000)),
  salt_phase_down_rate=0.30,
  sec68_fraction=2/37,                 # §68(a) as amended by OBBBA §70111: 2/37 of the lesser amount (= 0.37 − 0.35 over 0.37)
  qbi_rate=0.20, qbi_threshold=dict(single=201750, mfj=403500, mfs=201775), qbi_range=dict(single=75000, mfj=150000, mfs=75000),
  qbi_w2=0.50, qbi_alt_w2=0.25, qbi_ubia=0.025, qbi_ti_limit=0.20, qbi_min=400, qbi_min_active=1000,
  addl_med_rate=0.009, addl_med_thr=dict(single=200000, mfj=250000, mfs=125000),
  niit_rate=0.038, niit_thr=dict(single=200000, mfj=250000, mfs=125000),
  sep_pct=0.25, sep_dollar_limit=72000, comp_limit=360000,
  passive_allowance=25000, passive_phaseout=(100000, 150000),       # MFS living together: no allowance (§469(i)(5)(B))
  ebl_threshold=dict(single=256000, mfj=512000),                     # §461(l)(3) as indexed for 2026 (Rev. Proc. 2025-32 §4.31)
  # Schedule 1-A (2025 form, Parts II–V; 2026 seed amounts). Tips / overtime: $100 for each WHOLE $1,000 of MAGI over the
  # threshold (form lines 11 / 19: "decrease the result to the next lower whole number"); car-loan interest: $200 for each
  # $1,000 "or portion thereof" (line 28: "increase the result to the next higher whole number"); seniors: linear 6% (line 34).
  sch1a_senior=6000, sch1a_senior_rate=0.06, sch1a_senior_thr=dict(single=75000, mfj=150000),
  sch1a_tips_max=25000, sch1a_tips_thr=dict(single=150000, mfj=300000), sch1a_tips_per_step=100,
  sch1a_ot_max=dict(single=12500, mfj=25000), sch1a_ot_thr=dict(single=150000, mfj=300000), sch1a_ot_per_step=100,
  sch1a_car_max=10000, sch1a_car_thr=dict(single=100000, mfj=200000), sch1a_car_per_step=200, sch1a_step=1000,
  sh_current=0.90, sh_prior=1.00, sh_prior_high=1.10, sh_high_agi=dict(standard=150000, mfs=75000), sh_min_balance=1000,
  installment_due=[date(2026,4,15), date(2026,6,15), date(2026,9,15), date(2027,1,15)],
  return_due=date(2027,4,15), q4_file_and_pay=date(2027,2,1),
  sch_ai_period_ends=['03-31','05-31','08-31','12-31'], sch_ai_factors=[4, 2.4, 1.5, 1], sch_ai_pcts=[0.225, 0.45, 0.675, 0.90], sch_ai_months=[3, 5, 8, 12],
  # §6654 / §6621 quarterly rates (Q2 2026 = 6%; 2027 quarters are unpublished placeholders at 7%). [VERIFY 2027]
  underpayment_rates=[
    (date(2026,1,1), date(2026,3,31), 0.07), (date(2026,4,1), date(2026,6,30), 0.06),
    (date(2026,7,1), date(2026,9,30), 0.07), (date(2026,10,1), date(2026,12,31), 0.07),
    (date(2027,1,1), date(2027,3,31), 0.07), (date(2027,4,1), date(2027,6,30), 0.07),
  ],
)

# ---------------------------------------------------------------- building blocks (form arithmetic)

def bracket_tax(ti, fs):
    t = 0.0; lo = 0.0
    for hi, rate in P['brackets'][fs]:
        if ti > lo: t += (min(ti, hi) - lo) * rate
        lo = hi
    return t

def qd_ltcg_tax(ti, pref, fs):
    """Qualified Dividends and Capital Gain Tax Worksheet (Form 1040 instructions): `pref` = qualified dividends +
    net long-term gain (limited to the net capital gain). Ordinary income fills the brackets first; the preferential
    income takes 0% up to the zero-rate breakpoint, 15% up to the 15%-rate breakpoint, 20% above; never more than
    the all-ordinary tax."""
    ti = max(0.0, ti); pref = max(0.0, min(pref, ti))
    if pref == 0: return bracket_tax(ti, fs)
    zero_bp, fifteen_bp = P['ltcg_breakpoints'][fs]
    ordinary = ti - pref
    at_zero = max(0.0, min(pref, zero_bp - ordinary))
    at_fifteen = max(0.0, min(pref - at_zero, fifteen_bp - max(ordinary, zero_bp)))
    at_twenty = pref - at_zero - at_fifteen
    worksheet = bracket_tax(ordinary, fs) + at_zero * P['ltcg_rates'][0] + at_fifteen * P['ltcg_rates'][1] + at_twenty * P['ltcg_rates'][2]
    return dict(tax=min(worksheet, bracket_tax(ti, fs)), ordinary_portion=ordinary, at_zero=at_zero, at_fifteen=at_fifteen, at_twenty=at_twenty)

def se_tax(se_income, ss_wages=0.0, wage_base=None):
    """Schedule SE: NESE = SE income × 92.35% (0 below $400); Social Security on NESE up to the wage base less
    W-2 Social Security wages; Medicare on all NESE. `wage_base` lets Schedule AI Part II prorate the limit."""
    base = P['ss_wage_base'] if wage_base is None else wage_base
    nese = se_income * P['se_nese'] if se_income > 0 else 0.0
    if nese < P['se_min']: nese = 0.0
    ss = P['se_ss'] * max(0.0, min(nese, base - ss_wages))
    med = P['se_med'] * nese
    return dict(nese=nese, ss=ss, medicare=med, se=ss + med, half=(ss + med) * P['se_half'])

def sep_limit(se_income, half_se):
    """Pub. 560: self-employed SEP limit = (plan rate ÷ (1 + plan rate)) × net earnings after ½ SE, capped by the
    §415(c) dollar limit and the §401(a)(17) compensation limit."""
    rate = P['sep_pct'] / (1 + P['sep_pct'])
    return min(P['sep_dollar_limit'], rate * min(max(0.0, se_income - half_se), P['comp_limit']))

def salt_cap(magi, fs):
    s = P['salt']['mfs' if fs == 'mfs' else 'standard']
    return max(s['floor'], s['cap'] - P['salt_phase_down_rate'] * max(0.0, magi - s['threshold']))

def qbi_component(qbi, w2, ubia, ti_before_qbi, fs, sstb=False):
    """§199A(b): below the threshold 20% × QBI; above threshold + range min(20% × QBI, max(50% W-2, 25% W-2 +
    2.5% UBIA)); in between the excess over the limit is phased in. SSTB: applicable percentage (1 − phase-in) on
    QBI, W-2 and UBIA; nothing above the range."""
    thr = P['qbi_threshold'][fs]; rng = P['qbi_range'][fs]
    phase = min(1.0, max(0.0, (ti_before_qbi - thr) / rng))
    if sstb:
        if phase >= 1: return dict(component=0.0, phase_in=phase, limit=None, excluded='SSTB above the phase-in range')
        applicable = 1 - phase; qbi *= applicable; w2 *= applicable; ubia = None if ubia is None else ubia * applicable
    tentative = P['qbi_rate'] * max(0.0, qbi)
    if phase <= 0 or qbi <= 0: return dict(component=tentative, phase_in=phase, limit=None, excluded=None)
    limit = max(P['qbi_w2'] * w2, (P['qbi_alt_w2'] * w2 + P['qbi_ubia'] * ubia) if ubia is not None else 0.0)
    component = tentative if tentative <= limit else (limit if phase >= 1 else tentative - (tentative - limit) * phase)
    return dict(component=component, phase_in=phase, limit=limit, excluded=None)

def addl_medicare(wages, nese, fs):
    """Form 8959: 0.9% of wages over the threshold plus 0.9% of NESE over the threshold REDUCED by wages."""
    thr = P['addl_med_thr'][fs]
    return P['addl_med_rate'] * (max(0.0, wages - thr) + max(0.0, nese - max(0.0, thr - wages)))

def niit(nii, magi, fs):
    return P['niit_rate'] * max(0.0, min(nii, magi - P['niit_thr'][fs]))

def safe_harbor(fed_tax_rounded, prior_tax, prior_agi, fs, withholding, rule='lesser_of'):
    cur = P['sh_current'] * fed_tax_rounded
    high = prior_agi > P['sh_high_agi']['mfs' if fs == 'mfs' else 'standard']
    pri = (P['sh_prior_high'] if high else P['sh_prior']) * prior_tax
    req = min(cur, pri) if rule == 'lesser_of' else cur
    inst = req / 4
    return dict(current_90=r(cur), prior=r(pri), prior_pct_high_agi_applied=high, required=r(req), installment=r(inst),
                withholding_per_q=r(withholding / 4), net_per_installment=r(inst - withholding / 4), required_exact=req)

def schedule_1a(fs, magi, seniors, tips=0.0, overtime=0.0, car=0.0):
    """2025 Schedule 1-A, Parts II–V, line by line. MAGI = AGI (no exclusions modelled). A married taxpayer must file
    jointly for every Part (§151(d)(5)(C)(v), §224(f), §225(e), §163(h)(4)(F)): MFS gets zero.
      Part II  lines 7–13: smaller of tips / 25,000; excess MAGI over 150,000 / 300,000 ÷ 1,000 rounded DOWN × $100.
      Part III lines 15–21: smaller of overtime / 12,500 (25,000 joint); same threshold and rounding as tips.
      Part IV  lines 24–30: smaller of interest / 10,000; excess over 100,000 / 200,000 ÷ 1,000 rounded UP × $200.
      Part V   lines 31–36: 6,000 per 65+ person; less 6% of MAGI over 75,000 / 150,000 (linear)."""
    zero = dict(senior=0.0, tips=0.0, overtime=0.0, car=0.0, total=0.0, steps=dict(tips=0, overtime=0, car=0))
    if fs == 'mfs': return zero
    step = P['sch1a_step']
    excess = lambda thr: max(0.0, magi - thr)
    tips_steps = math.floor(excess(P['sch1a_tips_thr'][fs]) / step)                     # line 11: next LOWER whole number
    ot_steps = math.floor(excess(P['sch1a_ot_thr'][fs]) / step)                         # line 19: next LOWER whole number
    car_steps = math.ceil(excess(P['sch1a_car_thr'][fs]) / step)                        # line 28: next HIGHER whole number
    tips_d = max(0.0, min(tips, P['sch1a_tips_max']) - tips_steps * P['sch1a_tips_per_step']) if tips > 0 else 0.0
    ot_d = max(0.0, min(overtime, P['sch1a_ot_max'][fs]) - ot_steps * P['sch1a_ot_per_step']) if overtime > 0 else 0.0
    car_d = max(0.0, min(car, P['sch1a_car_max']) - car_steps * P['sch1a_car_per_step']) if car > 0 else 0.0
    senior_d = max(0.0, P['sch1a_senior'] * seniors - P['sch1a_senior_rate'] * excess(P['sch1a_senior_thr'][fs])) if seniors > 0 else 0.0
    return dict(senior=senior_d, tips=tips_d, overtime=ot_d, car=car_d, total=senior_d + tips_d + ot_d + car_d,
                steps=dict(tips=tips_steps, overtime=ot_steps, car=car_steps))

# ---------------------------------------------------------------- Form 1040 (individual), form order

def se_person_ss_wages(inputs):
    """W-2 Social Security wages of the person who owns the SE businesses (the wage-base offset is per person, Schedule SE
    line 8): `wages` belong to that person unless `wages_are_spouses` says the other spouse earned them."""
    return 0.0 if inputs.get('wages_are_spouses') else inputs.get('wages', 0.0)

def form_1040(fs, *, wages=0.0, wages_are_spouses=False, officer_wages=0.0, se_businesses=(), passthrough=(), interest=0.0,
              qualified_dividends=0.0, ltcg=0.0, rental=0.0, suspended_passive_loss=0.0, sep=0.0, sehi=0.0,
              itemized=None, seniors=0, charitable_cash_nonitemizer=0.0, credits=0.0, wage_base=None, sch1a=None, ebl_addback=0.0):
    """One return. `se_businesses` = [dict(profit, w2, ubia, sstb)] (Sch C, one owner, all QBI-eligible);
    `passthrough` = [dict(ordinary, sstb, active)] (S corp K-1: not SE income; QBI when active, excluded when SSTB
    above the range); `rental` = passive K-1 rental after §469 (never QBI); `itemized` = dict(salt, mortgage,
    charity, other) or None. `wage_base` prorates the SE Social Security limit (Schedule AI Part II).
    `sch1a` = dict(tips, overtime, car) → Schedule 1-A with the `seniors` count (None = no Schedule 1-A items);
    `ebl_addback` = the §461(l) excess business loss disallowed this year (added back to ordinary income, an NOL note)."""
    ss_w = se_person_ss_wages(dict(wages=wages, wages_are_spouses=wages_are_spouses))
    se_income = sum(b['profit'] for b in se_businesses)
    se = se_tax(se_income, ss_w, wage_base)
    sep_cap = sep_limit(se_income, se['half']) if sep else 0.0
    sep_used = min(sep, sep_cap)
    sehi_used = min(sehi, max(0.0, se_income - se['half'] - sep_used) + officer_wages)
    business = se_income + sum(k['ordinary'] for k in passthrough)
    total_wages = wages + officer_wages
    total_income = total_wages + business + interest + qualified_dividends + ltcg + rental + ebl_addback
    agi = total_income - se['half'] - sep_used - sehi_used
    # deductions
    std = P['std'][fs] + seniors * (P['std_addl_65_married'] if fs in ('mfj', 'mfs') else P['std_addl_65_unmarried'])
    # §170(p): the standard-deduction ALTERNATIVE includes the non-itemizer charitable deduction on cash gifts (an itemizer's
    # cash gifts count here only for the comparison; the deduction itself is taken only when the standard deduction wins).
    cash_gifts = charitable_cash_nonitemizer or (itemized['charity'] if itemized else 0.0)
    nonitemizer = min(max(0.0, cash_gifts), P['charity_nonitemizer'][fs])
    std_total = std + nonitemizer
    it = None
    if itemized:
        cap = salt_cap(agi, fs)
        charity_floor = P['charity_floor_pct'] * agi if itemized['charity'] > 0 else 0.0
        it = dict(salt_paid=itemized['salt'], salt_cap=cap, salt_allowed=min(itemized['salt'], cap), mortgage=itemized['mortgage'],
                  charity_gross=itemized['charity'], charity_floor=charity_floor, charity_allowed=max(0.0, itemized['charity'] - charity_floor), other=itemized.get('other', 0.0))
        it['before_68'] = it['salt_allowed'] + it['mortgage'] + it['charity_allowed'] + it['other']
    pre_68_deduction = max(std_total, it['before_68']) if it else std_total
    s1a = schedule_1a(fs, agi, seniors, **sch1a) if sch1a else None        # MAGI = AGI
    sch1a = s1a['total'] if s1a else 0.0
    # §199A on taxable income before QBI, itemized taken BEFORE §68 (the §68 base needs QBI; MODULE.md Q32)
    ti_before_qbi = agi - pre_68_deduction - sch1a
    components = []
    attributable = se['half'] + sep_used + sehi_used              # Reg. 1.199A-3(b)(1)(vi): allocated to the SE businesses pro rata by their (positive) SE income
    positive_profit = sum(b['profit'] for b in se_businesses if b['profit'] > 0)
    for b in se_businesses:
        weight = b['profit'] / positive_profit if b['profit'] > 0 and positive_profit > 0 else 0.0
        c = qbi_component(b['profit'] - attributable * weight, b.get('w2', 0.0), b.get('ubia'), ti_before_qbi, fs, b.get('sstb', False)); c['source'] = 'sch_c'; components.append(c)
    for k in passthrough:
        if k.get('active', True):
            c = qbi_component(k['ordinary'], k.get('w2', 0.0), k.get('ubia'), ti_before_qbi, fs, k.get('sstb', False)); c['source'] = 's_corp'; components.append(c)
    net_cap_gain_with_qd = max(0.0, ltcg) + qualified_dividends
    overall_limit = P['qbi_ti_limit'] * max(0.0, ti_before_qbi - net_cap_gain_with_qd)
    combined = sum(c['component'] for c in components)
    qbi = min(combined, overall_limit)
    # §68 (itemizers only): reduce by 2/37 of the lesser of itemized deductions or TI (before §68, plus itemized) over the 37% bracket start
    deduction = pre_68_deduction; chosen = 'standard'; sec68 = 0.0
    if it:
        top_start = P['brackets'][fs][-2][0]
        over_top = max(0.0, (agi - sch1a - qbi) - top_start)
        sec68 = P['sec68_fraction'] * min(it['before_68'], over_top) if it['before_68'] > 0 else 0.0
        it['sec68_reduction'] = sec68; it['total'] = it['before_68'] - sec68
        if it['total'] > std_total: deduction = it['total']; chosen = 'itemized'
        else: deduction = std_total
        if sec68 > 0: assert combined <= overall_limit, 'the oracle assumes the QBI overall limit does not bind when §68 applies (ordering)'
    ti = max(0.0, agi - deduction - sch1a - qbi)
    pref = qualified_dividends + max(0.0, ltcg)
    tax_ws = qd_ltcg_tax(ti, pref, fs) if pref > 0 else dict(tax=bracket_tax(ti, fs), ordinary_portion=ti, at_zero=0.0, at_fifteen=0.0, at_twenty=0.0)
    inc_tax = tax_ws['tax']
    nr = min(credits, inc_tax)
    addl = addl_medicare(total_wages, se['nese'], fs)
    nii = max(0.0, interest + qualified_dividends + max(0.0, ltcg) + rental)   # Form 8960 line 8 floored (a net rental loss cannot make NII negative)
    nii_tax = niit(nii, agi, fs)
    fed = inc_tax - nr + se['se'] + addl + nii_tax
    out = dict(total_income=r(total_income), se_income=r(se_income), nese=r(se['nese']), se_tax=r(se['se']), half_se=r(se['half']),
               sep_deducted=r(sep_used), sep_limit=r(sep_cap), sehi=r(sehi_used), agi=r(agi),
               standard_deduction=r(std_total), nonitemizer_charitable=r(nonitemizer),   # standard_deduction = the standard ALTERNATIVE incl. §170(p)
               deduction_chosen=chosen, deduction=r(deduction), sch1a_total=r(sch1a),
               taxable_income_before_qbi=r(ti_before_qbi), qbi=r(qbi), qbi_components=[dict(source=c['source'], component=r(c['component']), phase_in=round(c['phase_in'], 6), wage_ubia_limit=None if c['limit'] is None else r(c['limit']), excluded=c['excluded']) for c in components],
               qbi_overall_limit=r(overall_limit), taxable_income=r(ti), income_tax=r(inc_tax),
               worksheet=dict(ordinary_portion=r(tax_ws['ordinary_portion']), taxed_at_zero=r(tax_ws['at_zero']), taxed_at_fifteen=r(tax_ws['at_fifteen']), taxed_at_twenty=r(tax_ws['at_twenty'])) if pref > 0 else None,
               credits_nonrefundable=r(nr), addl_medicare=r(addl), nii=r(nii), niit=r(nii_tax), suspended_passive_loss=r(suspended_passive_loss),
               federal_total=r(fed), federal_total_exact=fed)
    if it: out['itemized'] = {k: (round(v, 6) if isinstance(v, float) else v) for k, v in it.items()}
    if s1a: out['sch1a'] = dict(senior=r(s1a['senior']), tips=r(s1a['tips']), overtime=r(s1a['overtime']), car_loan_interest=r(s1a['car']), total=r(s1a['total']), steps=s1a['steps'])
    if ebl_addback: out['ebl_addback'] = r(ebl_addback)
    return out

# ---------------------------------------------------------------- Form 2210 Schedule AI

def schedule_ai(columns, required_annual_payment, fed_total_exact, fs, calc):
    """Form 2210 (2025) Schedule AI lines 1–27 and Part II. `columns[i]` = the ACTUAL inputs Jan 1 – period end for
    columns (a)–(c) (keyword dicts for `calc`); column (d) is the full year. Part I: annualize income and adjustments
    (× line 2), FULL-YEAR standard deduction (line 7) and FULL-YEAR credits (line 18), tax on the annualized taxable
    income; Part II: SE tax on PERIOD net earnings against the prorated Social Security limit (line 29), annualized
    (lines 32–35 = rate × factor). Lines 22–27 (2025 numbering): 22 Σ previous 27; 23 = 21 − 22 (≥ 0);
    24 = 25% × line 9; 25 = previous 26 − previous 27; 26 = 24 + 25; 27 = min(23, 26)."""
    rows = []; prev_27 = 0.0; prev_26 = None; cum_27 = 0.0; line24 = required_annual_payment / 4
    for i in range(4):
        f = P['sch_ai_factors'][i]; pct = P['sch_ai_pcts'][i]; months = P['sch_ai_months'][i]
        if i < 3:
            a = {k: (v * f if isinstance(v, (int, float)) and k in ('wages', 'interest', 'qualified_dividends', 'ltcg', 'rental', 'sep', 'sehi', 'officer_wages') else v) for k, v in columns[i].items()}
            a['se_businesses'] = [dict(b, profit=b['profit'] * f) for b in columns[i].get('se_businesses', ())]
            a['passthrough'] = [dict(k, ordinary=k['ordinary'] * f) for k in columns[i].get('passthrough', ())]
            if 'itemized' in a and a['itemized']: a['itemized'] = {k: v * f for k, v in a['itemized'].items()}
            annualized = calc(fs, **a)
            # Part II on the PERIOD figures: period NESE against wage base × months/12, then × factor (lines 28–36). It equals
            # the SE tax on the annualized inputs because factor = 12 ÷ months (both sides scale alike), so line 17 is the
            # annualized return's total with its SE tax swapped for Part II.
            period_profit = sum(b['profit'] for b in columns[i].get('se_businesses', ()))
            part_ii_se = se_tax(period_profit, se_person_ss_wages(columns[i]), P['ss_wage_base'] * months / 12)['se'] * f
            se_on_annualized = se_tax(period_profit * f, se_person_ss_wages(a))['se']
            total_exact = annualized['federal_total_exact'] - se_on_annualized + part_ii_se
        else:
            annualized = calc(fs, **columns[3]); total_exact = fed_total_exact
            part_ii_se = se_tax(sum(b['profit'] for b in columns[3].get('se_businesses', ())), se_person_ss_wages(columns[3]))['se']
        line21 = total_exact * pct
        line22 = cum_27
        line23 = max(0.0, line21 - line22)
        line25 = 0.0 if prev_26 is None else prev_26 - prev_27
        line26 = line24 + line25
        line27 = min(line23, line26)
        rows.append(dict(period=i + 1, period_end=f"2026-{P['sch_ai_period_ends'][i]}", annualization_factor=f, applicable_pct=pct,
                         annualized_agi=annualized['agi'], annualized_qbi=annualized['qbi'], annualized_taxable_income=annualized['taxable_income'],
                         annualized_income_tax=annualized['income_tax'], annualized_se_tax=r(part_ii_se), annualized_total_tax=r(total_exact),
                         required_cumulative=r(line21), annualized_installment=r(line23), regular_installment=r(line24),
                         regular_with_recapture=r(line26), required_installment=r(line27), used_annualized=line23 < line26, required_installment_exact=line27))
        cum_27 += line27; prev_26 = line26; prev_27 = line27
    return rows

# ---------------------------------------------------------------- scenarios
res = {}

def main():
    due = P['installment_due']; rates = P['underpayment_rates']; ret = P['return_due']

    # ── seasonal: single, Sch C "Ortiz Holiday Decor", Q4-heavy ──────────────────────────────────────────
    monthly = [2000, 2000, 4000, 6000, 8000, 10000, 10000, 10000, 14000, 30000, 40000, 44000]       # tax-basis Sch C profit by month
    cum = lambda m: float(sum(monthly[:m]))
    col = lambda m: dict(se_businesses=[dict(profit=cum(m))])
    full = form_1040('single', **col(12))
    sh = safe_harbor(full['federal_total'], prior_tax=50000, prior_agi=140000, fs='single', withholding=0)     # 100% prior > 90% current → current rule
    ai = schedule_ai([col(3), col(5), col(8), col(12)], sh['required_exact'], full['federal_total_exact'], 'single', form_1040)
    req = [row['required_installment_exact'] for row in ai]
    assert all(ai[i]['used_annualized'] for i in range(3)) and not ai[3]['used_annualized'], 'seasonal design: columns (a)-(c) annualized, (d) recaptured'
    assert abs(sum(req) - sh['required_exact']) < 1e-6, 'Σ line 27 = required annual payment (full recapture)'
    paid_on_time = [math.ceil(x) for x in req]                                                                  # pay each required installment (rounded up) on its due date
    rows_ok, pen_ok = penalty_schedule(req, due, 0.0, list(zip(due, paid_on_time)), rates, ret)
    rows_late, pen_late = penalty_schedule(req, due, 0.0, [(due[3], float(math.ceil(sum(req))))], rates, ret)   # nothing until Jan 15, 2027
    res['seasonal'] = dict(monthly_sch_c_profit=monthly, cumulative=dict(months_3=cum(3), months_5=cum(5), months_8=cum(8), months_12=cum(12)), federal=full,
                           safe_harbor=sh, schedule_ai=[{k: v for k, v in row.items() if k != 'required_installment_exact'} for row in ai],
                           required_installments=[r(x) for x in req], paid_annualized_on_time=dict(payments=paid_on_time, penalty_by_installment=rows_ok, penalty_total=pen_ok),
                           paid_all_on_jan_15=dict(payment=math.ceil(sum(req)), penalty_by_installment=rows_late, penalty_total=pen_late,
                                                   q4_catch_up_before_payment=r(sum(req))),
                           note=('Form 2210 Schedule AI: income is 8,000 / 22,000 / 52,000 through Mar 31 / May 31 / Aug 31 of 180,000, so columns (a)-(c) '
                                 'annualize to 32,000 / 52,800 / 78,000 and each annualized installment is below the regular 25%; column (d) recaptures the '
                                 'skipped regular amounts (line 25 = previous 26 - previous 27). The §199A deduction hits the 20%-of-taxable-income limit in every column.'))

    # ── late_payments: pure ledger case (any taxpayer with tax 40,000, prior 36,000 / AGI 120,000, withholding 8,000) ──
    sh2 = safe_harbor(40000, prior_tax=36000, prior_agi=120000, fs='mfj', withholding=8000)
    pays = [(date(2026,4,15), 5000.0), (date(2026,6,15), 7000.0), (date(2026,8,1), 2000.0), (date(2027,2,1), 7000.0), (date(2027,3,1), 7000.0)]
    rows2, pen2 = penalty_schedule([sh2['required_exact'] / 4] * 4, due, 2000.0, pays, rates, ret)
    res['late_payments'] = dict(current_year_tax=40000, withholding=8000, prior_year=dict(tax=36000, agi=120000), safe_harbor=sh2,
                                payments=[dict(date=d.isoformat(), amount=a) for d, a in pays], penalty_by_installment=rows2, penalty_total=pen2,
                                expected_timeline=('Q1 9,000 − 2,000 withholding − 5,000 = 2,000 short Apr 15; the Jun 15 withholding share cures Q1 (earliest unpaid) so Q2 is 2,000 short '
                                                   'until Aug 1 (15 days at 6% to Jun 30, then 32 days at 7%); Q3 7,000 short Sep 15, reduced to 5,000 by the Jan 15 withholding share, '
                                                   'cured Feb 1 (legs split at Sep 30 and Dec 31, all 7%); Q4 9,000 short Jan 15, 2,000 paid Feb 1, cured Mar 1.'))

    # ── mfs: Dana Whitfield, married filing separately, born 1958-03-15, lived with spouse ───────────────
    # wages 60,000 incl. 8,000 qualified tips + 5,000 qualified overtime; 3,000 car-loan interest → Schedule 1-A 0 (joint return required);
    # Sch C 30,000; qualified dividends 5,000; LP rental loss −10,000 with active participation → fully suspended (§469(i)(5)(B)); 1,500 cash gifts.
    mfs = form_1040('mfs', wages=60000, se_businesses=[dict(profit=30000.0)], qualified_dividends=5000, rental=0.0, suspended_passive_loss=10000,
                    seniors=1, charitable_cash_nonitemizer=1500)
    mfs['sch1a_inputs'] = dict(qualified_tips=8000, qualified_overtime=5000, car_loan_interest=3000, age=68, allowed=0,
                               rule='§151(d)(5)(C)(v), §224(f), §225(e), §163(h)(4)(F): a married taxpayer must file jointly — MFS gets no Schedule 1-A deduction')
    mfs['rental_loss_input'] = -10000
    res['mfs'] = dict(federal=mfs, safe_harbor=safe_harbor(mfs['federal_total'], prior_tax=12000, prior_agi=80000, fs='mfs', withholding=6000),
                      note='MFS: 16,100 standard + 1,650 (65, married) + 1,000 non-itemizer charitable; QD 5,000 all at 15% (ordinary income already above the 49,450 zero-rate amount); '
                           'the MFS high-AGI test uses 75,000 so the prior-year harbor is 110%; Additional Medicare / NIIT thresholds 125,000 not reached.')

    # ── high_income_mfj: the Patels ─────────────────────────────────────────────────────────────────────
    # Raj: Sch C manufacturing 300,000 (W-2 wages paid 60,000, UBIA 700,000), SEP contribution 60,000. Priya: S corp law practice (SSTB) — officer wages
    # 200,000, K-1 ordinary 150,000, 100% owner, active. Portfolio: interest 20,000, qualified dividends 40,000, LTCG 150,000. Passive LP rental +30,000.
    # Itemized: SALT 60,000, mortgage interest 25,000, cash charity 50,000. Withholding 60,000. Prior year: tax 150,000, AGI 700,000.
    hi = form_1040('mfj', officer_wages=200000, se_businesses=[dict(profit=300000.0, w2=60000.0, ubia=700000.0)], passthrough=[dict(ordinary=150000.0, sstb=True, active=True)],
                   interest=20000, qualified_dividends=40000, ltcg=150000, rental=30000, sep=60000, itemized=dict(salt=60000, mortgage=25000, charity=50000, other=0.0))
    assert hi['deduction_chosen'] == 'itemized' and hi['itemized']['sec68_reduction'] > 0 and hi['worksheet']['taxed_at_twenty'] > 0 and hi['worksheet']['taxed_at_fifteen'] > 0
    res['high_income_mfj'] = dict(federal=hi, safe_harbor=safe_harbor(hi['federal_total'], prior_tax=150000, prior_agi=700000, fs='mfj', withholding=60000),
                                  note='SALT cap at the 10,000 floor (MAGI far above 505,000); §68: 2/37 × lesser(itemized 80,912, (AGI − QBI) − 768,700); §199A fully phased in — Sch C limited '
                                       'to max(50% × 60,000, 25% × 60,000 + 2.5% × 700,000) = 32,500, the SSTB S corp excluded; SEP capped at 20% × (300,000 − ½ SE); QD + LTCG 190,000 split '
                                       'at the 613,700 breakpoint (15% / 20%); Additional Medicare on NESE above 250,000 − 200,000 wages; NIIT on 240,000 of investment income.')

    # ── itemizer_salt: the Nguyens ──────────────────────────────────────────────────────────────────────
    # Linh: Sch C design studio 300,000 (W-2 60,000, UBIA 100,000), SEHI 12,000 all months deductible. Tuan: outside W-2 wages 250,000, withholding 45,000.
    # Interest 3,000. Itemized: SALT 45,000, mortgage 18,000, cash charity 20,000. Prior year: tax 100,000, AGI 400,000.
    it = form_1040('mfj', wages=250000, wages_are_spouses=True, se_businesses=[dict(profit=300000.0, w2=60000.0, ubia=100000.0)], interest=3000, sehi=12000,
                   itemized=dict(salt=45000, mortgage=18000, charity=20000, other=0.0))
    assert it['deduction_chosen'] == 'itemized' and 0 < it['qbi_components'][0]['phase_in'] < 1 and it['itemized']['sec68_reduction'] == 0
    assert P['salt']['standard']['floor'] < it['itemized']['salt_cap'] < P['salt']['standard']['cap']
    res['itemizer_salt'] = dict(federal=it, safe_harbor=safe_harbor(it['federal_total'], prior_tax=100000, prior_agi=400000, fs='mfj', withholding=45000),
                                note='SALT cap = 40,400 − 30% × (AGI − 505,000); charity less 0.5% of AGI; §199A phase-in fraction = (TI before QBI − 403,500) ÷ 150,000, the excess of 20% × QBI '
                                     'over max(50% W-2, 25% W-2 + 2.5% UBIA) phased in by that fraction; SEHI (12,000) and ½ SE are attributable deductions of the Sch C.')

    print(json.dumps(res, indent=2))
    json.dump(res, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scenarios_expected.json'), 'w'), indent=2)

if __name__ == '__main__':
    main()
