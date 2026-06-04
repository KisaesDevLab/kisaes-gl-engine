// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression: runTick's inner (tenant, company) loop had no per-iteration
// try/catch, so one company's runForCompany() throw aborted the sweep for
// every later company and tenant that tick. The fix catches+logs+continues.

const tenantRows = [{ id: 't1' }];
const companyRows = [{ id: 'c1' }, { id: 'c2' }];

vi.mock('../../db/index.js', () => ({
  db: {
    // First select (tenants) awaits .from() directly → tenantRows.
    // Second select (companies) calls .from().where() → companyRows.
    select: () => ({
      from: () => {
        const thenable: Promise<typeof tenantRows> & { where?: () => Promise<typeof companyRows> } =
          Promise.resolve(tenantRows);
        thenable.where = () => Promise.resolve(companyRows);
        return thenable;
      },
    }),
  },
}));

vi.mock('../../utils/scheduler-lock.js', () => ({
  // Run the locked body inline — the advisory lock isn't under test.
  withSchedulerLock: async (_name: string, fn: () => Promise<unknown>) => fn(),
}));

const lastRunCompletedAt = vi.fn();
const runForCompany = vi.fn();
vi.mock('./orchestrator.service.js', () => ({
  lastRunCompletedAt: (...a: unknown[]) => lastRunCompletedAt(...a),
  runForCompany: (...a: unknown[]) => runForCompany(...a),
}));

import { runTick } from './scheduler.service.js';

describe('review-checks runTick — per-company error isolation', () => {
  beforeEach(() => {
    lastRunCompletedAt.mockReset().mockResolvedValue(null); // never throttled
    runForCompany.mockReset();
  });

  it('continues the sweep when one company throws (does not abort remaining)', async () => {
    runForCompany
      .mockRejectedValueOnce(new Error('company c1 blew up'))
      .mockResolvedValueOnce(undefined);

    await expect(runTick()).resolves.toBeUndefined(); // tick itself never rejects
    // The second company must still be processed despite c1 failing.
    expect(runForCompany).toHaveBeenCalledTimes(2);
    expect(runForCompany).toHaveBeenNthCalledWith(1, 't1', 'c1');
    expect(runForCompany).toHaveBeenNthCalledWith(2, 't1', 'c2');
  });
});
