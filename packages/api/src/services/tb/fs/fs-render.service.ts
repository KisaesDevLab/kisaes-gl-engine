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

    const font = await merged.embedFont(fsFontBytes(fsFont(input.style.fontKey).footerFile), { subset: true });
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
  const size = style.elements.footer.sizePt;
  const fmt = style.footer.pageNumber.format;
  const right = style.footer.pageNumber.position === 'bottom_right';
  let pageNo = 0;
  for (const { section, from, to } of ranges) {
    for (let i = from; i < to; i++) {
      const page = doc.getPage(i);
      const { width } = page.getSize();
      const m = section.pageSetup.margins;
      const left = m.left * 72;
      const rightEdge = width - m.right * 72;
      const baseY = Math.max(14, (m.bottom * 72) / 2 - size / 2);
      const lines: Array<{ text: string; align: 'left' | 'center' | 'right' }> = [];
      if (section.footer && style.footer.text.trim()) lines.push({ text: style.footer.text.trim(), align: right ? 'left' : 'center' });
      if (section.pageNumber) {
        pageNo += 1;
        const t = fsPageNumberText(fmt, pageNo, numberedTotal);
        if (t) lines.push({ text: t, align: right ? 'right' : 'center' });
      }
      // Footer text above the page number when both are centred; side by
      // side when the number sits bottom-right.
      let y = baseY + (lines.length > 1 && !right ? size * 1.4 : 0);
      for (const l of lines) {
        const w = font.widthOfTextAtSize(l.text, size);
        const x = l.align === 'center' ? (width - w) / 2 : l.align === 'right' ? rightEdge - w : left;
        page.drawText(l.text, { x, y, size, font, color: rgb(0, 0, 0) });
        if (!right) y -= size * 1.4;
      }
    }
  }
}
