// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Report-pack generation core. Renders each report section to its own
// single-orientation PDF via one Chromium, merges [cover, TOC, ...sections]
// with pdf-lib, stamps cross-document page numbers, and uploads the merged
// buffer as a transient artifact (expires_at = now + TTL).
//
// Lives in the API package so it can run in EITHER process: the background
// worker's BullMQ job (the normal path) OR inline in the API when the queue
// is unreachable (appliance deployments without a separate worker/Redis).

import { and, asc, eq, inArray } from 'drizzle-orm';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import puppeteer, { type Browser } from 'puppeteer';
import { sql } from 'drizzle-orm';
import {
  getReportDef,
  resolveReportDates,
  reportPackItemOptionsSchema,
  formatIsoUS,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { reportPacks, reportPackItems, reportPackRuns } from '../db/schema/index.js';
import { REPORT_PACK_RENDERERS, renderReportSectionHtml } from './report-pack-render.js';
import { buildReportPackSectionHtml, escapeHtml } from './report-export.service.js';
import { getLetter, resolveLetterContent, buildLetterPageHtml } from './report-letter.service.js';
import { getReportFooter } from './tenant-report-settings.service.js';
import { getProviderForTenant } from './storage/storage-provider.factory.js';
import { reportPackArtifactKey, ARTIFACT_TTL_MS } from './report-pack.service.js';

const TOC_ENTRIES_PER_PAGE = 30;
const PDF_MARGIN = { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' };

interface RenderedSection {
  reportId: string;
  label: string;
  bytes: Uint8Array;
  pageCount: number;
  startPage: number;
}

interface SectionFailure {
  reportId: string;
  message: string;
}

async function htmlToPdfBytes(browser: Browser, html: string, landscape: boolean): Promise<Uint8Array> {
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({ format: 'Letter', landscape, margin: PDF_MARGIN, printBackground: true });
  } finally {
    await page.close();
  }
}

function coverHtml(packName: string, companyName: string, dateLabel: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;height:100vh;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#111}
    .company{font-size:16px;color:#666;margin-bottom:8px}
    .title{font-size:34px;font-weight:700;text-align:center;margin:0 40px}
    .date{font-size:15px;color:#444;margin-top:16px}
  </style></head><body>
    <div class="company">${escapeHtml(companyName)}</div>
    <div class="title">${escapeHtml(packName)}</div>
    <div class="date">${escapeHtml(dateLabel)}</div>
  </body></html>`;
}

function tocHtml(entries: Array<{ label: string; startPage: number }>): string {
  const rows = entries.map((e, i) => `
    <tr><td class="idx">${i + 1}.</td><td class="lbl">${escapeHtml(e.label)}</td><td class="pg">${e.startPage}</td></tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:40px;color:#111}
    h1{font-size:24px;margin:0 0 24px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    td{padding:7px 4px;border-bottom:1px solid #eee}
    .idx{width:34px;color:#666}
    .pg{width:60px;text-align:right;font-variant-numeric:tabular-nums;color:#444}
  </style></head><body>
    <h1>Contents</h1>
    <table>${rows}</table>
  </body></html>`;
}

/** Copy every page of a source PDF (raw bytes) into `target`. */
async function appendPdf(target: PDFDocument, srcBytes: Uint8Array): Promise<void> {
  const src = await PDFDocument.load(srcBytes);
  const pages = await target.copyPages(src, src.getPageIndices());
  for (const p of pages) target.addPage(p);
}

/**
 * Generate one report_pack_runs row end-to-end: render sections, merge, stamp
 * page numbers + footer, upload the transient artifact, and move the run to
 * succeeded / partial / failed. Idempotent enough for at-least-once delivery —
 * a re-run simply re-uploads and overwrites the run's transient artifact.
 */
export async function generateReportPackRun(runId: string): Promise<void> {
  const run = await db.query.reportPackRuns.findFirst({ where: eq(reportPackRuns.id, runId) });
  if (!run) {
    console.error(`[report-pack] run ${runId} not found — skipping`);
    return;
  }
  const pack = await db.query.reportPacks.findFirst({ where: eq(reportPacks.id, run.packId) });
  if (!pack || pack.deletedAt) {
    await db.update(reportPackRuns).set({
      status: 'failed',
      finishedAt: new Date(),
      errorJson: { message: 'Pack was deleted before the run started' },
    }).where(eq(reportPackRuns.id, runId));
    return;
  }

  const items = await db.select().from(reportPackItems)
    .where(eq(reportPackItems.packId, pack.id))
    .orderBy(asc(reportPackItems.sortOrder));

  // Atomically CLAIM the run. createRun's enqueue-timeout fallback can race
  // the worker (a slow-but-successful enqueue after the timeout fires both
  // the inline generator and the queued job) — without this compare-and-swap
  // two Chromium renders would fight over the same run row and artifact key.
  // 'failed' stays claimable so a queued retry after a failure still runs.
  const claimed = await db.update(reportPackRuns)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(reportPackRuns.id, runId), inArray(reportPackRuns.status, ['queued', 'failed'])))
    .returning({ id: reportPackRuns.id });
  if (claimed.length === 0) {
    console.log(`[report-pack] run ${runId} already claimed by another generator — skipping`);
    return;
  }

  const companyRow = await db.execute(
    sql`SELECT business_name FROM companies WHERE id = ${run.companyId}`,
  );
  const companyName = (companyRow.rows as Array<{ business_name?: string }>)[0]?.business_name || 'Company';
  const tenantFooter = await getReportFooter(run.tenantId);
  // A pack-level per-page footer (user-typed) overrides the tenant default so
  // every page of THIS pack carries the caller's footer text.
  const footer = (pack.pageFooter && pack.pageFooter.trim()) ? pack.pageFooter.trim() : tenantFooter;

  const rangeStart = run.rangeStart ?? '';
  const rangeEnd = run.rangeEnd ?? '';
  const asOfDate = run.asOfDate ?? rangeEnd;

  const sections: RenderedSection[] = [];
  const failures: SectionFailure[] = [];

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    executablePath: process.env['PUPPETEER_EXECUTABLE_PATH'] || undefined,
  });

  try {
    // Engagement letter (SSARS 21) — rendered FIRST, before any financial
    // statement, so it opens the pack. Reuses the pack's date range + default
    // basis. A missing/inactive letter is skipped silently; a render error
    // follows the pack's onError policy like any other section.
    if (pack.letterId) {
      try {
        const letter = await getLetter(pack.letterId);
        if (letter.isActive) {
          const basis = pack.defaultBasis === 'cash' ? 'cash' : 'accrual';
          const { title, bodyHtml, fontStack } = await resolveLetterContent(letter, run.tenantId, run.companyId, {
            periodStart: rangeStart,
            periodEnd: rangeEnd,
            asOfDate,
            basis,
            reportDate: rangeEnd,
          });
          // Footer is stamped on EVERY page after merge (below), not embedded
          // in the flowed HTML (which only lands on the last page).
          const letterHtml = buildLetterPageHtml({ title, bodyHtml, companyName, footer: '', fontStack });
          const bytes = await htmlToPdfBytes(browser, letterHtml, false);
          const doc = await PDFDocument.load(bytes);
          sections.push({ reportId: '__letter__', label: title, bytes, pageCount: doc.getPageCount(), startPage: 0 });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (pack.onError === 'skip') {
          failures.push({ reportId: '__letter__', message });
        } else {
          throw err;
        }
      }
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      await db.update(reportPackRuns).set({
        progress: Math.round((i / Math.max(items.length, 1)) * 90),
        currentReportId: item.reportId,
      }).where(eq(reportPackRuns.id, runId));

      const def = getReportDef(item.reportId);
      try {
        const renderer = REPORT_PACK_RENDERERS[item.reportId];
        if (!def || !renderer) throw new Error(`Unknown report id: ${item.reportId}`);

        const options = reportPackItemOptionsSchema.parse(item.optionsJson ?? {});
        const params = resolveReportDates(def, { start: rangeStart, end: rangeEnd }, asOfDate);
        const opts = {
          basis: options.basis ?? (pack.defaultBasis === 'cash' ? 'cash' as const : 'accrual' as const),
          tagId: options.tagId ?? pack.defaultTagId ?? null,
          groupBy: options.groupBy ?? null,
          showPct: options.showPct ?? false,
          compare: options.compare ?? false,
        };

        const reportData = await renderer(run.tenantId, run.companyId, params, opts);
        const { html: tableHtml, orientation } = renderReportSectionHtml(item.reportId, reportData);
        const dateLabel = def.temporal === 'as-of'
          ? `As of ${formatIsoUS(params['as_of_date'] ?? asOfDate)}`
          : `${formatIsoUS(rangeStart)} to ${formatIsoUS(rangeEnd)}`;
        const sectionHtml = buildReportPackSectionHtml({
          title: def.label, companyName, dateLabel, tableHtml, footer: '',
        });
        const bytes = await htmlToPdfBytes(browser, sectionHtml, orientation === 'landscape');
        const doc = await PDFDocument.load(bytes);
        sections.push({ reportId: item.reportId, label: def.label, bytes, pageCount: doc.getPageCount(), startPage: 0 });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (pack.onError === 'skip') {
          failures.push({ reportId: item.reportId, message });
          continue;
        }
        throw err;
      }
    }

    const coverPages = pack.coverPage ? 1 : 0;
    const tocPages = pack.toc && sections.length > 0 ? Math.ceil(sections.length / TOC_ENTRIES_PER_PAGE) : 0;
    let cursor = coverPages + tocPages + 1;
    for (const s of sections) {
      s.startPage = cursor;
      cursor += s.pageCount;
    }

    const merged = await PDFDocument.create();
    if (coverPages > 0) {
      const dateLabel = `${formatIsoUS(rangeStart)} to ${formatIsoUS(rangeEnd)}`;
      await appendPdf(merged, await htmlToPdfBytes(browser, coverHtml(pack.name, companyName, dateLabel), false));
    }
    if (tocPages > 0) {
      const tocBytes = await htmlToPdfBytes(browser, tocHtml(sections.map((s) => ({ label: s.label, startPage: s.startPage }))), false);
      await appendPdf(merged, tocBytes);
    }
    for (const s of sections) await appendPdf(merged, s.bytes);

    if (merged.getPageCount() === 0) merged.addPage();

    // Stamp page numbers (right) and the footer (left) onto EVERY content
    // page of the merged PDF — so the footer repeats on every page, not just
    // the last page of each section (which is where a flowed-HTML footer lands).
    const footerLines = (footer && footer.trim())
      ? footer.trim().split('\n').map((l) => l.trim()).filter(Boolean)
      : [];
    if (pack.pageNumbers || footerLines.length > 0) {
      const font = await merged.embedFont(StandardFonts.Helvetica);
      const pages = merged.getPages();
      const total = pages.length;
      const size = 8;
      const gray = rgb(0.4, 0.4, 0.4);
      pages.forEach((page, idx) => {
        if (idx < coverPages) return;
        const { width: pw } = page.getSize();
        if (pack.pageNumbers) {
          const label = `Page ${idx + 1} of ${total}`;
          const width = font.widthOfTextAtSize(label, size);
          page.drawText(label, { x: pw - width - 36, y: 18, size, font, color: gray });
        }
        if (footerLines.length > 0) {
          // Left-aligned so it never collides with the right page number;
          // truncate to the available width; stack multiple lines upward.
          const maxW = pw - 72 - (pack.pageNumbers ? 90 : 0);
          footerLines.forEach((raw, li) => {
            let text = raw;
            while (text.length > 1 && font.widthOfTextAtSize(text, size) > maxW) text = text.slice(0, -1);
            const y = 18 + (footerLines.length - 1 - li) * 10;
            page.drawText(text, { x: 36, y, size, font, color: gray });
          });
        }
      });
    }

    const mergedBytes = await merged.save();
    const buffer = Buffer.from(mergedBytes);
    const key = reportPackArtifactKey(run.tenantId, runId);
    const provider = await getProviderForTenant(run.tenantId);
    await provider.upload(key, buffer, { fileName: `${runId}.pdf`, mimeType: 'application/pdf', sizeBytes: buffer.length });

    const status = failures.length > 0 ? 'partial' : 'succeeded';
    await db.update(reportPackRuns).set({
      status,
      progress: 100,
      currentReportId: null,
      transientKey: key,
      expiresAt: new Date(Date.now() + ARTIFACT_TTL_MS),
      pageCount: merged.getPageCount(),
      byteSize: buffer.length,
      errorJson: failures.length > 0 ? { failures } : null,
      finishedAt: new Date(),
    }).where(eq(reportPackRuns.id, runId));

    console.log(`[report-pack] run ${runId} ${status}: ${sections.length} section(s), ${failures.length} failure(s), ${merged.getPageCount()} page(s)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(reportPackRuns).set({
      status: 'failed',
      currentReportId: null,
      errorJson: { message, failures },
      finishedAt: new Date(),
    }).where(and(eq(reportPackRuns.id, runId)));
    throw err;
  } finally {
    await browser.close();
  }
}
