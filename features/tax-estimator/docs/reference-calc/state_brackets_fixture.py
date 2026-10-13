# Copyright 2026 Kisaes LLC
# Licensed under the PolyForm Small Business License 1.0.0.
# Free for small businesses; see LICENSE for terms.
"""Reference calculator (test oracle) for the state rate schedules and capital gains (OPEN-QUESTIONS Q53) — tax year 2025.

Independent of the app engine (nothing under packages/ is imported). Run:
    python3 -I state_brackets_fixture.py
Prints the expected values and rewrites state_brackets_expected.json next to this file.
`npm run test:tax-oracle` regenerates every oracle file and fails when the committed JSON differs.
The engine golden test that reads this file is
packages/shared/src/tax-estimator/engine/oracle.state-brackets.golden.test.ts.

Two married-filing-jointly Missouri residents, tax year 2025, no business income:

Scenario `mo_resident_ks_ar` — W-2 wages 80,000 (40,000 each), qualified dividends 4,000, net short-term gain 3,000,
  net long-term gain 60,000 of which unrecaptured §1250 gain 15,000 and collectibles gain 5,000 (the 25% / 28% buckets
  end up taxed at ordinary rates: the Schedule D Tax Worksheet only charges 25% / 28% above the 24% bracket).
  Nonresident income: Kansas 40,000 and Arkansas 20,000 (entered), both states use the ratio method.
Scenario `mo_high_buckets` — wages 600,000 (300,000 each), net long-term gain 200,000 of which unrecaptured §1250
  gain 60,000 and collectibles gain 30,000 (both buckets taxed at 25% / 28%); Arkansas nonresident income 100,000.

Federal (2025): Form 1040 with the standard deduction 31,500 (MFJ, P.L. 119-21 §70102), 2025 brackets (Rev. Proc.
  2024-40 §3.01 Table 1: 10% to 23,850; 12% to 96,950; 22% to 206,700; 24% to 394,600; 32% to 501,050; 35% to
  751,600; 37%), the Schedule D Tax Worksheet (2025 Instructions for Schedule D, lines 1-47; MFJ thresholds line 15
  96,700, line 19 394,600, line 26 600,050), Additional Medicare 0.9% over 250,000 (Form 8959), NIIT 3.8% (Form 8960).
  Federal income tax for the Missouri deduction = regular tax (no credits) — MO-1040 line 9 (1040 line 22).

Missouri (resident; 2025 MO-1040 and instructions, RSMo 143.121 / 143.131 / 143.171):
  MO AGI = federal AGI − 100% of the net capital gain (MO-A line 18 = 1040 line 7a, HB 594 (2025));
  federal tax deduction = tax × % by MO AGI (35% ≤ 25,000 / 25% ≤ 50,000 / 15% ≤ 100,000 / 5% ≤ 125,000 / 0%), max
  10,000 married combined (MO-1040 lines 9-13, RSMo 143.171);
  standard deduction 31,500 (= federal, MO-1040 line 14); no personal exemptions (RSMo 143.151 / 143.161, federal §151 = 0);
  tax = 2025 tax rate chart: 0% to 1,313, then 2%, 2.5%, 3%, 3.5%, 4%, 4.5% per 1,313 band, 4.7% over 9,191;
  credit for tax paid to other states (Form MO-CR): min(other-state tax, MO tax × other-state income ÷ MO AGI).
Kansas (nonresident, K-40 2025 + Schedule S Part B): tax as a resident on all income × Kansas income ÷ federal AGI;
  KS taxable income = federal AGI − standard deduction 8,240 (MFJ) − exemption 18,320 (MFJ); 5.2% to 46,000, 5.58% above.
Arkansas (nonresident, AR1000NR 2025 lines 38A-38D): tax on all income × Arkansas income ÷ total income (federal AGI);
  AR net taxable income = federal AGI − 50% of the net long-term gain (AR1000D line 8; the excess over 10,000,000 is
  fully exempt) − standard deduction 4,940 (MFJ); tax from the 2025 tax table formula: income over 100,000 = 3,809 +
  3.9% of the excess; less the personal tax credits 58 (two boxes × 29, AR1000F line 7A).
The Arkansas and Kansas nonresident figures use the engine's denominator (federal AGI) — MODULE.md State calculation.
"""
import json, math, os, sys
sys.dont_write_bytecode = True

