// Use a separate test database to avoid wiping dev data
process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://kisbooks:kisbooks@localhost:5434/kisbooks_test';
process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6379';
process.env['JWT_SECRET'] = 'test-secret-key-for-testing-only';
process.env['NODE_ENV'] = 'test';
