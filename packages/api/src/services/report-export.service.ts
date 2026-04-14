export function toCsv(data: Record<string, unknown>[], columns: Array<{ key: string; label: string }>): string {
  const header = columns.map((c) => `"${c.label}"`).join(',');
  const rows = data.map((row) =>
    columns.map((c) => {
      const val = row[c.key];
      if (val === null || val === undefined) return '""';
      return `"${String(val).replace(/"/g, '""')}"`;
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
  <h1>${companyName}</h1>
  <div style="font-size:16px;font-weight:600;margin-bottom:2px">${title}</div>
  <div class="meta">${dateLabel}</div>
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
