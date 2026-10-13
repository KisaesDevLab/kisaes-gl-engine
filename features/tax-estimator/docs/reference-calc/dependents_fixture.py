# Copyright 2026 Kisaes LLC
# Licensed under the PolyForm Small Business License 1.0.0.
# Free for small businesses; see LICENSE for terms.
"""Reference calculator (test oracle) for the dependent credits (OPEN-QUESTIONS Q44) — tax year 2026.

Independent of the app engine (nothing under packages/ is imported). Run:
    python3 -I dependents_fixture.py
Prints the expected values and rewrites dependents_expected.json next to this file.
`npm run test:tax-oracle` regenerates every oracle file and fails when the committed JSON differs.
The engine golden test that reads this file is
packages/shared/src/tax-estimator/engine/oracle.dependents.golden.test.ts.

Scenario `dependents_phaseout` — the Okafors, MFJ, 2026:
  Chidi: Schedule C profit 380,000. Ada: W-2 wages 60,000. No other income.
  Dependents: Tobi (born 2016-03-10, age 10 at Dec 31, 2026), Zara (born 2011-07-01, age 15), Ike (born 2008-02-20, age 18,
  full-time student). Child-care expenses paid for Tobi: 7,000.
  -> MAGI ~423k is inside the §24(b) phase-out (400,000 MFJ); §21 rate falls to the 20% floor (2026 OBBBA second step).
Scenario `dependents_low_income` — the Okafors' low-income variant: wages 17,000 each (34,000), same dependents,
  care expenses 4,000 -> care credit limited by the tiny regular tax, CTC / ODC unused, ACTC by the 1,700-per-child cap.
Each scenario also figures two state rows from the shipped 2026 `exemptions` seed values: a GA resident row (dependent
exemption 5,000 each off federal AGI, effective rate 5%) and an AR resident row (personal credits 58 MFJ + 29 per
dependent off the tax, effective rate 3.9%).

Federal arithmetic:
  Form 1040 lines from scenarios_fixture.form_1040 with credits = 0 (batch-1 oracle, Form 1040 order).
  Schedule 8812 (2025 form; 2026 amounts from Rev. Proc. 2025-32 §4.05):
    line 4  qualifying children under 17 (§24(c)(1)): age = 2026 − birth year (attained on the anniversary, Rev. Rul. 2003-72)
    line 5  4 × 2,200            line 6/7 other dependents × 500 (§24(h)(4))
    line 9-12 MAGI − 400,000 rounded UP to a multiple of 1,000, × 5% (= $50 per $1,000 or fraction, §24(b))
    line 14 Credit Limit Worksheet A: regular tax − Form 2441 credit (the care credit is taken first)
    line 16a unused = line 12 − line 14; 16b children × 1,700; 17 = smaller; 18a earned income;
    line 19-20 15% × (earned income − 2,500); line 27 ACTC = smaller of 17 and 20 (Part II-B not used: < 3 children)
    earned income = wages + Schedule SE net profit − ½ SE tax (8812 earned-income worksheet as approximated in Q44)
  Form 2441 / §21 (2026, P.L. 119-21 §70405): qualifying persons = children under 13 (Tobi only);
    expenses ≤ 3,000 (one person) and ≤ the lower-earning spouse's earned income;
    applicable % = 50 − ⌈(AGI − 15,000) / 2,000⌉ points, not below 35; then − ⌈(AGI − 150,000) / 4,000⌉ points (joint), not below 20.
  Federal total = regular tax − care − CTC/ODC + SE tax + Additional Medicare + NIIT − ACTC.
"""
import json, math, os, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rivera_fixture import r
from scenarios_fixture import form_1040, se_tax

TAX_YEAR = 2026
# 2026 parameters (Rev. Proc. 2025-32 §4.05, §24 as amended by P.L. 119-21 §70104, §21 as amended by §70405)
C = dict(ctc=2200, actc_cap=1700, odc=500, phaseout_mfj=400000, step=1000, per_step=50, floor=2500, rate=0.15, ctc_age=17,
         care_age=13, care_limit_one=3000, care_limit_two=6000, care_max=50, care_p1_start=15000, care_p1_step=2000, care_p1_min=35,
         care_p2_start_mfj=150000, care_p2_step_mfj=4000, care_p2_min=20)
DEPENDENTS = [dict(name='Tobi', dob='2016-03-10', kind='qualifying_child', student=False),
              dict(name='Zara', dob='2011-07-01', kind='qualifying_child', student=False),
              dict(name='Ike', dob='2008-02-20', kind='qualifying_child', student=True)]
# 2026 `exemptions` seed values (GA HB 463 dependent exemption 5,000; AR personal tax credits 29 per box).
GA = dict(dependent_exemption=5000, rate=0.05)
AR = dict(personal_credit_mfj=58, dependent_credit=29, rate=0.039)

def age(dob): return TAX_YEAR - int(dob[:4])

