// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Backup run log — row lifecycle (start → success), the failure path,
// partial destination outcomes (mirror failed at finish, remote failed
// after finish), verifier matching, list filtering, and the per-kind
// health summary. Also proves migration 0139 applied (every test reads
// and writes the backup_runs table).

import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { backupRuns, tenants } from '../db/schema/index.js';
import {
  startBackupRun,
  finishBackupRun,
  updateRunRemote,
  recordVerifyOutcome,
  listBackupRuns,
  backupRunsSummary,
  sweepStaleRuns,
  STALE_RUN_ERROR,
  type RunDestinations,
} from './backup-run-log.service.js';

async function getRun(id: string) {
  const [row] = await db.select().from(backupRuns).where(eq(backupRuns.id, id)).limit(1);
  return row!;
}

beforeEach(async () => {
  await db.delete(backupRuns);
});

describe('backup run lifecycle', () => {
  it('start → finish success records the full row', async () => {
    const id = await startBackupRun({ kind: 'db_backup', trigger: 'scheduled' });
    expect(id).toBeTruthy();

    let row = await getRun(id!);
    expect(row.status).toBe('running');
    expect(row.kind).toBe('db_backup');
    expect(row.trigger).toBe('scheduled');
    expect(row.tenantId).toBeNull();
    expect(row.finishedAt).toBeNull();

    await finishBackupRun(id, {
      status: 'success',
      sizeBytes: 12345,
      artifactName: 'kis-books-backup-2026-07-20T00-00-00-000Z.vmb',
      destinations: {
        local: { configured: true, ok: true },
        mirror: { configured: false },
      },
    });

    row = await getRun(id!);
    expect(row.status).toBe('success');
    expect(row.finishedAt).not.toBeNull();
    expect(row.sizeBytes).toBe(12345);
    expect(row.artifactName).toBe('kis-books-backup-2026-07-20T00-00-00-000Z.vmb');
    const dest = row.destinations as RunDestinations;
    expect(dest.local?.ok).toBe(true);
    expect(dest.mirror?.configured).toBe(false);
  });

  it('the failure path records status=failed with the error', async () => {
    const id = await startBackupRun({ kind: 'system_backup', trigger: 'manual' });
    await finishBackupRun(id, { status: 'failed', error: 'pg_dump exploded' });
    const row = await getRun(id!);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('pg_dump exploded');
    expect(row.finishedAt).not.toBeNull();
  });

  it('a configured-but-failed mirror downgrades success to partial', async () => {
    const id = await startBackupRun({ kind: 'tenant_backup', trigger: 'scheduled' });
    await finishBackupRun(id, {
      status: 'success',
      destinations: {
        local: { configured: true, ok: true },
        mirror: { configured: true, ok: false, copied: 0, failed: 1, error: 'ENOSPC' },
      },
    });
    const row = await getRun(id!);
    expect(row.status).toBe('partial');
  });

  it('a remote failure arriving AFTER a successful finish downgrades to partial', async () => {
    const id = await startBackupRun({ kind: 'db_backup', trigger: 'scheduled' });
    await finishBackupRun(id, { status: 'success', destinations: { local: { configured: true, ok: true } } });
    await updateRunRemote(id, { configured: true, ok: false, error: 'B2 503' });
    const row = await getRun(id!);
    expect(row.status).toBe('partial');
    expect((row.destinations as RunDestinations).remote?.error).toBe('B2 503');
  });

  it('an unconfigured remote destination never downgrades the run', async () => {
    const id = await startBackupRun({ kind: 'db_backup', trigger: 'scheduled' });
    await finishBackupRun(id, { status: 'success', destinations: { local: { configured: true, ok: true } } });
    await updateRunRemote(id, { configured: false });
    const row = await getRun(id!);
    expect(row.status).toBe('success');
  });

  it('a remote failure recorded BEFORE finish still yields partial (fire-and-forget race)', async () => {
    const id = await startBackupRun({ kind: 'tenant_backup', trigger: 'manual' });
    await updateRunRemote(id, { configured: true, ok: false, error: 'upload timed out' });
    await finishBackupRun(id, { status: 'success', destinations: { local: { configured: true, ok: true } } });
    const row = await getRun(id!);
    expect(row.status).toBe('partial');
    expect((row.destinations as RunDestinations).remote?.error).toBe('upload timed out');
  });

  it('writers are no-ops for a null run id (log failure must not break backups)', async () => {
    await expect(finishBackupRun(null, { status: 'success' })).resolves.toBeUndefined();
    await expect(updateRunRemote(null, { configured: true, ok: true })).resolves.toBeUndefined();
  });
});

