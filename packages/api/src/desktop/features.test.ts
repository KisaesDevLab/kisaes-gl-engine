// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import {
  DESKTOP_SCHEDULERS,
  DESKTOP_UNMOUNTED,
  familyOf,
  schedulerEnabled,
  serverOnly,
  type SchedulerName,
} from './features.js';
import { loadDesktopProfile, _resetDesktopProfileForTests } from './profile.js';

function loadDesktop() {
  loadDesktopProfile({
    CL_MODE: 'desktop',
    CL_TOKEN: 'f'.repeat(48),
    CL_BIND: '127.0.0.1:0',
    CL_DATA_DIR: path.join(os.tmpdir(), 'cl-features-test'),
  });
}

function fakeApp() {
  return { use: vi.fn(), post: vi.fn() } as unknown as Express & { use: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };
}

afterEach(() => _resetDesktopProfileForTests());

describe('schedulers', () => {
  const names = Object.keys(DESKTOP_SCHEDULERS) as SchedulerName[];

  it('server starts every scheduler', () => {
    loadDesktopProfile({});
    for (const n of names) expect(schedulerEnabled(n), n).toBe(true);
  });

  it('desktop follows the table', () => {
    loadDesktop();
    expect(names.filter((n) => schedulerEnabled(n)).sort()).toEqual([
      'aiRetention',
      'balanceValidation',
      'classificationStateBackfill',
      'fingerprint',
      'recurring',
      'reportPackSweep',
      'tagBackfill',
    ]);
  });
});

describe('serverOnly', () => {
  const handler = () => undefined;

  it('server: plain app.use / app.post with the same arguments', () => {
    loadDesktopProfile({});
    const app = fakeApp();
    serverOnly(app).use('/api/v1/plaid/webhooks', handler);
    serverOnly(app).post('/mcp', handler);
    expect(app.use).toHaveBeenCalledWith('/api/v1/plaid/webhooks', handler);
    expect(app.post).toHaveBeenCalledWith('/mcp', handler);
  });

  it('desktop: mounts nothing, except the allowed sub-paths of a family', () => {
    loadDesktop();
    const app = fakeApp();
    serverOnly(app).use('/api/portal/questions', handler);
    serverOnly(app).post('/mcp', handler);
    expect(app.use).not.toHaveBeenCalled();
    expect(app.post).not.toHaveBeenCalled();
    serverOnly(app).use('/api/setup', handler);
    expect(app.use).toHaveBeenCalledTimes(1);
    expect(app.use.mock.calls[0]![0]).toBe('/api/setup');
  });

  it('refuses a mount path that is not in the table (both modes)', () => {
    loadDesktopProfile({});
    expect(() => serverOnly(fakeApp()).use('/api/v1/accounts', handler)).toThrow(/DESKTOP_UNMOUNTED/);
  });

  it('familyOf matches whole path segments only', () => {
    expect(familyOf('/api/portal/banking')?.prefix).toBe('/api/portal');
    expect(familyOf('/api/portalx')).toBeUndefined();
    expect(familyOf('/api/v1/plaid/webhooks')?.prefix).toBe('/api/v1/plaid');
  });

  it('table prefixes are unique and well-formed', () => {
    const prefixes = DESKTOP_UNMOUNTED.map((f) => f.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const p of prefixes) expect(p).toMatch(/^\/[a-z0-9/-]+$/);
  });
});
