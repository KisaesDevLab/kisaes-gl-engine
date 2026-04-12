// Use a separate test database to avoid wiping dev data
process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://kisbooks:kisbooks@localhost:5434/kisbooks_test';
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6379';
process.env['JWT_SECRET'] = 'test-secret-key-for-testing-only';
// Installation sentinel encryption key — stable value for reproducible tests.
// The sentinel service test overrides DATA_DIR so real sentinels are never
// written to /data during tests.
process.env['ENCRYPTION_KEY'] =
  process.env['ENCRYPTION_KEY'] || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env['NODE_ENV'] = 'test';
