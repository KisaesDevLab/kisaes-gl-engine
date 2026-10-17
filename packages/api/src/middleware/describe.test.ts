// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe as suite, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { validate } from './validate.js';
import { describe, getOpenApiMeta, attachOpenApiMeta } from './describe.js';

const res = {} as Response;

suite('validate() OpenAPI metadata', () => {
  it('attaches the body schema without changing request handling', () => {
    const schema = z.object({ amount: z.string().regex(/^-?\d+(\.\d{1,4})?$/), memo: z.string().default('') });
    const mw = validate(schema);
    expect(getOpenApiMeta(mw)).toEqual({ body: schema });
    // Metadata is invisible to enumeration / JSON.
    expect(Object.keys(mw)).toEqual([]);

    const req = { body: { amount: '12.50', extra: 1 } } as unknown as Request;
    const next = vi.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.body).toEqual({ amount: '12.50', memo: '' });
  });

  it('still throws the ZodError for invalid bodies', () => {
    const mw = validate(z.object({ name: z.string() }));
    const next = vi.fn();
    expect(() => mw({ body: {} } as Request, res, next)).toThrow(z.ZodError);
    expect(next).not.toHaveBeenCalled();
  });
});

suite('describe()', () => {
  it('is a pass-through middleware that carries metadata', () => {
    const query = z.object({ page: z.string().optional() });
    const mw = describe({ summary: 'List things', tags: ['things'], query });
    const req = { body: { a: 1 }, query: { page: '2' } } as unknown as Request;
    const next = vi.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.body).toEqual({ a: 1 });
    expect(getOpenApiMeta(mw)).toEqual({ summary: 'List things', tags: ['things'], query });
  });

  it('merges metadata attached more than once and ignores non-functions', () => {
    const fn = attachOpenApiMeta(() => undefined, { summary: 'a' });
    attachOpenApiMeta(fn, { deprecated: true });
    expect(getOpenApiMeta(fn)).toEqual({ summary: 'a', deprecated: true });
    expect(getOpenApiMeta(undefined)).toBeUndefined();
    expect(getOpenApiMeta(() => undefined)).toBeUndefined();
  });
});
