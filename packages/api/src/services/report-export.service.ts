// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

/**
 * Escape a string for safe insertion into HTML. Used by the PDF pipeline
 * so user-controlled strings (account names, memos, P&L section labels,
 * company names) can't inject markup or script tags into the rendered
 * PDF — puppeteer would otherwise execute them.
 */
export function escapeHtml(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Prefix CSV values that look like formula attacks (start with =, +, @,
 * or a lone - followed by alphanumerics — i.e. a potential function call
 * or reference) with a leading apostrophe so Excel / Google Sheets treat
 * them as literal text. Skips decorative section banners like
 * "--- REVENUE ---" whose leading dashes are cosmetic, not attacks.
 */
function neutralizeFormula(s: string): string {
  if (/^[=+@]/.test(s)) return `'${s}`;
  // Lone '-' followed by a letter/digit (e.g. -SUM(...), -1+1) — but not
  // our "---" section banners.
  if (/^-[A-Za-z0-9]/.test(s)) return `'${s}`;
  return s;
}

export function toCsv(data: Record<string, unknown>[], columns: Array<{ key: string; label: string }>): string {
  const header = columns.map((c) => `"${neutralizeFormula(c.label).replace(/"/g, '""')}"`).join(',');
  const rows = data.map((row) =>
    columns.map((c) => {
      const val = row[c.key];
      if (val === null || val === undefined) return '""';
      return `"${neutralizeFormula(String(val)).replace(/"/g, '""')}"`;
    }).join(','),
  );
  return header + '\n' + rows.join('\n');
}

export function toReportHtml(
  title: string,
  companyName: string,
  dateLabel: string,
  tableHtml: string,
): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:30px;font-size:12px;color:#111}
  h1{font-size:20px;margin:0 0 4px}
  .meta{color:#666;margin-bottom:20px;font-size:11px}
  table{width:100%;border-collapse:collapse}
  th{background:#f3f4f6;padding:6px 8px;text-align:left;font-size:10px;text-transform:uppercase;border-bottom:2px solid #d1d5db}
  td{padding:5px 8px;border-bottom:1px solid #e5e7eb;font-size:11px}
  .amount{text-align:right;font-variant-numeric:tabular-nums}
  .total-row{font-weight:bold;border-top:2px solid #111}
  @media print{body{padding:0}}
</style></head>
<body>
  <h1>${escapeHtml(companyName)}</h1>
  <div style="font-size:16px;font-weight:600;margin-bottom:2px">${escapeHtml(title)}</div>
  <div class="meta">${escapeHtml(dateLabel)}</div>
  ${tableHtml}
</body></html>`;
}

export interface ToPdfOptions {
  /** Page orientation. Defaults to portrait. Use 'landscape' for wide
   * reports like the General Ledger that need extra horizontal room. */
  orientation?: 'portrait' | 'landscape';
}

export async function toPdf(html: string, options: ToPdfOptions = {}): Promise<Buffer> {
  // Errors are NOT caught here — see the long-form note in
  // pdf.service.ts. The previous version returned raw HTML as a Buffer
  // on failure, which the routes then served with Content-Type:
  // application/pdf, producing files that PDF readers display as garbage.
  const puppeteer = await import('puppeteer');
  const browser = await puppeteer.default.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    executablePath: process.env['PUPPETEER_EXECUTABLE_PATH'] || undefined,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'Letter',
      landscape: options.orientation === 'landscape',
      margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' },
      printBackground: true,
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
