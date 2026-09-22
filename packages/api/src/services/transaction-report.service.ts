// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Transaction Report: one PDF that tells the whole story of a transaction —
// its header and journal lines, the same for everything linked to it (a bill
// and the payments that paid it), and then every attached source document,
// page for page. Also home to the enriched transaction detail and the
// related-transactions lookup the on-screen transaction view uses, so the
// screen and the printout are fed by the same code.

import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  TXN_TYPE_LABELS,
  buildTransactionHeaderFields,
  contactRoleLabel,
  formatIsoUS,
  transactionTitle,
  txnTypeLabel,
  type RelatedTransaction,
  type RelatedTransactionsResult,
  type PaymentMethod,
  type TransactionBankAccount,
  type TransactionDisplayInput,
  type TransactionHeaderField,
  type TransactionRelation,
  type TxnType,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { accounts, attachments, bankFeedItems, companies, contacts, tags, transactionTags, transactions, users } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { log } from '../utils/logger.js';
import * as ledger from './ledger.service.js';
import { readAttachmentBytes } from './attachment.service.js';
import { escapeHtml } from './report-export.service.js';
import { CASH_ACCOUNT_DETAIL_TYPES, RECONCILABLE_LIABILITY_DETAIL_TYPES } from './report.service.js';
import { getReportFooter } from './tenant-report-settings.service.js';
import { appendFramedPdf, appendPdfDocument, htmlToPdfBytes, launchPdfBrowser, stampCaption, stampPageFooter } from './pdf-merge.util.js';

// ─── Enriched detail ─────────────────────────────────────────────

// Accounts money actually moves through: bank / cash / undeposited funds,
// plus credit cards and lines of credit.
const MONEY_DETAIL_TYPES = new Set<string>([...CASH_ACCOUNT_DETAIL_TYPES, ...RECONCILABLE_LIABILITY_DETAIL_TYPES]);
// Money leaves on these types, arrives on the rest.
const OUTFLOW_TYPES = new Set<string>(['expense', 'bill_payment', 'customer_refund']);

/**
 * ledger.getTransaction plus the names the transaction view and the report
 * need: tag / payee per line, header tags, the bank account the money moved
 * through, and the number of the invoice a credit was applied to. Kept out of
 * getTransaction itself — that has dozens of internal callers on hot paths
 * that want none of this.
 */
export async function getTransactionDetail(tenantId: string, txnId: string) {
  const txn = await ledger.getTransaction(tenantId, txnId);
  const lines = txn.lines;

  const accountIds = [...new Set(lines.map((l) => l.accountId))];
  const tagIds = [...new Set(lines.map((l) => l.tagId).filter((v): v is string => !!v))];
  const lineContactIds = [...new Set(lines.map((l) => l.contactId).filter((v): v is string => !!v))];

  const [accountRows, tagRows, contactRows, headerTags, appliedInvoice] = await Promise.all([
    accountIds.length
      ? db.select({ id: accounts.id, accountType: accounts.accountType, detailType: accounts.detailType })
        .from(accounts).where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, accountIds)))
      : [],
    tagIds.length
      ? db.select({ id: tags.id, name: tags.name }).from(tags)
        .where(and(eq(tags.tenantId, tenantId), inArray(tags.id, tagIds)))
      : [],
    lineContactIds.length
      ? db.select({ id: contacts.id, displayName: contacts.displayName }).from(contacts)
        .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, lineContactIds)))
      : [],
    db.select({ id: tags.id, name: tags.name }).from(transactionTags)
      .innerJoin(tags, and(eq(tags.id, transactionTags.tagId), eq(tags.tenantId, tenantId)))
      .where(and(eq(transactionTags.tenantId, tenantId), eq(transactionTags.transactionId, txnId)))
      .orderBy(asc(tags.name)),
    txn.appliedToInvoiceId
      ? db.select({ txnNumber: transactions.txnNumber }).from(transactions)
        .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txn.appliedToInvoiceId))).limit(1)
      : [],
  ]);

  const accountById = new Map(accountRows.map((a) => [a.id, a]));
  const tagById = new Map(tagRows.map((t) => [t.id, t.name]));
  const contactById = new Map(contactRows.map((c) => [c.id, c.displayName]));

  const detailLines = lines.map((l) => ({
    ...l,
    accountType: accountById.get(l.accountId)?.accountType ?? null,
    accountDetailType: accountById.get(l.accountId)?.detailType ?? null,
    tagName: l.tagId ? tagById.get(l.tagId) ?? null : null,
    contactName: l.contactId ? contactById.get(l.contactId) ?? null : null,
  }));

  // Every line on a money account, tagged with the direction it moved.
  const moneyLines: TransactionBankAccount[] = detailLines
    .filter((l) => l.accountDetailType && MONEY_DETAIL_TYPES.has(l.accountDetailType))
    .map((l) => ({
      accountId: l.accountId,
      name: l.accountName ?? 'Unknown',
      accountNumber: l.accountNumber ?? null,
      side: Number(l.credit) > 0 ? 'from' as const : 'to' as const,
    }));
  let bankAccounts: TransactionBankAccount[];
  if (txn.txnType === 'transfer') {
    bankAccounts = [...moneyLines.filter((b) => b.side === 'from'), ...moneyLines.filter((b) => b.side === 'to')];
  } else {
    const wanted = OUTFLOW_TYPES.has(txn.txnType) ? 'from' : 'to';
    bankAccounts = moneyLines.filter((b) => b.side === wanted);
  }
  // A split can hit the same account on several lines.
  bankAccounts = bankAccounts.filter((b, i, all) => all.findIndex((o) => o.accountId === b.accountId && o.side === b.side) === i);

  return {
    ...txn,
    lines: detailLines,
    tags: headerTags,
    bankAccounts,
    appliedToInvoiceNumber: appliedInvoice[0]?.txnNumber ?? null,
  };
}

export type TransactionDetail = Awaited<ReturnType<typeof getTransactionDetail>>;

// ─── Related transactions ────────────────────────────────────────

const MAX_RELATED = 25;

