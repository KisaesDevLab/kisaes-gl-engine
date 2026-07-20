// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Local OCR — priority-2 text extraction that runs entirely on-server.
//
// See Build Plans/AI_PII_PROTECTION_ADDENDUM.md §Layer 1 Priority 2.
//
// Three paths, all local (no data leaves the server):
//   1. Text-based PDFs (online-banking statement downloads, typed
//      invoices): pdfjs-dist extracts the text layer (poppler's
//      `pdftotext` and legacy pdf-parse are fallbacks). Zero AI cost,
//      zero PII exposure, near-100% accuracy.
//   2. Scanned/image-only PDFs: rasterized to page PNGs via poppler's
//      `pdftoppm` (pdf-render.service), then OCR'd locally — GLM-OCR
//      when the local engine is configured, else Tesseract.js.
//   3. Images: GLM-OCR when configured, else Tesseract.js WASM OCR.
//
// Heavy dependencies (tesseract.js, pdf-parse) are loaded with dynamic
// import so the rest of the API starts up even if the OCR libs fail to
// load in a stripped-down environment — the caller gets a clear error in
// that case rather than a boot failure.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { log } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

export interface PdfExtractResult {
  text: string;
  numPages: number;
  isTextBased: boolean;
}

const MIN_TEXT_BASED_CHARS = 50;
const PDFTOTEXT_TIMEOUT_MS = 60_000;
// Cap the pages a scanned PDF gets locally OCR'd — bills/receipts are
// short documents; a 200-page scan should not tie up the worker.
const MAX_LOCAL_OCR_PAGES = 10;

