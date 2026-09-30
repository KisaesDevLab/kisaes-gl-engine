// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { imageInfoFromDataUri } from './image-size.js';

// 3×2 red PNG and a minimal baseline JPEG header (SOF0 5×7).
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEklEQVR4nGP4z8DAwMDAwMAAAB4ABTa+0oMAAAAASUVORK5CYII=';
const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x07, 0x00, 0x05, 0x03, ...new Array(9).fill(0)]);

describe('imageInfoFromDataUri', () => {
  it('reads PNG and JPEG dimensions', () => {
    expect(imageInfoFromDataUri(`data:image/png;base64,${PNG}`)).toMatchObject({ width: 3, height: 2, type: 'png' });
    expect(imageInfoFromDataUri(`data:image/jpeg;base64,${jpegHeader.toString('base64')}`)).toMatchObject({ width: 5, height: 7, type: 'jpg' });
    expect(imageInfoFromDataUri('data:image/gif;base64,AAAA')).toBeNull();
    expect(imageInfoFromDataUri(null)).toBeNull();
  });

  it('PNG bytes embed in pdf-lib', async () => {
    const doc = await PDFDocument.create();
    const info = imageInfoFromDataUri(`data:image/png;base64,${PNG}`)!;
    const img = await doc.embedPng(info.bytes);
    expect([img.width, img.height]).toEqual([3, 2]);
  });
});
