// Local OCR — priority-2 text extraction that runs entirely on-server.
//
// See Build Plans/AI_PII_PROTECTION_ADDENDUM.md §Layer 1 Priority 2.
//
// Two paths:
//   1. Text-based PDFs (online-banking statement downloads, typed
//      invoices): pdf-parse extracts the text layer. Zero AI cost, zero
//      PII exposure, near-100% accuracy.
//   2. Images and scanned PDFs: Tesseract.js runs WASM-based OCR
//      locally. Lower quality than GLM-OCR but keeps data on-server.
//
// Dependencies (pdf-parse, tesseract.js) are loaded with dynamic import
// so the rest of the API starts up even if the OCR libs fail to load in
// a stripped-down environment — the caller gets a clear error in that
// case rather than a boot failure.

export interface PdfExtractResult {
  text: string;
  numPages: number;
  isTextBased: boolean;
}

const MIN_TEXT_BASED_CHARS = 50;

/**
 * Extract text from a PDF buffer using pdf-parse. Returns the raw text
 * plus a flag indicating whether the PDF is text-based (has a usable
 * text layer). Scanned/image PDFs typically produce < 50 characters of
 * text output, which callers should treat as a signal to either route
 * to Tesseract or refuse.
 */
export async function extractTextFromPdf(buffer: Buffer): Promise<PdfExtractResult> {
  const { default: pdfParse } = (await import('pdf-parse')) as any;
  const result = await pdfParse(buffer);
  const text = String(result.text || '').trim();
  return {
    text,
    numPages: Number(result.numpages || 0),
    isTextBased: text.length >= MIN_TEXT_BASED_CHARS,
  };
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
  | { kind: 'none'; reason: 'scanned_pdf_no_ocr' | 'extraction_empty' };

/**
 * Convenience wrapper used by the task services: given a file buffer
 * and MIME type, produce the best local text extraction available
 * without any cloud calls. Returns a discriminated union so callers
 * can decide whether to fall back to cloud vision (if policy allows)
 * or surface a quality warning.
 */
export async function extractLocally(
  buffer: Buffer,
  mimeType: string
): Promise<LocalExtractionSource> {
  if (mimeType === 'application/pdf') {
    const pdf = await extractTextFromPdf(buffer);
    if (pdf.isTextBased) {
      return { kind: 'pdf_text', text: pdf.text, numPages: pdf.numPages };
    }
    // Scanned PDF. We'd need rasterization to feed Tesseract — not
    // wired in this stage. Caller decides next step.
    return { kind: 'none', reason: 'scanned_pdf_no_ocr' };
  }
  if (mimeType.startsWith('image/')) {
    const ocr = await tesseractOcr(buffer);
    if (ocr.text.length === 0) {
      return { kind: 'none', reason: 'extraction_empty' };
    }
    return { kind: 'tesseract', text: ocr.text, confidence: ocr.confidence };
  }
  return { kind: 'none', reason: 'extraction_empty' };
}
