// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import puppeteer, { type Browser } from 'puppeteer';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 15.4 + 17.1 — small
// Puppeteer wrapper used by W-9 confirmation PDFs and report
// instance PDFs. Reuses a single headless browser across the
// process to amortize the launch cost.

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    });
  }
  return browserPromise;
}

export async function htmlToPdf(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'letter',
      printBackground: true,
      margin: { top: '0.75in', right: '0.75in', bottom: '0.75in', left: '0.75in' },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}

// Bare-bones HTML escape for the templates below — they take
// already-validated user input but defensive escaping keeps a
// future regression from injecting markup.
export function escapeHtml(s: string | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 15.4 — W-9 confirmation HTML. Not the official IRS layout (the
// IRS PDF can't be filled programmatically without their fillable
// PDF), but a same-shape summary that the firm can keep on file
// alongside the audit-trail row.
export interface W9PdfData {
  legalName: string;
  businessName?: string | null;
  taxClassification: string;
  exemptPayeeCode?: string | null;
  address: { line1: string; city: string; state: string; zip: string };
  tinMasked: string;
  tinType: 'SSN' | 'EIN';
  signedAt: Date;
  signatureName: string;
  ipAddress?: string | null;
}

export function w9HtmlTemplate(d: W9PdfData): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:'Helvetica Neue',Arial,sans-serif;color:#111;font-size:11pt;line-height:1.4}
h1{font-size:18pt;margin-bottom:4px}
.meta{color:#555;font-size:9pt}
.section{margin-top:18px;border-top:1px solid #ccc;padding-top:8px}
.k{color:#555;font-size:9pt;text-transform:uppercase;letter-spacing:.05em}
.v{font-size:11pt}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px}
.note{margin-top:24px;padding:12px;border:1px solid #ddd;background:#fafafa;font-size:9pt;color:#444}
.sig{margin-top:18px;font-size:11pt}
</style></head><body>
<h1>Form W-9 — Request for Taxpayer Identification</h1>
<p class="meta">Captured ${escapeHtml(d.signedAt.toISOString())}</p>

<div class="section">
  <div class="k">Legal name</div>
  <div class="v">${escapeHtml(d.legalName)}</div>
  ${d.businessName ? `<div class="k" style="margin-top:6px">Business name</div><div class="v">${escapeHtml(d.businessName)}</div>` : ''}
</div>

<div class="section">
  <div class="grid">
    <div><div class="k">Federal tax classification</div><div class="v">${escapeHtml(d.taxClassification)}</div></div>
    <div><div class="k">Exempt payee code</div><div class="v">${escapeHtml(d.exemptPayeeCode ?? '—')}</div></div>
  </div>
</div>

<div class="section">
  <div class="k">Address</div>
  <div class="v">
    ${escapeHtml(d.address.line1)}<br>
    ${escapeHtml(d.address.city)}, ${escapeHtml(d.address.state)} ${escapeHtml(d.address.zip)}
  </div>
</div>

<div class="section">
  <div class="grid">
    <div><div class="k">Taxpayer ID number</div><div class="v">${escapeHtml(d.tinMasked)}</div></div>
    <div><div class="k">TIN type</div><div class="v">${escapeHtml(d.tinType)}</div></div>
  </div>
</div>

<div class="sig">
  <div class="k">Electronic signature</div>
  <div class="v">${escapeHtml(d.signatureName)} · ${escapeHtml(d.signedAt.toUTCString())}</div>
  ${d.ipAddress ? `<div class="meta">From IP ${escapeHtml(d.ipAddress)}</div>` : ''}
</div>

<div class="note">
  This document is a record of the W-9 information provided through the
  client portal. The submitter consented to electronic signature, and the
  Taxpayer ID is stored encrypted at rest. Retain for three years per IRS
  Pub. 1281.
</div>
</body></html>`;
}

// 17.1 — report instance HTML template. Renders the layout block
// list against the data snapshot. Honors the template's theme
// (primary color, font, logo, header/footer) and the per-block
// text_overrides from the data snapshot. The same data shape feeds
// the interactive client-side renderer in the portal.
export interface ReportPdfData {
  companyName: string;
  templateName: string;
  periodStart: string;
  periodEnd: string;
  layout: unknown[];
  data: Record<string, unknown>;
  publishedAt: Date;
  theme?: Record<string, unknown>;
}

function safeColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value) ? value : fallback;
}

function fmtMoneyPdf(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function fmtDeltaPct(cur: number, prior: number | null | undefined): string {
  if (prior == null || prior === 0 || !Number.isFinite(prior)) return '—';
  const pct = ((cur - prior) / Math.abs(prior)) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

// ── Inline SVG charts for the PDF ───────────────────────────────
// Puppeteer renders SVG natively (no JS execution needed), so a
// self-contained <svg> is the cleanest way to put real charts into
// the printed report.

interface ChartSeries {
  /** Series label (shown in the legend). */
  name: string;
  color: string;
  /** Per-category values. Length must match the categories array. */
  values: number[];
}

interface BarChartOpts {
  width?: number;
  height?: number;
  categories: string[];
  series: ChartSeries[];
  /** Where to draw the y-axis tick labels. Auto-derived if absent. */
  yTicks?: number;
}

function svgBarChart(opts: BarChartOpts): string {
  const W = opts.width ?? 640;
  const H = opts.height ?? 240;
  const PAD_L = 70;
  const PAD_R = 12;
  const PAD_T = 10;
  const PAD_B = 50; // room for x labels + legend
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const cats = opts.categories;
  const series = opts.series;
  if (cats.length === 0 || series.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"></svg>`;
  }

  // Y-axis range — include 0 even when all values are positive or
  // negative so bars anchor visually correctly.
  const allValues = series.flatMap((s) => s.values);
  const rawMin = Math.min(0, ...allValues);
  const rawMax = Math.max(0, ...allValues);
  // Pad 5% on the dominant side for breathing room.
  const span = Math.max(rawMax - rawMin, 1);
  const yMin = rawMin === 0 ? rawMin : rawMin - span * 0.05;
  const yMax = rawMax === 0 ? rawMax : rawMax + span * 0.05;
  const yRange = yMax - yMin || 1;

  const yToPx = (v: number) => PAD_T + innerH - ((v - yMin) / yRange) * innerH;
  const zeroY = yToPx(0);

  // Horizontal layout: each category gets a "group" of widths
  // groupW; inside each group the series bars sit side-by-side.
  const groupW = innerW / cats.length;
  const barGap = 4;
  const barW = Math.max(2, (groupW - barGap * (series.length + 1)) / series.length);

  // Y-axis tick labels — 4 ticks: min, 1/3, 2/3, max.
  const ticks = [yMin, yMin + yRange * (1 / 3), yMin + yRange * (2 / 3), yMax];

  const escSvg = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Format Y tick values as compact currency ($1k, $1M).
  const fmtTick = (v: number): string => {
    if (!Number.isFinite(v)) return '';
    const abs = Math.abs(v);
    if (abs >= 1_000_000) return `${v < 0 ? '-' : ''}$${(abs / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${v < 0 ? '-' : ''}$${(abs / 1_000).toFixed(0)}k`;
    return `${v < 0 ? '-' : ''}$${abs.toFixed(0)}`;
  };

  const gridLines = ticks
    .map(
      (t) =>
        `<line x1="${PAD_L}" y1="${yToPx(t)}" x2="${PAD_L + innerW}" y2="${yToPx(t)}" stroke="#eee" stroke-width="1"/>`,
    )
    .join('');

  const yLabels = ticks
    .map(
      (t) =>
        `<text x="${PAD_L - 6}" y="${yToPx(t) + 3}" text-anchor="end" font-size="9" fill="#555">${escSvg(fmtTick(t))}</text>`,
    )
    .join('');

  // Bars + category labels.
  let bars = '';
  let xLabels = '';
  cats.forEach((cat, i) => {
    const groupX = PAD_L + i * groupW;
    series.forEach((s, j) => {
      const v = s.values[i] ?? 0;
      const x = groupX + barGap + j * (barW + barGap);
      const y0 = zeroY;
      const y1 = yToPx(v);
      const y = Math.min(y0, y1);
      const h = Math.max(1, Math.abs(y0 - y1));
      bars += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${s.color}" rx="2" />`;
    });
    xLabels += `<text x="${groupX + groupW / 2}" y="${PAD_T + innerH + 14}" text-anchor="middle" font-size="9" fill="#555">${escSvg(cat)}</text>`;
  });

  // Zero baseline (only draw if it's inside the plot, not at the very bottom).
  const baseline =
    zeroY > PAD_T && zeroY < PAD_T + innerH
      ? `<line x1="${PAD_L}" y1="${zeroY}" x2="${PAD_L + innerW}" y2="${zeroY}" stroke="#999" stroke-width="1"/>`
      : '';

  // Legend below the chart.
  const legendItems = series.map((s, i) => {
    const lx = PAD_L + i * 110;
    const ly = H - 12;
    return `<g><rect x="${lx}" y="${ly - 8}" width="10" height="10" fill="${s.color}" rx="2"/><text x="${lx + 14}" y="${ly}" font-size="9" fill="#333">${escSvg(s.name)}</text></g>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Helvetica Neue',Arial,sans-serif">
${gridLines}
${baseline}
${bars}
${yLabels}
${xLabels}
${legendItems}
</svg>`;
}

interface PdfBlockPayload {
  type: string;
  data?: unknown;
  error?: string;
}

function renderBlockPdf(block: Record<string, unknown>, payload: PdfBlockPayload | undefined): string {
  const blockType = String(block['type'] ?? '');
  const name =
    (block['name'] as string | undefined) ??
    (block['report'] as string | undefined) ??
    (block['key'] as string | undefined) ??
    '';
  const friendly = name.replace(/_/g, ' ');

  if (!payload) {
    return `<section class="section"><h2>${escapeHtml(friendly)}</h2><p class="meta">No data computed.</p></section>`;
  }
  if (payload.error) {
    return `<section class="section"><h2>${escapeHtml(friendly)}</h2><p class="meta">${escapeHtml(payload.error)}</p></section>`;
  }

  switch (payload.type) {
    case 'top_customers':
    case 'top_vendors': {
      const rows = (payload.data as Array<{ name: string; amount: number }>) ?? [];
      const heading = payload.type === 'top_customers' ? 'Top Customers' : 'Top Vendors';
      if (rows.length === 0) {
        return `<section class="section"><h2>${heading}</h2><p class="meta">No activity in this period.</p></section>`;
      }
      const tbody = rows
        .map(
          (r) =>
            `<tr><td>${escapeHtml(r.name)}</td><td class="num">${escapeHtml(fmtMoneyPdf(r.amount))}</td></tr>`,
        )
        .join('');
      return `<section class="section"><h2>${heading}</h2><table class="data"><tbody>${tbody}</tbody></table></section>`;
    }
    case 'ar_aging':
    case 'ap_aging': {
      const b = payload.data as
        | {
            current: number;
            days1to30: number;
            days31to60: number;
            days61to90: number;
            over90: number;
            total: number;
          }
        | null
        | undefined;
      const heading = payload.type === 'ar_aging' ? 'Receivables Aging' : 'Payables Aging';
      if (!b || b.total === 0) {
        return `<section class="section"><h2>${heading}</h2><p class="meta">Nothing outstanding.</p></section>`;
      }
      return `<section class="section"><h2>${heading}</h2>
<table class="aging"><thead><tr><th>Current</th><th>1–30</th><th>31–60</th><th>61–90</th><th>90+</th><th>Total</th></tr></thead>
<tbody><tr>
<td class="num">${escapeHtml(fmtMoneyPdf(b.current))}</td>
<td class="num">${escapeHtml(fmtMoneyPdf(b.days1to30))}</td>
<td class="num">${escapeHtml(fmtMoneyPdf(b.days31to60))}</td>
<td class="num">${escapeHtml(fmtMoneyPdf(b.days61to90))}</td>
<td class="num">${escapeHtml(fmtMoneyPdf(b.over90))}</td>
<td class="num strong">${escapeHtml(fmtMoneyPdf(b.total))}</td>
</tr></tbody></table></section>`;
    }
    case 'pl_bar': {
      // pl_bar = chart block — render as SVG bars instead of a table.
      const p = payload.data as
        | {
            revenue: number;
            cogs: number;
            grossProfit: number;
            operatingExpense: number;
            netIncome: number;
          }
        | null
        | undefined;
      if (!p) {
        return `<section class="section"><h2>Profit &amp; Loss</h2><p class="meta">No data.</p></section>`;
      }
      const chart = svgBarChart({
        categories: ['Revenue', 'COGS', 'Gross Profit', 'Op. Expense', 'Net Income'],
        series: [
          {
            name: 'Amount',
            color: '#4f46e5',
            values: [p.revenue, p.cogs, p.grossProfit, p.operatingExpense, p.netIncome],
          },
        ],
      });
      return `<section class="section"><h2>Profit &amp; Loss</h2><div class="chart">${chart}</div></section>`;
    }
    case 'profit_loss': {
      // profit_loss = report-embed block — keep as a structured table.
      const p = payload.data as
        | {
            revenue: number;
            cogs: number;
            grossProfit: number;
            operatingExpense: number;
            netIncome: number;
          }
        | null
        | undefined;
      if (!p) {
        return `<section class="section"><h2>Profit &amp; Loss</h2><p class="meta">No data.</p></section>`;
      }
      return `<section class="section"><h2>Profit &amp; Loss</h2>
<table class="data"><tbody>
<tr><td>Revenue</td><td class="num">${escapeHtml(fmtMoneyPdf(p.revenue))}</td></tr>
<tr><td>COGS</td><td class="num">${escapeHtml(fmtMoneyPdf(p.cogs))}</td></tr>
<tr><td>Gross Profit</td><td class="num strong">${escapeHtml(fmtMoneyPdf(p.grossProfit))}</td></tr>
<tr><td>Operating Expense</td><td class="num">${escapeHtml(fmtMoneyPdf(p.operatingExpense))}</td></tr>
<tr class="total"><td>Net Income</td><td class="num strong">${escapeHtml(fmtMoneyPdf(p.netIncome))}</td></tr>
</tbody></table></section>`;
    }
    case 'balance_sheet': {
      const b = payload.data as { assets: number; liabilities: number; equity: number } | null | undefined;
      if (!b) {
        return `<section class="section"><h2>Balance Sheet</h2><p class="meta">No data.</p></section>`;
      }
      return `<section class="section"><h2>Balance Sheet</h2>
<table class="data"><tbody>
<tr><td>Total Assets</td><td class="num strong">${escapeHtml(fmtMoneyPdf(b.assets))}</td></tr>
<tr><td>Total Liabilities</td><td class="num">${escapeHtml(fmtMoneyPdf(b.liabilities))}</td></tr>
<tr><td>Total Equity</td><td class="num">${escapeHtml(fmtMoneyPdf(b.equity))}</td></tr>
</tbody></table></section>`;
    }
    case 'pl_vs_prior_year': {
      const d = payload.data as
        | {
            current: { revenue: number; cogs: number; grossProfit: number; operatingExpense: number; netIncome: number };
            prior: { revenue: number; cogs: number; grossProfit: number; operatingExpense: number; netIncome: number } | null;
          }
        | null
        | undefined;
      if (!d) {
        return `<section class="section"><h2>P&amp;L vs. Prior Year</h2><p class="meta">No data.</p></section>`;
      }
      const cats = ['Revenue', 'COGS', 'Gross Profit', 'Op. Expense', 'Net Income'];
      const curVals = [
        d.current.revenue,
        d.current.cogs,
        d.current.grossProfit,
        d.current.operatingExpense,
        d.current.netIncome,
      ];
      const priorVals = d.prior
        ? [
            d.prior.revenue,
            d.prior.cogs,
            d.prior.grossProfit,
            d.prior.operatingExpense,
            d.prior.netIncome,
          ]
        : [0, 0, 0, 0, 0];
      const chart = svgBarChart({
        categories: cats,
        series: [
          { name: 'Current', color: '#4f46e5', values: curVals },
          { name: 'Prior YR', color: '#9ca3af', values: priorVals },
        ],
      });
      // Keep a small Δ-summary table beneath the chart so the printed
      // page still surfaces exact percentages.
      const rows: Array<[string, number, number | null]> = [
        ['Revenue', d.current.revenue, d.prior?.revenue ?? null],
        ['COGS', d.current.cogs, d.prior?.cogs ?? null],
        ['Gross Profit', d.current.grossProfit, d.prior?.grossProfit ?? null],
        ['Operating Expense', d.current.operatingExpense, d.prior?.operatingExpense ?? null],
        ['Net Income', d.current.netIncome, d.prior?.netIncome ?? null],
      ];
      const tbody = rows
        .map(
          ([label, cur, prior]) =>
            `<tr><td>${escapeHtml(label)}</td><td class="num">${escapeHtml(fmtMoneyPdf(cur))}</td><td class="num">${escapeHtml(prior == null ? '—' : fmtMoneyPdf(prior))}</td><td class="num delta">${escapeHtml(fmtDeltaPct(cur, prior))}</td></tr>`,
        )
        .join('');
      const noPrior = !d.prior
        ? `<p class="meta" style="color:#a16207">No prior-year data on file — Prior YR bars show 0.</p>`
        : '';
      return `<section class="section"><h2>P&amp;L vs. Prior Year</h2>
<div class="chart">${chart}</div>
${noPrior}
<table class="data"><thead><tr><th></th><th>Current</th><th>Prior YR</th><th>Δ</th></tr></thead>
<tbody>${tbody}</tbody></table></section>`;
    }
    default:
      return `<section class="section"><h2>${escapeHtml(friendly)}</h2><p class="meta">Block "${escapeHtml(payload.type)}" not yet supported in PDF.</p></section>`;
  }
}

export function reportHtmlTemplate(d: ReportPdfData): string {
  const theme = d.theme ?? {};
  const primary = safeColor(theme['primaryColor'], '#4f46e5');
  const secondary = safeColor(theme['secondaryColor'], '#0ea5e9');
  const font = typeof theme['font'] === 'string' && theme['font']
    ? String(theme['font'])
    : 'Helvetica Neue';
  const headerText = typeof theme['headerText'] === 'string' ? String(theme['headerText']) : '';
  const footerText =
    typeof theme['footerText'] === 'string' && theme['footerText']
      ? String(theme['footerText'])
      : 'Powered by Vibe MyBooks';
  const logoUrl =
    typeof theme['brandingLogoUrl'] === 'string' && theme['brandingLogoUrl']
      ? String(theme['brandingLogoUrl'])
      : '';

  const dataKpis = (d.data['kpis'] as Record<string, unknown>) ?? {};
  const kpiNames = (d.data['kpi_names'] as Record<string, string>) ?? {};
  const aiSummary = typeof d.data['ai_summary'] === 'string' ? String(d.data['ai_summary']) : '';
  const textOverrides = (d.data['text_overrides'] as Record<string, string>) ?? {};
  const blockData = (d.data['blocks'] as Record<string, PdfBlockPayload>) ?? {};

  const blocks = (d.layout as Array<Record<string, unknown>>)
    .map((block, idx) => {
      const t = block['type'] as string;
      if (t === 'kpi-row') {
        const kpis = (block['kpis'] as string[]) ?? [];
        const cells = kpis
          .map((k) => {
            const v = dataKpis[k];
            const label = kpiNames[k] ?? k.replace(/_/g, ' ');
            return `<div class="kpi"><div class="k">${escapeHtml(label)}</div><div class="v">${escapeHtml(v == null ? '—' : String(v))}</div></div>`;
          })
          .join('');
        return `<section class="section"><div class="kpi-row">${cells}</div></section>`;
      }
      if (t === 'text') {
        // Prefer the stable block id; fall back to legacy index.
        const overrideKey = (block['id'] as string | undefined) ?? String(idx);
        const txt =
          textOverrides[overrideKey] ?? textOverrides[String(idx)] ?? ((block['placeholder'] as string) ?? '');
        if (!txt) return '';
        return `<section class="section"><div class="notes">${escapeHtml(txt)}</div></section>`;
      }
      if (t === 'ai_summary') {
        if (!aiSummary) return '';
        return `<section class="section"><h2>Narrative</h2><p>${escapeHtml(aiSummary)}</p></section>`;
      }
      if (t === 'block' || t === 'chart' || t === 'report') {
        const payloadKey =
          (block['id'] as string | undefined) ??
          (block['name'] as string | undefined) ??
          (block['report'] as string | undefined) ??
          (block['key'] as string | undefined) ??
          'unknown';
        return renderBlockPdf(block, blockData[payloadKey]);
      }
      if (t === 'page-break') {
        return `<div class="page-break"></div>`;
      }
      if (t === 'image') {
        const src = block['src'] as string;
        if (!src) return '';
        return `<section class="section"><img src="${escapeHtml(src)}" style="max-width:100%"/></section>`;
      }
      if (t === 'tag-segment') {
        const tags = ((block['tags'] as string[]) ?? []).length;
        return `<section class="section"><h2>Tag segment</h2><p class="meta">${tags} tag${tags === 1 ? '' : 's'} included.</p></section>`;
      }
      return '';
    })
    .join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:'${font}','Helvetica Neue',Arial,sans-serif;color:#111;font-size:10pt;line-height:1.4}
.brand{background:${primary};color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px;margin:-0.75in -0.75in 16px -0.75in}
.brand img{max-height:28px}
.brand .firm-text{font-size:11pt;font-weight:600}
.title{font-size:18pt;margin:0 0 2px 0}
h2{font-size:13pt;margin:18px 0 6px;color:#111}
.meta{color:#555;font-size:9pt}
.section{margin-top:14px;border-top:1px solid #eee;padding-top:8px}
.kpi-row{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.kpi{padding:8px;border:1px solid #e5e7eb;border-radius:6px}
.kpi .k{color:#555;font-size:8pt;text-transform:uppercase;letter-spacing:.05em}
.kpi .v{font-size:14pt;font-weight:600;margin-top:2px}
.notes{white-space:pre-wrap;font-size:10pt}
.page-break{page-break-after:always}
.accent{color:${secondary}}
.chart{margin:6px 0;text-align:center}
.chart svg{max-width:100%;height:auto}
table.data,table.aging{width:100%;border-collapse:collapse;font-size:10pt;margin-top:6px}
table.data td,table.aging td,table.aging th{padding:4px 6px;border-bottom:1px solid #eee}
table.data th,table.aging th{text-align:left;font-size:9pt;color:#555;text-transform:uppercase;letter-spacing:.04em;background:#fafafa}
table.aging th,table.aging td{text-align:right}
table.aging th:first-child,table.aging td:first-child{text-align:left}
.num{text-align:right;font-variant-numeric:tabular-nums}
.strong{font-weight:600}
tr.total td{border-top:2px solid #999;font-weight:700}
.delta{color:#555;font-size:9pt}
footer{margin-top:24px;padding-top:8px;border-top:1px solid #ddd;color:#666;font-size:8pt}
</style></head><body>
${(logoUrl || headerText) ? `<div class="brand">${logoUrl ? `<img src="${escapeHtml(logoUrl)}"/>` : ''}<span class="firm-text">${escapeHtml(headerText || '')}</span></div>` : ''}
<h1 class="title">${escapeHtml(d.companyName)} — ${escapeHtml(d.templateName)}</h1>
<p class="meta">${escapeHtml(d.periodStart)} → ${escapeHtml(d.periodEnd)} · Published ${escapeHtml(d.publishedAt.toUTCString())}</p>
${blocks}
<footer>${escapeHtml(footerText)}</footer>
</body></html>`;
}