// One hop only, by design. A payment can pay twenty bills, each paid by other
// payments that paid other bills — following that transitively turns "this
// bill and its payment" into half the vendor's history.
function linksFor(tenantId: string, txnId: string, txnType: string, appliedToInvoiceId: string | null) {
  switch (txnType) {
    case 'bill':
      return sql`
        SELECT bpa.payment_id AS id, 'payment' AS relation, bpa.amount::numeric AS amount
          FROM bill_payment_applications bpa WHERE bpa.tenant_id = ${tenantId} AND bpa.bill_id = ${txnId}
        UNION ALL
        -- A bill settled entirely by credits has no cash application row
        -- (CHECK amount > 0); the credit application still names the payment.
        SELECT vca.payment_id, 'payment', 0::numeric
          FROM vendor_credit_applications vca WHERE vca.tenant_id = ${tenantId} AND vca.bill_id = ${txnId}
        UNION ALL
        SELECT vca.credit_id, 'credit', vca.amount::numeric
          FROM vendor_credit_applications vca WHERE vca.tenant_id = ${tenantId} AND vca.bill_id = ${txnId}`;
    case 'bill_payment':
      return sql`
        SELECT bpa.bill_id AS id, 'paid_bill' AS relation, bpa.amount::numeric AS amount
          FROM bill_payment_applications bpa WHERE bpa.tenant_id = ${tenantId} AND bpa.payment_id = ${txnId}
        UNION ALL
        SELECT vca.bill_id, 'paid_bill', 0::numeric
          FROM vendor_credit_applications vca WHERE vca.tenant_id = ${tenantId} AND vca.payment_id = ${txnId}
        UNION ALL
        SELECT vca.credit_id, 'credit', vca.amount::numeric
          FROM vendor_credit_applications vca WHERE vca.tenant_id = ${tenantId} AND vca.payment_id = ${txnId}`;
    case 'vendor_credit':
      return sql`
        SELECT vca.bill_id AS id, 'credited_bill' AS relation, vca.amount::numeric AS amount
          FROM vendor_credit_applications vca WHERE vca.tenant_id = ${tenantId} AND vca.credit_id = ${txnId}
        UNION ALL
        SELECT vca.payment_id, 'payment', 0::numeric
          FROM vendor_credit_applications vca WHERE vca.tenant_id = ${tenantId} AND vca.credit_id = ${txnId}`;
    case 'invoice':
      // Two generations of linkage: Receive Payment writes
      // payment_applications; the invoice page's Record Payment, credit
      // memos and Stripe refunds only set applied_to_invoice_id. Same union
      // as the ar_apps CTE in report.service.ts.
      return sql`
        SELECT pa.payment_id AS id, 'payment' AS relation, pa.amount::numeric AS amount
          FROM payment_applications pa WHERE pa.tenant_id = ${tenantId} AND pa.invoice_id = ${txnId}
        UNION ALL
        SELECT tp.id, CASE WHEN tp.txn_type = 'customer_payment' THEN 'payment' ELSE 'credit' END, tp.total::numeric
          FROM transactions tp
          WHERE tp.tenant_id = ${tenantId} AND tp.applied_to_invoice_id = ${txnId}
            AND NOT EXISTS (SELECT 1 FROM payment_applications pa2
              WHERE pa2.tenant_id = ${tenantId} AND pa2.payment_id = tp.id AND pa2.invoice_id = ${txnId})`;
    case 'customer_payment':
      return sql`
        SELECT pa.invoice_id AS id, 'paid_invoice' AS relation, pa.amount::numeric AS amount
          FROM payment_applications pa WHERE pa.tenant_id = ${tenantId} AND pa.payment_id = ${txnId}
        UNION ALL
        SELECT tp.applied_to_invoice_id, 'paid_invoice', tp.total::numeric
          FROM transactions tp
          WHERE tp.tenant_id = ${tenantId} AND tp.id = ${txnId} AND tp.applied_to_invoice_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM payment_applications pa2
              WHERE pa2.tenant_id = ${tenantId} AND pa2.payment_id = tp.id AND pa2.invoice_id = tp.applied_to_invoice_id)`;
    case 'credit_memo':
    case 'customer_refund':
      if (!appliedToInvoiceId) return null;
      return sql`
        SELECT tp.applied_to_invoice_id AS id, 'paid_invoice' AS relation, tp.total::numeric AS amount
          FROM transactions tp WHERE tp.tenant_id = ${tenantId} AND tp.id = ${txnId}`;
    default:
      return null;
  }
}

interface RelatedRow {
  id: string; txn_type: string; txn_number: string | null; txn_date: string; status: string;
  contact_name: string | null; total: string | null; relation: string; amount: string | null;
  check_number: number | null; payment_method: string | null; reference_number: string | null;
  vendor_invoice_number: string | null; attachment_count: number;
  [key: string]: unknown;
}

/**
 * The transactions directly tied to this one — payments applied to a bill,
 * bills a payment paid, and the invoice-side equivalents. Voided ones are
 * returned (flagged by status) so callers can show that they existed.
 */
export async function getRelatedTransactions(tenantId: string, txnId: string, companyId?: string | null): Promise<RelatedTransactionsResult> {
  const [root] = await db.select({
    txnType: transactions.txnType, companyId: transactions.companyId, appliedToInvoiceId: transactions.appliedToInvoiceId,
  }).from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId))).limit(1);
  if (!root || (companyId && root.companyId && root.companyId !== companyId)) {
    throw AppError.notFound('Transaction not found');
  }

  const links = linksFor(tenantId, txnId, root.txnType, root.appliedToInvoiceId);
  if (!links) return { related: [], truncated: false };

  // Application rows are written without company_id, so scope on the joined
  // transaction. NULL-company rows are legacy single-company data and belong
  // to whichever company is asking.
  const result = await db.execute(sql`
    SELECT t.id, t.txn_type, t.txn_number, t.txn_date::text AS txn_date, t.status,
      c.display_name AS contact_name, t.total::text AS total,
      l.relation, l.amount::text AS amount,
      t.check_number, t.payment_method, t.reference_number, t.vendor_invoice_number,
      (SELECT COUNT(*) FROM attachments a
        WHERE a.tenant_id = t.tenant_id AND a.attachable_id = t.id
          AND a.attachable_type IN (t.txn_type, 'transaction', 'journal_entry'))::int AS attachment_count
    FROM (SELECT id, MIN(relation) AS relation, SUM(amount) AS amount FROM (${links}) raw GROUP BY id) l
    JOIN transactions t ON t.id = l.id AND t.tenant_id = ${tenantId}
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = t.tenant_id
    WHERE t.id <> ${txnId}
      AND (t.company_id IS NULL OR ${root.companyId}::uuid IS NULL OR t.company_id = ${root.companyId}::uuid)
    ORDER BY t.txn_date ASC, t.created_at ASC
    LIMIT ${MAX_RELATED + 1}
  `);

  const rows = result.rows as RelatedRow[];
  const related: RelatedTransaction[] = rows.slice(0, MAX_RELATED).map((r) => ({
    id: r.id,
    txnType: r.txn_type as TxnType,
    txnNumber: r.txn_number,
    txnDate: r.txn_date,
    status: r.status as RelatedTransaction['status'],
    contactName: r.contact_name,
    total: r.total,
    relation: r.relation as TransactionRelation,
    // A zero here is a link with no cash of its own (fully credited bill).
    appliedAmount: r.amount !== null && Number(r.amount) > 0 ? r.amount : null,
    checkNumber: r.check_number,
    paymentMethod: r.payment_method as RelatedTransaction['paymentMethod'],
    referenceNumber: r.reference_number,
    vendorInvoiceNumber: r.vendor_invoice_number,
    attachmentCount: r.attachment_count,
  }));
  return { related, truncated: rows.length > MAX_RELATED };
}

