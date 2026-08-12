// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// authenticate() must accept ONLY session-shaped JWTs. Special-purpose
// token families — download (?_dl=) tokens, tfa-pending handoffs,
// check-signature step-up proofs — historically shared JWT_SECRET, and a
// signature-valid token with a resolvable userId would authenticate API
// calls. This matrix pins the fix: real access tokens pass; every other
// family is a 401 on the Authorization header. It also pins the reverse
// directions (an access token satisfies no special-purpose verifier).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts } from '../db/schema/index.js';
import { authenticate } from './auth.js';
import * as authService from '../services/auth.service.js';
import * as tfaService from '../services/tfa.service.js';
import * as signatureService from '../services/check-signature.service.js';
import { issueDownloadToken } from '../utils/download-token.js';
import { verifyPreviewToken } from '../services/portal-auth.service.js';
import { env } from '../config/env.js';

let server: Server | null = null;
let port = 0;

const EMAIL = 'token-shape-owner@example.com';

async function cleanDb() {
  const owned = await db.select({ id: users.tenantId }).from(users).where(inArray(users.email, [EMAIL]));
  const tenantIds = [...new Set(owned.map((r) => r.id))];
  if (tenantIds.length === 0) return;
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
  app.get('/probe', authenticate, (req, res) => {
    res.json({ userId: req.userId, role: req.userRole });
  });
  app.use((err: Error & { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.statusCode ?? 500).json({ error: { message: err.message } });
  });
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
}

function probe(token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/probe', method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); },
    );
    req.on('error', reject);
    req.end();
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

describe('authenticate token-shape matrix', () => {
  it('accepts a real access token and rejects every special-purpose family', async () => {
    const reg = await authService.register({
      email: EMAIL, password: 'password123', displayName: 'Shape Owner', companyName: 'Shape Co',
    });
    const { user } = reg;

    // Real session token: accepted.
    expect(await probe(reg.tokens.accessToken)).toBe(200);

    // Download token (typ:'dl') as a Bearer header: rejected — its only
    // valid path is single-use ?_dl= consumption.
    const dl = issueDownloadToken({
      userId: user.id, tenantId: user.tenantId, userRole: 'owner', isSuperAdmin: false, companyId: null,
    });
    expect(await probe(dl.token)).toBe(401);

    // TFA-pending handoff: rejected (derived key AND marker/shape check).
    expect(await probe(tfaService.generateTfaToken(user.id))).toBe(401);

    // Check-signature step-up proof: rejected.
    const stepUp = signatureService.issueStepUpToken(user.id, user.tenantId);
    expect(await probe(stepUp.stepUpToken)).toBe(401);

    // Raw-secret token missing the role claim (shape of the historical
    // tfa/step-up families): rejected even without a marker.
    const roleless = jwt.sign({ userId: user.id, tenantId: user.tenantId }, env.JWT_SECRET, { expiresIn: 60 });
    expect(await probe(roleless)).toBe(401);
  });

  it('never lets an access token satisfy a special-purpose verifier', async () => {
    const reg = await authService.register({
      email: EMAIL, password: 'password123', displayName: 'Shape Owner', companyName: 'Shape Co',
    });
    const access = reg.tokens.accessToken;

    expect(tfaService.verifyTfaToken(access)).toBeNull();
    expect(signatureService.verifyStepUpToken(access, reg.user.id, reg.user.tenantId)).toBe(false);
    expect(() => verifyPreviewToken(access)).toThrow();
  });
});
