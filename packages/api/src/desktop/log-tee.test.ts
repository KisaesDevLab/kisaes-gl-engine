// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRotatingFileSink, teeStream } from './log-tee.js';
import { registerSecret, _resetSecretScrubberForTests } from '../utils/secret-scrubber.js';

const dirs: string[] = [];
function tmpFile(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-log-tee-'));
  dirs.push(d);
  return path.join(d, 'logs', 'engine.log');
}

afterEach(() => {
  _resetSecretScrubberForTests();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('createRotatingFileSink', () => {
  it('appends, creating the directory', () => {
    const f = tmpFile();
    const s = createRotatingFileSink(f, 1024, 3);
    s.write('one\n');
    s.write('two\n');
    s.close();
    expect(fs.readFileSync(f, 'utf8')).toBe('one\ntwo\n');
  });

  it('rotates by size and keeps at most CL_LOG_KEEP old files', () => {
    const f = tmpFile();
    const s = createRotatingFileSink(f, 20, 2);
    for (let i = 0; i < 8; i++) s.write(`line-${i}-xxxxxx\n`); // 15 bytes each
    s.close();
    expect(fs.readFileSync(f, 'utf8')).toBe('line-7-xxxxxx\n');
    expect(fs.readFileSync(`${f}.1`, 'utf8')).toBe('line-6-xxxxxx\n');
    expect(fs.readFileSync(`${f}.2`, 'utf8')).toBe('line-5-xxxxxx\n');
    expect(fs.existsSync(`${f}.3`)).toBe(false);
  });

  it('appends to an existing file and rotates it when already over the limit', () => {
    const f = tmpFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x'.repeat(50));
    const s = createRotatingFileSink(f, 20, 1);
    s.write('fresh\n');
    s.close();
    expect(fs.readFileSync(f, 'utf8')).toBe('fresh\n');
    expect(fs.readFileSync(`${f}.1`, 'utf8')).toBe('x'.repeat(50));
  });

  it('never throws when the file cannot be opened', () => {
    const f = tmpFile();
    fs.mkdirSync(f, { recursive: true }); // a directory where the file should be
    const s = createRotatingFileSink(f, 20, 1);
    expect(() => s.write('lost\n')).not.toThrow();
    s.close();
  });
});

describe('teeStream', () => {
  function fakeStream() {
    const written: Array<{ chunk: unknown; enc: unknown }> = [];
    const stream = {
      write(chunk: unknown, enc?: unknown, cb?: unknown): boolean {
        written.push({ chunk, enc });
        if (typeof cb === 'function') (cb as () => void)();
        return true;
      },
    };
    return { stream, written };
  }

  it('scrubs both the console copy and the file copy', () => {
    registerSecret('launch-token-ABCDEFGHIJKLMNOP');
    const { stream, written } = fakeStream();
    const sunk: string[] = [];
    const restore = teeStream(stream as never, (t) => sunk.push(t));
    stream.write('GET /x?t=launch-token-ABCDEFGHIJKLMNOP Bearer abc.def\n');
    restore();
    expect(sunk).toEqual(['GET /x?t=[redacted] Bearer [redacted]\n']);
    expect(written[0]!.chunk).toBe('GET /x?t=[redacted] Bearer [redacted]\n');
  });

  it('handles Buffer chunks and keeps the write callback', () => {
    const { stream } = fakeStream();
    const sunk: string[] = [];
    teeStream(stream as never, (t) => sunk.push(t));
    let called = 0;
    stream.write(Buffer.from('amount 1234.5600\n'), () => (called += 1));
    stream.write('second\n', 'utf8', () => (called += 1));
    expect(sunk).toEqual(['amount 1234.5600\n', 'second\n']);
    expect(called).toBe(2);
  });

  it('restore puts the original write back', () => {
    const { stream } = fakeStream();
    const original = stream.write;
    const restore = teeStream(stream as never, null);
    expect(stream.write).not.toBe(original);
    restore();
    expect(stream.write).toBe(original);
  });
});
