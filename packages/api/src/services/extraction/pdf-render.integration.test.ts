// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Integration test for real poppler rasterization. Skips automatically when
// `pdftoppm` isn't on PATH (e.g. a Windows dev box) so the suite stays green
// everywhere; it runs for real in the container image, which ships
// poppler-utils.

import { describe, it, expect } from 'vitest';
import { checkPdftoppmAvailable, renderPdfToPngPages } from './pdf-render.service.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Build a minimal, well-formed single-page PDF with a correct xref table so
// poppler renders it without reconstruction.
function makeMinimalPdf(): Buffer {
  const stream = 'BT /F1 24 Tf 20 60 Td (Hi) Tj ET\n';
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 120 120]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>',
    `<</Length ${Buffer.byteLength(stream)}>>\nstream\n${stream}endstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

describe('pdf-render integration (poppler)', () => {
  it('rasterizes a real PDF to PNG page(s)', async (ctx) => {
    const status = await checkPdftoppmAvailable();
    if (!status.available) {
      ctx.skip(); // poppler not installed on this host — covered in the container image
      return;
    }
    const pages = await renderPdfToPngPages(makeMinimalPdf(), { dpi: 72, grayscale: false });
    expect(pages.length).toBeGreaterThanOrEqual(1);
    expect(pages[0]!.pageNo).toBe(1);
    expect(pages[0]!.mimeType).toBe('image/png');
    expect(pages[0]!.data.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  });
});
