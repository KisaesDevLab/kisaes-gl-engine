// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { afterAll } from 'vitest';
import os from 'os';
import path from 'path';

// Use a separate test database to avoid wiping dev data
process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://kisbooks:kisbooks@localhost:5434/kisbooks_test';
// R6-12 / D13: never default to the production Redis (6379). The estimate, snapshot and portal
// tests write te:estimate:* cache entries, so on a host that runs the app this must point at a
// TEST instance (redis://localhost:6390 here). CI has no Redis at all; it gets a harmless
// unreachable test URL (the clients fall back exactly as they did before).
const PROD_REDIS_PORT = /:6379(\/|$)/;
const redisUrl = process.env['REDIS_URL'];
if (!redisUrl) {
  if (!process.env['CI']) throw new Error('REDIS_URL is not set. Export a TEST Redis URL (e.g. REDIS_URL=redis://localhost:6390) before running the API tests; refusing to default to the production instance on 6379 (D13).');
  process.env['REDIS_URL'] = 'redis://localhost:6390';
} else if (PROD_REDIS_PORT.test(redisUrl) && !process.env['CI']) {
  throw new Error(`REDIS_URL=${redisUrl} points at the default (production) Redis port; the API tests write cache entries, so use a TEST instance such as redis://localhost:6390 (D13).`);
}
process.env['JWT_SECRET'] = 'test-secret-key-for-testing-only';
// Installation sentinel encryption key — stable value for reproducible tests.
// The sentinel service test overrides DATA_DIR so real sentinels are never
// written to /data during tests.
process.env['ENCRYPTION_KEY'] =
  process.env['ENCRYPTION_KEY'] || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
// AES-GCM key used by utils/encryption.ts. Stable fixed value so tests that
// exercise encrypt/decrypt (Plaid tokens, OAuth refresh tokens, Stripe
// secrets) don't depend on deployment env.
process.env['PLAID_ENCRYPTION_KEY'] =
  process.env['PLAID_ENCRYPTION_KEY'] || 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2';
process.env['NODE_ENV'] = 'test';
// Route files that build a multer disk storage at import time (e.g.
// company.routes.ts logo upload) mkdir UPLOAD_DIR on module load — point
// it at a writable temp dir so importing them doesn't require /data.
process.env['UPLOAD_DIR'] =
  process.env['UPLOAD_DIR'] || path.join(os.tmpdir(), 'kis-books-test-uploads');
// PORTAL_IDENTITY_LINKING_V1 — flag is off in production but the
// test suite exercises both flag-on (identity auto-link, switcher
// authz) and explicit flag-off branches. Set it on globally here so
// the env config parses with the flag enabled; the existing
// non-identity tests do not seed identity rows so the flag is a
// no-op for them, and the few tests that need the flag off can
// stub it back via vi.stubEnv inside the test body.
process.env['PORTAL_IDENTITY_LINKING_V1'] = 'true';

// The passkey challenge store lazily opens a shared ioredis client. In the
// airgapped suite there is no Redis, so it falls back to its in-memory map
// but still leaves a reconnecting socket around. Close it after each test
// file (globals are enabled in vitest.config) so Vitest exits cleanly; the
// next file that touches it just re-creates the client lazily.
afterAll(async () => {
  const { closePasskeyChallengeStore } = await import('./services/passkey-challenge-store.js');
  await closePasskeyChallengeStore();
});
