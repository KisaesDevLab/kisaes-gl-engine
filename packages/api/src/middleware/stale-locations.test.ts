// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// The 428 check and the routes read the stamp from the same place (P33
// review S3): a stamp the check accepted, in the body or the query, is the
// stamp the route compares. Every stale-checked operation of openapi.json is
// covered structurally; one route per class runs live in LAN mode.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Request, Response } from 'express';
import { startLanEngine, DEVICE_A, type LanEngine } from '../desktop/lan.test-support.js';
import { requiredStampField, stampLocations, stampOf } from './stale-required.js';

const ID = '0b6c2a4e-6f6e-4c1d-8a37-6c1f4d8e9a01';
const STAMP = '2020-01-02T03:04:05.678Z';

interface Op { method: string; path: string; field: string; cls: string }

function staleOps(): Op[] {
  const spec = JSON.parse(readFileSync(new URL('../../../../openapi.json', import.meta.url), 'utf8')) as {
    paths: Record<string, Record<string, { 'x-stale'?: string }>>;
  };
  const ops: Op[] = [];
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const [m, op] of Object.entries(item)) {
      const cls = op?.['x-stale'];
      if (!cls || !(cls.startsWith('stale(') || cls === 'bulk')) continue;
      const path = p.replace(/\{[^}]+\}/g, ID);
      const field = requiredStampField(m.toUpperCase(), path);
      if (field) ops.push({ method: m.toUpperCase(), path, field, cls });
    }
  }
  return ops;
}

function run(op: Op, where: 'body' | 'query', value: unknown): Request {
  const req = {
    method: op.method, path: op.path,
    body: where === 'body' ? { [op.field]: value } : {},
    query: where === 'query' ? { [op.field]: String(value) } : {},
  } as unknown as Request;
  stampLocations()(req, {} as Response, () => undefined);
  return req;
}

describe('stamp locations (P33 review S3)', () => {
  const ops = staleOps();

  it('covers every stale-checked class', () => {
    expect(new Set(ops.map((o) => o.field))).toEqual(new Set(['expectedUpdatedAt', 'version', 'stamps']));
    expect(new Set(ops.map((o) => o.cls))).toEqual(new Set(['stale(updatedAt)', 'stale(version)', 'stale(schedule)', 'bulk']));
    expect(ops.length).toBeGreaterThan(50);
  });

  it('a stamp accepted in either place reaches both places, for every stale(*) operation', () => {
    for (const op of ops.filter((o) => o.field !== 'stamps')) {
      const value = op.field === 'version' ? 3 : STAMP;
      for (const where of ['body', 'query'] as const) {
        const req = run(op, where, value);
        const label = `${op.method} ${op.path} (${where})`;
        expect(stampOf(req, op.field), label).toBeDefined();
        expect((req.body as Record<string, unknown>)[op.field], label).toBe(value);
        expect(req.query[op.field], label).toBe(String(value));
      }
    }
  });

  it('bulk stamps count only as a body map', () => {
    for (const op of ops.filter((o) => o.field === 'stamps')) {
      expect(stampOf(run(op, 'query', 'x'), 'stamps'), op.path).toBeUndefined();
      expect(stampOf(run(op, 'body', { [ID]: STAMP }), 'stamps'), op.path).toBeDefined();
    }
  });

  it('a null body stamp falls back to the query, as the route reads it', async () => {
    const { takeExpectedUpdatedAt } = await import('../services/stale-context.js');
    const req = { method: 'DELETE', path: `/api/v1/transactions/${ID}`, body: { expectedUpdatedAt: null }, query: { expectedUpdatedAt: STAMP } } as unknown as Request;
    expect(stampOf(req, 'expectedUpdatedAt')).toBe(STAMP);
    expect(takeExpectedUpdatedAt(req)).toBe(STAMP);
  });
});

describe('stamp locations, live (LAN)', () => {
  let e: LanEngine;
  let jwt = '';
  let accA = '';
  let accB = '';
  const A = { device: DEVICE_A };
  const je = async () => {
    const c = await e.call(A, '/api/v1/transactions', { method: 'POST', jwt, body: {
      txnType: 'journal_entry', txnDate: '2026-03-02', memo: 'locations',
      lines: [{ accountId: accA, debit: '5.00', credit: '0' }, { accountId: accB, debit: '0', credit: '5.00' }],
    } });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    return c.json.transaction as { id: string; updatedAt: string };
  };

  beforeAll(async () => {
    e = await startLanEngine();
    jwt = await e.signIn(A);
    const r = await e.call(A, '/api/v1/accounts', { jwt });
    const list = (r.json.data ?? r.json.accounts ?? r.json) as Array<{ id: string; accountType: string }>;
    const exp = list.filter((a) => a.accountType === 'expense');
    accA = exp[0]!.id;
    accB = exp[1]!.id;
  }, 300_000);

  afterAll(async () => {
    await e?.close();
  });

  it('stale(updatedAt): DELETE with a stale stamp in the query is 409, not a delete', async () => {
    const t = await je();
    const r = await e.call(A, `/api/v1/transactions/${t.id}?expectedUpdatedAt=${encodeURIComponent(STAMP)}`, { method: 'DELETE', jwt });
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(r.json.error.code).toBe('STALE');
    expect((await e.query<{ status: string }>('SELECT status FROM transactions WHERE id = $1', [t.id]))[0]!.status).toBe('posted');
  });

  it('stale(updatedAt): a void with a stale stamp in the query is 409, not a void', async () => {
    const t = await je();
    const r = await e.call(A, `/api/v1/transactions/${t.id}/void?expectedUpdatedAt=${encodeURIComponent(STAMP)}`, { method: 'POST', jwt, body: { reason: 'x' } });
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect((await e.query<{ status: string }>('SELECT status FROM transactions WHERE id = $1', [t.id]))[0]!.status).toBe('posted');
    // The current stamp in the query is honoured.
    const ok = await e.call(A, `/api/v1/transactions/${t.id}/void?expectedUpdatedAt=${encodeURIComponent(t.updatedAt)}`, { method: 'POST', jwt, body: { reason: 'x' } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  });

  it('stale(version): DELETE with a stale version in the body is 409, not a delete', async () => {
    const c = await e.call(A, '/api/v1/budgets', { method: 'POST', jwt, body: { name: 'Locations', fiscalYear: 2026 } });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    const id = c.json.budget.id as string;
    const r = await e.call(A, `/api/v1/budgets/${id}`, { method: 'DELETE', jwt, body: { version: 999 } });
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(r.json.error.code).toBe('STALE_VERSION');
    expect((await e.query('SELECT 1 FROM budgets WHERE id = $1', [id])).length).toBe(1);
  });

  it('bulk: stamps in the query are not stamps (428)', async () => {
    const r = await e.call(A, '/api/v1/tags/bulk-tag?stamps=x', { method: 'POST', jwt, body: { transactionIds: [], tagIds: [] } });
    expect(r.status, JSON.stringify(r.json)).toBe(428);
  });
});
