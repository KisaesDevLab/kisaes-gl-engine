// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// setup.service reads CONFIG_DIR once at module load, so point it at a
// scratch dir *before* the dynamic import below. Otherwise these tests
// would probe the real /data/config and the marker written by the
// self-heal case would leak between runs.
const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'vibe-setup-status-'));
process.env['CONFIG_DIR'] = CONFIG_DIR;

// Mock the db module so status probing is deterministic: these cases are
// about the boolean logic, not about Postgres. Using the shared test DB
// would couple them to whatever rows other suites happen to have left.
const executeMock = vi.fn();
vi.mock('../db/index.js', () => ({
  db: { execute: executeMock },
}));

// Re-import after the mock is in place.
const setupService = await import('./setup.service.js');

const tenantsTableExists = { rows: [{ exists: true }] };
const rowCount = (n: number) => ({ rows: [{ cnt: String(n) }] });

describe('getSetupStatus — first-run detection', () => {
  beforeEach(() => {
    executeMock.mockReset();
    // Drop the persistent marker between cases; it short-circuits everything.
    rmSync(join(CONFIG_DIR, '.initialized'), { force: true });
  });

  afterAll(() => {
    rmSync(CONFIG_DIR, { recursive: true, force: true });
  });

  // Regression for the appliance deadlock: docker-entrypoint auto-runs
  // migrations on first boot (so the tenants table exists) and install.sh
  // pre-generates JWT_SECRET into .env (so envFileExists probes true).
  // Treating that pair as "configured" reported setupComplete = true on a
  // pristine install with zero users, which hid the first-run wizard AND
  // made the setup route guard 403 every endpoint — leaving no account to
  // log in with and no way to create one.
  it('reports setupComplete=false on a fresh appliance: schema migrated and secrets present, but no users', async () => {
    executeMock
      .mockResolvedValueOnce(tenantsTableExists) // entrypoint already migrated
      .mockResolvedValueOnce(rowCount(0)) // ...but nobody has run the wizard
      .mockResolvedValueOnce(rowCount(0)); // and no tenants either

    const status = await setupService.getSetupStatus();

    expect(status.databaseInitialized).toBe(true);
    expect(status.needsAdminUser).toBe(false);
    expect(status.envFileExists).toBe(true); // JWT_SECRET is set by test-setup.ts
    expect(status.hasAdminUser).toBe(false);
    expect(status.statusCheckFailed).toBe(false);
    expect(status.setupComplete).toBe(false);
  });

  // The protection this must not regress (900362a): a configured system
  // must never be offered the wizard, because re-running setup there is
  // destructive.
  it('reports setupComplete=true once an admin user exists', async () => {
    executeMock
      .mockResolvedValueOnce(tenantsTableExists)
      .mockResolvedValueOnce(rowCount(1)) // a real user exists
      .mockResolvedValueOnce(rowCount(1)); // ...and a tenant (self-heal probe)

    const status = await setupService.getSetupStatus();

    expect(status.hasAdminUser).toBe(true);
    expect(status.setupComplete).toBe(true);
  });

  it('fails closed when the schema probe throws', async () => {
    executeMock.mockRejectedValueOnce(new Error('connection refused'));

    const status = await setupService.getSetupStatus();

    expect(status.statusCheckFailed).toBe(true);
    expect(status.setupComplete).toBe(true);
  });

  // A failed users probe must never be mistaken for "no users" — that would
  // open the destructive setup endpoints on a populated database.
  it('fails closed when the users probe throws', async () => {
    executeMock
      .mockResolvedValueOnce(tenantsTableExists)
      .mockRejectedValueOnce(new Error('permission denied'));

    const status = await setupService.getSetupStatus();

    expect(status.statusCheckFailed).toBe(true);
    expect(status.setupComplete).toBe(true);
  });

  it('keeps the persistent marker authoritative while the database holds users', async () => {
    setupService.markInitialized();
    executeMock
      .mockResolvedValueOnce(rowCount(1)) // tenants
      .mockResolvedValueOnce(rowCount(3)); // users

    const status = await setupService.getSetupStatus();

    expect(status.setupComplete).toBe(true);
    expect(status.hasAdminUser).toBe(true);
    expect(status.staleMarker).toBe(false);
    expect(status.tenantCount).toBe(1);
  });

  it('keeps the marker lock (fail closed) when the database is unreachable', async () => {
    setupService.markInitialized();
    executeMock.mockRejectedValueOnce(new Error('connection refused'));

    const status = await setupService.getSetupStatus();

    expect(status.setupComplete).toBe(true);
    expect(status.hasAdminUser).toBe(true);
  });

  // The DR lockout: /data (with its .initialized marker) carried to a new
  // server, or kept across a Postgres wipe. The marker used to answer
  // hasAdminUser=true without a query, so every setup endpoint 403'd and the
  // login page offered a form no account could satisfy.
  it('re-opens setup when the marker exists but the database is completely empty', async () => {
    setupService.markInitialized();
    executeMock
      .mockResolvedValueOnce(rowCount(0)) // tenants
      .mockResolvedValueOnce(rowCount(0)); // users

    const status = await setupService.getSetupStatus();

    expect(status.setupComplete).toBe(false);
    expect(status.hasAdminUser).toBe(false);
    expect(status.staleMarker).toBe(true);
    expect(status.needsAdminUser).toBe(false);
  });

  it('asks for an admin account when the marker exists over restored tenants with no users', async () => {
    setupService.markInitialized();
    executeMock
      .mockResolvedValueOnce(rowCount(2)) // tenants (restored)
      .mockResolvedValueOnce(rowCount(0)); // users

    const status = await setupService.getSetupStatus();

    expect(status.setupComplete).toBe(false);
    expect(status.staleMarker).toBe(true);
    expect(status.needsAdminUser).toBe(true);
    expect(status.tenantCount).toBe(2);
  });

  // Tenant-scoped restore (no marker): data present, nobody to log in as.
  it('reports needsAdminUser when tenants exist without users and no marker', async () => {
    executeMock
      .mockResolvedValueOnce(tenantsTableExists)
      .mockResolvedValueOnce(rowCount(0)) // users
      .mockResolvedValueOnce(rowCount(1)); // tenants

    const status = await setupService.getSetupStatus();

    expect(status.setupComplete).toBe(false);
    expect(status.hasAdminUser).toBe(false);
    expect(status.needsAdminUser).toBe(true);
    expect(status.tenantCount).toBe(1);
  });
});

