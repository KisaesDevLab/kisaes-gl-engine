// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { adjustmentLinkRule } from './years-api.js';

const t = (over: Partial<Parameters<typeof adjustmentLinkRule>[0]> = {}) =>
  ({ code: null, kind: 'deduction' as const, affectsSe: false, affectsQbi: false, isAboveTheLine: false, ...over });

describe('adjustmentLinkRule (QA D1)', () => {
  it('requires an entity link for §179 vehicles and tax-vs-book depreciation', () => {
    expect(adjustmentLinkRule(t({ code: 'vehicle_179', affectsSe: true, affectsQbi: true }))).toBe('required');
    expect(adjustmentLinkRule(t({ code: 'depreciation_tax_vs_book', affectsSe: true, affectsQbi: true }))).toBe('required');
  });
  it('requires a link for a firm-defined business deduction (affects SE or QBI, not above the line)', () => {
    expect(adjustmentLinkRule(t({ affectsSe: true }))).toBe('required');
    expect(adjustmentLinkRule(t({ affectsQbi: true }))).toBe('required');
  });
  it('refuses a link for person-level owner deductions (SEHI, retirement, HSA)', () => {
    for (const code of ['owner_health_insurance', 'sep_solo_401k', 'hsa_contribution', 'retirement_catch_up']) {
      expect(adjustmentLinkRule(t({ code, isAboveTheLine: true }))).toBe('not_allowed');
    }
  });
  it('leaves income, add-backs and other deductions optional', () => {
    expect(adjustmentLinkRule(t({ code: 'other_deduction' }))).toBe('optional');
    expect(adjustmentLinkRule(t({ code: 'meals', kind: 'addback', affectsSe: true, affectsQbi: true }))).toBe('optional');
    expect(adjustmentLinkRule(t({ code: 'capital_gain_lt', kind: 'income' }))).toBe('optional');
  });
});
