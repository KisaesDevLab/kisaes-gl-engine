// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { countArrayElements, jsonArrayCap, JSON_ARRAY_ELEMENT_CAP } from './json-array-cap.js';
import { validate } from './validate.js';
import { errorHandler } from './error-handler.js';

describe('countArrayElements', () => {
  it('sums every array at every depth', () => {
    expect(countArrayElements({ a: [1, 2, 3], b: { c: [[1], [2, 3]] }, d: 'x' })).toBe(3 + 2 + 1 + 2);
    expect(countArrayElements([])).toBe(0);
    expect(countArrayElements('not an object')).toBe(0);
    expect(countArrayElements(null)).toBe(0);
  });

  it('stops counting once the cap is exceeded', () => {
    const body = { rows: new Array(1_000).fill(0) };
    const n = countArrayElements(body, 10);
    expect(n).toBeGreaterThan(10);
    expect(n).toBeLessThanOrEqual(1_000);
  });

  it('walks a deeply nested body without overflowing the stack', () => {
    let v: unknown = [1];
    for (let i = 0; i < 100_000; i++) v = [v];
    expect(countArrayElements(v)).toBe(100_001);
  });

  it('defaults to a cap far above every declared array limit', () => {
    expect(JSON_ARRAY_ELEMENT_CAP).toBeGreaterThanOrEqual(25 * 10_000);
  });
});

describe('jsonArrayCap', () => {
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(jsonArrayCap(5));
    // Every element fails this schema, so without the cap zod would record
    // one issue per element.
    app.post('/t', validate(z.object({ rows: z.array(z.object({ id: z.string().uuid() })) })), (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = async (body: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/t`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as { error?: { code?: string } } | null };
  };

  it('lets a body at the cap through to validation', async () => {
    const res = await post(JSON.stringify({ rows: new Array(5).fill({ id: 'x' }) }));
    expect(res.status).toBe(400); // zod validation refused it, not the cap
  });

  it('refuses a body over the cap before validation runs, with a stable code', async () => {
    const res = await post(JSON.stringify({ rows: new Array(6).fill({ id: 'x' }) }));
    expect(res.status).toBe(413);
    expect(res.json?.error?.code).toBe('BODY_TOO_MANY_ELEMENTS');
  });

  it('counts nested arrays toward the cap', async () => {
    const res = await post(JSON.stringify({ rows: [{ id: 'x', tags: [1, 2, 3, 4, 5] }] }));
    expect(res.status).toBe(413);
  });

  it('ignores non-object bodies', async () => {
    const res = await post('"a string"');
    expect(res.status).not.toBe(413);
  });
});
