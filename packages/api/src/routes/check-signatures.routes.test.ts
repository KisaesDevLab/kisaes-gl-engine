// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// /api/v1/check-signatures:
//   - owner CRUD + assignment; non-owner 403 on management
//   - 600×200 hard limit (601 wide → 400 SIGNATURE_TOO_LARGE)
//   - bytes on disk are ciphertext, never the raw PNG
//   - /mine reflects assignment; preview authz owner/assignee only
//   - cross-tenant ids 404
//   - step-up: wrong password 401 (+audit), right password → token that
//     verifyStepUpToken accepts for that user/tenant only

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { inArray, and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, auditLog, checkSignatures, checkSignatureUsers } from '../db/schema/index.js';
import { checkSignaturesRouter } from './check-signatures.routes.js';
import * as authService from '../services/auth.service.js';
import * as signatureService from '../services/check-signature.service.js';
import { env } from '../config/env.js';

let server: Server | null = null;
let port = 0;

const OWNER_EMAIL = 'check-sig-owner@example.com';
const STAFF_EMAIL = 'check-sig-staff@example.com';
const OTHER_OWNER_EMAIL = 'check-sig-other-owner@example.com';

function makePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

async function cleanDb() {
  const owned = await db.select({ id: users.tenantId }).from(users)
    .where(inArray(users.email, [OWNER_EMAIL, STAFF_EMAIL, OTHER_OWNER_EMAIL]));
  const tenantIds = [...new Set(owned.map((r) => r.id))];
  if (tenantIds.length === 0) return;
  await db.delete(checkSignatureUsers).where(inArray(checkSignatureUsers.tenantId, tenantIds));
  await db.delete(checkSignatures).where(inArray(checkSignatures.tenantId, tenantIds));
  await db.delete(auditLog).where(inArray(auditLog.tenantId, tenantIds));
  await db.delete(accounts).where(inArray(accounts.tenantId, tenantIds));
  await db.delete(companies).where(inArray(companies.tenantId, tenantIds));
  await db.delete(sessions).where(
    inArray(sessions.userId, db.select({ id: users.id }).from(users).where(inArray(users.tenantId, tenantIds))),
  );
  await db.delete(users).where(inArray(users.tenantId, tenantIds));
  await db.delete(tenants).where(inArray(tenants.id, tenantIds));
}

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/check-signatures', checkSignaturesRouter);
  app.use((err: Error & { statusCode?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err.name === 'ZodError' ? 400 : (err.statusCode ?? 500);
    res.status(status).json({ error: { message: err.message, code: err.code } });
  });
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
}

function rawRequest(method: string, pathname: string, opts: { body?: Buffer; headers?: Record<string, string>; token?: string }): Promise<{ status: number; body: Buffer; json: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: pathname, method,
        headers: {
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.body ? { 'Content-Length': String(opts.body.length) } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          let json: Record<string, any> = {};
          try { json = JSON.parse(body.toString('utf8')); } catch { /* binary */ }
          resolve({ status: res.statusCode ?? 0, body, json });
        });
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function request(method: string, pathname: string, body?: unknown, token?: string) {
  return rawRequest(method, pathname, {
    body: body ? Buffer.from(JSON.stringify(body)) : undefined,
    headers: { 'Content-Type': 'application/json' },
    token,
  });
}

