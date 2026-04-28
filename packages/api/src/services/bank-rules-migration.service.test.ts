// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { convertBankRule } from './bank-rules-migration.service.js';

// 3-tier rules plan, Phase 6 — pure conversion tests. No DB.
// Each test exercises one mapping or one warning path so a
// regression in the converter is easy to localize.

const ANY_UUID = '00000000-0000-0000-0000-000000000000';

function source(over: Partial<Parameters<typeof convertBankRule>[0]> = {}) {
  return {
    id: 'rule-1',
    name: 'Test rule',
    priority: 100,
    isActive: true,
    isGlobal: false,
    applyTo: 'both',
    bankAccountId: null,
    descriptionContains: null,
    descriptionExact: null,
    amountEquals: null,
    amountMin: null,
    amountMax: null,
    assignAccountId: null,
    assignContactId: null,
    assignAccountName: null,
    assignContactName: null,
    assignMemo: null,
    assignTagId: null,
    autoConfirm: false,
    ...over,
  };
}

const TENANT_USER_OPTS = {
  scope: 'tenant_user' as const,
  ownerUserId: ANY_UUID,
  ownerFirmId: null,
};

describe('convertBankRule — conditions', () => {
  it('description_contains → leaf descriptor.contains', () => {
    const out = convertBankRule(source({ descriptionContains: 'amazon' }), TENANT_USER_OPTS);
    expect(out.conditions).toEqual({
      type: 'leaf',
      field: 'descriptor',
      operator: 'contains',
      value: 'amazon',
    });
  });

  it('description_exact wins over description_contains when both are set', () => {
    const out = convertBankRule(
      source({ descriptionContains: 'amaz', descriptionExact: 'amazon mktplace' }),
      TENANT_USER_OPTS,
    );
    if (out.conditions.type !== 'leaf') throw new Error('expected leaf');
    expect(out.conditions.operator).toBe('equals');
    expect(out.conditions.value).toBe('amazon mktplace');
  });

  it('apply_to=deposits → amount_sign.eq -1', () => {
    const out = convertBankRule(
      source({ descriptionContains: 'x', applyTo: 'deposits' }),
      TENANT_USER_OPTS,
    );
    if (out.conditions.type !== 'group') throw new Error('expected group');
    const sign = out.conditions.children.find(
      (c) => c.type === 'leaf' && c.field === 'amount_sign',
    );
    expect(sign).toBeDefined();
    if (sign && sign.type === 'leaf') {
      expect(sign.value).toBe(-1);
    }
  });

  it('apply_to=expenses → amount_sign.eq +1', () => {
    const out = convertBankRule(
      source({ descriptionContains: 'x', applyTo: 'expenses' }),
      TENANT_USER_OPTS,
    );
    if (out.conditions.type !== 'group') throw new Error('expected group');
    const sign = out.conditions.children.find(
      (c) => c.type === 'leaf' && c.field === 'amount_sign',
    );
    if (sign && sign.type === 'leaf') {
      expect(sign.value).toBe(1);
    }
  });

  it('amount_equals on expenses → leaf amount.eq with positive value', () => {
    const out = convertBankRule(
      source({ amountEquals: '42.50', applyTo: 'expenses' }),
      TENANT_USER_OPTS,
    );
    if (out.conditions.type !== 'group') throw new Error('expected group');
    const amount = out.conditions.children.find(
      (c) => c.type === 'leaf' && c.field === 'amount',
    );
    if (amount && amount.type === 'leaf') {
      expect(amount.operator).toBe('eq');
      expect(amount.value).toBe(42.5);
    }
  });

  it('amount_equals on deposits → leaf amount.eq with negated value', () => {
    const out = convertBankRule(
      source({ amountEquals: '42.50', applyTo: 'deposits' }),
      TENANT_USER_OPTS,
    );
    if (out.conditions.type !== 'group') throw new Error('expected group');
    const amount = out.conditions.children.find(
      (c) => c.type === 'leaf' && c.field === 'amount',
    );
    if (amount && amount.type === 'leaf') {
      expect(amount.value).toBe(-42.5);
    }
  });

  it('amount_min + amount_max on expenses → leaf amount.between', () => {
    const out = convertBankRule(
      source({ amountMin: '10', amountMax: '500', applyTo: 'expenses' }),
      TENANT_USER_OPTS,
    );
    if (out.conditions.type !== 'group') throw new Error('expected group');
    const amount = out.conditions.children.find(
      (c) => c.type === 'leaf' && c.field === 'amount',
    );
    if (amount && amount.type === 'leaf') {
      expect(amount.operator).toBe('between');
      expect(amount.value).toEqual([10, 500]);
    }
  });

  it('amount range with apply_to=both warns about positive-only mapping', () => {
    const out = convertBankRule(
      source({ amountMin: '10', amountMax: '500', applyTo: 'both' }),
      TENANT_USER_OPTS,
    );
    expect(out.warnings.some((w) => /BOTH/.test(w))).toBe(true);
  });

  it('bank_account_id → leaf account_source_id.eq', () => {
    const out = convertBankRule(
      source({ bankAccountId: ANY_UUID }),
      TENANT_USER_OPTS,
    );
    if (out.conditions.type !== 'leaf') throw new Error('expected leaf');
    expect(out.conditions.field).toBe('account_source_id');
    expect(out.conditions.value).toBe(ANY_UUID);
  });

  it('multiple conditions are combined into an AND group', () => {
    const out = convertBankRule(
      source({ descriptionContains: 'x', applyTo: 'expenses', amountMin: '5' }),
      TENANT_USER_OPTS,
    );
    if (out.conditions.type !== 'group') throw new Error('expected group');
    expect(out.conditions.op).toBe('AND');
    expect(out.conditions.children.length).toBeGreaterThanOrEqual(3);
  });

  it('no source conditions → match-all degenerate group + warning', () => {
    const out = convertBankRule(source({}), TENANT_USER_OPTS);
    expect(out.warnings.some((w) => /no conditions/i.test(w))).toBe(true);
    if (out.conditions.type !== 'group') throw new Error('expected group');
    expect(out.conditions.op).toBe('OR');
  });
});

