// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// LocalProvider.resolvePath is the single choke point for every local
// file read/write (attachments, DR-restore bundle keys, exports). Keys
// that could escape UPLOAD_DIR must be refused regardless of caller.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LocalProvider } from './local.provider.js';

let root = '';
let outside = '';
const meta = { fileName: 'x', mimeType: 'application/octet-stream', sizeBytes: 1 };

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-root-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-outside-'));
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function withRoot<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env['UPLOAD_DIR'];
  process.env['UPLOAD_DIR'] = root;
  return fn().finally(() => {
    if (prev === undefined) delete process.env['UPLOAD_DIR']; else process.env['UPLOAD_DIR'] = prev;
  });
}

describe('LocalProvider key confinement', () => {
  it('writes ordinary tenant-rooted keys under the root', () => withRoot(async () => {
    const p = new LocalProvider(root);
    await p.upload('tenant-a/attachments/file.bin', Buffer.from('ok'), meta);
    expect(fs.existsSync(path.join(root, 'tenant-a/attachments/file.bin'))).toBe(true);
    expect((await p.download('tenant-a/attachments/file.bin')).toString()).toBe('ok');
  }));

  it('refuses traversal, absolute, NUL and backslash keys on every operation', () => withRoot(async () => {
    const p = new LocalProvider(root);
    const nul = String.fromCharCode(0);
    // An absolute-looking key is nested under the root (historic
    // path.join semantics), never written outside it.
    await p.upload(`${outside}/abs.txt`, Buffer.from('x'), meta);
    expect(fs.existsSync(path.join(root, outside.replace(/^\/+/, ''), 'abs.txt'))).toBe(true);
    const evil = [
      `../${path.basename(outside)}/pwned.txt`,
      'a/../../etc/passwd',
      'a/./b',
      'a\\..\\b',
      `a${nul}b`,
      '..',
    ];
    for (const k of evil) {
      await expect(p.upload(k, Buffer.from('x'), meta), k).rejects.toThrow(/Invalid storage key/);
      await expect(p.download(k), k).rejects.toThrow(/Invalid storage key/);
      await expect(p.delete(k), k).rejects.toThrow(/Invalid storage key/);
    }
    expect(fs.readdirSync(outside)).toEqual([]);
  }));
});
