# Copyright 2026 Kisaes LLC
# Licensed under the PolyForm Small Business License 1.0.0.
# Free for small businesses; see LICENSE for terms.
"""Reference calculator (test oracle) for the PRIOR-YEAR TREND projection methods (OPEN-QUESTIONS Q46) — tax year 2026.

Independent of the app engine (nothing under packages/ is imported). Run:
    python3 -I pytrend_fixture.py
Prints the expected values and rewrites pytrend_expected.json next to this file.
`npm run test:tax-oracle` regenerates every oracle file and fails when the committed JSON differs.
The engine golden test that reads this file is
packages/shared/src/tax-estimator/engine/oracle.pytrend.golden.test.ts.

Scenario `seasonal` — the Delgados, MFJ, 2026, no wages, standard deduction; Ana owns a seasonal Schedule C
(a landscaping business: thin winters, heavy autumn). Books closed through September 2026:
  * ordinary YTD 140,000, of which 10,000 is a one-off (non-recurring) item -> recurring YTD 130,000.
  * prior year 2025 recurring ordinary by month (non-recurring excluded), every month with activity:
        Jan-Sep 100,000 (the "same months"), Oct-Dec 80,000 (the "remaining months"), full year 180,000.
  Projection of ORDINARY income (MODULE.md "Projection", Q46):
    run_rate           140,000 + 130,000 / 9 x 3
    prior_year_scaled  140,000 + 80,000 x (130,000 / 100,000)   (factor 1.3, inside the [0.25, 4] cap)
    prior_year_dollar  140,000 + 80,000
  Scenario `capped_min`: same prior year, a weak current year: YTD 20,000 all recurring -> factor 0.2, capped at
  0.25 -> 20,000 + 80,000 x 0.25.
  Federal per method: Schedule SE (no W-2 wages, full 184,500 base), half SE tax above the line, §199A below the
  403,500 MFJ threshold (20% x (profit - half SE), then the 20% x taxable-income overall limit), 2026 MFJ brackets,
  Form 8959 (NESE under 250,000 -> 0), no NIIT (no investment income).
"""
import json, os, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rivera_fixture import r
from scenarios_fixture import form_1040

FS = 'mfj'
MONTHS = 12
CAP = (0.25, 4.0)            # projection policy bounds (projection-method.ts), not tax parameters
MIN_SAME_SHARE = 0.10

PY_MONTHLY = [5000, 5000, 10000, 10000, 10000, 15000, 15000, 15000, 15000, 30000, 30000, 20000]

def project(method, ytd, recurring, through, py_monthly):
    """Ordinary projection under one method; returns (projected, factor, capped, fallback)."""
    run_rate = ytd + recurring / through * (MONTHS - through)
    if method == 'run_rate':
        return run_rate, None, None, None
    same = sum(py_monthly[:through]); remaining = sum(py_monthly[through:]); full = same + remaining
    if method == 'prior_year_dollar':
        return ytd + remaining, None, None, None
    if same <= 0: return run_rate, None, None, 'py_same_months_not_positive'
    if abs(same) < MIN_SAME_SHARE * abs(full): return run_rate, None, None, 'py_same_months_small'
    if recurring <= 0: return run_rate, None, None, 'cy_recurring_not_positive'
    raw = recurring / same
    factor = min(CAP[1], max(CAP[0], raw))
    capped = 'min' if raw < CAP[0] else 'max' if raw > CAP[1] else None
    return ytd + remaining * factor, factor, capped, None

def scenario(method, *, ytd, recurring, through=9):
    projected, factor, capped, fallback = project(method, ytd, recurring, through, PY_MONTHLY)
    run_rate, _, _, _ = project('run_rate', ytd, recurring, through, PY_MONTHLY)
    f = form_1040(FS, se_businesses=[dict(profit=projected)])
    return dict(
        projected_ordinary=r(projected), run_rate_ordinary=r(run_rate), factor=None if factor is None else round(factor, 4), capped=capped, fallback=fallback,
        py=dict(same_months=r(sum(PY_MONTHLY[:through])), remaining=r(sum(PY_MONTHLY[through:])), full_year=r(sum(PY_MONTHLY))),
        federal=dict(total_income=f['total_income'], agi=f['agi'], se_tax=f['se_tax'], qbi=f['qbi'], taxable_income=f['taxable_income'], income_tax=f['income_tax']),
        federal_total=f['federal_total'], federal_total_exact=f['federal_total_exact'],
    )

def main():
    res = {}
    for m in ('run_rate', 'prior_year_scaled', 'prior_year_dollar'):
        res[f'seasonal_{m}'] = scenario(m, ytd=140000.0, recurring=130000.0)
    assert res['seasonal_prior_year_scaled']['factor'] == 1.3
    res['capped_min'] = scenario('prior_year_scaled', ytd=20000.0, recurring=20000.0)
    assert res['capped_min']['capped'] == 'min'
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pytrend_expected.json')
    with open(path, 'w') as fh: json.dump(res, fh, indent=2, sort_keys=True); fh.write('\n')
    print(json.dumps(res, indent=2, sort_keys=True))

if __name__ == '__main__':
    main()
