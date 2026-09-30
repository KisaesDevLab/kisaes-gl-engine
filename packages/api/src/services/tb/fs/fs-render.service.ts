// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// PDF for report-ready financial statements. Each section (cover, TOC,
// accountant's report, every statement, the supplementary divider, every
// schedule) is printed separately by Chromium with its own @page size, so
// paper / orientation / margins can differ per statement; pdf-lib then
// merges them and stamps the page chrome (footer text + page numbers)
// with the SAME embedded font via fontkit. Two passes: section page counts
// first, then the table of contents with real page numbers.

import { PDFDocument, rgb, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {
  fsBuildSections, fsFont, fsPageNumberText, fsSectionDocument,
  type FsDocumentInput, type FsFrontMatter, type FsHtmlSection, type FsLetterhead, type FsRenderedReport, type FsStyle,
} from '@kis-books/shared';
import { appendPdf, htmlToPdfBytesCssPage, launchPdfBrowser } from '../../pdf-merge.util.js';
import { fsFontBytes, fsFontDataFiles } from './fs-fonts.js';
import { imageInfoFromDataUri } from './image-size.js';

export interface FsPdfInput {
  report: FsRenderedReport;
  style: FsStyle;
  frontMatter: FsFrontMatter;
  letterhead: FsLetterhead | null;
  letter: { title: string; bodyHtml: string } | null;
  draft?: boolean;
}

export interface FsPdfResult {
  bytes: Buffer;
  pageCount: number;
  sectionPages: Record<string, number>;
}

export async function renderFsPdf(input: FsPdfInput): Promise<FsPdfResult> {
  const doc: FsDocumentInput = {
    report: input.report,
    style: input.style,
    frontMatter: input.frontMatter,
    letterhead: input.letterhead,
    letter: input.letter,
    fonts: { mode: 'data', files: fsFontDataFiles(input.style.fontKey) },
    draftWatermark: input.draft === true,
  };
  const browser = await launchPdfBrowser();
  try {
    // Pass 1: render every section, learn page counts.
    let sections = fsBuildSections(doc);
    const rendered = new Map<string, Uint8Array>();
    const counts = new Map<string, number>();
    for (const s of sections) {
      const bytes = await htmlToPdfBytesCssPage(browser, fsSectionDocument(s, doc));
      rendered.set(s.id, bytes);
      counts.set(s.id, (await PDFDocument.load(bytes)).getPageCount());
    }

    // Numbered pages start at the first numbered section (letter or first
    // statement); cover + TOC are unnumbered.
    const sectionPages: Record<string, number> = {};
    let n = 0;
    for (const s of sections) {
      if (!s.pageNumber) continue;
      sectionPages[s.id] = n + 1;
      n += counts.get(s.id) ?? 0;
    }
    const numberedTotal = n;

    // Pass 2: the TOC with real page numbers.
    if (sections.some((s) => s.kind === 'toc')) {
      sections = fsBuildSections({ ...doc, tocPages: sectionPages });
      const toc = sections.find((s) => s.kind === 'toc')!;
      const bytes = await htmlToPdfBytesCssPage(browser, fsSectionDocument(toc, { ...doc, tocPages: sectionPages }));
      rendered.set(toc.id, bytes);
      counts.set(toc.id, (await PDFDocument.load(bytes)).getPageCount());
    }

    const merged = await PDFDocument.create();
    merged.registerFontkit(fontkit);
    merged.setTitle(`${input.report.meta.companyName} — Financial Statements`);
    merged.setCreator('Vibe MyBooks');
    const ranges: Array<{ section: FsHtmlSection; from: number; to: number }> = [];
    for (const s of sections) {
      const from = merged.getPageCount();
      await appendPdf(merged, rendered.get(s.id)!);
      ranges.push({ section: s, from, to: merged.getPageCount() });
    }

    // Static face matching the footer's bold / italic style. Embedded in
    // full: pdf-lib's subsetter drops glyphs for some fonts (Carlito), and
    // it cannot draw from variable fonts at all.
    const faces = fsFont(input.style.fontKey).stampFaces;
    const fe = input.style.elements.footer;
    const file = fe.bold && fe.italic ? faces.boldItalic : fe.bold ? faces.bold : fe.italic ? faces.italic : faces.regular;
    // Ligatures off: fontkit's substitutions (Carlito's "ti") mis-measure in pdf-lib.
    // Edge-to-edge letterhead logo: the HTML reserved the space; draw the
    // image flush to the top and sides of the section's first page.
    for (const { section, from, to } of ranges) {
      if (!section.bleedLogo || from >= to) continue;
      const info = imageInfoFromDataUri(section.bleedLogo.dataUri);
      if (!info) continue;
      const img = info.type === 'png' ? await merged.embedPng(info.bytes) : await merged.embedJpg(info.bytes);
      const page = merged.getPage(from);
      const { width, height } = page.getSize();
      const h = section.bleedLogo.heightIn * 72;
      page.drawImage(img, { x: 0, y: height - h, width, height: h });
    }

    const font = await merged.embedFont(fsFontBytes(file), { subset: false, features: { liga: false, clig: false, dlig: false, calt: false } });
    stampChrome(merged, ranges, input.style, font, numberedTotal);

    const out = Buffer.from(await merged.save());
    return { bytes: out, pageCount: merged.getPageCount(), sectionPages };
  } finally {
    await browser.close();
  }
}

function stampChrome(
  doc: PDFDocument,
  ranges: Array<{ section: FsHtmlSection; from: number; to: number }>,
  style: FsStyle,
  font: PDFFont,
  numberedTotal: number,
) {
  const baseSize = style.elements.footer.sizePt;
  const fmt = style.footer.pageNumber.format;
  const right = style.footer.pageNumber.position === 'bottom_right';
  // Keep the lowest baseline clear of the printer's unprintable edge.
  const minBaseline = 22; // pt (~0.3in)
  let pageNo = 0;
  for (const { section, from, to } of ranges) {
    for (let i = from; i < to; i++) {
      const page = doc.getPage(i);
      const { width } = page.getSize();
      const m = section.pageSetup.margins;
      const left = m.left * 72;
      const rightEdge = width - m.right * 72;
      const avail = rightEdge - left;
      const footerText = section.footer ? style.footer.text.trim() : '';
      let numberText = '';
      if (section.pageNumber) {
        pageNo += 1;
        numberText = fsPageNumberText(fmt, pageNo, numberedTotal);
      }
      if (!footerText && !numberText) continue;
      // Side by side (number bottom-right) needs room for both on one line.
      const needed = right
        ? font.widthOfTextAtSize(footerText, baseSize) + (numberText ? font.widthOfTextAtSize(numberText, baseSize) + 18 : 0)
        : Math.max(font.widthOfTextAtSize(footerText, baseSize), font.widthOfTextAtSize(numberText, baseSize));
      const size = needed > avail ? Math.max(6, baseSize * (avail / needed)) : baseSize;
      const lines: Array<{ text: string; align: 'left' | 'center' | 'right' }> = [];
      if (right) {
        if (footerText) lines.push({ text: footerText, align: 'left' });
        if (numberText) lines.push({ text: numberText, align: 'right' });
      } else {
        if (footerText) lines.push({ text: footerText, align: 'center' });
        if (numberText) lines.push({ text: numberText, align: 'center' });
      }
      const gap = size * 1.35;
      const stacked = right ? 1 : lines.length;
      const blockH = size + (stacked - 1) * gap;
      const bottomMargin = m.bottom * 72;
      const y0 = Math.max(minBaseline, (bottomMargin - blockH) / 2);
      lines.forEach((l, idx) => {
        const w = font.widthOfTextAtSize(l.text, size);
        const x = l.align === 'center' ? (width - w) / 2 : l.align === 'right' ? rightEdge - w : left;
        const y = right ? y0 : y0 + (lines.length - 1 - idx) * gap;
        page.drawText(l.text, { x, y, size, font, color: rgb(0, 0, 0) });
      });
    }
  }
}
