// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Header-only image dimension parsing — no image library in this repo
// (deliberately: sharp/jimp are heavy deps for what amounts to reading a
// few big-endian ints). Used to hard-enforce the check-signature upload
// cap before any bytes are stored.

export interface ImageDims { width: number; height: number }

/** Parse PNG dimensions straight from the IHDR chunk. */
export function pngDimensions(buf: Buffer): ImageDims | null {
  // 8-byte signature + 4 len + "IHDR" → width at 16, height at 20 (BE).
  if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Parse JPEG dimensions by walking marker segments to the first SOF. */
export function jpegDimensions(buf: Buffer): ImageDims | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null; // SOI
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return null; // lost marker sync → malformed
    let marker = buf[off + 1]!;
    // Fill bytes: consecutive FFs before a marker are legal padding.
    while (marker === 0xff && off + 2 < buf.length) { off++; marker = buf[off + 1]!; }
    // Standalone markers with no length (TEM, RSTn) — skip.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / start of scan without SOF
    const segLen = buf.readUInt16BE(off + 2);
    if (segLen < 2 || off + 2 + segLen > buf.length) return null;
    // SOF0–SOF15 carry dimensions, except DHT (C4), JPG (C8), DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (segLen < 7) return null;
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    off += 2 + segLen;
  }
  return null;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** Sniff magic bytes; returns the true mime or null if neither PNG nor JPEG. */
export function sniffImageMime(buf: Buffer): 'image/png' | 'image/jpeg' | null {
  if (buf.length >= 4 && buf.subarray(0, 4).equals(PNG_SIG)) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

/** Dimensions for a sniffed PNG/JPEG buffer; null when unparseable. */
export function imageDimensions(buf: Buffer, mime: 'image/png' | 'image/jpeg'): ImageDims | null {
  return mime === 'image/png' ? pngDimensions(buf) : jpegDimensions(buf);
}
