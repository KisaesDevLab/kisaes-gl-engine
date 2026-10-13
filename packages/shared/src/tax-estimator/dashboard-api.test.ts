// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import type { PortalTaxJurisdictionDTO } from './portal-api.js';
import { addDaysIso, dashboardJurisdictionFigures, dashboardTotals, isBehind, vouchersDueWithin } from './dashboard-api.js';

const inst = (label: string, dueDate: string, amount: string, paid: string, remaining: string) => ({
  label, dueDate, amount, paid, remaining, status: (Number(remaining) > 0 ? 'unpaid' : 'paid') as 'paid' | 'unpaid', paidOn: null,
});
const fed: PortalTaxJurisdictionDTO = {
  jurisdiction: 'federal', label: 'Federal (IRS)', estimatesRequired: true, nextPayment: null,
  totals: { required: '28000', withholding: '0', estimatesPaid: '13000', remaining: '15000' },
  installments: [
    inst('Q1', '2026-04-15', '7000', '7000', '0'),
    inst('Q2', '2026-06-15', '7000', '6000', '1000'),
    inst('Q3', '2026-09-15', '7000', '0', '7000'),
    inst('Q4', '2027-01-15', '7000', '0', '7000'),
  ],
};
const none: PortalTaxJurisdictionDTO = { jurisdiction: 'AR', label: 'Arkansas', estimatesRequired: false, installments: [], nextPayment: null, totals: { required: '0', withholding: '0', estimatesPaid: '0', remaining: '0' } };

describe('dashboardJurisdictionFigures', () => {
  it('sums the installments due on or before today and picks the next one due today or later', () => {
    const f = dashboardJurisdictionFigures(fed, '2026-09-15', '123.4');
    expect(f.requiredToDate).toBe('21000');
    expect(f.paidToDate).toBe('13000');
    expect(f.shortfall).toBe('8000');
    // Due today counts as due AND as the next voucher.
    expect(f.nextVoucher).toEqual({ label: 'Q3', dueDate: '2026-09-15', amount: '7000', remaining: '7000', status: 'unpaid' });
    expect(f.penalty).toBe('123');
  });

  it('owner audience: no penalty; no vouchers → nothing next, nothing due', () => {
    expect(dashboardJurisdictionFigures(fed, '2026-10-01', null).penalty).toBeNull();
    const n = dashboardJurisdictionFigures(none, '2026-10-01', null);
    expect(n.nextVoucher).toBeNull();
    expect(n.shortfall).toBe('0');
  });

  it('after the last installment there is no next voucher', () => {
    expect(dashboardJurisdictionFigures(fed, '2027-01-16', '0').nextVoucher).toBeNull();
  });
});

describe('dashboardTotals / isBehind', () => {
  it('adds shortfall and penalty across jurisdictions', () => {
    const a = dashboardJurisdictionFigures(fed, '2026-10-01', '50');
    const b = dashboardJurisdictionFigures({ ...fed, jurisdiction: 'MO', label: 'Missouri' }, '2026-10-01', '10');
    expect(dashboardTotals([a, b], true)).toEqual({ shortfall: '16000', penalty: '60' });
    expect(dashboardTotals([a, b], false).penalty).toBeNull();
    expect(isBehind('16000')).toBe(true);
    expect(isBehind('0')).toBe(false);
    expect(isBehind('0.4')).toBe(false);
  });
});

describe('vouchersDueWithin', () => {
  it('includes both ends of the window and skips jurisdictions without vouchers', () => {
    expect(addDaysIso('2026-12-16', 30)).toBe('2027-01-15');
    expect(vouchersDueWithin([fed, none], '2026-12-16', 30).map((v) => v.installment)).toEqual(['Q4']);
    expect(vouchersDueWithin([fed], '2026-12-15', 30)).toEqual([]);
    expect(vouchersDueWithin([fed], '2027-01-15', 30).map((v) => v.installment)).toEqual(['Q4']);
    expect(vouchersDueWithin([fed], '2027-01-16', 30)).toEqual([]);
  });

  it('carries the paid status (paid vouchers are listed too)', () => {
    const v = vouchersDueWithin([fed], '2026-03-20', 30);
    expect(v).toEqual([{ jurisdiction: 'federal', jurisdictionLabel: 'Federal (IRS)', installment: 'Q1', dueDate: '2026-04-15', amount: '7000', remaining: '0', status: 'paid' }]);
  });
});
