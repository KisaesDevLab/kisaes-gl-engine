// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// The request-scoped closed-period context (lock-context.ts): the
// closing-date password is taken out of the body, is visible to everything
// the handler awaits, and is forgotten once the response is done, so work
// the handler left running can't use it later.

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { getLockContext, lockContextMiddleware } from './lock-context.js';

function fakeRequest(body: Record<string, unknown>): Request {
  return { body, userType: 'staff', userId: 'u-1' } as unknown as Request;
}

describe('lockContextMiddleware', () => {
  for (const event of ['finish', 'close'] as const) {
    it(`forgets the password and the override confirmation on response ${event}`, async () => {
      const req = fakeRequest({ closingPassword: 'closing-pass-123', overrideConfirmed: true, memo: 'x' });
      const res = new EventEmitter();
      let seen: ReturnType<typeof getLockContext>;
      let later: Promise<ReturnType<typeof getLockContext>> | undefined;
      await new Promise<void>((resolve) => {
        lockContextMiddleware(req, res as unknown as Response, () => {
          seen = { ...getLockContext()! };
          // Work the handler starts without awaiting; it runs after the response.
          later = new Promise((r) => setImmediate(() => r(getLockContext() ? { ...getLockContext()! } : undefined)));
          resolve();
        });
      });
      expect(req.body).toEqual({ overrideConfirmed: true, memo: 'x' });
      expect(seen!).toMatchObject({ closingPassword: 'closing-pass-123', overrideConfirmed: true, userId: 'u-1', userType: 'staff' });

      res.emit(event);
      const after = await later!;
      expect(after).toBeDefined();
      expect(after!.closingPassword).toBeUndefined();
      expect(after!.overrideConfirmed).toBe(false);
      expect(after!.userId).toBe('u-1');
    });
  }

  it('a request without a password carries none', async () => {
    const res = new EventEmitter();
    let ctx: ReturnType<typeof getLockContext>;
    await new Promise<void>((resolve) => {
      lockContextMiddleware(fakeRequest({ closingPassword: '' }), res as unknown as Response, () => {
        ctx = getLockContext();
        resolve();
      });
    });
    expect(ctx!).toBeDefined();
    expect('closingPassword' in ctx!).toBe(false);
  });
});
