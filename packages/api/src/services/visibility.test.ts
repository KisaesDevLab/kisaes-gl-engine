// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// services/visibility.ts (U-33): the hidden set (descendants included),
// byte-identical SQL when nothing is hidden, no viewer hides nothing, the
// refusal table, and the viewer surviving a multipart upload.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express, { type Request } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { authenticate } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import {
  andVisible, hiddenAccountIds, hiddenNotice, isConvertedRoute, underRefusePrefix, sensitiveAccountIds,
  reenterViewer, runWithoutViewer,
} from './visibility.js';
import { startSensitiveHarness, type SensitiveHarness } from '../routes/sensitive.test-fixtures.js';

const dialect = new PgDialect();

describe('andVisible / hiddenNotice (pure)', () => {
  it('an empty hidden set gives byte-identical SQL', () => {
    const base = sql`SELECT a.id FROM accounts a WHERE a.tenant_id = ${'t'}`;
    const withEmpty = sql`SELECT a.id FROM accounts a WHERE a.tenant_id = ${'t'}${andVisible([], sql`a.id`)}`;
    const q1 = dialect.sqlToQuery(base);
    const q2 = dialect.sqlToQuery(withEmpty);
    expect(q2.sql).toBe(q1.sql);
    expect(q2.params).toEqual(q1.params);
    expect(hiddenNotice([])).toBeNull();
  });

  it('a non-empty set adds one <> ALL(uuid[]) condition', () => {
    const q = dialect.sqlToQuery(sql`SELECT 1 FROM accounts a WHERE true${andVisible(['x', 'y'], sql`a.id`)}`);
    expect(q.sql).toBe('SELECT 1 FROM accounts a WHERE true AND a.id <> ALL(ARRAY[$1, $2]::uuid[])');
    expect(q.params).toEqual(['x', 'y']);
    expect(hiddenNotice(['x'])).toBe(true);
  });

  it('refuse prefixes cover the reporting family only', () => {
    expect(underRefusePrefix('/api/v1/reports/profit-loss')).toBe(true);
    expect(underRefusePrefix('/api/v1/reports')).toBe(true);
    expect(underRefusePrefix('/api/v1/reportsx')).toBe(false);
    expect(underRefusePrefix('/api/v1/accounts')).toBe(false);
    expect(isConvertedRoute('GET', '/api/v1/no-such')).toBe(false);
  });
});

describe('hidden set and the viewer store (live)', () => {
  let h: SensitiveHarness;
  let server: http.Server;
  let port = 0;
  let ownerToken = '';
  let bkToken = '';
  const seen: Record<string, string[]> = {};

  beforeAll(async () => {
    h = await startSensitiveHarness('sens-vis');
    ownerToken = jwt.sign({ userId: h.ownerId, tenantId: h.tenantId, role: 'owner', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
    bkToken = jwt.sign({ userId: h.bookkeeperId, tenantId: h.tenantId, role: 'bookkeeper', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
    const app = express();
    app.use(express.json());
    // Two routers under one prefix, as /api/v1/reports has: the first
    // router's authenticate must not refuse requests meant for the second.
    const first = express.Router();
    first.use(authenticate);
    first.get('/one', async (_req, res) => { res.json({ hidden: await hiddenAccountIds() }); });
    const plain = express.Router();
    plain.use(authenticate);
    plain.get('/ids', async (req: Request, res) => { seen[req.userId] = await hiddenAccountIds(); res.json({ hidden: seen[req.userId] }); });
    plain.get('/no-viewer', async (_req, res) => { res.json({ hidden: await runWithoutViewer(() => hiddenAccountIds()) }); });
    const upload = multer({ storage: multer.memoryStorage() });
    plain.post('/upload', upload.single('file'), async (_req, res) => { res.json({ hidden: await hiddenAccountIds() }); });
    plain.post('/upload-reentered', upload.single('file'), reenterViewer, async (_req, res) => { res.json({ hidden: await hiddenAccountIds() }); });
    app.use('/api/v1/reports', first);
    app.use('/api/v1/plain', plain);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await h.close();
  });

  function call(token: string, method: string, path: string, multipart = false): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const boundary = 'xBOUNDARYx';
      const body = multipart
        ? `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`
        : undefined;
      const req = http.request({
        hostname: '127.0.0.1', port, path, method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const t = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : null });
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  it('nothing marked: nobody has hidden accounts, reports are not refused', async () => {
    expect((await call(bkToken, 'GET', '/api/v1/plain/ids')).json.hidden).toEqual([]);
    expect((await call(bkToken, 'GET', '/api/v1/reports/one')).status).toBe(200);
  });

  it('a marked account hides itself and its sub-accounts from the bookkeeper only', async () => {
    await h.markWages();
    const expected = [h.acct.wages, h.acct.wagesSub].sort();
    expect((await sensitiveAccountIds(h.tenantId)).sort()).toEqual(expected);
    expect((await call(bkToken, 'GET', '/api/v1/plain/ids')).json.hidden.sort()).toEqual(expected);
    expect((await call(ownerToken, 'GET', '/api/v1/plain/ids')).json.hidden).toEqual([]);
    expect((await call(bkToken, 'GET', '/api/v1/plain/no-viewer')).json.hidden).toEqual([]);
  });

  it('refuses an unconverted reporting route for the bookkeeper, in any letter case', async () => {
    const r = await call(bkToken, 'GET', '/api/v1/reports/one');
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('SENSITIVE_HIDDEN');
    expect((await call(bkToken, 'GET', '/API/V1/Reports//one/')).status).toBe(403);
    expect((await call(ownerToken, 'GET', '/api/v1/reports/one')).status).toBe(200);
    // A route outside the prefixes is untouched.
    expect((await call(bkToken, 'GET', '/api/v1/plain/ids')).status).toBe(200);
  });

  it('the viewer survives a multipart upload (with reenterViewer as the backstop)', async () => {
    const expected = [h.acct.wages, h.acct.wagesSub].sort();
    const re = await call(bkToken, 'POST', '/api/v1/plain/upload-reentered', true);
    expect(re.status).toBe(200);
    expect(re.json.hidden.sort()).toEqual(expected);
    const plainUpload = await call(bkToken, 'POST', '/api/v1/plain/upload', true);
    expect(plainUpload.status).toBe(200);
    expect(plainUpload.json.hidden.sort()).toEqual(expected);
  });
});
