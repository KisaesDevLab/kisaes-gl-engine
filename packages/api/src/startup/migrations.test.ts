// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the db module so the helper doesn't try to open a real PG
// connection during the unit-test run. Tests that need a real DB
// already exist at the integration tier.
const executeMock = vi.fn();
vi.mock('../db/index.js', () => ({
  db: { execute: executeMock },
}));

// Re-import after the mock is in place.
const { checkPendingMigrations, MIGRATIONS_FOLDER } = await import('./migrations.js');

describe('checkPendingMigrations', () => {
  beforeEach(() => {
    executeMock.mockReset();
  });

  it('returns pending=true when applied count is less than journal count', async () => {
    // Pretend the DB has applied 5 migrations.
    executeMock.mockResolvedValueOnce({ rows: [{ n: 5 }] });
    const status = await checkPendingMigrations(MIGRATIONS_FOLDER);
    expect(status.applied).toBe(5);
    expect(status.total).toBeGreaterThan(5);
    expect(status.pending).toBe(true);
  });

  it('returns pending=false when applied count matches journal count', async () => {
    // Read the journal to find the actual total so the test stays
    // accurate as new migrations are added.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const journal = JSON.parse(
      readFileSync(resolve(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: unknown[] };
    const total = journal.entries.length;

    executeMock.mockResolvedValueOnce({ rows: [{ n: total }] });
    const status = await checkPendingMigrations(MIGRATIONS_FOLDER);
    expect(status.applied).toBe(total);
    expect(status.total).toBe(total);
    expect(status.pending).toBe(false);
  });

  it('returns pending=true with applied=0 when the migrations table does not exist', async () => {
    // drizzle.__drizzle_migrations missing → execute throws → caller
    // sees a fresh DB.
    executeMock.mockRejectedValueOnce(new Error('relation does not exist'));
    const status = await checkPendingMigrations(MIGRATIONS_FOLDER);
    expect(status.applied).toBe(0);
    expect(status.pending).toBe(true);
  });

  it('handles a null/undefined count from the DB without crashing', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{}] });
    const status = await checkPendingMigrations(MIGRATIONS_FOLDER);
    expect(status.applied).toBe(0);
    expect(status.pending).toBe(true);
  });
});
