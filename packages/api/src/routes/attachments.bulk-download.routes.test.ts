// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// POST /attachments/bulk-download — streams a ZIP of tenant-scoped
// attachments. Covers: happy path (both seeded files round-trip through
// unzipper), name-collision dedupe, foreign-tenant rejection (404),
// body validation (400), auth requirement (401), and the Bearer-header
// single-download path the web client uses.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// UPLOAD_DIR must be set before any module (config/env, LocalProvider)
// reads it. vi.hoisted runs ahead of the hoisted imports below.
const TMP_UPLOAD_DIR = vi.hoisted(() => {
  const dir = `${process.cwd()}/.tmp-bulk-download-test-${process.pid}`;
  process.env['UPLOAD_DIR'] = dir;
  return dir;
});

import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import fs from 'fs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import * as unzipper from 'unzipper';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, attachments } from '../db/schema/index.js';
import { auditLog } from '../db/schema/audit-log.js';
import { attachmentsRouter } from './attachments.routes.js';
import * as attachmentService from '../services/attachment.service.js';
import { invalidateSystemProviderCache } from '../services/storage/storage-provider.factory.js';

const TENANT_A_SLUG = 'bulk-dl-test-a';
const TENANT_B_SLUG = 'bulk-dl-test-b';
const USER_EMAIL = 'bulk-dl-test@example.com';

const ALPHA_CONTENT = '%PDF-1.4 alpha';
const BETA_CONTENT = 'col1,col2\n1,2\n';
const ALPHA_DUPE_CONTENT = '%PDF-1.4 alpha dupe';

let server: Server | null = null;
let port = 0;
let token = '';
let tenantAId = '';
let tenantBId = '';
let attA1 = ''; // alpha.pdf
let attA2 = ''; // beta.csv
let attA3 = ''; // alpha.pdf (name collision with attA1)
let attB1 = ''; // foreign tenant

function request(
  method: string,
  pathname: string,
  body?: unknown,
  authToken?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          ...(data ? { 'Content-Length': String(data.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function seedAttachment(tenantId: string, name: string, content: string, mime: string): Promise<string> {
  const att = await attachmentService.upload(
    tenantId,
    { originalname: name, buffer: Buffer.from(content), mimetype: mime, size: Buffer.byteLength(content) },
    'draft',
    crypto.randomUUID(),
  );
  return att!.id;
}

async function cleanDb() {
  const tenantIds = [tenantAId, tenantBId].filter(Boolean);
  if (tenantIds.length > 0) {
    await db.delete(auditLog).where(inArray(auditLog.tenantId, tenantIds));
    await db.delete(attachments).where(inArray(attachments.tenantId, tenantIds));
  }
  await db.delete(users).where(eq(users.email, USER_EMAIL));
  await db.delete(tenants).where(inArray(tenants.slug, [TENANT_A_SLUG, TENANT_B_SLUG]));
}

beforeAll(async () => {
  fs.mkdirSync(TMP_UPLOAD_DIR, { recursive: true });
  // The system-default provider cache may hold a LocalProvider built for a
  // different UPLOAD_DIR from an earlier test file (singleFork pool).
  invalidateSystemProviderCache();

  const [tenantA] = await db.insert(tenants).values({ name: 'Bulk DL Test A', slug: TENANT_A_SLUG }).returning();
  const [tenantB] = await db.insert(tenants).values({ name: 'Bulk DL Test B', slug: TENANT_B_SLUG }).returning();
  tenantAId = tenantA!.id;
  tenantBId = tenantB!.id;

  const [user] = await db.insert(users).values({
    tenantId: tenantAId,
    email: USER_EMAIL,
    passwordHash: 'not-used',
    displayName: 'Bulk DL Tester',
    role: 'owner',
  }).returning();

  token = jwt.sign(
    { userId: user!.id, tenantId: tenantAId, role: 'owner' },
    process.env['JWT_SECRET']!,
    { expiresIn: '5m' },
  );

  attA1 = await seedAttachment(tenantAId, 'alpha.pdf', ALPHA_CONTENT, 'application/pdf');
  attA2 = await seedAttachment(tenantAId, 'beta.csv', BETA_CONTENT, 'text/csv');
  attA3 = await seedAttachment(tenantAId, 'alpha.pdf', ALPHA_DUPE_CONTENT, 'application/pdf');
  attB1 = await seedAttachment(tenantBId, 'other.pdf', '%PDF-1.4 other', 'application/pdf');

  const app = express();
  app.use(express.json());
  app.use('/api/v1/attachments', attachmentsRouter);
  app.use((err: Error & { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.statusCode ?? 500).json({ error: { message: err.message } });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await cleanDb();
  fs.rmSync(TMP_UPLOAD_DIR, { recursive: true, force: true });
  invalidateSystemProviderCache();
});

describe('POST /attachments/bulk-download', () => {
  it('streams a zip containing every requested attachment', async () => {
    const res = await request('POST', '/api/v1/attachments/bulk-download', { attachmentIds: [attA1, attA2] }, token);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="attachments-\d{4}-\d{2}-\d{2}\.zip"$/);

    const dir = await unzipper.Open.buffer(res.body);
    const names = dir.files.map((f) => f.path).sort();
    expect(names).toEqual(['alpha.pdf', 'beta.csv']);

    const alpha = await dir.files.find((f) => f.path === 'alpha.pdf')!.buffer();
    const beta = await dir.files.find((f) => f.path === 'beta.csv')!.buffer();
    expect(alpha.toString()).toBe(ALPHA_CONTENT);
    expect(beta.toString()).toBe(BETA_CONTENT);
  });

  it('deduplicates colliding file names with a (1) suffix', async () => {
    const res = await request('POST', '/api/v1/attachments/bulk-download', { attachmentIds: [attA1, attA3] }, token);

    expect(res.status).toBe(200);
    const dir = await unzipper.Open.buffer(res.body);
    const names = dir.files.map((f) => f.path).sort();
    expect(names).toEqual(['alpha (1).pdf', 'alpha.pdf']);

    const dupe = await dir.files.find((f) => f.path === 'alpha (1).pdf')!.buffer();
    expect(dupe.toString()).toBe(ALPHA_DUPE_CONTENT);
  });

  it('rejects the whole request when any id belongs to another tenant', async () => {
    const res = await request('POST', '/api/v1/attachments/bulk-download', { attachmentIds: [attA1, attB1] }, token);
    expect(res.status).toBe(404);
  });

  it('rejects an empty id list', async () => {
    const res = await request('POST', '/api/v1/attachments/bulk-download', { attachmentIds: [] }, token);
    expect(res.status).toBe(400);
  });

  it('rejects non-uuid ids', async () => {
    const res = await request('POST', '/api/v1/attachments/bulk-download', { attachmentIds: ['not-a-uuid'] }, token);
    expect(res.status).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await request('POST', '/api/v1/attachments/bulk-download', { attachmentIds: [attA1] });
    expect(res.status).toBe(401);
  });
});

describe('GET /attachments/:id/download (Bearer header — the web client path)', () => {
  it('returns the file bytes for the authorized tenant', async () => {
    const res = await request('GET', `/api/v1/attachments/${attA1}/download`, undefined, token);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="alpha.pdf"');
    expect(res.body.toString()).toBe(ALPHA_CONTENT);
  });

  it('rejects a request without credentials', async () => {
    const res = await request('GET', `/api/v1/attachments/${attA1}/download`);
    expect(res.status).toBe(401);
  });
});
