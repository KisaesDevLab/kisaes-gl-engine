// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Regression: the per-tenant backup loop must be gated on its OWN last-run
// (`backup_tenant_last_run`), not on `backup_last_run`. `backup_last_run` is
// stamped only when the SYSTEM backup succeeds (so a failed system backup
// retries next tick). If the per-tenant loop shared that gate, a persistently
// failing system backup would keep the full cadence "due" and re-run every
// tenant's createBackup — rewriting/mirroring/re-uploading each .vmb — on every
// hourly tick, growing the never-purged mirror without bound.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const createBackup = vi.fn(async () => ({ fileName: 't.vmb', size: 1 }));
// System backup always FAILS — the exact condition that must NOT force the
// tenant loop to re-run every tick.
const createSystemBackup = vi.fn(async () => { throw new Error('disk full'); });

vi.mock('./backup.service.js', () => ({
  createBackup,
  createSystemBackup,
  purgeExpiredLocalBackups: vi.fn(async () => 0),
  purgeExpiredRemoteBackups: vi.fn(async () => 0),
}));

// In-memory settings so the cycle's getSetting/setSetting never touch the DB.
const settings = new Map<string, string>();
vi.mock('./admin.service.js', () => ({
  getSetting: async (k: string) => settings.get(k) ?? null,
  setSetting: async (k: string, v: string) => { settings.set(k, v); },
}));

// The scheduler enumerates tenants via `db.select({...}).from(tenants)`.
vi.mock('../db/index.js', () => ({
  db: { select: () => ({ from: async () => [{ id: 'tenant-a' }, { id: 'tenant-b' }] }) },
}));

// decrypt() the stored passphrase → pass-through so a placeholder resolves.
vi.mock('../utils/encryption.js', () => ({ decrypt: (s: string) => s }));

let sched: typeof import('./backup-scheduler.service.js');

beforeEach(async () => {
  sched = await import('./backup-scheduler.service.js');
  createBackup.mockClear();
  createSystemBackup.mockClear();
  settings.clear();
  // Weekly full cadence, never run → due; a stored (fake) passphrase.
  settings.set('backup_schedule', 'weekly');
  settings.set('backup_db_schedule', 'none');
  settings.set('backup_scheduled_passphrase', 'pass');
});

afterAll(() => { settings.clear(); });

describe('per-tenant backup gate (unbounded-retry regression)', () => {
  it('does not re-run the per-tenant loop on the next tick when the system backup keeps failing', async () => {
    // Tick 1: full cadence due, tenant loop runs for both tenants, system fails.
    await sched.__runBackupCycleForTests();
    expect(createBackup).toHaveBeenCalledTimes(2); // both tenants, once
    expect(createSystemBackup).toHaveBeenCalledTimes(1);
    // System failed → its stamp is NOT advanced (it will retry)…
    expect(settings.get('backup_last_run')).toBeFalsy();
    // …but the tenant loop stamped its OWN last-run.
    expect(settings.get('backup_tenant_last_run')).toBeTruthy();

    // Tick 2 (same interval): full cadence still "due" (system stamp not
    // advanced), so the system backup retries — but the tenant loop is SKIPPED.
    await sched.__runBackupCycleForTests();
    expect(createBackup).toHaveBeenCalledTimes(2); // still 2, NOT 4
    expect(createSystemBackup).toHaveBeenCalledTimes(2); // system retried
  });
});
