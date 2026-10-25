// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// The idempotent() middleware and the claim service on test routes (U-18):
//   E3  key shape boundaries -> 400 IDEMPOTENCY_KEY_INVALID;
//   E16 no context -> claim is a no-op;
//   E17 response redaction (canary secret key) and log hygiene;
//   E18 TTL: expired rows ignored, replaced on claim, swept;
//   route bugs: a 2xx without a claim, a claim in a second transaction or
//   inside a savepoint; settlement on error; the size cap.

import 'express-async-errors';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { idempotencyKeys } from '../db/schema/index.js';
import { idempotent, routeTemplate } from './idempotent.js';
import { errorHandler } from './error-handler.js';
import {
  claimIdempotency, recordIdempotentEntity, sweepExpired, findLive,
  __idempotencyDiagnostics, __idempotencyTestHooks,
} from '../services/idempotency.service.js';
import { AppError } from '../utils/errors.js';
import { makeCompany, cleanTenant, type Co } from '../services/templates/templates.test-helpers.js';

interface Res { status: number; json: any; headers: http.IncomingHttpHeaders }

let c: Co;
const tenantIds: string[] = [];
let server: Server;
let port = 0;
let executions = 0;

function fakeAuth(req: express.Request, _res: express.Response, next: express.NextFunction) {
  req.tenantId = c.tenantId;
  req.userId = (req.get('X-Test-User') ?? c.userId);
  req.companyId = req.get('X-Company-Id') ?? c.companyId;
  next();
}

beforeAll(async () => {
  c = await makeCompany('idem-mw', tenantIds);
  const app = express();
  app.use(express.json());
  const r = express.Router();
  r.use(fakeAuth);
  r.post('/things', idempotent({
    successStatus: 201,
    replay: async (_req, entity) => ({ thing: { id: entity?.id, reread: true } }),
  }), async (req, res) => {
    const id = crypto.randomUUID();
    await db.transaction(async (tx) => {
      await claimIdempotency(tx);
      await recordIdempotentEntity(tx, 'thing', id);
      if ((req.body as { fail?: string }).fail === 'in-tx') throw AppError.badRequest('refused', 'REFUSED');
    });
    executions++;
    if ((req.body as { fail?: string }).fail === 'after-commit') throw new Error('after commit');
    res.status(201).json({ thing: { id, big: (req.body as { big?: string }).big }, apiKey: 'canary-secret', nested: { accessToken: 'canary-token', ok: true } });
  });
  r.post('/things/:id/gone', idempotent({
    successStatus: 200,
    replay: async () => { throw new Error('record gone'); },
  }), async (_req, res) => {
    await db.transaction(async (tx) => { await claimIdempotency(tx); await recordIdempotentEntity(tx, 'thing', c.companyB); });
    res.json({ ok: true });
  });
  r.post('/unclaimed', idempotent({ successStatus: 200 }), async (_req, res) => { res.json({ ok: true }); });
  r.post('/two-tx', idempotent({ successStatus: 200 }), async (_req, res) => {
    await db.transaction(async (tx) => { await claimIdempotency(tx); });
    await db.transaction(async (tx) => { await claimIdempotency(tx); });
    res.json({ ok: true });
  });
  r.post('/savepoint', idempotent({ successStatus: 200 }), async (_req, res) => {
    await db.transaction(async (tx) => { await tx.transaction(async (sp) => { await claimIdempotency(sp); }); });
    res.json({ ok: true });
  });
  r.post('/reentrant', idempotent({ successStatus: 201 }), async (_req, res) => {
    await db.transaction(async (tx) => {
      await claimIdempotency(tx);
      await recordIdempotentEntity(tx, 'thing', c.companyId);
      await claimIdempotency(tx);
      await recordIdempotentEntity(tx, 'thing', c.companyB);
    });
    res.status(201).json({ ok: true });
  });
  app.use('/api/v1/test', r);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server.address() as AddressInfo).port; resolve(); }); });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

beforeEach(() => { executions = 0; __idempotencyDiagnostics.unclaimed.length = 0; });
afterEach(() => {
  delete __idempotencyTestHooks.settle;
  delete __idempotencyTestHooks.capBytes;
  delete __idempotencyTestHooks.afterClaim;
});

function post(pathname: string, body: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(data.length), ...headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (ch) => chunks.push(ch));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const newKey = () => crypto.randomUUID();
const rowsOf = (key: string) => db.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.tenantId, c.tenantId), eq(idempotencyKeys.idempotencyKey, key)));

