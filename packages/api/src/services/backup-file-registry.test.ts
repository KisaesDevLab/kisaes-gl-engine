// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { encodeFileEntryId, decodeFileEntryId } from './backup-file-registry.js';
import { writeBackBundleFiles } from './system-restore.service.js';

describe('file entry ids', () => {
  it('round-trips encode → decode', () => {
    const id = encodeFileEntryId('portal_receipts', 'row-123', 'storage_key');
    expect(decodeFileEntryId(id)).toEqual({ table: 'portal_receipts', column: 'storage_key', rowId: 'row-123' });
  });

  it('treats bare uuids as legacy attachment ids', () => {
    expect(decodeFileEntryId(crypto.randomUUID())).toBeNull();
  });

  it('rejects malformed prefixed ids', () => {
    expect(decodeFileEntryId('f:only-one-part')).toBeNull();
    expect(decodeFileEntryId('f:t:c:')).toBeNull();
  });

  it('keeps rowIds containing separators intact', () => {
    const decoded = decodeFileEntryId(encodeFileEntryId('t', 'a:b:c', 'col'));
    expect(decoded).toEqual({ table: 't', column: 'col', rowId: 'a:b:c' });
  });
});

describe('writeBackBundleFiles (round-trip through local provider + local paths)', () => {
  let tmpUploadDir: string;
  let originalUploadDir: string | undefined;
  const tenantId = crypto.randomUUID();
  const attachmentId = crypto.randomUUID();
  const receiptId = crypto.randomUUID();
  const payrollSessionId = crypto.randomUUID();

  beforeAll(() => {
    originalUploadDir = process.env['UPLOAD_DIR'];
    tmpUploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-files-test-'));
    process.env['UPLOAD_DIR'] = tmpUploadDir;
  });

  afterAll(() => {
    if (originalUploadDir === undefined) delete process.env['UPLOAD_DIR'];
    else process.env['UPLOAD_DIR'] = originalUploadDir;
    fs.rmSync(tmpUploadDir, { recursive: true, force: true });
  });

  it('writes every category back where it belongs and reports per-table counts', async () => {
    const attachmentKey = `tenants/${tenantId}/attachments/receipt.pdf`;
    const receiptKey = `tenants/${tenantId}/portal-receipts/upload.png`;

    const sections: Record<string, Record<string, unknown>[]> = {
      attachments: [
        { id: attachmentId, tenant_id: tenantId, storage_key: attachmentKey, file_path: '/uploads/receipt.pdf' },
      ],
      portal_receipts: [{ id: receiptId, tenant_id: tenantId, storage_key: receiptKey }],
      payroll_import_sessions: [
        // Absolute path OUTSIDE the (new) upload dir — must be remapped
        // under UPLOAD_DIR/payroll, never written outside it.
        { id: payrollSessionId, tenant_id: tenantId, file_path: '/data/uploads/payroll/register.csv' },
      ],
    };

    async function* bundle(): AsyncGenerator<{ id: string; buffer: Buffer }> {
      yield { id: attachmentId, buffer: Buffer.from('attachment-bytes') }; // legacy bare id
      yield { id: encodeFileEntryId('portal_receipts', receiptId, 'storage_key'), buffer: Buffer.from('receipt-bytes') };
      yield { id: encodeFileEntryId('payroll_import_sessions', payrollSessionId, 'file_path'), buffer: Buffer.from('payroll-bytes') };
      yield { id: crypto.randomUUID(), buffer: Buffer.from('orphan') }; // no matching row
    }

    const report = await writeBackBundleFiles(sections, bundle);

    expect(report.perTable['attachments']).toEqual({ restored: 1, failed: 0 });
    expect(report.perTable['portal_receipts']).toEqual({ restored: 1, failed: 0 });
    expect(report.perTable['payroll_import_sessions']).toEqual({ restored: 1, failed: 0 });
    expect(report.unknownEntries).toBe(1);

    // Provider-keyed files land under the local provider's base (UPLOAD_DIR).
    expect(fs.readFileSync(path.join(tmpUploadDir, attachmentKey)).toString()).toBe('attachment-bytes');
    expect(fs.readFileSync(path.join(tmpUploadDir, receiptKey)).toString()).toBe('receipt-bytes');
    // Foreign absolute path remapped to UPLOAD_DIR/payroll/<basename>.
    expect(fs.readFileSync(path.join(tmpUploadDir, 'payroll', 'register.csv')).toString()).toBe('payroll-bytes');
  });
});
