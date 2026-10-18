// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Import guards that need no archive: the free-disk-space check and the
// desktop path rules (UNC refused, one not-found answer).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertFreeDiskSpace } from './import.service.js';
import { resolveImportPath } from '../../routes/tenant-archives.routes.js';
import { AppError } from '../../utils/errors.js';

let dir = '';

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-import-guards-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('assertFreeDiskSpace', () => {
  const MiB = 1024 * 1024;
  it('refuses with 507 INSUFFICIENT_STORAGE when the files plus the margin do not fit, and passes otherwise', () => {
    const tight = () => ({ bsize: 4096, bavail: (300 * MiB) / 4096 });
    expect(() => assertFreeDiskSpace(dir, 10 * MiB, tight)).not.toThrow();
    let err: unknown;
    try {
      assertFreeDiskSpace(dir, 100 * MiB, tight);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'INSUFFICIENT_STORAGE', statusCode: 507 });
    expect((err as { details: { freeBytes: number } }).details.freeBytes).toBe(300 * MiB);
  });

  it('never blocks when free space cannot be read, and reads the real volume by default', () => {
    expect(() => assertFreeDiskSpace(dir, 1, () => { throw new Error('statfs unsupported'); })).not.toThrow();
    expect(() => assertFreeDiskSpace(dir, 0)).not.toThrow();
    expect(() => assertFreeDiskSpace(path.join(dir, 'not-created-yet'), 0)).not.toThrow();
  });
});

describe('resolveImportPath', () => {
  const codeOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (e) {
      return (e as AppError).code;
    }
    return undefined;
  };

  it('refuses UNC and network paths outright', () => {
    for (const p of ['\\\\server\\share\\backup.zip', '//server/share/backup.zip']) {
      expect(codeOf(() => resolveImportPath(p)), p).toBe('VALIDATION_ERROR');
    }
  });

  it('gives one answer for a missing file, a directory and a wrong extension', () => {
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    const messages = new Set<string>();
    for (const p of [path.join(dir, 'missing.zip'), dir, path.join(dir, 'notes.txt')]) {
      let err: AppError | undefined;
      try {
        resolveImportPath(p);
      } catch (e) {
        err = e as AppError;
      }
      expect(err?.code, p).toBe('FILE_NOT_FOUND');
      expect(err?.statusCode, p).toBe(400);
      messages.add(err!.message);
    }
    expect(messages.size).toBe(1);
    expect([...messages][0]).not.toContain(dir);
    fs.writeFileSync(path.join(dir, 'ok.clbackup'), 'x');
    expect(resolveImportPath(path.join(dir, 'ok.clbackup'))).toBe(fs.realpathSync(path.join(dir, 'ok.clbackup')));
  });
});
