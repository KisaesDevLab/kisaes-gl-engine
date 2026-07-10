// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { tenantStorageKey, SYSTEM_STORAGE_ROOT } from './storage-keys.js';

describe('tenantStorageKey', () => {
  const tenantId = crypto.randomUUID();

  it('roots the key at the tenant id: {tenantId}/{domain}/{parts}', () => {
    expect(tenantStorageKey(tenantId, 'attachments', 'file.pdf')).toBe(
      `${tenantId}/attachments/file.pdf`,
    );
    expect(tenantStorageKey(tenantId, 'reports', 'inst-1-v2.pdf')).toBe(
      `${tenantId}/reports/inst-1-v2.pdf`,
    );
    expect(tenantStorageKey(tenantId, 'backups', 'kis-books-backup-x.vmb')).toBe(
      `${tenantId}/backups/kis-books-backup-x.vmb`,
    );
  });

  it('joins multiple parts with slashes (documents job layout)', () => {
    expect(tenantStorageKey(tenantId, 'documents', 'job-1', 'page-2.png')).toBe(
      `${tenantId}/documents/job-1/page-2.png`,
    );
  });

  it('accepts the reserved _system root for system-level artifacts', () => {
    expect(tenantStorageKey(SYSTEM_STORAGE_ROOT, 'backups', 'sys.vmb')).toBe(
      '_system/backups/sys.vmb',
    );
  });

  it('rejects a tenant id that is neither a UUID nor _system', () => {
    expect(() => tenantStorageKey('not-a-uuid', 'attachments', 'x')).toThrow(
      'Invalid tenant id',
    );
    expect(() => tenantStorageKey('../etc', 'attachments', 'x')).toThrow('Invalid tenant id');
    expect(() => tenantStorageKey('', 'attachments', 'x')).toThrow('Invalid tenant id');
  });

  it('rejects traversal and malformed parts', () => {
    expect(() => tenantStorageKey(tenantId, 'attachments', '..')).toThrow(
      'Invalid storage key part',
    );
    expect(() => tenantStorageKey(tenantId, 'attachments', '../escape.pdf')).toThrow(
      'Invalid storage key part',
    );
    expect(() => tenantStorageKey(tenantId, 'documents', 'job', 'a/../b')).toThrow(
      'Invalid storage key part',
    );
    expect(() => tenantStorageKey(tenantId, 'attachments', '/absolute.pdf')).toThrow(
      'Invalid storage key part',
    );
    expect(() => tenantStorageKey(tenantId, 'attachments', 'win\\path.pdf')).toThrow(
      'Invalid storage key part',
    );
    expect(() => tenantStorageKey(tenantId, 'attachments', '')).toThrow(
      'Invalid storage key part',
    );
    expect(() => tenantStorageKey(tenantId, 'attachments')).toThrow(
      'at least one path part',
    );
  });

  it('allows a part that merely contains dots in a filename', () => {
    expect(tenantStorageKey(tenantId, 'receipts', 'scan..2026.pdf')).toBe(
      `${tenantId}/receipts/scan..2026.pdf`,
    );
  });
});
