// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// PDF → page-image rasterization for the local document-extraction pipeline.
//
// HARD CONSTRAINT (build brief #2): the vision model never receives a PDF.
// Ollama's API doesn't parse PDFs, so every PDF page is rendered to a PNG
// here first and sent as an `image_url` block. Image uploads (PNG/JPG) pass
// through unchanged as a single page.
//
// Rendering shells out to poppler's `pdftoppm` (installed via apk in
// packages/api/Dockerfile). poppler is the most robust appliance option:
// no headless-browser overhead (puppeteer is HTML→PDF, the wrong
// direction) and no native canvas bindings. The binary runs in the worker
// container's doc-render processor.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';

const execFileAsync = promisify(execFile);

const PDFTOPPM_BIN = 'pdftoppm';
// A dense multi-page statement at 300 DPI can take tens of seconds to
// rasterize; bound it so a pathological PDF can't wedge a worker forever.
const RENDER_TIMEOUT_MS = 120_000;

// Image MIME types we forward to the vision model as-is (single page). A
// multi-page TIFF would only surface page 1 — acceptable for the initial
// scope (photos/scans are single-page); logged in QUESTIONS.md.
const PASSTHROUGH_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
]);

export interface RenderOptions {
  dpi?: number;
  grayscale?: boolean;
}

export interface RenderedPage {
  /** 1-based page index. */
  pageNo: number;
  /** Image bytes (PNG for rendered PDF pages; original bytes for passthrough). */
  data: Buffer;
  /** MIME of `data` — drives the data-URL prefix and storage extension. */
  mimeType: string;
}

export function isRenderablePdf(mimeType: string): boolean {
  return mimeType.toLowerCase() === 'application/pdf';
}

export function isPassthroughImage(mimeType: string): boolean {
  return PASSTHROUGH_IMAGE_MIMES.has(mimeType.toLowerCase());
}

export interface PdftoppmStatus {
  available: boolean;
  version?: string;
  error?: string;
}

/**
 * Startup capability check — verifies `pdftoppm` is installed and runnable.
 * Read-only, never throws. The worker logs this at boot so a missing
 * poppler surfaces immediately rather than on the first PDF.
 */
export async function checkPdftoppmAvailable(): Promise<PdftoppmStatus> {
  try {
    // `pdftoppm -v` prints "pdftoppm version X.Y.Z" to stderr, exits 0.
    const { stdout, stderr } = await execFileAsync(PDFTOPPM_BIN, ['-v'], { timeout: 10_000 });
    const line = (stderr || stdout || '').split('\n')[0]?.trim();
    return { available: true, ...(line ? { version: line } : {}) };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Rasterize a PDF buffer to an ordered array of page PNGs via `pdftoppm`.
 * Writes the PDF to a private temp dir, renders, reads the PNGs back in
 * page order, and always cleans up the temp dir.
 */
export async function renderPdfToPngPages(pdf: Buffer, opts: RenderOptions = {}): Promise<RenderedPage[]> {
  const dpi = opts.dpi ?? env.EXTRACTION_RENDER_DPI;
  const grayscale = opts.grayscale ?? env.EXTRACTION_RENDER_GRAYSCALE;

  const workDir = await mkdtemp(path.join(tmpdir(), 'vibe-extract-'));
  const inputPath = path.join(workDir, 'input.pdf');
  const outPrefix = path.join(workDir, 'page');
  try {
    await writeFile(inputPath, pdf);

    const args = ['-png', '-r', String(dpi)];
    if (grayscale) args.push('-gray');
    args.push(inputPath, outPrefix);
    await execFileAsync(PDFTOPPM_BIN, args, { timeout: RENDER_TIMEOUT_MS });

    // pdftoppm writes `page-<n>.png`, zero-padded to the digit width of the
    // last page (page-1.png for ≤9 pages, page-01.png for 10–99, etc.).
    // Parse the trailing integer and sort numerically so page order is
    // correct regardless of padding.
    const numbered = (await readdir(workDir))
      .map((f) => {
        const m = f.match(/-(\d+)\.png$/);
        return m ? { f, n: parseInt(m[1]!, 10) } : null;
      })
      .filter((x): x is { f: string; n: number } => x !== null)
      .sort((a, b) => a.n - b.n);

    if (numbered.length === 0) {
      throw AppError.unprocessableEntity('PDF produced no rendered pages', 'PDF_RENDER_EMPTY');
    }

    const pages: RenderedPage[] = [];
    for (let i = 0; i < numbered.length; i += 1) {
      const data = await readFile(path.join(workDir, numbered[i]!.f));
      pages.push({ pageNo: i + 1, data, mimeType: 'image/png' });
    }
    return pages;
  } catch (err) {
    if (err instanceof AppError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    // ENOENT here means poppler isn't installed; a non-zero exit means the
    // PDF was malformed/encrypted. Both are unprocessable-entity from the
    // caller's perspective — the job routes to review rather than crashing.
    throw AppError.unprocessableEntity(`Failed to render PDF: ${msg}`, 'PDF_RENDER_FAILED');
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Dispatch by MIME: PDFs render to page PNGs; supported images pass through
 * as a single page; anything else is a bad request.
 */
export async function renderToPages(
  buffer: Buffer,
  mimeType: string,
  opts: RenderOptions = {},
): Promise<RenderedPage[]> {
  if (isRenderablePdf(mimeType)) {
    return renderPdfToPngPages(buffer, opts);
  }
  if (isPassthroughImage(mimeType)) {
    return [{ pageNo: 1, data: buffer, mimeType: mimeType.toLowerCase() }];
  }
  throw AppError.badRequest(`Unsupported document type for extraction: ${mimeType}`);
}