/** Multipart upload with an `image` file part + text fields. */
function uploadRequest(method: string, pathname: string, image: Buffer, fields: Record<string, string>, token: string) {
  const boundary = '----kisbookssigtest';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="sig.png"\r\nContent-Type: image/png\r\n\r\n`));
  parts.push(image);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return rawRequest(method, pathname, {
    body: Buffer.concat(parts),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    token,
  });
}

beforeEach(async () => {
  await cleanDb();
  await startApp();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await cleanDb();
});

async function setup() {
  const owner = await authService.register({
    email: OWNER_EMAIL, password: 'password123',
    displayName: 'Sig Owner', companyName: 'Sig Co',
  });
  const staff = await authService.inviteUser(owner.user.tenantId, {
    email: STAFF_EMAIL, displayName: 'Sig Staff', role: 'bookkeeper',
  }, owner.user.id);
  const staffLogin = await authService.login({ email: STAFF_EMAIL, password: staff.temporaryPassword! });
  return { owner, staff, staffToken: staffLogin.tokens.accessToken };
}

describe('check signature management', () => {
  it('owner creates, lists, assigns; bytes on disk are encrypted', async () => {
    const { owner, staff } = await setup();
    const png = makePng(600, 200);
    const created = await uploadRequest('POST', '/api/v1/check-signatures', png, { label: 'Kurt W', maxAmount: '5000.00' }, owner.tokens.accessToken);
    expect(created.status).toBe(201);
    const sigId = created.json['signature'].id;
    expect(created.json['signature'].width).toBe(600);
    expect(Number(created.json['signature'].maxAmount)).toBe(5000);

    // On-disk bytes are ciphertext, not the PNG.
    const row = await db.query.checkSignatures.findFirst({ where: eq(checkSignatures.id, sigId) });
    const disk = fs.readFileSync(path.join(env.UPLOAD_DIR, row!.filePath));
    expect(disk.subarray(0, 4).equals(png.subarray(0, 4))).toBe(false);

    const assign = await request('PUT', `/api/v1/check-signatures/${sigId}/users`, { userIds: [staff.user.id] }, owner.tokens.accessToken);
    expect(assign.status).toBe(200);

    const list = await request('GET', '/api/v1/check-signatures', undefined, owner.tokens.accessToken);
    expect(list.status).toBe(200);
    expect(list.json['signatures']).toHaveLength(1);
    expect(list.json['signatures'][0].users.map((u: any) => u.id)).toEqual([staff.user.id]);
  });

  it('hard-rejects oversized images with the actual dimensions', async () => {
    const { owner } = await setup();
    const res = await uploadRequest('POST', '/api/v1/check-signatures', makePng(601, 200), { label: 'Too Wide' }, owner.tokens.accessToken);
    expect(res.status).toBe(400);
    expect(res.json['error'].code).toBe('SIGNATURE_TOO_LARGE');
    expect(res.json['error'].message).toContain('601×200');
    const tall = await uploadRequest('POST', '/api/v1/check-signatures', makePng(600, 201), { label: 'Too Tall' }, owner.tokens.accessToken);
    expect(tall.status).toBe(400);
  });

  it('refuses non-owners on management routes', async () => {
    const { owner, staffToken } = await setup();
    const created = await uploadRequest('POST', '/api/v1/check-signatures', makePng(10, 10), { label: 'Owner Sig' }, owner.tokens.accessToken);
    const sigId = created.json['signature'].id;

    expect((await uploadRequest('POST', '/api/v1/check-signatures', makePng(10, 10), { label: 'Nope' }, staffToken)).status).toBe(403);
    expect((await request('GET', '/api/v1/check-signatures', undefined, staffToken)).status).toBe(403);
    expect((await request('PUT', `/api/v1/check-signatures/${sigId}`, { label: 'Hax' }, staffToken)).status).toBe(403);
    expect((await request('DELETE', `/api/v1/check-signatures/${sigId}`, undefined, staffToken)).status).toBe(403);
  });

  it('404s cross-tenant signature ids', async () => {
    const { owner } = await setup();
    const created = await uploadRequest('POST', '/api/v1/check-signatures', makePng(10, 10), { label: 'Mine' }, owner.tokens.accessToken);
    const sigId = created.json['signature'].id;
    const other = await authService.register({
      email: OTHER_OWNER_EMAIL, password: 'password123',
      displayName: 'Other Owner', companyName: 'Other Co',
    });
    expect((await request('PUT', `/api/v1/check-signatures/${sigId}`, { label: 'Steal' }, other.tokens.accessToken)).status).toBe(404);
    expect((await rawRequest('GET', `/api/v1/check-signatures/${sigId}/image`, { token: other.tokens.accessToken })).status).toBe(403);
  });

  it('/mine and image preview follow assignment', async () => {
    const { owner, staff, staffToken } = await setup();
    const png = makePng(400, 120);
    const created = await uploadRequest('POST', '/api/v1/check-signatures', png, { label: 'Shared' }, owner.tokens.accessToken);
    const sigId = created.json['signature'].id;

    // Unassigned: /mine empty, preview 403. Owner: sees all, preview 200.
    expect((await request('GET', '/api/v1/check-signatures/mine', undefined, staffToken)).json['signatures']).toHaveLength(0);
    expect((await rawRequest('GET', `/api/v1/check-signatures/${sigId}/image`, { token: staffToken })).status).toBe(403);
    expect((await request('GET', '/api/v1/check-signatures/mine', undefined, owner.tokens.accessToken)).json['signatures']).toHaveLength(1);

    await request('PUT', `/api/v1/check-signatures/${sigId}/users`, { userIds: [staff.user.id] }, owner.tokens.accessToken);

    const mine = await request('GET', '/api/v1/check-signatures/mine', undefined, staffToken);
    expect(mine.json['signatures'].map((s: any) => s.id)).toEqual([sigId]);
    const img = await rawRequest('GET', `/api/v1/check-signatures/${sigId}/image`, { token: staffToken });
    expect(img.status).toBe(200);
    expect(img.body.equals(png)).toBe(true); // decrypted round-trip
  });

  it('soft delete hides the signature and removes the file', async () => {
    const { owner } = await setup();
    const created = await uploadRequest('POST', '/api/v1/check-signatures', makePng(10, 10), { label: 'Gone' }, owner.tokens.accessToken);
    const sigId = created.json['signature'].id;
    const row = await db.query.checkSignatures.findFirst({ where: eq(checkSignatures.id, sigId) });

    expect((await request('DELETE', `/api/v1/check-signatures/${sigId}`, undefined, owner.tokens.accessToken)).status).toBe(200);
    expect((await request('GET', '/api/v1/check-signatures', undefined, owner.tokens.accessToken)).json['signatures']).toHaveLength(0);
    expect(fs.existsSync(path.join(env.UPLOAD_DIR, row!.filePath))).toBe(false);
    const after = await db.query.checkSignatures.findFirst({ where: eq(checkSignatures.id, sigId) });
    expect(after!.isActive).toBe(false); // row survives for print history
  });
});

describe('step-up re-authentication', () => {
  it('rejects a wrong password with 401 and audits the failure', async () => {
    const { owner } = await setup();
    const res = await request('POST', '/api/v1/check-signatures/step-up', { password: 'wrong-password' }, owner.tokens.accessToken);
    expect(res.status).toBe(401);
    const rows = await db.select().from(auditLog).where(and(
      eq(auditLog.tenantId, owner.user.tenantId), eq(auditLog.entityType, 'check_signature_stepup'),
    ));
    expect(rows.length).toBe(1);
    const after = rows[0]!.afterData;
    expect(typeof after === 'string' ? JSON.parse(after) : after).toMatchObject({ success: false, method: 'password' });
  });

  it('mints a scoped token on the right password', async () => {
    const { owner } = await setup();
    const res = await request('POST', '/api/v1/check-signatures/step-up', { password: 'password123' }, owner.tokens.accessToken);
    expect(res.status).toBe(200);
    const { stepUpToken } = res.json as { stepUpToken: string };
    expect(signatureService.verifyStepUpToken(stepUpToken, owner.user.id, owner.user.tenantId)).toBe(true);
    // Scoped: another user/tenant can't reuse it.
    expect(signatureService.verifyStepUpToken(stepUpToken, crypto.randomUUID(), owner.user.tenantId)).toBe(false);
    expect(signatureService.verifyStepUpToken('garbage', owner.user.id, owner.user.tenantId)).toBe(false);
  });

  it('400s when neither credential is supplied', async () => {
    const { owner } = await setup();
    expect((await request('POST', '/api/v1/check-signatures/step-up', {}, owner.tokens.accessToken)).status).toBe(400);
  });
});