// ─── Attachments ─────────────────────────────────────────────────

type AttachmentRow = typeof attachments.$inferSelect;

/**
 * Everything attached to a transaction. Mostly attachable_type = txn type,
 * with three exceptions that are easy to miss: AJE files are stored under
 * 'journal_entry', tenant import and the review checks use 'transaction',
 * and a receipt attached in the bank feed stays on the feed item.
 */
export async function listReportAttachments(tenantId: string, txn: { id: string; txnType: string }): Promise<AttachmentRow[]> {
  const types = [...new Set([txn.txnType, 'transaction', 'journal_entry'])];
  const feedItems = await db.select({ id: bankFeedItems.id }).from(bankFeedItems)
    .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.matchedTransactionId, txn.id)));
  const direct = and(inArray(attachments.attachableType, types), eq(attachments.attachableId, txn.id));
  const viaFeed = feedItems.length
    ? and(eq(attachments.attachableType, 'bank_feed_items'), inArray(attachments.attachableId, feedItems.map((f) => f.id)))
    : undefined;
  return db.select().from(attachments)
    .where(and(eq(attachments.tenantId, tenantId), viaFeed ? or(direct, viaFeed) : direct))
    .orderBy(asc(attachments.createdAt));
}

// ─── PDF ─────────────────────────────────────────────────────────

// A report is for reading, not archiving a filing cabinet. Past these the
// file is listed in the summary as left out, with the reason.
const MAX_ATTACHMENTS = 40;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_PAGES_PER_PDF = 50;
const MAX_TOTAL_PAGES = 300;
const READ_TIMEOUT_MS = 20_000;

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);