def r(x): return int(math.floor(x + 0.5))

FED_BRACKETS_MFJ = [(0, .10), (23850, .12), (96950, .22), (206700, .24), (394600, .32), (501050, .35), (751600, .37)]
STD_MFJ = 31500
WS = dict(l15=96700, l19=394600, l26=600050)

def marginal(x, brackets):
    t = 0.0
    for i, (lo, rate) in enumerate(brackets):
        hi = brackets[i + 1][0] if i + 1 < len(brackets) else None
        if x <= lo: break
        t += ((x if hi is None else min(x, hi)) - lo) * rate
    return t

def fed_tax(x): return marginal(x, FED_BRACKETS_MFJ)

def schedule_d_worksheet(ti, qd, d15, d16, d18_collectibles, d19_unrecaptured):
    l1 = ti; l2 = qd; l6 = l2
    l7 = min(d15, d16); l9 = l7; l10 = l6 + l9
    l11 = d18_collectibles + d19_unrecaptured
    l12 = min(l9, l11); l13 = l10 - l12; l14 = max(0, l1 - l13)
    l16 = min(l1, WS['l15']); l17 = min(l14, l16); l18 = max(0, l1 - l10)
    l19 = min(l1, WS['l19']); l20 = min(l14, l19); l21 = max(l18, l20)
    l22 = l16 - l17
    l23 = min(l1, l13); l24 = l22; l25 = max(0, l23 - l24)
    l27 = min(l1, WS['l26']); l28 = l21 + l22; l29 = max(0, l27 - l28); l30 = min(l25, l29); l31 = l30 * .15
    l32 = l24 + l30; l33 = l23 - l32; l34 = l33 * .20
    l35 = min(l9, d19_unrecaptured); l36 = l10 + l21; l38 = max(0, l36 - l1); l39 = max(0, l35 - l38); l40 = l39 * .25
    l41 = l21 + l22 + l30 + l33 + l39; l42 = l1 - l41; l43 = l42 * .28
    l44 = fed_tax(l21); l45 = l31 + l34 + l40 + l43 + l44; l46 = fed_tax(l1)
    return dict(tax=min(l45, l46), ordinary_portion=l21, at_zero=l22, at_fifteen=l30, at_twenty=l33, at_twenty_five=l39, at_twenty_eight=l42)

MO_CHART = [(0, 0), (1313, .02), (2626, .025), (3939, .03), (5252, .035), (6565, .04), (7878, .045), (9191, .047)]
MO_FTD = [(0, .35), (25000, .25), (50000, .15), (100000, .05), (125000, 0.0)]
MO_FTD_CAP_COMBINED = 10000
KS = dict(brackets=[(0, .052), (46000, .0558)], std=8240, exemption=18320)
AR = dict(std=4940, credits=58, over_100k_base=3809, top=.039)

def ar_table(nti):
    assert nti > 100000, 'the oracle scenarios use the AR over-$100,000 rule'
    return AR['over_100k_base'] + AR['top'] * (nti - 100000)

