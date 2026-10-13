// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { DEFAULT_PORTAL_CONTACT_TAX_OPTIONS, mostRestrictivePortalOptions } from './portal-api.js';

describe('mostRestrictivePortalOptions (Q52 owner card × Q51 options)', () => {
  it('no contacts → the defaults; one contact → its options', () => {
    expect(mostRestrictivePortalOptions([])).toEqual(DEFAULT_PORTAL_CONTACT_TAX_OPTIONS);
    const one = { calculationSummary: true, quarterlyEstimates: false, paymentsOnRecord: true, pdfDownload: false };
    expect(mostRestrictivePortalOptions([one])).toEqual(one);
  });

  it('several contacts → AND of every switch', () => {
    expect(mostRestrictivePortalOptions([
      { calculationSummary: true, quarterlyEstimates: true, paymentsOnRecord: false, pdfDownload: true },
      { calculationSummary: true, quarterlyEstimates: false, paymentsOnRecord: true, pdfDownload: true },
    ])).toEqual({ calculationSummary: true, quarterlyEstimates: false, paymentsOnRecord: false, pdfDownload: true });
  });
});
