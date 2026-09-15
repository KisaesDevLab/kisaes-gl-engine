// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import {
  FIRM_CAPABILITY_KEYS,
  TENANT_CAPABILITY_KEYS,
  ADMIN_CAPABILITY_KEYS,
  FIRM_CAPABILITIES,
} from '../constants/firm-capabilities.js';
import {
  defaultFirmCapabilities,
  emptyFirmCapabilities,
  hasAnyFirmCapability,
  isCapabilityEligibleRole,
  normalizeFirmCapabilityMap,
  resolveFirmCapabilities,
  unionFirmCapabilities,
} from './firm-capabilities.js';

const allTrue = Object.fromEntries(FIRM_CAPABILITY_KEYS.map((k) => [k, true]));
const allFalse = Object.fromEntries(FIRM_CAPABILITY_KEYS.map((k) => [k, false]));

describe('firm capability catalog', () => {
  it('splits cleanly into tenant and admin scopes', () => {
    expect(TENANT_CAPABILITY_KEYS.length + ADMIN_CAPABILITY_KEYS.length).toBe(FIRM_CAPABILITY_KEYS.length);
    expect(TENANT_CAPABILITY_KEYS).toContain('team_management');
    expect(ADMIN_CAPABILITY_KEYS).toContain('admin_tenant_ops');
    expect(new Set(FIRM_CAPABILITIES.map((c) => c.key)).size).toBe(FIRM_CAPABILITIES.length);
  });
});

describe('defaultFirmCapabilities', () => {
  it('firm_admin defaults to everything on', () => {
    expect(defaultFirmCapabilities('firm_admin')).toEqual(allTrue);
  });
  it('firm_staff and firm_readonly default to nothing', () => {
    expect(defaultFirmCapabilities('firm_staff')).toEqual(allFalse);
    expect(defaultFirmCapabilities('firm_readonly')).toEqual(allFalse);
    expect(defaultFirmCapabilities(null)).toEqual(allFalse);
  });
});

describe('resolveFirmCapabilities', () => {
  it('NULL stored → role defaults', () => {
    expect(resolveFirmCapabilities('firm_admin', null)).toEqual(allTrue);
    expect(resolveFirmCapabilities('firm_staff', undefined)).toEqual(allFalse);
  });
  it('empty object stored → nothing, even for firm_admin (upgrade-day backfill)', () => {
    expect(resolveFirmCapabilities('firm_admin', {})).toEqual(allFalse);
  });
  it('partial stored map → exactly those keys; absent keys are false', () => {
    const r = resolveFirmCapabilities('firm_staff', { team_management: true });
    expect(r.team_management).toBe(true);
    expect(r.admin_tenant_ops).toBe(false);
    expect(Object.keys(r).sort()).toEqual([...FIRM_CAPABILITY_KEYS].sort());
  });
  it('a trimmed firm_admin loses the trimmed keys', () => {
    const r = resolveFirmCapabilities('firm_admin', { ...allTrue, admin_user_support: false });
    expect(r.admin_user_support).toBe(false);
    expect(r.team_management).toBe(true);
  });
  it('firm_readonly is always nothing, regardless of stored map', () => {
    expect(resolveFirmCapabilities('firm_readonly', allTrue)).toEqual(allFalse);
    expect(isCapabilityEligibleRole('firm_readonly')).toBe(false);
  });
  it('unknown role → nothing', () => {
    expect(resolveFirmCapabilities('bogus', allTrue)).toEqual(allFalse);
  });
  it('non-boolean truthy values do not count', () => {
    const r = resolveFirmCapabilities('firm_staff', { team_management: 'yes' as unknown as boolean });
    expect(r.team_management).toBe(false);
  });
});

describe('unionFirmCapabilities', () => {
  it('ORs per key', () => {
    const a = { ...emptyFirmCapabilities(), team_management: true };
    const b = { ...emptyFirmCapabilities(), admin_tenant_ops: true };
    const u = unionFirmCapabilities([a, b]);
    expect(u.team_management).toBe(true);
    expect(u.admin_tenant_ops).toBe(true);
    expect(u.check_signatures).toBe(false);
  });
  it('empty input → nothing', () => {
    expect(unionFirmCapabilities([])).toEqual(allFalse);
  });
});

describe('helpers', () => {
  it('hasAnyFirmCapability', () => {
    expect(hasAnyFirmCapability(null)).toBe(false);
    expect(hasAnyFirmCapability({})).toBe(false);
    expect(hasAnyFirmCapability({ admin_user_support: true })).toBe(true);
    expect(hasAnyFirmCapability({ not_a_key: true })).toBe(false);
  });
  it('normalizeFirmCapabilityMap drops unknown keys and non-booleans', () => {
    expect(normalizeFirmCapabilityMap({ team_management: true, bogus: true, check_signatures: 'x' }))
      .toEqual({ team_management: true });
  });
});