describe('E3 key shape', () => {
  it.each([
    ['15 characters', 'a'.repeat(15)],
    ['65 characters', 'a'.repeat(65)],
    ['a dot', `${'a'.repeat(20)}.b`],
    ['a space', `${'a'.repeat(20)} b`],
    ['a non-ASCII letter', `${'a'.repeat(20)}é`],
  ])('%s -> 400 IDEMPOTENCY_KEY_INVALID, nothing runs', async (_label, key) => {
    const r = await post('/api/v1/test/things', { n: 1 }, { 'Idempotency-Key': key });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('IDEMPOTENCY_KEY_INVALID');
    expect(executions).toBe(0);
  });

  it.each([['16 characters', 'a'.repeat(16)], ['64 characters', `${'Z9_-'.repeat(16)}`]])('%s is accepted', async (_label, key) => {
    await db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.tenantId, c.tenantId), eq(idempotencyKeys.idempotencyKey, key)));
    const r = await post('/api/v1/test/things', { n: 1 }, { 'Idempotency-Key': key });
    expect(r.status).toBe(201);
    expect(executions).toBe(1);
  });

  it('no header: runs every time, stores nothing', async () => {
    const before = (await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.tenantId, c.tenantId))).length;
    expect((await post('/api/v1/test/things', { n: 1 })).status).toBe(201);
    expect((await post('/api/v1/test/things', { n: 1 })).status).toBe(201);
    expect(executions).toBe(2);
    expect((await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.tenantId, c.tenantId))).length).toBe(before);
  });
});

describe('replay and settlement', () => {
  it('route template, replay header, one execution', async () => {
    const key = newKey();
    const a = await post('/api/v1/test/things', { n: 1 }, { 'Idempotency-Key': key });
    const b = await post('/api/v1/test/things', { n: 1 }, { 'Idempotency-Key': key });
    expect(a.status).toBe(201);
    expect(a.headers['idempotent-replayed']).toBeUndefined();
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json.thing).toEqual(a.json.thing);
    expect(executions).toBe(1);
    const [row] = await rowsOf(key);
    expect(row).toMatchObject({ state: 'done', route: 'POST /test/things', responseStatus: 201, successStatus: 201, entityType: 'thing' });
    expect(routeTemplate({ method: 'post', baseUrl: '/api/v1/transactions', route: { path: '/:id/void' } } as never)).toBe('POST /transactions/:id/void');
  });

  it('a refusal inside the transaction stores nothing; the retry runs again', async () => {
    const key = newKey();
    const a = await post('/api/v1/test/things', { fail: 'in-tx' }, { 'Idempotency-Key': key });
    expect(a.status).toBe(400);
    expect(await rowsOf(key)).toHaveLength(0);
    const b = await post('/api/v1/test/things', { fail: 'in-tx' }, { 'Idempotency-Key': key });
    expect(b.status).toBe(400);
    expect(b.headers['idempotent-replayed']).toBeUndefined();
  });

  it('a failure after the commit is settled as a replay of the committed row', async () => {
    const key = newKey();
    const a = await post('/api/v1/test/things', { fail: 'after-commit' }, { 'Idempotency-Key': key });
    expect(a.status).toBe(201);
    expect(a.headers['idempotent-replayed']).toBe('true');
    expect(a.json.thing.reread).toBe(true);
    expect(executions).toBe(1);
  });

  it('re-entrant claims on one transaction; the first record wins', async () => {
    const key = newKey();
    expect((await post('/api/v1/test/reentrant', {}, { 'Idempotency-Key': key })).status).toBe(201);
    const [row] = await rowsOf(key);
    expect(row!.entityId).toBe(c.companyId);
  });

  it('reader failure: 200 minimal committed body', async () => {
    const key = newKey();
    __idempotencyTestHooks.settle = () => { throw new Error('settle down'); };
    expect((await post('/api/v1/test/things/x/gone', {}, { 'Idempotency-Key': key })).status).toBe(200);
    delete __idempotencyTestHooks.settle;
    const r = await post('/api/v1/test/things/x/gone', {}, { 'Idempotency-Key': key });
    expect(r.status).toBe(200);
    expect(r.headers['idempotent-replayed']).toBe('true');
    expect(r.json).toEqual({ idempotency: { state: 'committed', entityType: 'thing', entityId: c.companyB } });
  });

  it('over the size cap: no body stored, the reader replays with the success status', async () => {
    __idempotencyTestHooks.capBytes = 200;
    const key = newKey();
    const a = await post('/api/v1/test/things', { big: 'x'.repeat(500) }, { 'Idempotency-Key': key });
    expect(a.status).toBe(201);
    const [row] = await rowsOf(key);
    expect(row).toMatchObject({ state: 'done', responseBody: null, responseTruncated: true });
    const b = await post('/api/v1/test/things', { big: 'x'.repeat(500) }, { 'Idempotency-Key': key });
    expect(b.status).toBe(201);
    expect(b.json).toEqual({ thing: { id: row!.entityId, reread: true } });
  });
});

