// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// PDF text-layer detection + extraction for the GLM-OCR statement pipeline,
// ported from Vibe-Transaction-Convertor's extractor/preprocess.ts.
//
// Most online-banking statements are text-layer PDFs: we can read every
// transaction row straight out of the PDF with no OCR cost and no image step.
// Scanned/photographed statements have no usable text layer and must go through
// GLM-OCR. `analyzePdf` measures per-page text coverage; `routePdf` chooses the
// path; `extractTextLayer` pulls the text out for the 'text' (and the text
// pages of the 'hybrid') route. Rasterization for the OCR path is handled by
// renderPdfToPngPages in pdf-render.service.ts — not duplicated here.
//
// Uses pdfjs-dist's legacy build: no DOM, no canvas for the text-only paths.

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// pdfjs-dist doesn't export its display/api types via a resolvable subpath under
// exports-based module resolution, so we describe the small surface we use with
// local structural types (no `any`).
interface PdfTextItem {
  str: string;
  hasEOL?: boolean;
}
interface PdfTextContent {
  items: Array<PdfTextItem | Record<string, unknown>>;
}
interface PdfPageProxy {
  getTextContent(): Promise<PdfTextContent>;
  cleanup(): void;
}
interface PdfDocumentProxy {
  numPages: number;
  getPage(n: number): Promise<PdfPageProxy>;
  destroy(): Promise<void>;
}

export interface PageAnalysis {
  index: number; // 0-based
  hasText: boolean;
  charCount: number;
}

export interface PdfAnalysis {
  pageCount: number;
  hasTextLayer: boolean;
  textLayerCoverage: number; // share of pages with text
  avgCharsPerPage: number;
  suspectedScan: boolean;
  pages: PageAnalysis[];
}

export type ExtractionMethod = 'text' | 'ocr' | 'hybrid';

const TEXT_LAYER_PAGE_THRESHOLD = 0.5;
const TEXT_AVG_CHAR_THRESHOLD = 100;
const PER_PAGE_HAS_TEXT_THRESHOLD = 30;

const loadPdfFromBuffer = async (buffer: Buffer): Promise<PdfDocumentProxy> => {
  // pdf.js TRANSFERS (detaches) the ArrayBuffer it's given. Passing a view over
  // the caller's buffer (buffer.buffer) detaches the caller's data, so the next
  // pdf.js/render pass on the same fileBuffer throws "Cannot perform Construct
  // on a detached ArrayBuffer". `new Uint8Array(buffer)` makes a fresh COPY
  // (TypedArray-from-TypedArray copies), so pdf.js detaches the copy instead.
  const task = getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: false,
  });
  return task.promise as unknown as PdfDocumentProxy;
};

const isTextItem = (item: PdfTextItem | Record<string, unknown>): item is PdfTextItem =>
  typeof (item as { str?: unknown }).str === 'string';

const analyzeLoaded = async (doc: PdfDocumentProxy): Promise<PdfAnalysis> => {
  const pageCount = doc.numPages;
  const pages: PageAnalysis[] = [];
  let totalChars = 0;
  let pagesWithText = 0;

  for (let i = 1; i <= pageCount; i += 1) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();
    let charCount = 0;
    for (const item of textContent.items) {
      if (isTextItem(item)) charCount += item.str.length;
    }
    const hasText = charCount >= PER_PAGE_HAS_TEXT_THRESHOLD;
    if (hasText) pagesWithText += 1;
    totalChars += charCount;
    pages.push({ index: i - 1, hasText, charCount });
    page.cleanup();
  }

  await doc.destroy();

  const textLayerCoverage = pageCount === 0 ? 0 : pagesWithText / pageCount;
  const avgCharsPerPage = pageCount === 0 ? 0 : totalChars / pageCount;
  const hasTextLayer =
    textLayerCoverage > TEXT_LAYER_PAGE_THRESHOLD && avgCharsPerPage > TEXT_AVG_CHAR_THRESHOLD;
  const suspectedScan = !hasTextLayer && pageCount > 0;

  return { pageCount, hasTextLayer, textLayerCoverage, avgCharsPerPage, suspectedScan, pages };
};

export const analyzePdf = async (buffer: Buffer): Promise<PdfAnalysis> => {
  const doc = await loadPdfFromBuffer(buffer);
  return analyzeLoaded(doc);
};

// Decide the extraction path. `forceOcr` (admin/env STATEMENT_FORCE_OCR) forces
// OCR even when a text layer exists — useful when a text-layer PDF has corrupt
// or garbled glyph mappings (some bank PDFs do this) and OCR reads cleaner.
export const routePdf = (analysis: PdfAnalysis, forceOcr = false): ExtractionMethod => {
  if (forceOcr) return 'ocr';
  if (analysis.pageCount === 0) return 'ocr';
  if (analysis.hasTextLayer && analysis.pages.every((p) => p.hasText)) return 'text';
  if (analysis.textLayerCoverage === 0) return 'ocr';
  return 'hybrid';
};

export interface PageText {
  index: number; // 0-based
  text: string;
  hasText: boolean;
}

const extractFromLoaded = async (doc: PdfDocumentProxy): Promise<PageText[]> => {
  const out: PageText[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page: PdfPageProxy = await doc.getPage(i);
    const tc = await page.getTextContent();
    const parts: string[] = [];
    for (const item of tc.items) {
      if (!isTextItem(item)) continue;
      const t = item;
      if (t.str.length === 0) continue;
      parts.push(t.str);
      // pdfjs marks the end of a visual line with hasEOL.
      if ((t as { hasEOL?: boolean }).hasEOL) parts.push('\n');
      else parts.push(' ');
    }
    const text = parts
      .join('')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
    out.push({ index: i - 1, text, hasText: text.length >= PER_PAGE_HAS_TEXT_THRESHOLD });
    page.cleanup();
  }
  await doc.destroy();
  return out;
};

export const extractTextLayer = async (buffer: Buffer): Promise<PageText[]> => {
  const doc = await loadPdfFromBuffer(buffer);
  return extractFromLoaded(doc);
};