describe('convertBankRule — actions', () => {
  it('assign_account_id → set_account', () => {
    const out = convertBankRule(
      source({ descriptionContains: 'x', assignAccountId: ANY_UUID }),
      TENANT_USER_OPTS,
    );
    if (!Array.isArray(out.actions)) throw new Error('expected flat list');
    expect(out.actions[0]).toEqual({ type: 'set_account', accountId: ANY_UUID });
  });

  it('assign_contact_id → set_vendor', () => {
    const out = convertBankRule(
      source({ descriptionContains: 'x', assignContactId: ANY_UUID }),
      TENANT_USER_OPTS,
    );
    if (!Array.isArray(out.actions)) throw new Error('expected flat list');
    expect(out.actions[0]).toEqual({ type: 'set_vendor', vendorId: ANY_UUID });
  });

  it('assign_memo → set_memo', () => {
    const out = convertBankRule(
      source({ descriptionContains: 'x', assignMemo: 'Office expense' }),
      TENANT_USER_OPTS,
    );
    if (!Array.isArray(out.actions)) throw new Error('expected flat list');
    expect(out.actions[0]).toEqual({ type: 'set_memo', memo: 'Office expense' });
  });

  it('assign_tag_id → set_tag for tenant_user', () => {
    const out = convertBankRule(
      source({ descriptionContains: 'x', assignTagId: ANY_UUID }),
      TENANT_USER_OPTS,
    );
    if (!Array.isArray(out.actions)) throw new Error('expected flat list');
    expect(out.actions.some((a) => a.type === 'set_tag')).toBe(true);
  });

  it('assign_tag_id on global_firm scope is dropped + warned', () => {
    const out = convertBankRule(
      source({ descriptionContains: 'x', assignTagId: ANY_UUID }),
      { scope: 'global_firm', ownerUserId: null, ownerFirmId: ANY_UUID },
    );
    if (!Array.isArray(out.actions)) throw new Error('expected flat list');
    expect(out.actions.some((a) => a.type === 'set_tag')).toBe(false);
    expect(out.warnings.some((w) => /tag/i.test(w))).toBe(true);
  });

  it('auto_confirm=true emits a behavior-change warning', () => {
    const out = convertBankRule(
      source({ descriptionContains: 'x', autoConfirm: true }),
      TENANT_USER_OPTS,
    );
    expect(out.warnings.some((w) => /auto_confirm|auto-post/i.test(w))).toBe(true);
  });

  it('global rule with assignAccountName warns about system_tag rebinding', () => {
    const out = convertBankRule(
      source({ descriptionContains: 'x', assignAccountName: 'Office Supplies' }),
      { scope: 'global_firm', ownerUserId: null, ownerFirmId: ANY_UUID },
    );
    expect(out.warnings.some((w) => /system_tag|account name/i.test(w))).toBe(true);
  });

  it('contact-name only (no contact id) warns rather than auto-creating', () => {
    const out = convertBankRule(
      source({ descriptionContains: 'x', assignContactName: 'Amazon' }),
      TENANT_USER_OPTS,
    );
    expect(out.warnings.some((w) => /contact name/i.test(w))).toBe(true);
    if (!Array.isArray(out.actions)) throw new Error('expected flat list');
    expect(out.actions.some((a) => a.type === 'set_vendor')).toBe(false);
  });
});

describe('convertBankRule — metadata', () => {
  it('preserves priority + active', () => {
    const out = convertBankRule(
      source({ priority: 50, isActive: false, descriptionContains: 'x' }),
      TENANT_USER_OPTS,
    );
    expect(out.priority).toBe(50);
    expect(out.active).toBe(false);
  });

  it('null priority defaults to 100', () => {
    const out = convertBankRule(
      source({ priority: null, descriptionContains: 'x' }),
      TENANT_USER_OPTS,
    );
    expect(out.priority).toBe(100);
  });

  it('attaches sourceRuleId for the dry-run report', () => {
    const out = convertBankRule(
      source({ id: 'src-123', descriptionContains: 'x' }),
      TENANT_USER_OPTS,
    );
    expect(out.sourceRuleId).toBe('src-123');
  });
});
