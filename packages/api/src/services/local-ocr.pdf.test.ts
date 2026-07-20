// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Local PDF extraction pipeline (bill/receipt OCR at strict/standard PII
// levels — no pixels ever leave the server on these paths).
//
// Regression context: pdf-parse v1 bundles a 2017 pdf.js that throws
// "Invalid PDF structure" on PDFs from modern generators (xref streams,
// newer flate params) — that made EVERY such PDF bill upload fail. The
// chain is now pdfjs-dist → poppler pdftotext → pdf-parse, and scanned
// (image-only) PDFs are rasterized locally and OCR'd with GLM-OCR (when
// the local engine is configured) or Tesseract instead of being rejected.
//
// Tesseract.js and the GLM-OCR client are mocked (no traineddata download,
// no llama.cpp server); pdfjs-dist and poppler run for real, with a skip
// guard for hosts without poppler (mirrors pdf-render.integration.test.ts).

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const tesseractText = { value: 'MOCK TESSERACT TEXT' };
vi.mock('tesseract.js', () => ({
  createWorker: async () => ({
    recognize: async () => ({ data: { text: tesseractText.value, confidence: 88 } }),
    terminate: async () => undefined,
  }),
}));

const glmOcrPages = vi.fn();
vi.mock('./extraction/glm-ocr.client.js', () => ({
  ocrPages: (...args: unknown[]) => glmOcrPages(...args),
}));

import { extractTextFromPdf, extractLocally, type LocalGlmOptions } from './local-ocr.service.js';
import { checkPdftoppmAvailable } from './extraction/pdf-render.service.js';

// A text-layer PDF from a modern generator (pdf-lib). This exact document
// shape makes legacy pdf-parse throw "Invalid PDF structure".
async function makeTextPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(
    'ACME Supplies Inc\nInvoice #: 12345\nInvoice Date: 2026-07-01\nDue Date: 2026-08-01\nTerms: Net 30\nWidget A  2  50.00  100.00\nTotal Due: 108.00',
    { x: 50, y: 700, size: 14, font, lineHeight: 18 },
  );
  return Buffer.from(await doc.save());
}

// An image-only ("scanned") PDF: a page with drawn shapes and no text
// objects at all — no text layer for any extractor to find.
async function makeScannedPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  page.drawRectangle({ x: 20, y: 20, width: 160, height: 160, color: rgb(0.2, 0.4, 0.6) });
  return Buffer.from(await doc.save());
}

const glmConfig: LocalGlmOptions = {
  enabled: true,
  baseUrl: 'http://glm-ocr:8082',
  model: 'glm-ocr',
  prompt: 'OCR:',
  timeoutMs: 5000,
  concurrency: 2,
  apiKey: null,
  renderDpi: 72,
};

let popplerAvailable = false;
beforeAll(async () => {
  popplerAvailable = (await checkPdftoppmAvailable()).available;
});

describe('extractTextFromPdf — modern text-layer PDFs', () => {
  it('extracts the text layer from a pdf-lib generated PDF (legacy pdf-parse regression)', async () => {
    const pdf = await makeTextPdf();
    const result = await extractTextFromPdf(pdf);
    expect(result.isTextBased).toBe(true);
    expect(result.text).toContain('ACME Supplies Inc');
    expect(result.text).toContain('12345');
  });

  it('reports a shape-only PDF as not text-based instead of throwing', async () => {
    const pdf = await makeScannedPdf();
    const result = await extractTextFromPdf(pdf);
    expect(result.isTextBased).toBe(false);
  });

  it('degrades to isTextBased:false on a corrupt buffer instead of throwing', async () => {
    const result = await extractTextFromPdf(Buffer.from('%PDF-1.4 this is not a real pdf'));
    expect(result.isTextBased).toBe(false);
  });
});

describe('extractLocally — routing', () => {
  it('routes a text-layer PDF to pdf_text', async () => {
    const pdf = await makeTextPdf();
    const result = await extractLocally(pdf, 'application/pdf');
    expect(result.kind).toBe('pdf_text');
    if (result.kind === 'pdf_text') expect(result.text).toContain('ACME');
  });

  it('rasterizes a scanned PDF and OCRs it locally with Tesseract', async (ctx) => {
    if (!popplerAvailable) return ctx.skip();
    tesseractText.value = 'MOCK TESSERACT TEXT';
    const pdf = await makeScannedPdf();
    const result = await extractLocally(pdf, 'application/pdf');
    expect(result.kind).toBe('tesseract');
    if (result.kind === 'tesseract') expect(result.text).toBe('MOCK TESSERACT TEXT');
  });

  it('prefers the local GLM-OCR engine for scanned PDFs when configured', async (ctx) => {
    if (!popplerAvailable) return ctx.skip();
    glmOcrPages.mockResolvedValueOnce([{ index: 0, markdown: 'GLM PAGE MARKDOWN', confidence: 0.9 }]);
    const pdf = await makeScannedPdf();
    const result = await extractLocally(pdf, 'application/pdf', { glm: glmConfig });
    expect(result.kind).toBe('glm_ocr');
    if (result.kind === 'glm_ocr') expect(result.text).toBe('GLM PAGE MARKDOWN');
    // The GLM client got real PNG page buffers, never the raw PDF.
    const pages = glmOcrPages.mock.calls[0]![0] as Array<{ mimeType: string }>;
    expect(pages.every((p) => p.mimeType === 'image/png')).toBe(true);
  });

  it('falls back to Tesseract when GLM-OCR fails', async (ctx) => {
    if (!popplerAvailable) return ctx.skip();
    glmOcrPages.mockRejectedValueOnce(new Error('GLM-OCR POST http://glm-ocr:8082 → HTTP 500'));
    tesseractText.value = 'FALLBACK TEXT';
    const pdf = await makeScannedPdf();
    const result = await extractLocally(pdf, 'application/pdf', { glm: glmConfig });
    expect(result.kind).toBe('tesseract');
    if (result.kind === 'tesseract') expect(result.text).toBe('FALLBACK TEXT');
  });

  it('returns none/extraction_empty when local OCR reads nothing', async (ctx) => {
    if (!popplerAvailable) return ctx.skip();
    tesseractText.value = '';
    const pdf = await makeScannedPdf();
    const result = await extractLocally(pdf, 'application/pdf');
    expect(result).toEqual({ kind: 'none', reason: 'extraction_empty' });
    tesseractText.value = 'MOCK TESSERACT TEXT';
  });

  it('returns none/scanned_pdf_no_ocr when the PDF cannot be rasterized', async () => {
    // Corrupt buffer: no text layer AND poppler can't render it.
    const result = await extractLocally(Buffer.from('%PDF-1.4 garbage'), 'application/pdf');
    expect(result).toEqual({ kind: 'none', reason: 'scanned_pdf_no_ocr' });
  });
});
