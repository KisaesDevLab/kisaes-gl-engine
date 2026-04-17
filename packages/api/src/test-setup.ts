// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Use a separate test database to avoid wiping dev data
process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://kisbooks:kisbooks@localhost:5434/kisbooks_test';
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6379';
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