describe('verifier integration', () => {
  it('attaches the verify outcome to the newest run with a matching artifact name', async () => {
    const artifact = 'kis-books-backup-2026-07-19T21-43-00-000Z.vmx';
    const id = await startBackupRun({ kind: 'system_backup', trigger: 'scheduled' });
    await finishBackupRun(id, { status: 'success', artifactName: artifact });

    await recordVerifyOutcome({ tenantId: null, fileName: artifact, ok: true, depth: 'deep', sizeBytes: 999 });

    const row = await getRun(id!);
    expect(row.verify).toMatchObject({ ok: true, depth: 'deep' });
    // No standalone verify row was inserted.
    const { total } = await listBackupRuns({ limit: 10, offset: 0, kind: 'verify' });
    expect(total).toBe(0);
  });

  it('inserts a standalone verify row when no run matches (failure is never dropped)', async () => {
    await recordVerifyOutcome({
      tenantId: '00000000-0000-0000-0000-000000000000', // synthetic system id — not a real tenant
      fileName: 'kis-books-backup-pre-log-era.vmb',
      ok: false,
      depth: 'header',
      error: 'magic bytes mismatch',
    });
    const { runs, total } = await listBackupRuns({ limit: 10, offset: 0, kind: 'verify' });
    expect(total).toBe(1);
    expect(runs[0]!.status).toBe('failed');
    expect(runs[0]!.tenantId).toBeNull(); // bogus tenant id recorded system-wide, no FK violation
    expect(runs[0]!.error).toBe('magic bytes mismatch');
    expect(runs[0]!.verify).toMatchObject({ ok: false, error: 'magic bytes mismatch' });
  });

  it('records the run per-tenant when the tenant actually exists', async () => {
    const [tenant] = await db.insert(tenants).values({ name: 'Run Log Verify T', slug: 'run-log-verify-t' }).returning();
    try {
      await recordVerifyOutcome({ tenantId: tenant!.id, fileName: 'kis-books-backup-x.vmb', ok: true, depth: 'full' });
      const { runs } = await listBackupRuns({ limit: 10, offset: 0, kind: 'verify' });
      expect(runs[0]!.tenantId).toBe(tenant!.id);
    } finally {
      await db.delete(backupRuns);
      await db.delete(tenants).where(eq(tenants.id, tenant!.id));
    }
  });
});

