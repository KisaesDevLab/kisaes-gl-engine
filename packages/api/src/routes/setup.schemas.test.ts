// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { initializeSchema, remoteExecuteSchema, executeStagedSchema, checkPortSchema } from './setup.schemas.js';

const base = {
  db: { host: 'db', port: 5432, database: 'kisbooks', username: 'kisbooks', password: 'pw' },
  jwtSecret: 'j'.repeat(32),
  backupKey: 'b'.repeat(32),
  encryptionKey: 'e'.repeat(64),
  admin: { email: 'admin@example.com', password: 'correct-horse-battery', displayName: 'Admin' },
  company: { name: 'Acme' },
};

describe('initializeSchema', () => {
  it('accepts a complete fresh-install payload and defaults redis', () => {
    const parsed = initializeSchema.parse(base);
    expect(parsed.redis).toEqual({ host: 'redis', port: 6379 });
  });

  it('requires a company name unless adopting restored tenants', () => {
    expect(initializeSchema.safeParse({ ...base, company: { name: '' } }).success).toBe(false);
    expect(initializeSchema.safeParse({ ...base, company: { name: '' }, adoptExistingTenants: true }).success).toBe(true);
  });

  it('enforces the 12-character admin password policy and 32-char secrets', () => {
    expect(initializeSchema.safeParse({ ...base, admin: { ...base.admin, password: 'short' } }).success).toBe(false);
    expect(initializeSchema.safeParse({ ...base, jwtSecret: 'tooshort' }).success).toBe(false);
  });

  it('rejects non-object garbage instead of reaching path/fs code', () => {
    expect(initializeSchema.safeParse('x').success).toBe(false);
    expect(executeStagedSchema.safeParse({ backupId: { not: 'a string' }, passphrase: 'p' }).success).toBe(false);
    expect(executeStagedSchema.safeParse({ backupId: '../../etc', passphrase: 'p' }).success).toBe(false);
    expect(checkPortSchema.safeParse({ port: 70000 }).success).toBe(false);
  });

  it('remote execute requires string object keys', () => {
    const creds = { bucket: 'b', endpoint: 'https://s3.example.com', keyId: 'k', applicationKey: 'a', passphrase: 'p' };
    expect(remoteExecuteSchema.safeParse({ ...creds, keys: [] }).success).toBe(false);
    expect(remoteExecuteSchema.safeParse({ ...creds, keys: [1] }).success).toBe(false);
    expect(remoteExecuteSchema.safeParse({ ...creds, keys: ['backups/a.vmx'] }).success).toBe(true);
  });
});
