// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// In-process archive jobs (M2, M3): one running job per kind, kinds overlap,
// a failed job never blocks the next, resources are visible while a job is
// queued or running and gone afterwards, and job lookup is per user.

import { describe, it, expect, beforeEach } from 'vitest';
import { AppError } from '../../utils/errors.js';
import { _resetJobsForTests, activeJobResources, getJob, startJob, waitForJob } from './jobs.js';

function gate(): { promise: Promise<string>; open: (v: string) => void; fail: (e: unknown) => void } {
  let open: (v: string) => void = () => undefined;
  let fail: (e: unknown) => void = () => undefined;
  const promise = new Promise<string>((resolve, reject) => { open = resolve; fail = reject; });
  return { promise, open, fail };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => _resetJobsForTests());

describe('archive jobs', () => {
  it('runs one job per kind at a time, in order, while kinds overlap', async () => {
    const a = gate();
    const b = gate();
    const c = gate();
    const order: string[] = [];
    const ja = startJob('export', 'tenant-a', 'u1', async () => { order.push('a'); return a.promise; });
    const jb = startJob('export', 'tenant-b', 'u1', async () => { order.push('b'); return b.promise; });
    const jc = startJob('import', null, 'u1', async () => { order.push('c'); return c.promise; });
    await tick();
    expect(ja.status).toBe('running');
    expect(jb.status).toBe('queued');
    expect(jc.status).toBe('running'); // another kind runs alongside
    expect(order).toEqual(['a', 'c']);
    a.open('A');
    await waitForJob(ja.id);
    await tick();
    expect(jb.status).toBe('running');
    expect(order).toEqual(['a', 'c', 'b']);
    b.open('B');
    c.open('C');
    expect((await waitForJob(jb.id)).result).toBe('B');
    expect((await waitForJob(jc.id)).result).toBe('C');
  });

  it('a failed job does not block the next one of its kind, and errors are sanitized', async () => {
    const j1 = startJob('import', null, 'u1', async () => { throw new Error('/secret/path and params: [1,2]'); });
    const j2 = startJob('import', null, 'u1', async () => { throw AppError.badRequest('nope', 'SOME_CODE'); });
    const j3 = startJob('import', null, 'u1', async () => 'ok');
    expect((await waitForJob(j1.id)).error).toEqual({ code: 'INTERNAL_ERROR', message: 'The job failed. See the engine log.' });
    expect((await waitForJob(j2.id)).error).toMatchObject({ code: 'SOME_CODE', message: 'nope' });
    expect((await waitForJob(j3.id)).result).toBe('ok');
  });

  it('exposes claimed resources while queued or running, and only to the owner or a super admin', async () => {
    const g = gate();
    const j = startJob('export', 'Tenant-X', 'u1', async (p) => { p.claim('ARCHIVE-1'); return g.promise; }, ['/tmp/up.zip']);
    expect(activeJobResources()).toEqual(new Set(['tenant-x', '/tmp/up.zip']));
    await tick();
    expect(activeJobResources()).toEqual(new Set(['tenant-x', '/tmp/up.zip', 'archive-1']));
    expect(getJob(j.id, 'u1', false).id).toBe(j.id);
    expect(getJob(j.id, 'admin', true).id).toBe(j.id);
    expect(() => getJob(j.id, 'u2', false)).toThrow(/No such job/);
    g.open('done');
    await waitForJob(j.id);
    expect(activeJobResources()).toEqual(new Set());
  });
});