def care_pct(agi):
    pct = C['care_max']
    if agi > C['care_p1_start']: pct = max(C['care_p1_min'], pct - math.ceil((agi - C['care_p1_start']) / C['care_p1_step']))
    if agi > C['care_p2_start_mfj']: pct = max(C['care_p2_min'], pct - math.ceil((agi - C['care_p2_start_mfj']) / C['care_p2_step_mfj']))
    return pct / 100

def scenario(*, chidi_profit, ada_wages, chidi_wages, care_expenses):
    fed = form_1040('mfj', wages=ada_wages + chidi_wages, wages_are_spouses=True, se_businesses=[dict(profit=chidi_profit)] if chidi_profit else [], credits=0.0)
    se = se_tax(chidi_profit, chidi_wages) if chidi_profit else dict(se=0.0, half=0.0)
    agi = fed['agi']                                     # rounded AGI is what Schedule 8812 line 3 / Form 2441 line 7 read
    regular = fed['income_tax']
    # earned income per spouse
    earned_chidi = chidi_wages + chidi_profit - se['half']
    earned_ada = ada_wages
    earned = earned_chidi + earned_ada
    ages = {d['name']: age(d['dob']) for d in DEPENDENTS}
    ctc_kids = [d for d in DEPENDENTS if d['kind'] == 'qualifying_child' and ages[d['name']] < C['ctc_age']]
    others = [d for d in DEPENDENTS if d not in ctc_kids]
    care_people = [d for d in DEPENDENTS if ages[d['name']] < C['care_age']]
    # Form 2441
    limit = C['care_limit_one'] if len(care_people) == 1 else C['care_limit_two']
    allowed_exp = min(care_expenses, limit, min(earned_chidi, earned_ada))
    pct = care_pct(agi)
    care_tentative = allowed_exp * pct
    care = min(care_tentative, regular)
    # Schedule 8812
    line5 = len(ctc_kids) * C['ctc']; line7 = len(others) * C['odc']
    excess = max(0, agi - C['phaseout_mfj'])
    reduction = math.ceil(excess / C['step']) * C['per_step'] if excess > 0 else 0
    line12 = max(0, line5 + line7 - reduction)
    line14 = min(line12, regular - care)
    unused = line12 - line14
    by_children = len(ctc_kids) * C['actc_cap']
    by_earned = C['rate'] * max(0.0, earned - C['floor'])
    actc = min(unused, by_children, by_earned) if unused > 0 and ctc_kids else 0.0
    total = regular - care - line14 + fed['se_tax'] + fed['addl_medicare'] + fed['niit'] - actc
    # States (resident rows, effective rate on federal AGI)
    ga_base = agi - GA['dependent_exemption'] * len(DEPENDENTS)
    ga_tax = GA['rate'] * max(0.0, ga_base)
    ar_gross = AR['rate'] * agi
    ar_credits = min(AR['personal_credit_mfj'] + AR['dependent_credit'] * len(DEPENDENTS), ar_gross)
    return dict(
        federal=dict(agi=fed['agi'], taxable_income=fed['taxable_income'], income_tax=fed['income_tax'], se_tax=fed['se_tax'], qbi=fed['qbi'],
                     addl_medicare=fed['addl_medicare'], niit=fed['niit']),
        dependents=[dict(name=d['name'], age=ages[d['name']], ctc=d in ctc_kids, care=d in care_people) for d in DEPENDENTS],
        credits=dict(ctc_children=len(ctc_kids), other_dependents=len(others), ctc_tentative=line5, odc_tentative=line7, phaseout_reduction=reduction,
                     ctc_odc_after_phaseout=line12, care_qualifying=len(care_people), care_expense_limit=limit, care_allowed_expenses=r(allowed_exp),
                     care_rate=pct, care_credit=r(care), ctc_odc_allowed=r(line14), earned_income=r(earned), actc_by_children=by_children,
                     actc_by_earned_income=r(by_earned), actc=r(actc)),
        federal_total=r(total), federal_total_exact=total,
        state=dict(GA=dict(exemptions=GA['dependent_exemption'] * len(DEPENDENTS), net_tax=r(ga_tax)),
                   AR=dict(exemption_credits=ar_credits, net_tax=r(ar_gross - ar_credits))),
    )

def main():
    res = {}
    hi = scenario(chidi_profit=380000.0, ada_wages=60000.0, chidi_wages=0.0, care_expenses=7000.0)
    assert hi['credits']['phaseout_reduction'] > 0 and hi['credits']['care_rate'] == 0.20 and hi['credits']['actc'] == 0, 'design: phase-out, 20% floor, no ACTC'
    res['dependents_phaseout'] = hi
    lo = scenario(chidi_profit=0.0, ada_wages=17000.0, chidi_wages=17000.0, care_expenses=4000.0)
    assert lo['credits']['actc'] == 3400, 'design: ACTC capped at 2 x 1,700'
    res['dependents_low_income'] = lo
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dependents_expected.json')
    with open(path, 'w') as f: json.dump(res, f, indent=2, sort_keys=True); f.write('\n')
    print(json.dumps(res, indent=2, sort_keys=True))

if __name__ == '__main__':
    main()
