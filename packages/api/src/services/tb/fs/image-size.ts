// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Pixel size of a PNG / JPEG data URI, read from the image header (the
// letterhead needs the logo's aspect ratio to lay it out edge to edge and
// to size it in Word).

export interface ImageInfo { width: number; height: number; type: 'png' | 'jpg'; bytes: Buffer }

export function imageInfoFromDataUri(dataUri: string | null | undefined): ImageInfo | null {
  if (!dataUri) return null;
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(dataUri);
  if (!m) return null;
  const bytes = Buffer.from(m[2]!, 'base64');
  if (m[1] === 'png') {
    // Signature (8) + IHDR length/type (8) → width, height (big-endian).
    if (bytes.length < 24 || bytes.readUInt32BE(12) !== 0x49484452) return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), type: 'png', bytes };
  }
  // JPEG: walk markers to the first start-of-frame.
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1]!;
    const len = bytes.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7), type: 'jpg', bytes };
    }
    i += 2 + len;
  }
  return null;
}
