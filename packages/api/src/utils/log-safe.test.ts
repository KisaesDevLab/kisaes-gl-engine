// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { format } from 'node:util';
import type { Request, Response } from 'express';
import { accessLogUrl, errorSummaryForLog } from './log-safe.js';
import { scrubSecrets } from './secret-scrubber.js';
import { AppError } from './errors.js';
import { loadDesktopProfile, _resetDesktopProfileForTests } from '../desktop/profile.js';
import { errorHandler } from '../middleware/error-handler.js';

// What a drizzle query failure looks like when it reaches the error
// handler: DrizzleQueryError (message carries the params) wrapping a pg
// DatabaseError whose `detail` echoes the row.
function drizzleStyleError(): Error {
  const pgErr = Object.assign(new Error('duplicate key value violates unique constraint "contacts_name_unique"'), {
    name: 'error',
    code: '23505',
    detail: 'Key (tenant_id, display_name)=(t1, Acme Plumbing LLC) already exists.',
    where: 'SQL statement in Ledger Memo Rent for June',
    parameters: ['4821.37', 'Acme Plumbing LLC'],
  });
  const err = new Error(
    'Failed query: insert into "contacts" ("display_name", "opening_balance", "email") values ($1, $2, $3)\n' +
      'params: Acme Plumbing LLC,4821.37,owner@acme-plumbing.com',
  );
  err.name = 'DrizzleQueryError';
  Object.assign(err, { query: 'insert into …', params: ['Acme Plumbing LLC', '4821.37', 'owner@acme-plumbing.com'], cause: pgErr });
  return err;
}

const LEAKS = ['Acme', '4821.37', 'acme-plumbing', 'Rent for June', 'display_name)=('];

afterEach(() => {
  _resetDesktopProfileForTests();
  vi.restoreAllMocks();
});

describe('accessLogUrl', () => {
  it('server: keeps the query string, redacts credentials and path tokens', () => {
    expect(accessLogUrl('/api/v1/contacts?search=Acme&token=abc&limit=5', false)).toBe(
      '/api/v1/contacts?search=Acme&token=[redacted]&limit=5',
    );
    expect(accessLogUrl('/api/w9/abcdef123/form', false)).toBe('/api/w9/[redacted]/form');
  });

  it('desktop: path only', () => {
    expect(accessLogUrl('/api/v1/contacts?search=Acme&amount=4821.37', true)).toBe('/api/v1/contacts');
    expect(accessLogUrl('/api/v1/auth/methods?email=owner@acme.com#x', true)).toBe('/api/v1/auth/methods');
    expect(accessLogUrl('/api/v1/accounts', true)).toBe('/api/v1/accounts');
  });
});

describe('errorSummaryForLog', () => {
  it('names the error and its cause without params, detail or values', () => {
    const line = errorSummaryForLog(drizzleStyleError());
    expect(line.split('\n')[0]).toBe(
      'DrizzleQueryError Failed query (cause: error code=23505 duplicate key value violates unique constraint "contacts_name_unique")',
    );
    for (const leak of LEAKS) expect(line).not.toContain(leak);
    expect(line).toMatch(/\n\s+at /);
  });

  it('drops a quoted input value echoed by pg and caps long messages', () => {
    expect(errorSummaryForLog(Object.assign(new Error('invalid input syntax for type numeric: "48a1.37"'), { stack: '' }))).toBe(
      'Error invalid input syntax for type numeric: "[value]"',
    );
    const long = errorSummaryForLog(Object.assign(new Error('x'.repeat(500)), { stack: '' }));
    expect(long.length).toBeLessThan(220);
  });

  it('an AppError with a code prints its code, status and ids, never the message or amounts in details', () => {
    const id = '0b6f7f1e-3c1a-4d55-9a8e-2f1d7c9b1a01';
    const other = '7a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    const err = Object.assign(
      new AppError(400, 'Splits add up to 4821.37 but the bank line is 4800.00 (Acme Plumbing LLC).', 'SPLITS_DONT_BALANCE',
        { id, paymentIds: [other], difference: '21.37', total: '4821.37', name: 'Acme Plumbing LLC', accountId: 'not-a-uuid' }),
      { stack: '' },
    );
    const line = errorSummaryForLog(err);
    expect(line).toBe(`AppError code=SPLITS_DONT_BALANCE status=400 id=${id} paymentIds=${other}`);
    for (const leak of ['4821.37', '4800.00', '21.37', 'Acme', 'not-a-uuid']) expect(line).not.toContain(leak);
    // As a cause too.
    const wrapped = Object.assign(new Error('Batch failed'), { cause: err, stack: '' });
    expect(errorSummaryForLog(wrapped)).toBe(`Error Batch failed (cause: AppError code=SPLITS_DONT_BALANCE status=400 id=${id} paymentIds=${other})`);
    // No code: the short message, as before.
    expect(errorSummaryForLog(Object.assign(new AppError(500, 'plain'), { stack: '' }))).toBe('AppError plain');
  });

  it('copes with non-errors', () => {
    expect(errorSummaryForLog('boom')).toBe('boom');
    expect(errorSummaryForLog(null)).toBe('null');
  });
});

describe('errorHandler log line', () => {
  function run(): string {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    errorHandler(drizzleStyleError(), {} as Request, res, () => undefined);
    // What the desktop log tee writes: the formatted console line, scrubbed.
    return scrubSecrets(spy.mock.calls.map((args) => format(...args)).join('\n'));
  }

  it('desktop: no amounts, names, emails or memo text reach the log', () => {
    loadDesktopProfile({
      CL_MODE: 'desktop',
      CL_TOKEN: 'logsafe_' + 'q'.repeat(40),
      CL_BIND: '127.0.0.1:0',
      CL_DATA_DIR: path.join(os.tmpdir(), 'cl-log-safe-test'),
    });
    const out = run();
    expect(out).toContain('Unhandled error: DrizzleQueryError Failed query');
    for (const leak of LEAKS) expect(out).not.toContain(leak);
  });

  it('server: unchanged full dump for operators', () => {
    loadDesktopProfile({});
    expect(run()).toContain('params: Acme Plumbing LLC');
  });
});
