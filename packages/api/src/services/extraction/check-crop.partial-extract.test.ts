// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Regression: poppler 25.x exits non-zero for a PDF containing any malformed
// object ("End of file inside array", "Unknown compression method in flate
// stream") AFTER it has already written every image. Treating that exit code
// as fatal discarded a complete set of check thumbnails and reported the
// statement as having no check images at all — which sends the user off to
// type payees by hand when they were fully recoverable.
//
// Verified against a real client statement: inside the container pdfimages
// exits 3 while writing all 30 PNGs, and the service returned 0 candidates
// before this fix and 27 after. poppler 24.x exits 0 on the same file, so a
// fixture-based test cannot reproduce it portably — execFile is stubbed here
// instead, which is the actual contract under test.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import util from 'node:util';
import path from 'node:path';
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';

function crc32(buf: Buffer): number {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let r = 0xffffffff;
  for (const b of buf) r = table[(r ^ b) & 0xff]! ^ (r >>> 8);
  return (r ^ 0xffffffff) >>> 0;
}

/** Minimal valid RGBA PNG of the given size. */
function makePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  const raw = Buffer.alloc(height * (1 + width * 4), 0x80);
  for (let y = 0; y < height; y += 1) raw[y * (1 + width * 4)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// How the stub behaves for this test run.
const behavior = {
  listFails: false,
  pngFails: true,
  /** Images the stub "extracts" before reporting failure: [num, w, h]. */
  images: [[0, 600, 250]] as Array<[number, number, number]>,
};

vi.mock('node:child_process', () => {
  const execFile = (cmd: string, args: string[], _opts: unknown, cb?: Function) => {
    const done = typeof _opts === 'function' ? (_opts as Function) : cb!;
    const isList = args.includes('-list');
    if (isList) {
      const rows = behavior.images
        .map(([num, w, h]) => `   1  ${String(num).padStart(4)} image  ${w}  ${h}  rgb 3 8 image no [inline] 300 300 0B 0.0%`)
        .join('\n');
      const stdout = `page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio\n---\n${rows}\n`;
      if (behavior.listFails) {
        const err = new Error('pdfimages -list failed') as Error & { stdout?: string };
        err.stdout = stdout; // poppler still printed the listing
        return done(err, stdout, '');
      }
      return done(null, stdout, '');
    }
    // The extraction call: write the PNGs poppler would have written, THEN
    // report a non-zero exit. This is precisely the production shape.
    const prefix = args[args.length - 1]!;
    for (const [num, w, h] of behavior.images) {
      writeFileSync(
        path.join(path.dirname(prefix), `${path.basename(prefix)}-001-${String(num).padStart(3, '0')}.png`),
        makePng(w, h),
      );
    }
    if (behavior.pngFails) {
      const err = new Error('Command failed: pdfimages') as Error & { stdout?: string; code?: number };
      err.code = 3;
      err.stdout = '';
      return done(err, '', 'Syntax Error: End of file inside array');
    }
    return done(null, '', '');
  };
  // promisify(execFile) must yield { stdout, stderr }, matching Node's own
  // custom promisified execFile, because that is what the service destructures.
  (execFile as unknown as Record<symbol, unknown>)[util.promisify.custom] = (cmd: string, args: string[], opts: unknown) =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, opts, (err: (Error & { stdout?: string }) | null, stdout: string, stderr: string) => {
        if (err) {
          (err as Error & { stdout?: string; stderr?: string }).stdout = err.stdout ?? stdout;
          (err as Error & { stderr?: string }).stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  return { execFile, default: { execFile } };
});

const { extractCheckCandidateImages } = await import('./check-crop.service.js');

beforeEach(() => {
  behavior.listFails = false;
  behavior.pngFails = true;
  behavior.images = [[0, 600, 250]];
});

describe('extractCheckCandidateImages — partial extraction salvage', () => {
  it('keeps the images pdfimages wrote even though it exited non-zero', async () => {
    const out = await extractCheckCandidateImages(Buffer.from('%PDF-1.4 fake'));
    expect(out).toHaveLength(1);
    expect(out[0]!.width).toBe(600);
    expect(out[0]!.height).toBe(250);
    expect(out[0]!.page).toBe(1);
  });

  it('still applies the check-shape filter to salvaged images', async () => {
    // A square logo and a full-page scan must not become check candidates
    // just because the run failed.
    behavior.images = [[0, 600, 250], [1, 120, 120], [2, 1000, 1600]];
    const out = await extractCheckCandidateImages(Buffer.from('%PDF-1.4 fake'));
    expect(out).toHaveLength(1);
    expect(out[0]!.width).toBe(600);
  });

  it('falls back to no mask filter when the listing itself failed', async () => {
    // With no usable listing we cannot tell a check from its soft-mask, so
    // images are kept on geometry alone rather than all being rejected.
    behavior.listFails = true;
    behavior.pngFails = true;
    const out = await extractCheckCandidateImages(Buffer.from('%PDF-1.4 fake'));
    expect(out).toHaveLength(1);
  });

  it('still returns images on a clean run', async () => {
    behavior.pngFails = false;
    const out = await extractCheckCandidateImages(Buffer.from('%PDF-1.4 fake'));
    expect(out).toHaveLength(1);
  });
});
