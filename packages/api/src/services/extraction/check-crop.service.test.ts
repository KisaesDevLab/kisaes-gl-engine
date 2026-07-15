// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach } from 'vitest';
import zlib from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { clearOcrCache } from './glm-ocr.client.js';
import {
  pngDimensions,
  extractCheckCandidateImages,
  checkPagesOf,
  readChecksFromCandidates,
} from './check-crop.service.js';

// The GLM client memoizes responses by image hash — identical fixture PNGs
// across tests would otherwise serve each other stale reads.
beforeEach(() => clearOcrCache());

/** Minimal valid RGBA PNG of the given size (solid gray) — no image libs. */
function makePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4), 0x80);
  for (let y = 0; y < height; y += 1) raw[y * (1 + width * 4)] = 0; // filter byte
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Standard CRC-32 (PNG flavor).
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return ~c;
}

describe('pngDimensions', () => {
  it('reads IHDR dimensions', () => {
    expect(pngDimensions(makePng(600, 250))).toEqual({ width: 600, height: 250 });
  });
  it('rejects non-PNG buffers', () => {
    expect(pngDimensions(Buffer.from('not a png at all, definitely'))).toBeNull();
  });
});

describe('extractCheckCandidateImages', () => {
  it('keeps check-shaped embedded images and drops logos/squares', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const check = await doc.embedPng(makePng(600, 250)); // aspect 2.4 → check-like
    const logo = await doc.embedPng(makePng(120, 120)); // square → filtered
    page.drawImage(check, { x: 30, y: 400, width: 300, height: 125 });
    page.drawImage(logo, { x: 30, y: 700, width: 60, height: 60 });
    const pdf = Buffer.from(await doc.save());

    const candidates = await extractCheckCandidateImages(pdf);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.width).toBe(600);
    expect(candidates[0]!.height).toBe(250);
    expect(checkPagesOf(candidates)).toEqual([1]);
  });

  it('returns [] for a text-only PDF and never throws on garbage', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const pdf = Buffer.from(await doc.save());
    expect(await extractCheckCandidateImages(pdf)).toEqual([]);
    expect(await extractCheckCandidateImages(Buffer.from('garbage'))).toEqual([]);
  });
});

describe('readChecksFromCandidates', () => {
  const candidate = { page: 1, data: makePng(600, 250), width: 600, height: 250 };

  const glmStub = (payload: unknown) => ({
    baseUrl: 'http://glm.test',
    fetcher: (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch,
  });

  it('parses a clean GLM read through the shared check-number parser', async () => {
    const results = await readChecksFromCandidates([candidate], {
      glm: glmStub({ check_number: '01234', payee: 'Acme Lawn Care', amount: '$1,150.00', confidence: 0.92 }),
      vision: null,
    });
    expect(results).toEqual([
      { checkNumber: '1234', payee: 'Acme Lawn Care', amount: '1150.00', confidence: 0.92 },
    ]);
  });

  it('drops unreadable payees and account-number-like check numbers', async () => {
    const noPayee = await readChecksFromCandidates([candidate], {
      glm: glmStub({ check_number: '1234', payee: null, confidence: 0.9 }),
      vision: null,
    });
    expect(noPayee).toEqual([]);

    const accountLike = await readChecksFromCandidates([candidate], {
      glm: glmStub({ check_number: '123456789012', payee: 'Someone', confidence: 0.9 }),
      vision: null,
    });
    expect(accountLike).toEqual([]);
  });

  it('keeps the highest-confidence read per check number', async () => {
    const secondCandidate = { page: 2, data: makePng(602, 250), width: 602, height: 250 };
    const results = await readChecksFromCandidates(
      [candidate, secondCandidate],
      {
        glm: {
          baseUrl: 'http://glm.test',
          fetcher: (() => {
            let call = 0;
            return (async () => {
              call += 1;
              const payload =
                call === 1
                  ? { check_number: '55', payee: 'Blurry Read', confidence: 0.55 }
                  : { check_number: '55', payee: 'Clear Read', confidence: 0.95 };
              return new Response(
                JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
                { status: 200, headers: { 'content-type': 'application/json' } },
              );
            }) as typeof fetch;
          })(),
        },
        vision: null,
      },
    );
    expect(results).toEqual([{ checkNumber: '55', payee: 'Clear Read', confidence: 0.95 }]);
  });
});
