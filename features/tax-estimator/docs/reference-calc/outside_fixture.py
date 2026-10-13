# Copyright 2026 Kisaes LLC
# Licensed under the PolyForm Small Business License 1.0.0.
# Free for small businesses; see LICENSE for terms.
"""Reference calculator (test oracle) for businesses OUTSIDE MyBooks (OPEN-QUESTIONS Q45) — tax year 2026.

Independent of the app engine (nothing under packages/ is imported). Run:
    python3 -I outside_fixture.py
Prints the expected values and rewrites outside_expected.json next to this file.
`npm run test:tax-oracle` regenerates every oracle file and fails when the committed JSON differs.
The engine golden test that reads this file is
packages/shared/src/tax-estimator/engine/oracle.outside.golden.test.ts.

Scenario `outside_mix` — the Okonkwos, MFJ, 2026, no wages, standard deduction:
  Maya (primary):
    * a LINKED Schedule C in MyBooks, books closed through September: YTD profit 90,000 (all recurring)
      -> projected 90,000 + 90,000 / 9 x 3 = 120,000 (MODULE.md "Projection").
    * an OUTSIDE partnership K-1, entered as the owner's share (25% stated, informational), full-year amounts:
      ordinary 60,000, interest 2,000, qualified dividends 3,000, long-term capital gain 10,000.
      Limited partner, passive activity: not SE income (§1402(a)(13)); ordinary IS QBI (§199A needs no
      material participation); passive ordinary, interest, dividends and gains are net investment income
      (§1411(c)(1)(A)(ii) / (c)(2)(A)).
  Leo (spouse):
    * an OUTSIDE Schedule C entered year to date through June: profit 45,000, entity total at 100%
      -> projected 45,000 + 45,000 / 6 x 6 = 90,000 (same run-rate rule as a linked business).
  Federal: Schedule SE per spouse (no W-2 wages, so the full 2026 wage base 184,500 is open), half SE tax above the
  line, §199A below the 403,500 MFJ threshold (20% x QBI per business, QBI of each Sch C = profit - the owner's half
  SE tax (Reg. 1.199A-3(b)(1)(vi)), then the 20% x (taxable income before QBI - net capital gain incl. qualified
  dividends) overall limit), the QD / LTCG worksheet, Form 8959 (NESE under 250,000 -> 0), Form 8960 NIIT
  (3.8% x min(NII, MAGI - 250,000)).
"""
import json, os, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rivera_fixture import r
from scenarios_fixture import P, se_tax, qbi_component, qd_ltcg_tax, addl_medicare, niit

FS = 'mfj'
MONTHS = 12

def project(ytd, months_elapsed):
    """YTD + YTD / months elapsed x months remaining (every amount recurring)."""
    return ytd + ytd / months_elapsed * (MONTHS - months_elapsed)

def scenario(*, linked_ytd, linked_through, k1, leo_ytd, leo_through):
    maya_schc = project(linked_ytd, linked_through)
    leo_schc = project(leo_ytd, leo_through)
    se_maya = se_tax(maya_schc)
    se_leo = se_tax(leo_schc)
    k1_ordinary = k1['ordinary']                                # owner share: 100% of the entered amount, not x 25%
    assert k1_ordinary > 0, 'the oracle keeps the passive K-1 profitable (no §469 suspension)'
    ltcg = max(0.0, k1['ltcg'])
    total_income = maya_schc + leo_schc + k1_ordinary + k1['interest'] + k1['qualified_dividends'] + ltcg
    agi = total_income - se_maya['half'] - se_leo['half']
    deduction = P['std'][FS]
    ti_before_qbi = agi - deduction
    comps = [
        qbi_component(maya_schc - se_maya['half'], 0.0, None, ti_before_qbi, FS),
        qbi_component(leo_schc - se_leo['half'], 0.0, None, ti_before_qbi, FS),
        qbi_component(k1_ordinary, 0.0, None, ti_before_qbi, FS),
    ]
    assert all(c['phase_in'] == 0 for c in comps), 'design: below the §199A threshold'
    combined = sum(c['component'] for c in comps)
    net_cg_with_qd = ltcg + k1['qualified_dividends']
    overall = P['qbi_ti_limit'] * max(0.0, ti_before_qbi - net_cg_with_qd)
    qbi = min(combined, overall)
    ti = max(0.0, ti_before_qbi - qbi)
    tax = qd_ltcg_tax(ti, net_cg_with_qd, FS)['tax']
    se_total = se_maya['se'] + se_leo['se']
    addl = addl_medicare(0.0, se_maya['nese'] + se_leo['nese'], FS)
    nii = k1['interest'] + k1['qualified_dividends'] + ltcg + k1_ordinary
    niit_tax = niit(nii, agi, FS)
    total = tax + se_total + addl + niit_tax
    return dict(
        projected=dict(linked_schc=r(maya_schc), outside_schc=r(leo_schc), outside_k1_share=r(k1_ordinary + k1['interest'] + k1['qualified_dividends'] + ltcg)),
        federal=dict(total_income=r(total_income), agi=r(agi), taxable_income=r(ti), income_tax=r(tax), se_tax=r(se_total), qbi=r(qbi),
                     qbi_components=[r(c['component']) for c in comps], addl_medicare=r(addl), nii=r(nii), niit=r(niit_tax)),
        se=dict(maya=r(se_maya['se']), leo=r(se_leo['se'])),
        federal_total=r(total), federal_total_exact=total,
    )

def main():
    res = {}
    mix = scenario(linked_ytd=90000.0, linked_through=9,
                   k1=dict(ordinary=60000.0, interest=2000.0, qualified_dividends=3000.0, ltcg=10000.0),
                   leo_ytd=45000.0, leo_through=6)
    assert mix['federal']['niit'] > 0, 'design: MAGI over 250,000 so the passive K-1 reaches NIIT'
    res['outside_mix'] = mix
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'outside_expected.json')
    with open(path, 'w') as f: json.dump(res, f, indent=2, sort_keys=True); f.write('\n')
    print(json.dumps(res, indent=2, sort_keys=True))

if __name__ == '__main__':
    main()