// Poppler `pdftotext` — robust against modern PDFs (xref streams, newer
// flate params) that the legacy in-process parsers choke on. `-layout`
// preserves the visual column layout, which keeps invoice line items
// readable for the downstream field-extraction model.
async function pdftotextExtract(buffer: Buffer): Promise<string> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'vibe-pdftotext-'));
  const inputPath = path.join(workDir, 'input.pdf');
  const outPath = path.join(workDir, 'out.txt');
  try {
    await writeFile(inputPath, buffer);
    await execFileAsync('pdftotext', ['-layout', inputPath, outPath], { timeout: PDFTOTEXT_TIMEOUT_MS });
    return (await readFile(outPath, 'utf8')).trim();
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Extract the text layer from a PDF buffer. Returns the raw text plus a
 * flag indicating whether the PDF is text-based (has a usable text
 * layer). Scanned/image PDFs typically produce < 50 characters of text
 * output, which callers should treat as a signal to route to local
 * rasterize+OCR or refuse.
 *
 * Extraction chain (all local): pdfjs-dist (modern, in-process; already
 * used by the statement pipeline) → poppler `pdftotext` → pdf-parse
 * (legacy). pdf-parse alone bundles a 2017 pdf.js that throws "Invalid
 * PDF structure" on many current-generator PDFs — that was the original
 * "PDF bill upload always fails" bug, so it is now the last resort, and
 * a parse failure here degrades to `isTextBased: false` instead of
 * throwing (the caller's rasterize path may still succeed).
 */
export async function extractTextFromPdf(buffer: Buffer): Promise<PdfExtractResult> {
  // 1. pdfjs-dist text layer (per-page, modern parser).
  try {
    const { extractTextLayer } = await import('./extraction/pdf-detect.service.js');
    const pages = await extractTextLayer(buffer);
    const text = pages.map((p) => p.text).join('\n\n').trim();
    if (text.length >= MIN_TEXT_BASED_CHARS) {
      return { text, numPages: pages.length, isTextBased: true };
    }
    // A parseable PDF with (almost) no text layer is a scanned PDF —
    // that's a real answer, not a parser failure. Don't bother the
    // fallbacks; report not-text-based so the caller rasterizes.
    return { text, numPages: pages.length, isTextBased: false };
  } catch (err) {
    log.warn({
      component: 'local-ocr',
      event: 'pdfjs_text_layer_failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  // 2. poppler pdftotext.
  try {
    const text = await pdftotextExtract(buffer);
    return { text, numPages: 0, isTextBased: text.length >= MIN_TEXT_BASED_CHARS };
  } catch (err) {
    log.warn({
      component: 'local-ocr',
      event: 'pdftotext_failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  // 3. Legacy pdf-parse (kept for stripped-down environments without
  // poppler where the old parser still handles the PDF).
  try {
    const { default: pdfParse } = (await import('pdf-parse')) as any;
    const result = await pdfParse(buffer);
    const text = String(result.text || '').trim();
    return {
      text,
      numPages: Number(result.numpages || 0),
      isTextBased: text.length >= MIN_TEXT_BASED_CHARS,
    };
  } catch (err) {
    log.warn({
      component: 'local-ocr',
      event: 'pdf_parse_failed',
      message: err instanceof Error ? err.message : String(err),
    });
    // Degrade instead of throwing: the caller can still try rasterize+OCR.
    return { text: '', numPages: 0, isTextBased: false };
  }
}

/**
 * Quick detector: true when the PDF has a meaningful text layer. Used
 * by the statement parser to route between the pdf-parse path and the
 * scanned-PDF / image fallback.
 */
export async function isPdfTextBased(buffer: Buffer): Promise<boolean> {
  const r = await extractTextFromPdf(buffer);
  return r.isTextBased;
}

export interface OcrResult {
  text: string;
  confidence: number;
}

// Cached Tesseract worker — starting one is expensive (WASM load +
// traineddata download) so we keep it alive for the lifetime of the
// process. Only one OCR job can run on it at a time; the orchestrator's
// semaphore already serializes AI jobs globally so that's fine.
let _worker: any = null;
let _workerPromise: Promise<any> | null = null;

async function getWorker(): Promise<any> {
  if (_worker) return _worker;
  if (!_workerPromise) {
    _workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      const w = await createWorker('eng');
      _worker = w;
      return w;
    })();
  }
  return _workerPromise;
}

/**
 * Run Tesseract OCR on an image buffer. Accepts common image formats
 * (PNG, JPG, TIFF, BMP, WebP). Returns raw text plus Tesseract's
 * self-reported confidence (0-1).
 */
export async function tesseractOcr(imageBuffer: Buffer): Promise<OcrResult> {
  const worker = await getWorker();
  const { data } = await worker.recognize(imageBuffer);
  return {
    text: String(data?.text || '').trim(),
    confidence: typeof data?.confidence === 'number' ? data.confidence / 100 : 0,
  };
}

/**
 * Gracefully tear down the Tesseract worker. Called during test
 * teardown so Vitest can exit; in production the worker lives for the
 * process lifetime.
 */
export async function shutdownTesseract(): Promise<void> {
  const w = _worker;
  _worker = null;
  _workerPromise = null;
  if (w && typeof w.terminate === 'function') {
    try { await w.terminate(); } catch { /* best-effort */ }
  }
}

export type LocalExtractionSource =
  | { kind: 'pdf_text'; text: string; numPages: number }
  | { kind: 'tesseract'; text: string; confidence: number }
  | { kind: 'glm_ocr'; text: string; confidence: number }
  | { kind: 'none'; reason: 'scanned_pdf_no_ocr' | 'extraction_empty' };

/**
 * Optional local GLM-OCR engine settings (structural subset of
 * ai-config.service's ResolvedGlmOcrConfig). When `enabled`, scanned
 * pages are OCR'd by the GLM-OCR appliance — a local llama.cpp server,
 * so data still never leaves the box — with Tesseract as the fallback.
 */
export interface LocalGlmOptions {
  enabled: boolean;
  baseUrl: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  concurrency: number;
  apiKey: string | null;
  renderDpi: number;
}

export interface ExtractLocallyOptions {
  glm?: LocalGlmOptions | null;
}

interface PageImage {
  data: Buffer;
  mimeType: string;
}

// OCR a set of page images locally: GLM-OCR when configured (higher
// quality, still on-server), else Tesseract. GLM failures fall back to
// Tesseract rather than failing the extraction.
async function ocrPagesLocally(
  pages: PageImage[],
  glm: LocalGlmOptions | null | undefined,
): Promise<{ kind: 'glm_ocr' | 'tesseract'; text: string; confidence: number } | null> {
  if (glm?.enabled) {
    try {
      const { ocrPages } = await import('./extraction/glm-ocr.client.js');
      const out = await ocrPages(pages, {
        baseUrl: glm.baseUrl,
        model: glm.model,
        prompt: glm.prompt,
        timeoutMs: glm.timeoutMs,
        concurrency: glm.concurrency,
        apiKey: glm.apiKey,
      });
      const text = out.map((p) => p.markdown).join('\n\n').trim();
      if (text.length > 0) {
        const confidence = out.length
          ? out.reduce((s, p) => s + p.confidence, 0) / out.length
          : 0;
        return { kind: 'glm_ocr', text, confidence };
      }
    } catch (err) {
      log.warn({
        component: 'local-ocr',
        event: 'glm_ocr_failed_falling_back_to_tesseract',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const texts: string[] = [];
  let confSum = 0;
  for (const page of pages) {
    const ocr = await tesseractOcr(page.data);
    if (ocr.text.length > 0) texts.push(ocr.text);
    confSum += ocr.confidence;
  }
  const text = texts.join('\n\n').trim();
  if (text.length === 0) return null;
  return { kind: 'tesseract', text, confidence: pages.length ? confSum / pages.length : 0 };
}

/**
 * Convenience wrapper used by the task services: given a file buffer
 * and MIME type, produce the best local text extraction available
 * without any cloud calls. Returns a discriminated union so callers
 * can decide whether to fall back to cloud vision (if policy allows)
 * or surface a quality warning.
 *
 * PDFs: text layer first; scanned/image-only PDFs are rasterized with
 * poppler `pdftoppm` and OCR'd locally (GLM-OCR when configured, else
 * Tesseract) — this is what makes scanned PDFs work at the strict and
 * standard PII protection levels, where raw images must never go to a
 * cloud provider.
 */
export async function extractLocally(
  buffer: Buffer,
  mimeType: string,
  opts: ExtractLocallyOptions = {},
): Promise<LocalExtractionSource> {
  if (mimeType === 'application/pdf') {
    const pdf = await extractTextFromPdf(buffer);
    if (pdf.isTextBased) {
      return { kind: 'pdf_text', text: pdf.text, numPages: pdf.numPages };
    }
    // Scanned/image-only PDF: rasterize locally and OCR the pages.
    let pages: PageImage[];
    try {
      const { renderPdfToPngPages } = await import('./extraction/pdf-render.service.js');
      const rendered = await renderPdfToPngPages(
        buffer,
        opts.glm?.renderDpi ? { dpi: opts.glm.renderDpi } : {},
      );
      pages = rendered.slice(0, MAX_LOCAL_OCR_PAGES).map((p) => ({ data: p.data, mimeType: p.mimeType }));
    } catch (err) {
      log.warn({
        component: 'local-ocr',
        event: 'pdf_rasterize_failed',
        message: err instanceof Error ? err.message : String(err),
      });
      return { kind: 'none', reason: 'scanned_pdf_no_ocr' };
    }
    const ocr = await ocrPagesLocally(pages, opts.glm);
    if (!ocr) return { kind: 'none', reason: 'extraction_empty' };
    return ocr;
  }
  if (mimeType.startsWith('image/')) {
    const ocr = await ocrPagesLocally([{ data: buffer, mimeType }], opts.glm);
    if (!ocr) return { kind: 'none', reason: 'extraction_empty' };
    return ocr;
  }
  return { kind: 'none', reason: 'extraction_empty' };
}