def scenario(*, wages, qd, stcg, ltcg, u1250, collectibles, ks_income, ar_income):
    net_gain = stcg + ltcg
    agi = wages + qd + net_gain
    ti = agi - STD_MFJ
    ws = schedule_d_worksheet(ti, qd, ltcg, net_gain, collectibles, u1250)
    regular = ws['tax']
    addl = .009 * max(0, wages - 250000)
    niit = .038 * min(qd + net_gain, max(0, agi - 250000))
    federal_total = regular + addl + niit
    # Kansas nonresident: ratio of the as-if-resident tax.
    ks = None
    if ks_income:
        ks_ti = max(0, agi - KS['std'] - KS['exemption'])
        ks_full = marginal(ks_ti, KS['brackets'])
        ks_ratio = ks_income / agi
        ks = dict(taxable_income=ks_ti, full_year_tax=ks_full, ratio=ks_ratio, tax=ks_full * ks_ratio)
    # Arkansas nonresident.
    ar_excl = .5 * min(ltcg, net_gain)
    ar_ti = agi - ar_excl - AR['std']
    ar_full = ar_table(ar_ti) - AR['credits']
    ar_ratio = ar_income / agi
    ar = dict(capital_gain_exclusion=ar_excl, taxable_income=ar_ti, full_year_tax=ar_full, ratio=ar_ratio, tax=ar_full * ar_ratio)
    # Missouri resident.
    mo_agi = agi - net_gain
    pct = [p for lo, p in MO_FTD if mo_agi > lo or lo == 0][-1]
    ftd = min(regular * pct, MO_FTD_CAP_COMBINED)
    mo_ti = max(0, mo_agi - ftd - STD_MFJ)
    mo_tax = marginal(mo_ti, MO_CHART)
    credits = {}
    for name, other in (('KS', ks), ('AR', ar)):
        if other is None: continue
        income = ks_income if name == 'KS' else ar_income
        limit = mo_tax * min(1.0, income / mo_agi)
        credits[name] = dict(limit=limit, allowed=min(other['tax'], limit))
    credit = min(sum(c['allowed'] for c in credits.values()), mo_tax)
    out = dict(
        federal=dict(agi=r(agi), taxable_income=r(ti), regular_tax=r(regular), federal_income_tax=r(regular), addl_medicare=r(addl), niit=r(niit), federal_total=r(federal_total),
                     worksheet={k: r(v) for k, v in ws.items() if k != 'tax'}),
        MO=dict(capital_gain_exclusion=r(net_gain), mo_agi=r(mo_agi), federal_tax_deduction_pct=pct, federal_tax_deduction=r(ftd), standard_deduction=STD_MFJ,
                taxable_income=r(mo_ti), gross_tax=r(mo_tax), credits={k: dict(limit=r(v['limit']), allowed=r(v['allowed'])) for k, v in credits.items()},
                credit=r(credit), net_tax=r(mo_tax - credit)),
        AR={k: (round(v, 6) if k == 'ratio' else r(v)) for k, v in ar.items()},
    )
    if ks: out['KS'] = {k: (round(v, 6) if k == 'ratio' else r(v)) for k, v in ks.items()}
    out['state_total'] = r(mo_tax - credit + (ks['tax'] if ks else 0) + ar['tax'])
    return out

def main():
    res = {}
    a = scenario(wages=80000.0, qd=4000.0, stcg=3000.0, ltcg=60000.0, u1250=15000.0, collectibles=5000.0, ks_income=40000.0, ar_income=20000.0)
    assert a['federal']['worksheet']['at_twenty_five'] == 0 and a['federal']['worksheet']['at_twenty_eight'] == 0, 'design: buckets below the 24% bracket'
    assert a['MO']['federal_tax_deduction_pct'] == .15, 'design: MO AGI in the 15% tier'
    res['mo_resident_ks_ar'] = a
    b = scenario(wages=600000.0, qd=0.0, stcg=0.0, ltcg=200000.0, u1250=60000.0, collectibles=30000.0, ks_income=0.0, ar_income=100000.0)
    assert b['federal']['worksheet']['at_twenty_five'] > 0 and b['federal']['worksheet']['at_twenty_eight'] > 0, 'design: both buckets taxed at 25% / 28%'
    res['mo_high_buckets'] = b
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'state_brackets_expected.json')
    with open(path, 'w') as f: json.dump(res, f, indent=2, sort_keys=True); f.write('\n')
    print(json.dumps(res, indent=2, sort_keys=True))

if __name__ == '__main__':
    main()
