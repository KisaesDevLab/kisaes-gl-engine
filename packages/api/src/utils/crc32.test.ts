import { describe, it, expect } from 'vitest';
import { crc32 } from './crc32.js';

describe('crc32', () => {
  it('returns 0 for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('matches known test vectors', () => {
    // Reference: https://rosettacode.org/wiki/CRC-32 and zlib.crc32
    expect(crc32(Buffer.from('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.from('a'))).toBe(0xe8b7be43);
  });

  it('is deterministic', () => {
    const buf = Buffer.from('hello world');
    expect(crc32(buf)).toBe(crc32(buf));
  });

  it('detects single-byte changes', () => {
    const a = crc32(Buffer.from('hello world'));
    const b = crc32(Buffer.from('hello worle'));
    expect(a).not.toBe(b);
  });

  it('matches zlib.crc32 for random bytes', async () => {
    const zlib = await import('zlib');
    const buf = Buffer.from([0x00, 0x01, 0xff, 0xab, 0xcd, 0x42, 0x7f]);
    expect(crc32(buf)).toBe(zlib.crc32(buf));
  });

  it('matches zlib.crc32 for a 64KB random payload', async () => {
    const zlib = await import('zlib');
    const crypto = await import('crypto');
    const buf = crypto.randomBytes(65_536);
    expect(crc32(buf)).toBe(zlib.crc32(buf));
  });

  it('returns an unsigned 32-bit integer', () => {
    const buf = Buffer.from('anything');
    const result = crc32(buf);
    expect(Number.isInteger(result)).toBe(true);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(0xffffffff);
  });
});
