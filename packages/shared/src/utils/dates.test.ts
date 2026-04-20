// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.
//
// Pure-function tests for the shared date helpers. Fiscal-year math is
// consulted by the budget, P&L comparative, and tenant-report-settings
// services — an off-by-one here would mis-bucket every report.

import { describe, it, expect } from 'vitest';
import {
  formatDate, getFiscalYearStart, getFiscalYearEnd, toUTC,
} from './dates.js';

describe('formatDate', () => {
  it('formats MM/DD/YYYY by default', () => {
    const d = new Date(2026, 3, 9); // April 9, 2026 (local)
    expect(formatDate(d)).toBe('04/09/2026');
  });

  it('supports YYYY-MM-DD and DD/MM/YYYY', () => {
    const d = new Date(2026, 11, 31); // Dec 31, 2026
    expect(formatDate(d, 'YYYY-MM-DD')).toBe('2026-12-31');
    expect(formatDate(d, 'DD/MM/YYYY')).toBe('31/12/2026');
  });

  it('pads single-digit months and days to two characters', () => {
    const d = new Date(2026, 0, 1);
    expect(formatDate(d, 'MM/DD/YYYY')).toBe('01/01/2026');
  });
});

describe('getFiscalYearStart', () => {
  it('calendar year — reference inside the same FY returns Jan 1 of that year', () => {
    const ref = new Date(2026, 5, 15); // June 15, 2026
    const start = getFiscalYearStart(1, ref);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(0);
    expect(start.getDate()).toBe(1);
  });

  it('July start — reference before July returns the prior-year July', () => {
    const ref = new Date(2026, 2, 15); // March 15, 2026
    const start = getFiscalYearStart(7, ref);
    expect(start.getFullYear()).toBe(2025);
    expect(start.getMonth()).toBe(6); // July = 6
  });

  it('July start — reference on or after July returns this-year July', () => {
    const ref = new Date(2026, 7, 1); // Aug 1, 2026
    const start = getFiscalYearStart(7, ref);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(6);
  });
});

describe('getFiscalYearEnd', () => {
  it('calendar year — returns Dec 31', () => {
    const ref = new Date(2026, 5, 15);
    const end = getFiscalYearEnd(1, ref);
    expect(end.getFullYear()).toBe(2026);
    expect(end.getMonth()).toBe(11);
    expect(end.getDate()).toBe(31);
  });

  it('July-start fiscal year — returns June 30 of the following year', () => {
    const ref = new Date(2026, 7, 1); // in FY 2026-Jul → 2027-Jun
    const end = getFiscalYearEnd(7, ref);
    expect(end.getFullYear()).toBe(2027);
    expect(end.getMonth()).toBe(5); // June = 5
    expect(end.getDate()).toBe(30);
  });
});

describe('toUTC', () => {
  it('returns an ISO-8601 UTC string', () => {
    const d = new Date('2026-04-20T13:14:15.000Z');
    expect(toUTC(d)).toBe('2026-04-20T13:14:15.000Z');
  });
});
