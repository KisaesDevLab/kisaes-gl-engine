// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Building blocks for PDFs assembled from several sources: server-built HTML
// rendered through Chromium, plus existing PDFs (uploaded attachments) copied
// in page-for-page with pdf-lib. Shared by report packs and the Transaction
// Report so both get the same hardened renderer and the same stamping.

import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont } from 'pdf-lib';
import puppeteer, { type Browser } from 'puppeteer';

const PDF_MARGIN = { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' };

export async function launchPdfBrowser(): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    executablePath: process.env['PUPPETEER_EXECUTABLE_PATH'] || undefined,
  });
}

export async function htmlToPdfBytes(browser: Browser, html: string, landscape: boolean): Promise<Uint8Array> {
  const page = await browser.newPage();
  try {
    // Same hardening as pdf.service.ts: every section is static server-built
    // HTML (and the letter body is stored super-admin HTML rendered verbatim),
    // so no script should ever run and no network request should ever leave
    // this page. Even if markup slips through, it cannot execute or exfiltrate
    // during rendering.
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('data:') || url.startsWith('about:') || url.startsWith('file:')) {
        req.continue();
      } else {
        req.abort();
      }
    });
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({ format: 'Letter', landscape, margin: PDF_MARGIN, printBackground: true });
  } finally {
    await page.close();
  }
}

/**
 * Copy pages of `srcBytes` onto the end of `target`; returns how many were
 * added. Throws on an unreadable or encrypted source — callers decide whether
 * that sinks the document or just skips the file. `maxPages` takes the first
 * N pages only.
 */
export async function appendPdf(target: PDFDocument, srcBytes: Uint8Array, maxPages?: number): Promise<number> {
  return appendPdfDocument(target, await PDFDocument.load(srcBytes), maxPages);
}

/** appendPdf for a source that is already parsed (e.g. validated up front). */
export async function appendPdfDocument(target: PDFDocument, src: PDFDocument, maxPages?: number): Promise<number> {
  const indices = maxPages === undefined ? src.getPageIndices() : src.getPageIndices().slice(0, maxPages);
  const pages = await target.copyPages(src, indices);
  for (const p of pages) target.addPage(p);
  return pages.length;
}

// Letter, with room kept clear for stampCaption (top) and stampPageFooter
// (bottom) so neither ever lands on the source document's own print.
const FRAME_PAGE = { width: 612, height: 792 };
const FRAME_BOX = { x: 36, y: 40, width: 540, height: 716 };

/**
 * Append pages of `src`, each placed — still vector, still searchable — inside
 * a bordered frame on a fresh Letter page, scaled down to fit and never up.
 * For source documents that print edge to edge (utility statements, scans),
 * where stamping a caption straight onto the page would cover their content.
 * Returns how many pages were added; on a throw, nothing is left behind.
 */
export async function appendFramedPdf(target: PDFDocument, src: PDFDocument, maxPages?: number): Promise<number> {
  const indices = maxPages === undefined ? src.getPageIndices() : src.getPageIndices().slice(0, maxPages);
  const before = target.getPageCount();
  try {
    // A page with no content stream (a blank separator sheet) cannot be
    // embedded; it still gets its frame so the page count stays honest.
    const drawable = indices.filter((i) => src.getPage(i).node.Contents() !== undefined);
    const embedded = await target.embedPdf(src, drawable);
    indices.forEach((srcIdx) => {
      const srcPage = src.getPage(srcIdx);
      const ep = embedded[drawable.indexOf(srcIdx)];
      const size = ep ?? srcPage.getSize();
      // embedPage ignores /Rotate, so a scan stored sideways would come out
      // sideways. Undo it here: /Rotate is clockwise, drawPage rotates CCW.
      const turn = ((srcPage.getRotation().angle % 360) + 360) % 360;
      const sideways = turn === 90 || turn === 270;
      const shownW = sideways ? size.height : size.width;
      const shownH = sideways ? size.width : size.height;
      const landscape = shownW > shownH;
      const pageW = landscape ? FRAME_PAGE.height : FRAME_PAGE.width;
      const pageH = landscape ? FRAME_PAGE.width : FRAME_PAGE.height;
      const boxW = pageW - 2 * FRAME_BOX.x;
      const boxH = pageH - FRAME_BOX.y - (FRAME_PAGE.height - FRAME_BOX.y - FRAME_BOX.height);
      const scale = Math.min(boxW / shownW, boxH / shownH, 1);
      const w = shownW * scale;
      const h = shownH * scale;
      // Centred, hung from the top of the box.
      const left = FRAME_BOX.x + (boxW - w) / 2;
      const bottom = FRAME_BOX.y + boxH - h;
      const origin = turn === 90 ? { x: left, y: bottom + h }
        : turn === 180 ? { x: left + w, y: bottom + h }
          : turn === 270 ? { x: left + w, y: bottom }
            : { x: left, y: bottom };
      const page = target.addPage([pageW, pageH]);
      if (ep) page.drawPage(ep, { ...origin, xScale: scale, yScale: scale, rotate: degrees(-turn) });
      page.drawRectangle({ x: left, y: bottom, width: w, height: h, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.75 });
    });
    return indices.length;
  } catch (err) {
    while (target.getPageCount() > before) target.removePage(target.getPageCount() - 1);
    throw err;
  }
}

/** Stamp `label` top-left on pages [fromIdx, toIdx) — names an appended attachment. */
export function stampCaption(doc: PDFDocument, fromIdx: number, toIdx: number, label: string, font: PDFFont): void {
  const text = label.slice(0, 110);
  for (let i = fromIdx; i < toIdx; i++) {
    const page = doc.getPage(i);
    const { height } = page.getSize();
    page.drawText(text, {
      x: 24, y: height - 20, size: 9, font, color: rgb(0.15, 0.15, 0.15),
    });
  }
}

/**
 * Stamp "Page X of Y" (right) and the tenant's report footer (left) onto
 * every page from `skipPages` on — so the footer repeats on every page, not
 * just the last page of each section (which is where a flowed-HTML footer
 * lands).
 */
export async function stampPageFooter(
  doc: PDFDocument,
  opts: { pageNumbers: boolean; footer?: string | null; skipPages?: number },
): Promise<void> {
  const footerLines = (opts.footer && opts.footer.trim())
    ? opts.footer.trim().split('\n').map((l) => l.trim()).filter(Boolean)
    : [];
  if (!opts.pageNumbers && footerLines.length === 0) return;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const total = pages.length;
  const size = 8;
  const gray = rgb(0.4, 0.4, 0.4);
  pages.forEach((page, idx) => {
    if (idx < (opts.skipPages ?? 0)) return;
    const { width: pw } = page.getSize();
    if (opts.pageNumbers) {
      const label = `Page ${idx + 1} of ${total}`;
      const width = font.widthOfTextAtSize(label, size);
      page.drawText(label, { x: pw - width - 36, y: 18, size, font, color: gray });
    }
    if (footerLines.length > 0) {
      // Left-aligned so it never collides with the right page number;
      // truncate to the available width; stack multiple lines upward.
      const maxW = pw - 72 - (opts.pageNumbers ? 90 : 0);
      footerLines.forEach((raw, li) => {
        let text = raw;
        while (text.length > 1 && font.widthOfTextAtSize(text, size) > maxW) text = text.slice(0, -1);
        const y = 18 + (footerLines.length - 1 - li) * 10;
        page.drawText(text, { x: 36, y, size, font, color: gray });
      });
    }
  });
}
