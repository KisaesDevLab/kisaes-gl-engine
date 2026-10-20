// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertInside, keyBelongsToTenant, resolveInside } from './contained-path.js';

const T1 = '3b1d2f40-1111-4222-8333-444444444444';
const T2 = '9a9a9a9a-1111-4222-8333-444444444444';
let root = '';
let outside = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-root-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-outside-'));
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sub', 'ok.txt'), 'ok');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('resolveInside', () => {
  it('returns the real path of a regular file inside the root, relative or absolute', () => {
    const real = fs.realpathSync(path.join(root, 'sub', 'ok.txt'));
    expect(resolveInside(root, 'sub/ok.txt')).toBe(real);
    expect(resolveInside(root, path.join(root, 'sub', 'ok.txt'))).toBe(real);
    expect(resolveInside(path.join(root, 'sub'), 'ok.txt')).toBe(real);
  });

  it('returns null for escapes, absolute paths elsewhere, directories, missing files, NUL and empty', () => {
    for (const bad of ['../x', 'sub/../../y', path.join(outside, 'secret.txt'), 'sub', 'nope.txt', 'sub/ok\0.txt', '', null, undefined]) {
      expect(resolveInside(root, bad), String(bad)).toBeNull();
    }
    expect(resolveInside(path.join(root, 'sub'), path.join(root, 'sub', '..', 'sub', 'ok.txt'))).not.toBeNull();
    expect(resolveInside(path.join(root, 'missing-root'), 'ok.txt')).toBeNull();
  });

  it('follows symlinks and refuses one that points outside', () => {
    const link = path.join(root, 'sub', 'link.txt');
    try {
      fs.symlinkSync(path.join(outside, 'secret.txt'), link, 'file');
    } catch {
      return; // no symlink privilege on this host: nothing to check
    }
    expect(resolveInside(root, 'sub/link.txt')).toBeNull();
  });

  it('assertInside throws with the given message', () => {
    expect(() => assertInside(root, '../x', 'nope')).toThrow('nope');
    expect(assertInside(root, 'sub/ok.txt')).toBe(fs.realpathSync(path.join(root, 'sub', 'ok.txt')));
  });
});

describe('keyBelongsToTenant', () => {
  it('accepts the tenant root and the legacy domain/tenant layout, in any case', () => {
    expect(keyBelongsToTenant(`${T1}/attachments/a.pdf`, T1)).toBe(true);
    expect(keyBelongsToTenant(`attachments/${T1}/a.pdf`, T1)).toBe(true);
    expect(keyBelongsToTenant(`/${T1.toUpperCase()}/attachments/a.pdf`, T1)).toBe(true);
    expect(keyBelongsToTenant('logos/a.png', T1)).toBe(true); // no tenant segment: root containment applies
  });

  it("refuses another tenant's folder and the appliance root", () => {
    expect(keyBelongsToTenant(`${T2}/attachments/a.pdf`, T1)).toBe(false);
    expect(keyBelongsToTenant(`attachments/${T2}/a.pdf`, T1)).toBe(false);
    expect(keyBelongsToTenant('_system/backups/all.vmb', T1)).toBe(false);
    expect(keyBelongsToTenant('_system/backups/all.vmb', '_system')).toBe(true);
    expect(keyBelongsToTenant('', T1)).toBe(false);
    expect(keyBelongsToTenant(`${T1}/a\0b`, T1)).toBe(false);
  });
});
