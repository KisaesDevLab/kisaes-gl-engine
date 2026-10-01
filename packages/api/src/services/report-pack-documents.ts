// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Report Packs — "document" sections. Unlike the table reports in
// report-pack-render.ts, these produce finished PDF bytes: completed bank
// reconciliations (each followed by its statement file), the uploaded bank
// statements for the period, and the date-range Transaction Report with its
// attachments. The generator merges them like any other section, so the TOC,
// page numbering and skip-on-error behave the same.
//
// Files follow the Transaction Report's contract: PDFs are FRAMED (never
// stamped over — statements print to the top edge), never loaded with
// ignoreEncryption; images go through the hardened Chromium (EXIF, WebP).
// A file that cannot be read costs that file, never the section.

import { sql } from 'drizzle-orm';
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import { formatIsoUS, type ReportPackItemOptions } from '@kis-books/shared';
import { db } from '../db/index.js';
import { log } from '../utils/logger.js';
import { readAttachmentBytes } from './attachment.service.js';
import { buildReportPackSectionHtml, escapeHtml } from './report-export.service.js';
import { buildReconciliationDetail } from './report.service.js';
import { appendFramedPdf, appendPdf, stampCaption } from './pdf-merge.util.js';
import { generateTransactionRangeReportPdf, planTransactionRangeReport } from './transaction-report.service.js';

export interface DocumentSectionContext {
  tenantId: string;
  companyId: string;
  companyName: string;
  rangeStart: string;
  rangeEnd: string;
  options: ReportPackItemOptions;
  /** The requester may read attachments (statement files, transaction attachments). */
  allowAttachments: boolean;
  /** The requester may read transactions (the Transaction Report). */
  allowTransactions: boolean;
  /** HTML → PDF (portrait Letter) through the pack's hardened browser. */
  renderHtml: (html: string) => Promise<Uint8Array>;
}

export type DocumentSectionRenderer = (ctx: DocumentSectionContext) => Promise<Uint8Array>;

// Same per-file limits as the Transaction Report.
const MAX_FILE_PAGES = 50;
const MAX_SECTION_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const READ_TIMEOUT_MS = 20_000;
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function money(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function periodLabel(start: string | null, end: string): string {
  return start ? `${formatIsoUS(start)} – ${formatIsoUS(end)}` : `ending ${formatIsoUS(end)}`;
}

function accountLabel(name: string, number: string | null): string {
  return number ? `${number} ${name}` : name;
}

const EXTRA_CSS = `<style>
  .kv{display:grid;grid-template-columns:repeat(2,1fr);gap:4px 24px;margin:0 0 16px 0;font-size:11px}
  .kv .k{color:#6b7280}
  h3{font-size:13px;margin:18px 0 6px 0}
  .muted{color:#6b7280;font-size:11px}
  .warn{color:#b91c1c;font-size:11px}
</style>`;

function sectionHtml(ctx: DocumentSectionContext, title: string, body: string): string {
  return buildReportPackSectionHtml({
    title,
    companyName: ctx.companyName,
    dateLabel: `${formatIsoUS(ctx.rangeStart)} to ${formatIsoUS(ctx.rangeEnd)}`,
    tableHtml: EXTRA_CSS + body,
    footer: '',
  });
}

// ─── Statement files ─────────────────────────────────────────────

interface FileRow {
  fileName: string;
  mimeType: string | null;
  fileSize: number | null;
  filePath: string;
  storageKey: string | null;
  providerFileId: string | null;
}

/** A file read and checked up front, so the page that lists it can say what happened. */
type PreparedFile =
  | { ok: true; kind: 'pdf'; doc: PDFDocument; pages: number; totalPages: number; fileName: string }
  | { ok: true; kind: 'image'; dataUrl: string; fileName: string }
  | { ok: false; note: string; fileName: string };

class FileBudget {
  bytes = 0;
}

async function prepareFile(tenantId: string, f: FileRow, budget: FileBudget): Promise<PreparedFile> {
  const fileName = f.fileName;
  const mime = (f.mimeType ?? '').toLowerCase();
  const isPdf = mime === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf');
  const isImage = IMAGE_MIME_TYPES.has(mime);
  if (!isPdf && !isImage) return { ok: false, note: 'not included — only PDF and image files can be printed', fileName };
  if (isImage && (f.fileSize ?? 0) > MAX_IMAGE_BYTES) return { ok: false, note: 'not included — the image is too large', fileName };
  if (budget.bytes + (f.fileSize ?? 0) > MAX_SECTION_BYTES) return { ok: false, note: 'not included — this section is over its 100 MB file limit', fileName };
  try {
    const bytes = await withTimeout(readAttachmentBytes(tenantId, f), READ_TIMEOUT_MS, 'Reading the file');
    budget.bytes += bytes.length;
    if (isImage) {
      return { ok: true, kind: 'image', dataUrl: `data:${mime === 'image/jpg' ? 'image/jpeg' : mime};base64,${bytes.toString('base64')}`, fileName };
    }
    const doc = await PDFDocument.load(bytes);
    const totalPages = doc.getPageCount();
    return { ok: true, kind: 'pdf', doc, pages: Math.min(totalPages, MAX_FILE_PAGES), totalPages, fileName };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ component: 'report-packs', event: 'statement_file_skipped', fileName, message });
    return {
      ok: false,
      note: /encrypt/i.test(message) ? 'could not be included — the PDF is password-protected' : 'could not be included — the file could not be read',
      fileName,
    };
  }
}

