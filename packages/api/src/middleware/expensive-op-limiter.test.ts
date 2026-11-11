// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// The report limiter (ClientLedger P28): 30 per user per minute on a server
// (MyBooks Online, unchanged), 600 in the desktop profile, where drilling
// through reports fires bursts of reads from the one local owner.

import { describe, it, expect, vi, afterEach } from 'vitest';

const profile = vi.hoisted(() => ({ desktop: false }));
vi.mock('../desktop/profile.js', async (orig) => ({
  ...(await orig<typeof import('../desktop/profile.js')>()),
  isDesktop: () => profile.desktop,
}));

import { expensiveOpMax, EXPENSIVE_OP_MAX_SERVER, EXPENSIVE_OP_MAX_DESKTOP } from './expensive-op-limiter.js';

afterEach(() => { profile.desktop = false; });

describe('expensiveOpMax', () => {
  it('keeps 30/min on a server and raises it to 600/min on the desktop', () => {
    expect(EXPENSIVE_OP_MAX_SERVER).toBe(30);
    expect(expensiveOpMax()).toBe(30);
    profile.desktop = true;
    expect(EXPENSIVE_OP_MAX_DESKTOP).toBe(600);
    expect(expensiveOpMax()).toBe(600);
  });
});