describe('route bugs are caught in tests', () => {
  it('a 2xx without a claim is logged as IDEMPOTENCY_UNCLAIMED and still sent', async () => {
    const r = await post('/api/v1/test/unclaimed', {}, { 'Idempotency-Key': newKey() });
    expect(r.status).toBe(200);
    expect(__idempotencyDiagnostics.unclaimed).toEqual(['POST /test/unclaimed']);
  });

  it('a claim in a second database transaction is IDEMPOTENCY_MULTI_TX', async () => {
    const r = await post('/api/v1/test/two-tx', {}, { 'Idempotency-Key': newKey() });
    expect(r.status).toBe(500);
    expect(r.json.error.code).toBe('IDEMPOTENCY_MULTI_TX');
  });

  it('a claim inside a savepoint is IDEMPOTENCY_SAVEPOINT', async () => {
    const r = await post('/api/v1/test/savepoint', {}, { 'Idempotency-Key': newKey() });
    expect(r.status).toBe(500);
    expect(r.json.error.code).toBe('IDEMPOTENCY_SAVEPOINT');
  });
});

describe('E16 no context', () => {
  it('claim and record are no-ops outside a keyed request', async () => {
    const before = (await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.tenantId, c.tenantId))).length;
    await db.transaction(async (tx) => {
      await claimIdempotency(tx);
      await recordIdempotentEntity(tx, 'thing', c.companyId);
    });
    expect((await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.tenantId, c.tenantId))).length).toBe(before);
  });
});

describe('E17 redaction and logs', () => {
  it('secret-looking keys never reach response_body; logs carry no body and at most 8 key characters', async () => {
    const key = newKey();
    const lines: string[] = [];
    const prevLevel = process.env['LOG_LEVEL'];
    process.env['LOG_LEVEL'] = 'debug';
    const spyLog = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    const spyErr = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    try {
      const a = await post('/api/v1/test/things', { n: 1, memo: 'Rivera kitchen' }, { 'Idempotency-Key': key });
      expect(a.json.apiKey).toBe('canary-secret');
      const b = await post('/api/v1/test/things', { n: 1, memo: 'Rivera kitchen' }, { 'Idempotency-Key': key });
      expect(b.headers['idempotent-replayed']).toBe('true');
      expect(b.json.apiKey).toBeUndefined();
      expect(b.json.nested).toEqual({ ok: true });
    } finally {
      spyLog.mockRestore(); spyWarn.mockRestore(); spyErr.mockRestore();
      if (prevLevel === undefined) delete process.env['LOG_LEVEL']; else process.env['LOG_LEVEL'] = prevLevel;
    }
    const [row] = await rowsOf(key);
    const stored = JSON.stringify(row!.responseBody);
    expect(stored).not.toContain('canary');
    const joined = lines.join('\n');
    expect(joined).toContain(key.slice(0, 8));
    expect(joined).not.toContain(key.slice(0, 9));
    expect(joined).not.toContain('Rivera kitchen');
    expect(joined).not.toContain('canary');
  });
});

describe('E18 TTL', () => {
  it('an expired row is ignored by the lookup, replaced on claim and removed by the sweep', async () => {
    const key = newKey();
    expect((await post('/api/v1/test/things', { n: 1 }, { 'Idempotency-Key': key })).status).toBe(201);
    await db.execute(sql`UPDATE idempotency_keys SET created_at = now() - interval '25 hours' WHERE tenant_id = ${c.tenantId} AND idempotency_key = ${key}`);
    expect(await findLive(c.tenantId, c.userId, key)).toBeUndefined();
    // Another body with the old key: not a reuse once expired; it runs and replaces the row.
    const r = await post('/api/v1/test/things', { n: 2 }, { 'Idempotency-Key': key });
    expect(r.status).toBe(201);
    expect(r.headers['idempotent-replayed']).toBeUndefined();
    expect(executions).toBe(2);
    expect(await rowsOf(key)).toHaveLength(1);

    const old = newKey();
    await db.insert(idempotencyKeys).values({
      tenantId: c.tenantId, companyId: c.companyId, userId: c.userId, idempotencyKey: old, route: 'POST /test/things',
      requestSha256: '0'.repeat(64), state: 'done', successStatus: 201, createdAt: new Date(Date.now() - 25 * 3600 * 1000),
    });
    expect(await sweepExpired()).toBeGreaterThanOrEqual(1);
    expect(await rowsOf(old)).toHaveLength(0);
    expect(await rowsOf(key)).toHaveLength(1);
  });
});
