// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';

// The DB role is mocked so the test does not depend on how the test
// database user was created; the migration step runs for real.
const superuser = { value: false };
const role = { dangerous: [] as string[], warnings: [] as string[] };
vi.mock('./db-role.js', () => ({
  readDbRole: vi.fn(async () => ({
    superuser: superuser.value,
    dangerous: superuser.value ? ['superuser', ...role.dangerous] : role.dangerous,
    warnings: role.warnings,
  })),
  cachedDbSuperuser: () => superuser.value,
  _resetDbRoleCacheForTests: () => undefined,
}));

import { runDesktopPreflight } from './preflight.js';
import { loadDesktopProfile, _resetDesktopProfileForTests } from '../desktop/profile.js';
import { formatFatalLine } from '../desktop/fatal.js';
import { registerSecret, _resetSecretScrubberForTests } from '../utils/secret-scrubber.js';

function loadDesktop(extra: Record<string, string> = {}) {
  // A private copy: the test process environment stays untouched.
  loadDesktopProfile({
    CL_MODE: 'desktop',
    CL_TOKEN: 'k'.repeat(48),
    CL_BIND: '127.0.0.1:0',
    CL_DATA_DIR: path.join(os.tmpdir(), 'cl-preflight-test'),
    ...extra,
  });
}

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  superuser.value = false;
  role.dangerous = [];
  role.warnings = [];
  warnSpy.mockRestore();
  _resetDesktopProfileForTests();
  _resetSecretScrubberForTests();
});

describe('runDesktopPreflight', () => {
  it('non-superuser role: ok, no warning', async () => {
    loadDesktop();
    superuser.value = false;
    const r = await runDesktopPreflight();
    expect(r).toEqual({ status: 'ok', dbSuperuser: false });
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('DB_SUPERUSER');
  });

  it('superuser role: ok with a structured warning', async () => {
    loadDesktop();
    superuser.value = true;
    const r = await runDesktopPreflight();
    expect(r).toEqual({ status: 'ok', dbSuperuser: true });
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('DB_SUPERUSER'));
    expect(warned).toBeDefined();
    expect(JSON.parse(warned!)).toMatchObject({ event: 'warning', code: 'DB_SUPERUSER' });
  });

  it('superuser role with CL_REQUIRE_NON_SUPERUSER=1: blocked', async () => {
    loadDesktop({ CL_REQUIRE_NON_SUPERUSER: '1' });
    superuser.value = true;
    const r = await runDesktopPreflight();
    expect(r.status).toBe('blocked');
    if (r.status === 'blocked') expect(r.code).toBe('DB_SUPERUSER_FORBIDDEN');
  });

  it('server-file role membership is dangerous too: warned, and blocked under CL_REQUIRE_NON_SUPERUSER=1', async () => {
    loadDesktop();
    role.dangerous = ['pg_write_server_files'];
    const r = await runDesktopPreflight();
    expect(r).toEqual({ status: 'ok', dbSuperuser: false });
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('DB_SUPERUSER'));
    expect(warned).toContain('pg_write_server_files');

    _resetDesktopProfileForTests();
    loadDesktop({ CL_REQUIRE_NON_SUPERUSER: '1' });
    const blocked = await runDesktopPreflight();
    expect(blocked).toMatchObject({ status: 'blocked', code: 'DB_SUPERUSER_FORBIDDEN' });
    if (blocked.status === 'blocked') expect(blocked.details).toContain('pg_write_server_files');
  });

  it('createrole / replication / bypassrls only warn, even under CL_REQUIRE_NON_SUPERUSER=1', async () => {
    loadDesktop({ CL_REQUIRE_NON_SUPERUSER: '1' });
    role.warnings = ['createrole', 'replication', 'bypassrls'];
    const r = await runDesktopPreflight();
    expect(r).toEqual({ status: 'ok', dbSuperuser: false });
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('DB_ROLE_ATTRIBUTES'));
    expect(JSON.parse(warned!)).toMatchObject({ event: 'warning', code: 'DB_ROLE_ATTRIBUTES' });
    expect(warned).toContain('createrole, replication, bypassrls');
  });
});

describe('fatal line', () => {
  it('is one JSON line with event/code/message and scrubbed secrets', () => {
    registerSecret('super-secret-launch-token-value');
    const line = formatFatalLine('X', 'bad super-secret-launch-token-value at postgresql://u:pw123456@h/db');
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trim().split('\n')).toHaveLength(1);
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({ event: 'fatal', code: 'X', message: 'bad [redacted] at postgresql://u:[redacted]@h/db' });
  });
});
