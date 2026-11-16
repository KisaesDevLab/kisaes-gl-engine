// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Review S5 (ClientLedger P29): 1099 amounts are summed and compared with the
// threshold as exact decimals. A vendor whose boxes total exactly the
// threshold is over it; float addition put 512.04 + 0.29 + 87.67 at
// 599.9999999999999 and left such a vendor out of the summary tile, the
// threshold scanner and the filing.

import { describe, it, expect } from 'vitest';
import { meets1099Threshold, sum1099 } from './portal-1099.service.js';
import { decodeVendorStatus } from './portal-1099.status.js';

describe('1099 thresholds compared exactly (S5)', () => {
  it('three box totals that make exactly 600.00 meet a 600 threshold', () => {
    const boxes = [512.04, 0.29, 87.67];
    expect(boxes.reduce((s, t) => s + t, 0)).toBeLessThan(600); // the float bug this replaces
    expect(sum1099(boxes)).toBe(600);
    expect(meets1099Threshold(sum1099(boxes), '600.00')).toBe(true);
    expect(meets1099Threshold(599.99, '600')).toBe(false);
    expect(meets1099Threshold('600.0000', 600)).toBe(true);
  });

  it('the status pill uses the same exact rule (blocked at the threshold, warning at 80%)', () => {
    const base = { is1099Eligible: true, w9OnFile: false, exclusionReason: null };
    expect(decodeVendorStatus({ ...base, ytdTotal: sum1099([512.04, 0.29, 87.67]), necThreshold: '600.00' })).toBe('blocked');
    expect(decodeVendorStatus({ ...base, ytdTotal: 480, necThreshold: '600' })).toBe('warning');
    expect(decodeVendorStatus({ ...base, ytdTotal: 479.99, necThreshold: '600' })).toBe('compliant');
  });
});