describe('stale-run sweep', () => {
  it('marks a running row older than the threshold failed; a fresh running row is untouched', async () => {
    const staleId = await startBackupRun({ kind: 'system_backup', trigger: 'scheduled' });
    // Backdate past the 6h threshold — the row's process "crashed" 7h ago.
    await db.update(backupRuns)
      .set({ startedAt: new Date(Date.now() - 7 * 60 * 60 * 1000) })
      .where(eq(backupRuns.id, staleId!));
    const freshId = await startBackupRun({ kind: 'system_backup', trigger: 'scheduled' });

    const swept = await sweepStaleRuns();
    expect(swept).toBe(1);

    const stale = await getRun(staleId!);
    expect(stale.status).toBe('failed');
    expect(stale.error).toBe(STALE_RUN_ERROR);
    expect(stale.finishedAt).toBeNull(); // never finished — the sweep only names the outcome

    const fresh = await getRun(freshId!);
    expect(fresh.status).toBe('running');
    expect(fresh.error).toBeNull();
  });

  it('listBackupRuns sweeps lazily and the summary counts swept rows as failures', async () => {
    const t0 = new Date(Date.now() - 9 * 60 * 60 * 1000);
    await db.insert(backupRuns).values([
      { kind: 'db_backup', trigger: 'scheduled', status: 'success', startedAt: t0, finishedAt: t0 },
      { kind: 'db_backup', trigger: 'scheduled', status: 'running', startedAt: new Date(Date.now() - 8 * 60 * 60 * 1000) },
    ]);

    // The read path itself must never return a stale 'running' row.
    const { runs } = await listBackupRuns({ limit: 10, offset: 0, kind: 'db_backup' });
    const sweptRow = runs.find((r) => r.status !== 'success')!;
    expect(sweptRow.status).toBe('failed');
    expect(sweptRow.error).toBe(STALE_RUN_ERROR);

    // And the health summary treats the swept run as a real failure.
    const summary = await backupRunsSummary();
    expect(summary['db_backup']!.consecutiveFailures).toBe(1);
    expect(summary['db_backup']!.lastRun?.status).toBe('failed');
  });
});

describe('listBackupRuns + summary', () => {
  it('filters by status and kind, newest first, with limit/offset', async () => {
    const mk = async (kind: 'db_backup' | 'tenant_backup', status: 'success' | 'failed') => {
      const id = await startBackupRun({ kind, trigger: 'scheduled' });
      await finishBackupRun(id, { status, ...(status === 'failed' ? { error: 'x' } : {}) });
      return id!;
    };
    await mk('db_backup', 'success');
    await mk('db_backup', 'failed');
    await mk('tenant_backup', 'success');

    const all = await listBackupRuns({ limit: 10, offset: 0 });
    expect(all.total).toBe(3);
    // Newest first
    const times = all.runs.map((r) => new Date(r.startedAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const failedOnly = await listBackupRuns({ limit: 10, offset: 0, status: 'failed' });
    expect(failedOnly.total).toBe(1);
    expect(failedOnly.runs[0]!.kind).toBe('db_backup');

    const dbOnly = await listBackupRuns({ limit: 10, offset: 0, kind: 'db_backup' });
    expect(dbOnly.total).toBe(2);

    const paged = await listBackupRuns({ limit: 1, offset: 1 });
    expect(paged.runs).toHaveLength(1);
    expect(paged.total).toBe(3);
    expect(paged.runs[0]!.id).toBe(all.runs[1]!.id);
  });

  it('summary reports last success and consecutive failures per kind', async () => {
    // db_backup: success then two failures → 2 consecutive failures.
    const t0 = new Date(Date.now() - 3000);
    const t1 = new Date(Date.now() - 2000);
    const t2 = new Date(Date.now() - 1000);
    await db.insert(backupRuns).values([
      { kind: 'db_backup', trigger: 'scheduled', status: 'success', startedAt: t0, finishedAt: t0 },
      { kind: 'db_backup', trigger: 'scheduled', status: 'failed', startedAt: t1, finishedAt: t1, error: 'a' },
      { kind: 'db_backup', trigger: 'scheduled', status: 'failed', startedAt: t2, finishedAt: t2, error: 'b' },
      { kind: 'system_backup', trigger: 'scheduled', status: 'success', startedAt: t2, finishedAt: t2 },
    ]);

    const summary = await backupRunsSummary();
    expect(summary['db_backup']).toBeTruthy();
    expect(summary['db_backup']!.consecutiveFailures).toBe(2);
    expect(summary['db_backup']!.lastRun?.status).toBe('failed');
    expect(new Date(summary['db_backup']!.lastSuccessAt!).getTime()).toBe(t0.getTime());
    expect(summary['system_backup']!.consecutiveFailures).toBe(0);
    expect(summary['system_backup']!.lastRun?.status).toBe('success');
  });
});
