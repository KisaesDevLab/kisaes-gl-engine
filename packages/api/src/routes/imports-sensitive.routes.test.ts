// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// U-263 (imports-batch-v1): a viewer with any hidden account is refused every
// Bulk Import route (403 SENSITIVE_HIDDEN), as payroll import is (U-247). The
// owner is not.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { startSensitiveHarness, type SensitiveHarness } from './sensitive.test-fixtures.js';

let h: SensitiveHarness;

beforeAll(async () => {
  h = await startSensitiveHarness('sens-imports');
  await h.markWages();
}, 120_000);

afterAll(async () => { await h.close(); });

describe('U-263 sensitive accounts on Bulk Import', () => {
  it('lists the capability and the refuse prefix', async () => {
    expect(DESKTOP_CAPABILITIES).toContain('imports-batch-v1');
    const doors = await h.call('bk', 'GET', '/api/v1/sensitive-doors');
    expect(doors.json.refusePrefixes).toContain('/api/v1/imports');
  });

  it('refuses every import route to the restricted viewer, not to the owner', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    for (const [method, path] of [
      ['GET', '/api/v1/imports'],
      ['GET', '/api/v1/imports/batches'],
      ['GET', `/api/v1/imports/batches/${id}`],
      ['POST', '/api/v1/imports/batches'],
      ['POST', `/api/v1/imports/batches/${id}/commit`],
      ['POST', `/api/v1/imports/batches/${id}/undo`],
      // U-267, U-271 (imports-tieout-v1).
      ['POST', `/api/v1/imports/batches/${id}/tieout`],
      ['POST', `/api/v1/imports/batches/${id}/verify`],
      ['PUT', `/api/v1/imports/batches/${id}/spot-check`],
      ['GET', `/api/v1/imports/batches/${id}/transactions`],
      ['POST', `/api/v1/imports/${id}/commit`],
    ] as const) {
      const bk = await h.call('bk', method, path, method === 'GET' ? undefined : {});
      expect([path, bk.status, bk.json?.error?.code]).toEqual([path, 403, 'SENSITIVE_HIDDEN']);
    }
    const own = await h.call('owner', 'GET', '/api/v1/imports/batches');
    expect(own.status).toBe(200);
  });
});