/** One line for an index / reconciliation page describing what happened to the file. */
function fileStatus(p: PreparedFile | null, noFileReason: string): string {
  if (!p) return `<span class="muted">${escapeHtml(noFileReason)}</span>`;
  if (!p.ok) return `<span class="warn">${escapeHtml(p.fileName)} — ${escapeHtml(p.note)}</span>`;
  if (p.kind === 'pdf' && p.pages < p.totalPages) {
    return `${escapeHtml(p.fileName)} <span class="muted">(first ${p.pages} of ${p.totalPages} pages follow)</span>`;
  }
  return `${escapeHtml(p.fileName)} <span class="muted">(follows)</span>`;
}

/** Append a prepared file to `target`, captioned. Returns pages added. */
async function appendPrepared(ctx: DocumentSectionContext, target: PDFDocument, p: PreparedFile, caption: string, font: PDFFont): Promise<number> {
  if (!p.ok) return 0;
  const before = target.getPageCount();
  if (p.kind === 'pdf') {
    await appendFramedPdf(target, p.doc, p.pages);
  } else {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body{margin:0}
      img{display:block;max-width:100%;max-height:9.4in;margin:18px auto 0 auto;object-fit:contain;image-orientation:from-image;border:1px solid #e5e7eb}
    </style></head><body><img src="${p.dataUrl}" alt=""></body></html>`;
    await appendPdf(target, await ctx.renderHtml(html));
  }
  stampCaption(target, before, target.getPageCount(), caption, font);
  return target.getPageCount() - before;
}

const ATTACHMENTS_DENIED = 'Statement files are not included: your role does not have access to attachments.';

// ─── Bank reconciliations ────────────────────────────────────────

interface RecRow { id: string; statement_date: string; account_name: string; account_number: string | null }

/**
 * Completed reconciliations whose statement date falls in the pack range,
 * across the company's accounts (scoped through accounts.company_id —
 * reconciliations.company_id is never populated). In-progress ones are left
 * out by design.
 */
export async function listCompletedReconciliations(tenantId: string, companyId: string, start: string, end: string): Promise<RecRow[]> {
  const res = await db.execute(sql`
    SELECT r.id, r.statement_date::text AS statement_date, a.name AS account_name, a.account_number
    FROM reconciliations r
    JOIN accounts a ON a.id = r.account_id AND a.tenant_id = r.tenant_id
    WHERE r.tenant_id = ${tenantId}
      AND (a.company_id = ${companyId} OR a.company_id IS NULL)
      AND r.status = 'complete'
      AND r.statement_date BETWEEN ${start} AND ${end}
    ORDER BY a.account_number NULLS LAST, a.name, r.statement_date
  `);
  return res.rows as unknown as RecRow[];
}

async function loadAttachment(tenantId: string, attachmentId: string): Promise<FileRow | null> {
  const res = await db.execute(sql`
    SELECT file_name, mime_type, file_size, file_path, storage_key, provider_file_id
    FROM attachments WHERE tenant_id = ${tenantId} AND id = ${attachmentId} LIMIT 1
  `);
  const r = res.rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    fileName: String(r['file_name']),
    mimeType: (r['mime_type'] as string | null) ?? null,
    fileSize: r['file_size'] != null ? Number(r['file_size']) : null,
    filePath: String(r['file_path'] ?? ''),
    storageKey: (r['storage_key'] as string | null) ?? null,
    providerFileId: (r['provider_file_id'] as string | null) ?? null,
  };
}

function linesTable(rows: Array<{ txnDate: string; txnType: string; txnNumber: string | null; description: string | null; payment: number | null; deposit: number | null }>, totals: { payments: number; deposits: number }): string {
  if (rows.length === 0) return '<p class="muted">None.</p>';
  return `<table>
    <thead><tr><th>Date</th><th>Type</th><th>Number</th><th>Description</th><th class="amount">Payment</th><th class="amount">Deposit</th></tr></thead>
    <tbody>${rows.map((l) => `<tr>
      <td>${escapeHtml(formatIsoUS(l.txnDate))}</td>
      <td>${escapeHtml(l.txnType.replace(/_/g, ' '))}</td>
      <td>${escapeHtml(l.txnNumber ?? '')}</td>
      <td>${escapeHtml(l.description ?? '')}</td>
      <td class="amount">${l.payment ? money(l.payment) : ''}</td>
      <td class="amount">${l.deposit ? money(l.deposit) : ''}</td>
    </tr>`).join('')}
    <tr class="total-row"><td colspan="4">Total</td><td class="amount">${money(totals.payments)}</td><td class="amount">${money(totals.deposits)}</td></tr>
    </tbody></table>`;
}

const renderBankReconciliations: DocumentSectionRenderer = async (ctx) => {
  const includeStatements = !ctx.options.omitStatements;
  const recs = await listCompletedReconciliations(ctx.tenantId, ctx.companyId, ctx.rangeStart, ctx.rangeEnd);
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.HelveticaBold);
  if (recs.length === 0) {
    await appendPdf(out, await ctx.renderHtml(sectionHtml(ctx, 'Bank Reconciliations', '<p class="muted">No completed reconciliations have a statement date in this period.</p>')));
    return out.save();
  }

  const budget = new FileBudget();
  const details = [];
  for (const r of recs) details.push(await buildReconciliationDetail(ctx.tenantId, r.id));

  // Summary page: one row per reconciliation.
  const summary = `<table>
    <thead><tr><th>Account</th><th>Statement date</th><th class="amount">Beginning</th><th class="amount">Ending</th><th class="amount">Difference</th><th>Completed</th></tr></thead>
    <tbody>${details.map((d) => `<tr>
      <td>${escapeHtml(accountLabel(d.reconciliation.accountName, d.reconciliation.accountNumber))}</td>
      <td>${escapeHtml(formatIsoUS(d.reconciliation.statementDate))}</td>
      <td class="amount">${money(d.reconciliation.beginningBalance)}</td>
      <td class="amount">${money(d.reconciliation.statementEndingBalance)}</td>
      <td class="amount">${money(d.reconciliation.difference ?? 0)}</td>
      <td>${d.reconciliation.completedAt ? escapeHtml(formatIsoUS(new Date(d.reconciliation.completedAt).toISOString())) : ''}${d.reconciliation.completedBy ? ` — ${escapeHtml(d.reconciliation.completedBy)}` : ''}</td>
    </tr>`).join('')}</tbody></table>
    ${includeStatements && !ctx.allowAttachments ? `<p class="muted">${ATTACHMENTS_DENIED}</p>` : ''}`;
  await appendPdf(out, await ctx.renderHtml(sectionHtml(ctx, 'Bank Reconciliations', summary)));

  for (const d of details) {
    const rec = d.reconciliation;
    const label = accountLabel(rec.accountName, rec.accountNumber);
    let file: PreparedFile | null = null;
    let noFile = 'No statement is linked to this reconciliation.';
    if (includeStatements && d.statement) {
      if (!d.statement.attachmentId) noFile = 'The linked statement has no file (imported from a bank download).';
      else if (!ctx.allowAttachments) noFile = 'Statement file not included (no access to attachments).';
      else {
        const row = await loadAttachment(ctx.tenantId, d.statement.attachmentId);
        file = row ? await prepareFile(ctx.tenantId, row, budget) : null;
        if (!row) noFile = 'The statement file is missing.';
      }
    }
    const stmt = d.statement;
    const body = `
      <div class="kv">
        <div><span class="k">Account:</span> ${escapeHtml(label)}</div>
        <div><span class="k">Statement date:</span> ${escapeHtml(formatIsoUS(rec.statementDate))}</div>
        <div><span class="k">Beginning balance:</span> ${money(rec.beginningBalance)}</div>
        <div><span class="k">Statement ending balance:</span> ${money(rec.statementEndingBalance)}</div>
        <div><span class="k">Cleared balance:</span> ${money(rec.clearedBalance)}</div>
        <div><span class="k">Difference:</span> ${money(rec.difference ?? 0)}</div>
        <div><span class="k">Completed:</span> ${rec.completedAt ? escapeHtml(formatIsoUS(new Date(rec.completedAt).toISOString())) : ''}${rec.completedBy ? ` by ${escapeHtml(rec.completedBy)}` : ''}</div>
        ${stmt ? `<div><span class="k">Statement period:</span> ${escapeHtml(periodLabel(stmt.periodStart, stmt.periodEnd))}${stmt.institutionName ? ` — ${escapeHtml(stmt.institutionName)}` : ''}${stmt.maskedAccountNumber ? ` ${escapeHtml(stmt.maskedAccountNumber)}` : ''}</div>` : ''}
        ${includeStatements ? `<div style="grid-column:1/-1"><span class="k">Statement file:</span> ${fileStatus(file, noFile)}</div>` : ''}
      </div>
      <h3>Cleared transactions (${d.cleared.length})</h3>
      ${linesTable(d.cleared, { payments: d.totals.clearedPayments, deposits: d.totals.clearedDeposits })}
      <h3>Uncleared as of ${escapeHtml(formatIsoUS(rec.statementDate))} (${d.uncleared.length})</h3>
      ${linesTable(d.uncleared, { payments: d.totals.unclearedPayments, deposits: d.totals.unclearedDeposits })}`;
    await appendPdf(out, await ctx.renderHtml(sectionHtml(ctx, `Reconciliation — ${label} — ${formatIsoUS(rec.statementDate)}`, body)));
    if (file) {
      await appendPrepared(ctx, out, file, `Statement — ${label} — ${stmt ? periodLabel(stmt.periodStart, stmt.periodEnd) : formatIsoUS(rec.statementDate)}`, font);
    }
  }
  return out.save();
};

// ─── Bank statements ─────────────────────────────────────────────

interface StatementRow {
  id: string;
  period_start: string | null;
  period_end: string;
  closing_balance: string;
  institution_name: string | null;
  masked_account_number: string | null;
  reconciliation_id: string | null;
  account_name: string;
  account_number: string | null;
  attachment_id: string | null;
}

/** Statements whose period ends in the pack range, for the company's accounts. */
export async function listStatementsInRange(tenantId: string, companyId: string, start: string, end: string): Promise<StatementRow[]> {
  const res = await db.execute(sql`
    SELECT bs.id, bs.period_start::text AS period_start, bs.period_end::text AS period_end, bs.closing_balance,
           bs.institution_name, bs.masked_account_number, bs.reconciliation_id, bs.attachment_id,
           a.name AS account_name, a.account_number
    FROM bank_statements bs
    JOIN accounts a ON a.id = bs.account_id AND a.tenant_id = bs.tenant_id
    WHERE bs.tenant_id = ${tenantId}
      AND (a.company_id = ${companyId} OR a.company_id IS NULL)
      AND bs.period_end BETWEEN ${start} AND ${end}
    ORDER BY a.account_number NULLS LAST, a.name, bs.period_end
  `);
  return res.rows as unknown as StatementRow[];
}

const renderBankStatements: DocumentSectionRenderer = async (ctx) => {
  const rows = await listStatementsInRange(ctx.tenantId, ctx.companyId, ctx.rangeStart, ctx.rangeEnd);
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.HelveticaBold);
  if (rows.length === 0) {
    await appendPdf(out, await ctx.renderHtml(sectionHtml(ctx, 'Bank Statements', '<p class="muted">No bank statements end in this period.</p>')));
    return out.save();
  }

  const budget = new FileBudget();
  const prepared: Array<{ row: StatementRow; file: PreparedFile | null; noFile: string }> = [];
  for (const row of rows) {
    let file: PreparedFile | null = null;
    let noFile = 'No file (imported from a bank download).';
    if (row.attachment_id) {
      if (!ctx.allowAttachments) noFile = 'Not included (no access to attachments).';
      else {
        const att = await loadAttachment(ctx.tenantId, row.attachment_id);
        file = att ? await prepareFile(ctx.tenantId, att, budget) : null;
        if (!att) noFile = 'The statement file is missing.';
      }
    }
    prepared.push({ row, file, noFile });
  }

  const index = `<table>
    <thead><tr><th>Account</th><th>Period</th><th>Institution</th><th class="amount">Closing balance</th><th>Reconciled</th><th>File</th></tr></thead>
    <tbody>${prepared.map(({ row, file, noFile }) => `<tr>
      <td>${escapeHtml(accountLabel(row.account_name, row.account_number))}</td>
      <td>${escapeHtml(periodLabel(row.period_start, row.period_end))}</td>
      <td>${escapeHtml([row.institution_name, row.masked_account_number].filter(Boolean).join(' '))}</td>
      <td class="amount">${money(row.closing_balance)}</td>
      <td>${row.reconciliation_id ? 'Yes' : 'No'}</td>
      <td>${fileStatus(file, noFile)}</td>
    </tr>`).join('')}</tbody></table>
    ${!ctx.allowAttachments ? `<p class="muted">${ATTACHMENTS_DENIED}</p>` : ''}`;
  await appendPdf(out, await ctx.renderHtml(sectionHtml(ctx, 'Bank Statements', index)));

  for (const { row, file } of prepared) {
    if (!file) continue;
    await appendPrepared(ctx, out, file, `Statement — ${accountLabel(row.account_name, row.account_number)} — ${periodLabel(row.period_start, row.period_end)}`, font);
  }
  return out.save();
};

// ─── Transaction Report ──────────────────────────────────────────

/**
 * The date-range Transaction Report for the pack range — every planned part,
 * back to back, so nothing is capped away. Rendered through the pack's own
 * browser; the parts skip their own page footer (the pack stamps one
 * across the whole document).
 */
const renderTransactionReport: DocumentSectionRenderer = async (ctx) => {
  if (!ctx.allowTransactions) {
    throw new Error('The Transaction Report needs access to transactions.');
  }
  const filters = {
    startDate: ctx.rangeStart,
    endDate: ctx.rangeEnd,
    txnType: ctx.options.txnType,
    accountId: ctx.options.accountId,
    includeVoid: ctx.options.includeVoid ?? false,
  };
  const { plan } = await planTransactionRangeReport(ctx.tenantId, filters, ctx.companyId);
  if (plan.truncated) {
    log.warn({ component: 'report-packs', event: 'transaction_report_truncated', tenantId: ctx.tenantId, matched: plan.transactionCount });
  }
  const deps = { openRenderer: async () => ({ render: ctx.renderHtml, close: async () => {} }) };
  const wanted = ctx.options.includeAttachments ?? false;
  const opts = {
    companyId: ctx.companyId,
    includeAttachments: wanted && ctx.allowAttachments,
    stampFooter: false,
    attachmentsOmittedNote: wanted
      ? 'Attachments are not included: your role does not have access to attachments.'
      : 'Attachments are not included in this report pack.',
  };
  const out = await PDFDocument.create();
  const parts = Math.max(plan.parts.length, 1);
  for (let part = 1; part <= parts; part++) {
    const result = await generateTransactionRangeReportPdf(ctx.tenantId, { ...filters, part }, opts, deps);
    await appendPdf(out, result.buffer);
  }
  return out.save();
};

export const REPORT_PACK_DOCUMENT_RENDERERS: Record<string, DocumentSectionRenderer> = {
  'bank-reconciliations': renderBankReconciliations,
  'bank-statements': renderBankStatements,
  'transaction-report': renderTransactionReport,
};
