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
  td{padding:5px 8px;border-bottom:1px solid #e5e7eb}
  .amount{text-align:right;font-family:monospace}
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

export async function toPdf(html: string): Promise<Buffer> {
  try {
    const puppeteer = await import('puppeteer');
    const browser = await puppeteer.default.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'Letter',
      margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' },
      printBackground: true,
    });
    await browser.close();
    return Buffer.from(pdf);
  } catch {
    return Buffer.from(html, 'utf-8');
  }
}
