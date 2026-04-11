import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeAtomicSync } from './atomic-write.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('writeAtomicSync', () => {
  it('writes a buffer to the destination', () => {
    const dest = path.join(dir, 'out.bin');
    writeAtomicSync(dest, Buffer.from('hello'));
    expect(fs.readFileSync(dest, 'utf8')).toBe('hello');
  });

  it('writes a string to the destination', () => {
    const dest = path.join(dir, 'out.txt');
    writeAtomicSync(dest, 'hello world');
    expect(fs.readFileSync(dest, 'utf8')).toBe('hello world');
  });

  it('creates parent directories if they do not exist', () => {
    const dest = path.join(dir, 'nested', 'deeper', 'out.txt');
    writeAtomicSync(dest, 'nested');
    expect(fs.readFileSync(dest, 'utf8')).toBe('nested');
  });

  it('overwrites an existing file', () => {
    const dest = path.join(dir, 'out.txt');
    writeAtomicSync(dest, 'first');
    writeAtomicSync(dest, 'second');
    expect(fs.readFileSync(dest, 'utf8')).toBe('second');
  });

  it('leaves no .tmp file after a successful write', () => {
    const dest = path.join(dir, 'out.txt');
    writeAtomicSync(dest, 'payload');
    expect(fs.existsSync(dest + '.tmp')).toBe(false);
  });

  it('accepts and writes a zero-byte buffer', () => {
    const dest = path.join(dir, 'empty.bin');
    writeAtomicSync(dest, Buffer.alloc(0));
    expect(fs.readFileSync(dest).length).toBe(0);
  });

  it('applies the requested mode on POSIX', () => {
    if (process.platform === 'win32') return; // mode bits are meaningless on Windows
    const dest = path.join(dir, 'secure.txt');
    writeAtomicSync(dest, 'secret', 0o600);
    const stat = fs.statSync(dest);
    // 0o600 = rw for owner only
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('is safe to call repeatedly without leaving orphan tmp files', () => {
    const dest = path.join(dir, 'out.txt');
    for (let i = 0; i < 10; i++) {
      writeAtomicSync(dest, `iteration-${i}`);
    }
    expect(fs.readFileSync(dest, 'utf8')).toBe('iteration-9');
    expect(fs.existsSync(dest + '.tmp')).toBe(false);
  });
});