describe('buildDatabaseUrl', () => {
  it('percent-encodes credentials so reserved characters survive the round trip', () => {
    const url = setupService.buildDatabaseUrl({
      host: 'db',
      port: 5432,
      database: 'kisbooks',
      username: 'kis books',
      password: 'p@ss:w/rd#1?',
    });
    expect(url).toBe('postgresql://kis%20books:p%40ss%3Aw%2Frd%231%3F@db:5432/kisbooks');
    const parsed = new URL(url);
    expect(parsed.hostname).toBe('db');
    expect(decodeURIComponent(parsed.password)).toBe('p@ss:w/rd#1?');
    expect(decodeURIComponent(parsed.username)).toBe('kis books');
  });

  it('matches getDatabaseDefaults decoding', () => {
    const cfg = { host: 'db', port: 5432, database: 'kisbooks', username: 'kisbooks', password: 'a@b/c' };
    const prev = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = setupService.buildDatabaseUrl(cfg);
    try {
      const defaults = setupService.getDatabaseDefaults();
      expect(defaults.password).toBe('a@b/c');
      expect(defaults.host).toBe('db');
      expect(defaults.source).toBe('env');
    } finally {
      if (prev === undefined) delete process.env['DATABASE_URL'];
      else process.env['DATABASE_URL'] = prev;
    }
  });

  it('brackets IPv6 hosts', () => {
    expect(setupService.buildDatabaseUrl({ host: '::1', port: 5432, database: 'd', username: 'u', password: 'p' }))
      .toBe('postgresql://u:p@[::1]:5432/d');
  });
});
