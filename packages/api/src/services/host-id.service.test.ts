import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureHostId, readHostId, hostIdExists, getHostIdPath } from './host-id.service.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-id-test-'));
  process.env['DATA_DIR'] = tmpDir;
});

afterEach(() => {
  delete process.env['DATA_DIR'];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('host-id.service', () => {
  it('generates a new host ID when the file is absent', () => {
    expect(hostIdExists()).toBe(false);
    const id = ensureHostId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(hostIdExists()).toBe(true);
  });

  it('is idempotent — repeated calls return the same ID', () => {
    const first = ensureHostId();
    const second = ensureHostId();
    const third = ensureHostId();
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it('persists the ID to /<DATA_DIR>/.host-id', () => {
    const id = ensureHostId();
    expect(fs.readFileSync(getHostIdPath(), 'utf8').trim()).toBe(id);
  });

  it('readHostId returns null when the file is absent', () => {
    expect(readHostId()).toBeNull();
  });

  it('readHostId returns the ID when present', () => {
    const created = ensureHostId();
    expect(readHostId()).toBe(created);
  });

  it('regenerates if the existing file is not a valid UUID', () => {
    fs.writeFileSync(getHostIdPath(), 'not-a-uuid');
    const id = ensureHostId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(id).not.toBe('not-a-uuid');
  });

  it('tolerates trailing whitespace and newlines in the host-id file', () => {
    const valid = '11111111-1111-4111-8111-111111111111';
    fs.writeFileSync(getHostIdPath(), valid + '\n\n  ');
    expect(readHostId()).toBe(valid);
    expect(ensureHostId()).toBe(valid);
  });

  it('regenerates if the file is empty', () => {
    fs.writeFileSync(getHostIdPath(), '');
    const id = ensureHostId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('readHostId returns null for an invalid file without creating one', () => {
    fs.writeFileSync(getHostIdPath(), 'garbage');
    expect(readHostId()).toBeNull();
    // The file still exists (we didn't touch it)
    expect(hostIdExists()).toBe(true);
  });
});