export interface ReportRenderer {
  render(html: string): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface TransactionReportDeps {
  /** Override the HTML→PDF renderer (tests — Chromium is not on CI runners). */
  openRenderer?: () => Promise<ReportRenderer>;
}

export interface TransactionReportOptions {
  companyId?: string | null;
  /** False when the caller may not read attachments: summary pages only. */
  includeAttachments: boolean;
  /** Printed as "Generated … by <name>". */
  userId?: string | null;
}

export interface TransactionReportResult {
  buffer: Buffer;
  fileName: string;
  pageCount: number;
  /** One line per attachment that could not be included. */
  warnings: string[];
}

async function openChromiumRenderer(): Promise<ReportRenderer> {
  const browser = await launchPdfBrowser();
  return {
    render: (html) => htmlToPdfBytes(browser, html, false),
    close: () => browser.close(),
  };
}

// Chromium costs a few hundred MB per launch. Two at a time is plenty for a
// button a bookkeeper clicks; the rest wait their turn.
const MAX_CONCURRENT = 2;
let running = 0;
const waiting: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

interface PreparedAttachment {
  ordinal: number;
  fileName: string;
  ownerLabel: string;
  ownerId: string;
  /** False when the file was left out — `note` says why. */
  included: boolean;
  /**
   * How it is placed: a PDF's pages are copied in right after the block
   * that owns it; an image is drawn inline under that block, so the entry
   * and the picture of it share a page.
   */
  kind: 'pdf' | 'image' | null;
  /** PDF: where its framed pages sit in the scratch document, [from, to). */
  from: number;
  to: number;
  /** Image: the data URL the block embeds. */
  dataUrl: string | null;
  note: string | null;
}

/**
 * One rendered chunk of the summary. Blocks pack into a chunk until one of
 * them owns PDF attachments — those pages have to follow that block, so the
 * chunk ends there and the next block starts a fresh chunk (a fresh page).
 * Blocks with no attachments, or only inline images, keep packing.
 */
interface ReportPart {
  body: string;
  /** Transactions whose PDF attachment pages are copied in after this chunk. */
  attachmentsOf: string[];
}

/** Split blocks into parts. `head` goes in front of the first part only. */
function partsFrom(head: string, items: Array<{ html: string; txnId: string | null; endsPart: boolean }>): ReportPart[] {
  const parts: ReportPart[] = [];
  let body = head;
  for (const item of items) {
    body += item.html;
    if (item.endsPart && item.txnId) {
      parts.push({ body, attachmentsOf: [item.txnId] });
      body = '';
    }
  }
  if (body || parts.length === 0) parts.push({ body, attachmentsOf: [] });
  return parts;
}

function hasPdfPages(atts: PreparedAttachment[]): boolean {
  return atts.some((a) => a.included && a.kind === 'pdf');
}

function isPdf(att: AttachmentRow): boolean {
  return att.mimeType === 'application/pdf' || /\.pdf$/i.test(att.fileName);
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function fmtMoney(value: string | null | undefined): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? money.format(n) : '';
}

function fmtField(f: TransactionHeaderField): string {
  switch (f.kind) {
    case 'money': return escapeHtml(fmtMoney(f.value));
    case 'date': return escapeHtml(formatIsoUS(f.value));
    case 'datetime': return escapeHtml(formatIsoUS(new Date(f.value).toISOString()));
    case 'multiline': return escapeHtml(f.value).replace(/\n/g, '<br>');
    default: return escapeHtml(f.value);
  }
}

const RELATION_LABELS: Record<TransactionRelation, string> = {
  payment: 'Payment applied',
  paid_bill: 'Bill paid',
  paid_invoice: 'Applied to invoice',
  credit: 'Credit applied',
  credited_bill: 'Applied to bill',
};

// The DB row in the shape the shared display helpers take (ISO strings for
// timestamps, the narrow unions for type / status / method).
function toDisplay(txn: TransactionDetail): TransactionDisplayInput {
  return {
    txnType: txn.txnType as TxnType,
    txnNumber: txn.txnNumber,
    txnDate: txn.txnDate,
    dueDate: txn.dueDate,
    status: txn.status as TransactionDisplayInput['status'],
    basis: txn.basis as TransactionDisplayInput['basis'],
    contactName: txn.contactName,
    memo: txn.memo,
    internalNotes: txn.internalNotes,
    paymentTerms: txn.paymentTerms,
    termsDays: txn.termsDays,
    subtotal: txn.subtotal,
    taxAmount: txn.taxAmount ?? '0',
    total: txn.total,
    amountPaid: txn.amountPaid ?? '0',
    balanceDue: txn.balanceDue,
    creditsApplied: txn.creditsApplied,
    vendorInvoiceNumber: txn.vendorInvoiceNumber,
    checkNumber: txn.checkNumber,
    printStatus: txn.printStatus,
    payeeNameOnCheck: txn.payeeNameOnCheck,
    payeeAddress: txn.payeeAddress,
    printedMemo: txn.printedMemo,
    printedAt: txn.printedAt?.toISOString() ?? null,
    paymentMethod: txn.paymentMethod as PaymentMethod | null,
    referenceNumber: txn.referenceNumber,
    source: txn.source,
    ajeNumber: txn.ajeNumber,
    voidReason: txn.voidReason,
    voidedAt: txn.voidedAt?.toISOString() ?? null,
    tags: txn.tags,
    bankAccounts: txn.bankAccounts,
    appliedToInvoiceNumber: txn.appliedToInvoiceNumber,
  };
}

function blockTitle(txn: TransactionDisplayInput): string {
  const title = transactionTitle(txn);
  return txn.contactName ? `${title} — ${contactRoleLabel(txn.txnType)}: ${txn.contactName}` : title;
}

function relatedLabel(r: RelatedTransaction): string {
  return transactionTitle({ ...r });
}

function transactionBlockHtml(txn: TransactionDetail, atts: PreparedAttachment[], attachmentTotal: number, extra = ''): string {
  const display = toDisplay(txn);
  // The contact is already in the block title.
  const fields = buildTransactionHeaderFields(display).filter((f) => f.key !== 'contact');
  const hasName = txn.lines.some((l) => l.contactName);
  const hasTag = txn.lines.some((l) => l.tagName);
  const debits = txn.lines.reduce((s, l) => s + Number(l.debit), 0);
  const credits = txn.lines.reduce((s, l) => s + Number(l.credit), 0);
  const pills = [txn.status, txn.billStatus, txn.invoiceStatus].filter((v): v is string => !!v);

  return `<section class="txn">
    <div class="txn-head">
      <h2>${escapeHtml(blockTitle(display))}</h2>
      <div>${pills.map((p) => `<span class="pill pill-${escapeHtml(p)}">${escapeHtml(p)}</span>`).join(' ')}</div>
    </div>
    <div class="cols">
      <div class="card details">
        <h3>Details</h3>
        ${fields.map((f) => `<p><span class="lbl">${escapeHtml(f.label)}:</span> ${fmtField(f)}</p>`).join('')}
      </div>
      <div class="card lines">
        <h3>Journal Lines</h3>
        <table>
          <thead><tr><th>Account</th><th>Description</th>${hasName ? '<th>Name</th>' : ''}${hasTag ? '<th>Tag</th>' : ''}<th class="num">Debit</th><th class="num">Credit</th></tr></thead>
          <tbody>${txn.lines.map((l) => `<tr>
            <td>${escapeHtml(l.accountName ?? 'Unknown')}${l.accountNumber ? ` <span class="muted">(${escapeHtml(l.accountNumber)})</span>` : ''}</td>
            <td>${escapeHtml(l.description ?? '') || '—'}</td>
            ${hasName ? `<td>${escapeHtml(l.contactName ?? '')}</td>` : ''}${hasTag ? `<td>${escapeHtml(l.tagName ?? '')}</td>` : ''}
            <td class="num">${Number(l.debit) > 0 ? fmtMoney(l.debit) : ''}</td>
            <td class="num">${Number(l.credit) > 0 ? fmtMoney(l.credit) : ''}</td>
          </tr>`).join('')}</tbody>
          <tfoot><tr><td colspan="${2 + (hasName ? 1 : 0) + (hasTag ? 1 : 0)}">Totals</td><td class="num">${fmtMoney(String(debits))}</td><td class="num">${fmtMoney(String(credits))}</td></tr></tfoot>
        </table>
      </div>
    </div>
    ${atts.length ? `<div class="atts"><span class="lbl">Attachments:</span> ${atts.map((a) => a.included
      ? `<span class="att">${a.ordinal}. ${escapeHtml(a.fileName)}${a.note ? ` <span class="muted">(${escapeHtml(a.note)})</span>` : ''}</span>`
      : `<span class="att att-missing">${escapeHtml(a.fileName)} — ${escapeHtml(a.note ?? 'not included')}</span>`).join('')}</div>` : ''}
    ${extra}
    ${inlineImagesHtml(atts, attachmentTotal)}
  </section>`;
}

// One stylesheet for both report kinds. `.txn` blocks refuse to split across
// a page break, so a page holds as many whole blocks as fit and a block that
// would straddle the edge starts the next page — the date-range report packs
// several transactions per page this way.
const REPORT_CSS = `
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;font-size:10.5px;margin:0}
    header{border-bottom:2px solid #111827;padding-bottom:6px;margin-bottom:14px}
    header h1{font-size:16px;margin:0}
    header .sub{color:#6b7280;margin-top:2px}
    h2{font-size:14px;margin:0}
    h3{font-size:11.5px;margin:0 0 6px 0;color:#1f2937}
    .txn{margin-bottom:18px;break-inside:avoid;page-break-inside:avoid}
    .txn-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;page-break-after:avoid}
    .cols{display:flex;gap:10px;align-items:flex-start}
    .card{border:1px solid #e5e7eb;border-radius:6px;padding:10px}
    .details{width:32%;box-sizing:border-box}
    .details p{margin:0 0 4px 0;line-height:1.35}
    .lines{flex:1}
    .linked{margin-bottom:18px}
    .lbl{color:#6b7280}
    .muted{color:#6b7280}
    table{width:100%;border-collapse:collapse}
    th{text-align:left;color:#6b7280;font-weight:600;border-bottom:1px solid #d1d5db;padding:3px 4px}
    td{padding:4px;border-bottom:1px solid #f3f4f6;vertical-align:top}
    tfoot td{font-weight:600;border-bottom:none}
    tr{page-break-inside:avoid}
    .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
    .pill{display:inline-block;padding:1px 7px;border-radius:999px;font-size:9px;font-weight:600;background:#e5e7eb;color:#374151}
    .pill-posted,.pill-paid{background:#dcfce7;color:#15803d}
    .pill-void,.pill-overdue{background:#fee2e2;color:#b91c1c}
    .pill-partial,.pill-unpaid,.pill-draft{background:#fef9c3;color:#a16207}
    .atts{margin-top:6px;line-height:1.5}
    .att{margin-right:10px}
    .att-missing{color:#b91c1c}
    .links{margin-top:6px;line-height:1.5}
    .links .rel{margin-right:10px}
    .range-note{margin:0 0 12px 0;color:#6b7280}
    .fig{margin:8px 0 0 0;break-inside:avoid;page-break-inside:avoid}
    .fig figcaption{font-size:9px;font-weight:600;color:#374151;margin:0 0 3px 0}
    .fig img{display:block;max-width:100%;max-height:6.6in;object-fit:contain;image-orientation:from-image;border:1px solid #e5e7eb}
`;

/** The document around one rendered chunk of the summary. */
function shell(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${REPORT_CSS}</style></head><body>${body}</body></html>`;
}

/**
 * A block's inline images: each one under the entry it documents, with the
 * same "Attachment N of M" caption the PDF pages get stamped with. Chromium
 * honours EXIF orientation and WebP, which pdf-lib's image embedding does not.
 */
function inlineImagesHtml(atts: PreparedAttachment[], total: number): string {
  return atts.filter((a) => a.included && a.kind === 'image' && a.dataUrl).map((a) =>
    `<figure class="fig"><figcaption>Attachment ${a.ordinal} of ${total} — ${escapeHtml(a.fileName)}</figcaption><img src="${a.dataUrl}" alt=""></figure>`,
  ).join('');
}

/** A one-line "Linked:" summary for a block on the date-range report. */
function linkedLineHtml(related: RelatedTransactionsResult): string {
  if (related.related.length === 0) return '';
  return `<div class="links"><span class="lbl">Linked:</span> ${related.related.map((r) =>
    `<span class="rel">${escapeHtml(RELATION_LABELS[r.relation] ?? r.relation)} — ${escapeHtml(relatedLabel(r))}${r.contactName ? ` (${escapeHtml(r.contactName)})` : ''}${r.appliedAmount ? ` ${escapeHtml(fmtMoney(r.appliedAmount))}` : ''}${r.status === 'void' ? ' <span class="pill pill-void">void</span>' : ''}</span>`).join('')}${related.truncated ? ' <span class="muted">…</span>' : ''}</div>`;
}

function summaryParts(opts: {
  companyName: string;
  generatedBy?: string | null;
  root: TransactionDetail;
  blocks: Array<{ txn: TransactionDetail; atts: PreparedAttachment[] }>;
  attachmentTotal: number;
  related: RelatedTransactionsResult;
  attachmentsOmitted: boolean;
}): ReportPart[] {
  const { related } = opts.related;
  const linked = related.length ? `<section class="linked card">
    <h3>Linked transactions</h3>
    <table>
      <thead><tr><th>Relationship</th><th>Transaction</th><th>Date</th><th>Name</th><th class="num">Applied</th><th class="num">Total</th></tr></thead>
      <tbody>${related.map((r) => `<tr>
        <td>${escapeHtml(RELATION_LABELS[r.relation] ?? r.relation)}</td>
        <td>${escapeHtml(relatedLabel(r))}${r.status === 'void' ? ' <span class="pill pill-void">void</span>' : ''}</td>
        <td>${escapeHtml(formatIsoUS(r.txnDate))}</td>
        <td>${escapeHtml(r.contactName ?? '')}</td>
        <td class="num">${r.appliedAmount ? fmtMoney(r.appliedAmount) : ''}</td>
        <td class="num">${r.total ? fmtMoney(r.total) : ''}</td>
      </tr>`).join('')}</tbody>
    </table>
    ${opts.related.truncated ? `<p class="muted">Only the first ${MAX_RELATED} linked transactions are shown.</p>` : ''}
    ${related.some((r) => r.status === 'void') ? '<p class="muted">Voided transactions are listed for reference; their details and attachments are not included.</p>' : ''}
  </section>` : '';

  const head = `<header>
      <h1>${escapeHtml(opts.companyName)}</h1>
      <div class="sub">Transaction Report — ${escapeHtml(blockTitle(toDisplay(opts.root)))}</div>
      <div class="sub">Generated ${escapeHtml(formatIsoUS(new Date().toISOString()))}${opts.generatedBy ? ` by ${escapeHtml(opts.generatedBy)}` : ''}</div>
    </header>
    ${opts.attachmentsOmitted ? '<p class="muted">Attachments are not included: your role does not have access to attachments.</p>' : ''}`;
  // The root block, its attachments, then the linked table and each linked
  // block with its own attachments — every document right after its entry.
  const block = (b: { txn: TransactionDetail; atts: PreparedAttachment[] }) => ({
    html: transactionBlockHtml(b.txn, b.atts, opts.attachmentTotal), txnId: b.txn.id, endsPart: hasPdfPages(b.atts),
  });
  return partsFrom(head, [
    ...opts.blocks.slice(0, 1).map(block),
    { html: linked, txnId: null, endsPart: false },
    ...opts.blocks.slice(1).map(block),
  ]);
}

function rangeSummaryParts(opts: {
  companyName: string;
  generatedBy?: string | null;
  startDate: string;
  endDate: string;
  criteria: string[];
  blocks: Array<{ txn: TransactionDetail; atts: PreparedAttachment[]; related: RelatedTransactionsResult }>;
  attachmentTotal: number;
  matched: number;
  /** Set when the plan split the range: which volume this is, and its own dates. */
  part: { index: number; of: number; startDate: string; endDate: string } | null;
  planTruncated: boolean;
  attachmentsOmitted: boolean;
}): ReportPart[] {
  const shown = opts.blocks.length;
  const count = opts.part
    ? `Part ${opts.part.index} of ${opts.part.of}: ${shown} of ${opts.matched} transactions (${formatIsoUS(opts.part.startDate)} to ${formatIsoUS(opts.part.endDate)}). Each part holds as many transactions as its attachment limits allow.`
    : `${shown} transaction${shown === 1 ? '' : 's'}`;
  const head = `<header>
      <h1>${escapeHtml(opts.companyName)}</h1>
      <div class="sub">Transaction Report — ${escapeHtml(formatIsoUS(opts.startDate))} to ${escapeHtml(formatIsoUS(opts.endDate))}${opts.criteria.length ? ` · ${opts.criteria.map(escapeHtml).join(' · ')}` : ''}${opts.part ? ` · Part ${opts.part.index} of ${opts.part.of}` : ''}</div>
      <div class="sub">Generated ${escapeHtml(formatIsoUS(new Date().toISOString()))}${opts.generatedBy ? ` by ${escapeHtml(opts.generatedBy)}` : ''}</div>
    </header>
    <p class="range-note">${escapeHtml(count)}</p>
    ${opts.planTruncated ? `<p class="muted">More than ${MAX_PLANNED_TRANSACTIONS} transactions matched; only the first ${MAX_PLANNED_TRANSACTIONS} are planned. Narrow the dates or filters for the rest.</p>` : ''}
    ${opts.attachmentsOmitted ? '<p class="muted">Attachments are not included: your role does not have access to attachments.</p>' : ''}
    ${shown === 0 ? '<p class="muted">No transactions match.</p>' : ''}`;
  return partsFrom(head, opts.blocks.map((b) => ({
    html: transactionBlockHtml(b.txn, b.atts, opts.attachmentTotal, linkedLineHtml(b.related)),
    txnId: b.txn.id,
    endsPart: hasPdfPages(b.atts),
  })));
}

/**
 * Build the report. Attachments are prepared BEFORE the summary renders so
 * the summary can say, per file, whether it made it in — a corrupt upload, a
 * password-protected statement or a slow storage provider costs that one
 * file, never the report.
 */
export async function generateTransactionReportPdf(
  tenantId: string,
  txnId: string,
  opts: TransactionReportOptions,
  deps: TransactionReportDeps = {},
): Promise<TransactionReportResult> {
  return withSlot(async () => {
    const related = await getRelatedTransactions(tenantId, txnId, opts.companyId);
    const root = await getTransactionDetail(tenantId, txnId);
    const included: TransactionDetail[] = [root];
    for (const r of related.related) {
      if (r.status !== 'void') included.push(await getTransactionDetail(tenantId, r.id));
    }
    const slug = (root.txnNumber || (root.checkNumber != null ? `check-${root.checkNumber}` : root.id.slice(0, 8))).replace(/[^A-Za-z0-9._-]+/g, '-');
    return assembleReport({
      tenantId, included, opts, deps,
      companyId: root.companyId,
      fileName: `transaction-report-${txnTypeLabel(toDisplay(root)).toLowerCase().replace(/[^a-z]+/g, '-')}-${slug}.pdf`,
      parts: (ctx) => summaryParts({ ...ctx, root, related }),
    });
  });
}

export const MAX_RANGE_TRANSACTIONS = 250;
/** How far back the planner looks: the list is fetched once, in date order. */
const MAX_PLANNED_TRANSACTIONS = 10000;

export interface TransactionRangeFilters {
  startDate: string;
  endDate: string;
  txnType?: string;
  contactId?: string;
  accountId?: string;
  tagId?: string;
  basis?: 'cash' | 'accrual';
  /** Voided transactions are left out unless asked for. */
  includeVoid?: boolean;
  /** Which planned part to build (1-based). Omitted = the first. */
  part?: number;
}

export interface RangeReportPart {
  /** 1-based, in date order. */
  index: number;
  startDate: string;
  endDate: string;
  transactionCount: number;
  /** PDF and image files this part will carry. */
  attachmentCount: number;
  attachmentBytes: number;
}

export interface RangeReportPlan {
  /** Transactions the filters match (after the void rule). */
  transactionCount: number;
  attachmentCount: number;
  parts: RangeReportPart[];
  /** True when more than MAX_PLANNED_TRANSACTIONS matched; the tail is not planned. */
  truncated: boolean;
}

interface PlannedTxn { id: string; txnDate: string; files: number; bytes: number }

/**
 * Split the matching transactions into parts so that no single PDF has to
 * leave anything out: a part closes when the next transaction would push it
 * past the transaction, file or byte cap, and the next one starts a fresh
 * part. Parts are contiguous in date order, so a report spanning a quarter
 * reads as one document in several volumes. The planner is deterministic —
 * the same filters give the same parts — which is what lets each part be
 * built on demand when its link is clicked instead of being stored.
 *
 * Only files the report can show (PDFs and images) count; anything else is
 * listed as "not included" wherever it falls. The per-part page cap still
 * applies inside a part (forty files of fifty pages each would exceed it),
 * and that part says so on its own summary.
 */
export async function planTransactionRangeReport(
  tenantId: string,
  filters: Omit<TransactionRangeFilters, 'part'>,
  companyId?: string | null,
): Promise<{ plan: RangeReportPlan; txnsByPart: PlannedTxn[][] }> {
  const list = await ledger.listTransactions(tenantId, {
    txnType: filters.txnType, contactId: filters.contactId, accountId: filters.accountId,
    tagId: filters.tagId, basis: filters.basis,
    startDate: filters.startDate, endDate: filters.endDate,
    sortBy: 'date', sortDir: 'asc',
    limit: MAX_PLANNED_TRANSACTIONS + 1, offset: 0,
  }, companyId ?? undefined);
  const rows = list.data.filter((t) => filters.includeVoid || t.status !== 'void');
  const truncated = rows.length > MAX_PLANNED_TRANSACTIONS;
  const ordered = rows.slice(0, MAX_PLANNED_TRANSACTIONS);

  const stats = await countReportAttachments(tenantId, ordered.map((t) => ({ id: t.id, txnType: t.txnType })));
  const txns: PlannedTxn[] = ordered.map((t) => ({
    id: t.id, txnDate: String(t.txnDate), files: stats.get(t.id)?.files ?? 0, bytes: stats.get(t.id)?.bytes ?? 0,
  }));

  const txnsByPart: PlannedTxn[][] = [];
  let current: PlannedTxn[] = [];
  let files = 0;
  let bytes = 0;
  for (const t of txns) {
    const overflow = current.length > 0 && (
      current.length + 1 > MAX_RANGE_TRANSACTIONS
      || files + t.files > MAX_ATTACHMENTS
      || bytes + t.bytes > MAX_TOTAL_BYTES
    );
    if (overflow) {
      txnsByPart.push(current);
      current = [];
      files = 0;
      bytes = 0;
    }
    current.push(t);
    files += t.files;
    bytes += t.bytes;
  }
  if (current.length > 0) txnsByPart.push(current);

  const parts: RangeReportPart[] = txnsByPart.map((group, i) => ({
    index: i + 1,
    startDate: group[0]!.txnDate,
    endDate: group[group.length - 1]!.txnDate,
    transactionCount: group.length,
    attachmentCount: group.reduce((n, t) => n + t.files, 0),
    attachmentBytes: group.reduce((n, t) => n + t.bytes, 0),
  }));
  return {
    plan: {
      transactionCount: txns.length,
      attachmentCount: txns.reduce((n, t) => n + t.files, 0),
      parts,
      truncated,
    },
    txnsByPart,
  };
}

/**
 * Showable attachments (PDF / image) per transaction, in two queries rather
 * than one per row: the transaction's own files and the ones left on the
 * bank line it posted from — the same two sources listReportAttachments reads.
 */
async function countReportAttachments(
  tenantId: string,
  txns: Array<{ id: string; txnType: string }>,
): Promise<Map<string, { files: number; bytes: number }>> {
  const out = new Map<string, { files: number; bytes: number }>();
  if (txns.length === 0) return out;
  const ids = txns.map((t) => t.id);
  const typeById = new Map(txns.map((t) => [t.id, t.txnType]));
  const showable = (a: { mimeType: string | null; fileName: string }) =>
    (!!a.mimeType && IMAGE_MIME_TYPES.has(a.mimeType.toLowerCase())) || isPdf(a as AttachmentRow);
  const add = (txnId: string, a: { mimeType: string | null; fileName: string; fileSize: number | null }) => {
    if (!showable(a)) return;
    const cur = out.get(txnId) ?? { files: 0, bytes: 0 };
    cur.files += 1;
    cur.bytes += a.fileSize ?? 0;
    out.set(txnId, cur);
  };

  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const direct = await db.select({
      attachableId: attachments.attachableId, attachableType: attachments.attachableType,
      mimeType: attachments.mimeType, fileName: attachments.fileName, fileSize: attachments.fileSize,
    }).from(attachments)
      .where(and(eq(attachments.tenantId, tenantId), inArray(attachments.attachableId, chunk)));
    for (const a of direct) {
      const type = typeById.get(a.attachableId);
      if (type && (a.attachableType === type || a.attachableType === 'transaction' || a.attachableType === 'journal_entry')) add(a.attachableId, a);
    }
    const viaFeed = await db.select({
      txnId: bankFeedItems.matchedTransactionId,
      mimeType: attachments.mimeType, fileName: attachments.fileName, fileSize: attachments.fileSize,
    }).from(attachments)
      .innerJoin(bankFeedItems, and(eq(bankFeedItems.id, attachments.attachableId), eq(bankFeedItems.tenantId, attachments.tenantId)))
      .where(and(
        eq(attachments.tenantId, tenantId),
        eq(attachments.attachableType, 'bank_feed_items'),
        inArray(bankFeedItems.matchedTransactionId, chunk),
      ));
    for (const a of viaFeed) if (a.txnId) add(a.txnId, a);
  }
  return out;
}

/**
 * The same report for every transaction in a date range (optionally one
 * type / payee / account / tag): each transaction's block with a one-line
 * note of what it is linked to, packed several to a page, then every
 * attachment in transaction order. Linked transactions are NOT expanded into
 * blocks of their own — in a range they are usually in the range already,
 * and a payment covering twenty bills would otherwise print twenty-one
 * times. Capped at MAX_RANGE_TRANSACTIONS, and the attachment caps are the
 * same as the single report's, so a quarter of receipts is a deliberate
 * choice of narrower filters rather than a 400-page surprise.
 */
export async function generateTransactionRangeReportPdf(
  tenantId: string,
  filters: TransactionRangeFilters,
  opts: TransactionReportOptions,
  deps: TransactionReportDeps = {},
): Promise<TransactionReportResult> {
  return withSlot(async () => {
    const { plan, txnsByPart } = await planTransactionRangeReport(tenantId, filters, opts.companyId);
    const partIndex = filters.part ?? 1;
    if (plan.parts.length > 0 && (partIndex < 1 || partIndex > plan.parts.length)) {
      throw AppError.badRequest(`This report has ${plan.parts.length} part(s); part ${partIndex} does not exist.`, 'REPORT_PART_OUT_OF_RANGE');
    }
    const chosen = txnsByPart[partIndex - 1] ?? [];
    const partInfo = plan.parts[partIndex - 1] ?? null;

    const included: TransactionDetail[] = [];
    const relatedById = new Map<string, RelatedTransactionsResult>();
    for (const t of chosen) {
      included.push(await getTransactionDetail(tenantId, t.id));
      relatedById.set(t.id, await getRelatedTransactions(tenantId, t.id, opts.companyId));
    }

    const criteria: string[] = [];
    if (filters.txnType) criteria.push(TXN_TYPE_LABELS[filters.txnType as TxnType] ?? filters.txnType);
    if (filters.contactId) {
      const [c] = await db.select({ name: contacts.displayName }).from(contacts)
        .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, filters.contactId))).limit(1);
      if (c) criteria.push(c.name);
    }
    if (filters.accountId) {
      const [a] = await db.select({ name: accounts.name, number: accounts.accountNumber }).from(accounts)
        .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, filters.accountId))).limit(1);
      if (a) criteria.push(a.number ? `${a.number} ${a.name}` : a.name);
    }
    if (filters.tagId) {
      const [t] = await db.select({ name: tags.name }).from(tags)
        .where(and(eq(tags.tenantId, tenantId), eq(tags.id, filters.tagId))).limit(1);
      if (t) criteria.push(`Tag: ${t.name}`);
    }
    if (filters.basis) criteria.push(filters.basis === 'cash' ? 'Cash basis' : 'Accrual basis');
    if (filters.includeVoid) criteria.push('including voided');

    const multi = plan.parts.length > 1 && partInfo;
    return assembleReport({
      tenantId, included, opts, deps,
      companyId: opts.companyId ?? included[0]?.companyId ?? null,
      fileName: multi
        ? `transaction-report-${filters.startDate}-to-${filters.endDate}-part-${partIndex}-of-${plan.parts.length}.pdf`
        : `transaction-report-${filters.startDate}-to-${filters.endDate}.pdf`,
      parts: (ctx) => rangeSummaryParts({
        ...ctx,
        startDate: filters.startDate,
        endDate: filters.endDate,
        criteria,
        blocks: ctx.blocks.map((b) => ({ ...b, related: relatedById.get(b.txn.id) ?? { related: [], truncated: false } })),
        matched: plan.transactionCount,
        part: multi ? { index: partIndex, of: plan.parts.length, startDate: partInfo.startDate, endDate: partInfo.endDate } : null,
        planTruncated: plan.truncated,
      }),
    });
  });
}

interface ReportBlock { txn: TransactionDetail; atts: PreparedAttachment[] }

interface AssembleContext {
  companyName: string;
  generatedBy: string | null;
  blocks: ReportBlock[];
  /** How many attachments made it in — the M in "Attachment N of M". */
  attachmentTotal: number;
  attachmentsOmitted: boolean;
}

/**
 * The part both reports share. Every attachment of every included
 * transaction is read first (within the caps) — PDF pages framed into a
 * scratch document, images kept as data URLs — so the summary can say, per
 * file, whether it made it in. The caller then composes the summary as
 * parts; each part is rendered and followed by the PDF pages of the
 * transactions it names, so a document always sits right after its entry
 * rather than in a pile at the end. Captions and the footer go on last.
 */
async function assembleReport(args: {
  tenantId: string;
  included: TransactionDetail[];
  opts: TransactionReportOptions;
  deps: TransactionReportDeps;
  companyId: string | null;
  fileName: string;
  parts: (ctx: AssembleContext) => ReportPart[];
}): Promise<TransactionReportResult> {
  const { tenantId, included, opts, deps } = args;
  let renderer: ReportRenderer | null = null;
  const getRenderer = async () => (renderer ??= await (deps.openRenderer ?? openChromiumRenderer)());

  try {
    const warnings: string[] = [];
    // PDF attachment pages are laid down in a scratch document first, so the
    // summary can report on each file truthfully; they are copied into place
    // behind their blocks once the summary parts exist.
    const scratch = await PDFDocument.create();
    const blocks: ReportBlock[] = [];
    let ordinal = 0;
    let seen = 0;
    let totalBytes = 0;
    let totalPages = 0;

    for (const txn of included) {
      const atts: PreparedAttachment[] = [];
      const rows = opts.includeAttachments ? await listReportAttachments(tenantId, txn) : [];
      const ownerLabel = [transactionTitle(toDisplay(txn)), txn.contactName].filter(Boolean).join(' · ');
      for (const att of rows) {
        seen++;
        const prepared: PreparedAttachment = { ordinal: 0, fileName: att.fileName, ownerLabel, ownerId: txn.id, included: false, kind: null, from: 0, to: 0, dataUrl: null, note: null };
        atts.push(prepared);
        try {
          if (seen > MAX_ATTACHMENTS) throw new SkipAttachment(`not included — the report holds ${MAX_ATTACHMENTS} attachments at most`);
          const image = !!att.mimeType && IMAGE_MIME_TYPES.has(att.mimeType.toLowerCase());
          if (!image && !isPdf(att)) throw new SkipAttachment('not included — only PDF and image attachments can be shown');
          totalBytes += att.fileSize ?? 0;
          if (totalBytes > MAX_TOTAL_BYTES) throw new SkipAttachment('not included — the report is over its 100 MB attachment limit');
          if (image && (att.fileSize ?? 0) > MAX_IMAGE_BYTES) throw new SkipAttachment('not included — the image is too large');
          if (totalPages >= MAX_TOTAL_PAGES) throw new SkipAttachment(`not included — the report is over its ${MAX_TOTAL_PAGES}-page limit`);

          const bytes = await withTimeout(readAttachmentBytes(tenantId, att), READ_TIMEOUT_MS, 'Reading the file');
          const available = Math.min(MAX_PAGES_PER_PDF, MAX_TOTAL_PAGES - totalPages);
          if (image) {
            // Drawn inline under its block by the summary render; counts as
            // a page toward the cap since it is usually about that big.
            const mime = att.mimeType!.toLowerCase().replace('image/jpg', 'image/jpeg');
            prepared.kind = 'image';
            prepared.dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
            totalPages += 1;
          } else {
            // No ignoreEncryption: pages copied out of an encrypted file
            // come out blank or garbled, which is worse than a note.
            const src = await PDFDocument.load(bytes);
            prepared.kind = 'pdf';
            prepared.from = scratch.getPageCount();
            const added = await appendFramedPdf(scratch, src, available);
            if (added < src.getPageCount()) prepared.note = `first ${added} of ${src.getPageCount()} pages`;
            prepared.to = scratch.getPageCount();
            totalPages += prepared.to - prepared.from;
          }
          prepared.included = true;
          prepared.ordinal = ++ordinal;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          prepared.note = err instanceof SkipAttachment
            ? message
            : /encrypt/i.test(message) ? 'could not be included — the PDF is password-protected'
              : 'could not be included — the file could not be read';
          warnings.push(`${att.fileName}: ${prepared.note}`);
          if (!(err instanceof SkipAttachment)) {
            log.warn({ component: 'transaction-report', event: 'attachment_skipped', attachmentId: att.id, transactionId: txn.id, message });
          }
        }
      }
      blocks.push({ txn, atts });
    }

    const [company] = args.companyId
      ? await db.select({ name: companies.businessName }).from(companies)
        .where(and(eq(companies.tenantId, tenantId), eq(companies.id, args.companyId))).limit(1)
      : await db.select({ name: companies.businessName }).from(companies)
        .where(eq(companies.tenantId, tenantId)).limit(1);

    // By id alone: firm staff working in a client's books have their user
    // row under the firm's tenant. The id comes from the verified JWT.
    const [user] = opts.userId
      ? await db.select({ displayName: users.displayName, email: users.email }).from(users)
        .where(eq(users.id, opts.userId)).limit(1)
      : [];

    const parts = args.parts({
      companyName: company?.name ?? '',
      generatedBy: user?.displayName || user?.email || null,
      blocks,
      attachmentTotal: ordinal,
      attachmentsOmitted: !opts.includeAttachments,
    });

    // Each part's pages, then the PDF attachment pages of the transactions
    // that part ends with — a document always follows its own entry.
    const merged = await PDFDocument.create();
    const captionFont = await merged.embedFont(StandardFonts.HelveticaBold);
    const attsByTxn = new Map(blocks.map((b) => [b.txn.id, b.atts]));
    const renderer = await getRenderer();
    for (const part of parts) {
      await appendPdfDocument(merged, await PDFDocument.load(await renderer.render(shell(part.body))));
      for (const txnId of part.attachmentsOf) {
        for (const att of attsByTxn.get(txnId) ?? []) {
          if (!att.included || att.kind !== 'pdf') continue;
          const start = merged.getPageCount();
          const pages = await merged.copyPages(scratch, Array.from({ length: att.to - att.from }, (_, i) => att.from + i));
          for (const page of pages) merged.addPage(page);
          stampCaption(merged, start, merged.getPageCount(),
            `Attachment ${att.ordinal} of ${ordinal} — ${att.fileName} — ${att.ownerLabel}`, captionFont);
        }
      }
    }
    await stampPageFooter(merged, { pageNumbers: true, footer: await getReportFooter(tenantId) });

    const buffer = Buffer.from(await merged.save());
    return { buffer, fileName: args.fileName, pageCount: merged.getPageCount(), warnings };
  } finally {
    // `renderer` is assigned inside a closure, which TS narrowing can't see.
    await (renderer as ReportRenderer | null)?.close();
  }
}

// A deliberate, explainable omission (caps, unsupported type) — as opposed to
// a file that failed to read, which is logged.
class SkipAttachment extends Error {}
