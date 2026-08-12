// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { pngDimensions, jpegDimensions, sniffImageMime, imageDimensions } from './image-dimensions.js';
import { encryptBuffer, decryptBuffer } from './encryption.js';

function makePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** Minimal JPEG: SOI, optional leading segments, then a SOF marker. */
function makeJpeg(width: number, height: number, opts: { sof?: number; app1Len?: number } = {}): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (opts.app1Len) {
    // EXIF APP1 segment of the given payload length.
    const seg = Buffer.alloc(4 + opts.app1Len);
    seg[0] = 0xff; seg[1] = 0xe1;
    seg.writeUInt16BE(2 + opts.app1Len, 2);
    parts.push(seg);
  }
  const sof = Buffer.alloc(2 + 2 + 7);
  sof[0] = 0xff; sof[1] = opts.sof ?? 0xc0;
  sof.writeUInt16BE(9, 2); // segment length
  sof[4] = 8; // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  parts.push(sof);
  return Buffer.concat(parts);
}

describe('pngDimensions', () => {
  it('reads IHDR dimensions', () => {
    expect(pngDimensions(makePng(600, 200))).toEqual({ width: 600, height: 200 });
  });
  it('rejects truncated and garbage buffers', () => {
    expect(pngDimensions(makePng(600, 200).subarray(0, 20))).toBeNull();
    expect(pngDimensions(Buffer.from('definitely not a png'))).toBeNull();
  });
});

describe('jpegDimensions', () => {
  it('reads baseline SOF0', () => {
    expect(jpegDimensions(makeJpeg(600, 200))).toEqual({ width: 600, height: 200 });
  });
  it('reads progressive SOF2', () => {
    expect(jpegDimensions(makeJpeg(512, 150, { sof: 0xc2 }))).toEqual({ width: 512, height: 150 });
  });
  it('walks past an EXIF APP1 prefix', () => {
    expect(jpegDimensions(makeJpeg(300, 100, { app1Len: 64 }))).toEqual({ width: 300, height: 100 });
  });
  it('skips DHT (C4) rather than reading it as SOF', () => {
    const dht = Buffer.alloc(6);
    dht[0] = 0xff; dht[1] = 0xc4; dht.writeUInt16BE(4, 2);
    const buf = Buffer.concat([Buffer.from([0xff, 0xd8]), dht, makeJpeg(60, 20).subarray(2)]);
    expect(jpegDimensions(buf)).toEqual({ width: 60, height: 20 });
  });
  it('returns null on garbage / no SOF / truncation', () => {
    expect(jpegDimensions(Buffer.from('junk'))).toBeNull();
    expect(jpegDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull(); // SOI then EOI
    expect(jpegDimensions(makeJpeg(600, 200).subarray(0, 6))).toBeNull();
  });
});

describe('sniffImageMime + imageDimensions', () => {
  it('sniffs png and jpeg, rejects others', () => {
    expect(sniffImageMime(makePng(1, 1))).toBe('image/png');
    expect(sniffImageMime(makeJpeg(1, 1))).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from('GIF89a...'))).toBeNull();
    expect(sniffImageMime(Buffer.from('%PDF-1.7'))).toBeNull();
  });
  it('dispatches by mime', () => {
    expect(imageDimensions(makePng(601, 200), 'image/png')).toEqual({ width: 601, height: 200 });
    expect(imageDimensions(makeJpeg(600, 201), 'image/jpeg')).toEqual({ width: 600, height: 201 });
  });
});

describe('encryptBuffer/decryptBuffer', () => {
  it('round-trips binary data byte-for-byte', () => {
    // Bytes that utf8 coercion would mangle.
    const data = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
    const out = decryptBuffer(encryptBuffer(data));
    expect(out.equals(data)).toBe(true);
  });
  it('throws on tampered ciphertext', () => {
    const payload = encryptBuffer(Buffer.from('signature bytes'));
    const parts = payload.split(':');
    const body = Buffer.from(parts[2]!, 'base64');
    body[0] = body[0]! ^ 0xff;
    const tampered = `${parts[0]}:${parts[1]}:${body.toString('base64')}`;
    expect(() => decryptBuffer(tampered)).toThrow();
  });
  it('throws on malformed payload', () => {
    expect(() => decryptBuffer('nonsense')).toThrow('Invalid encrypted data format');
  });
});
