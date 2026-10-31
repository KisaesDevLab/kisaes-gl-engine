// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and, inArray } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
import type { CreateInvoiceInput, RecordPaymentInput } from '@kis-books/shared';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import {
  transactions, accounts, companies, contacts, items, tags, transactionTags, journalLines,
} from '../db/schema/index.js';
import type { DocumentSendMethod } from '../db/schema/document-send-events.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as ledger from './ledger.service.js';
import { addCalendarDays, isCalendarDate } from '../utils/calendar-date.js';
import * as documentNumbers from './document-number.service.js';
import * as formsPrint from './forms-print.service.js';
import { claimIdempotency, recordIdempotentEntity } from './idempotency.service.js';
import { resolveBillTerms, type ResolvedBillTerms } from './bill.service.js';
import { computeInvoice, type InvoiceComputeResult, type SalesItemType } from '../utils/invoice-compute.js';
import { loadPricingLevel } from './price-levels.service.js';
import { getBalances } from './contacts.service.js';
import { env } from '../config/env.js';
import { deriveHeaderTags } from './tags/derive-header-tags.js';
import { listSendHistory, recordSendEvent } from './document-send.service.js';
import * as billing from './billable-costs.service.js';
import * as invoiceTemplates from './invoice-template.service.js';
import { activeLinksForInvoice, lockSourceTransactions, releaseBilledCosts } from './billable-links.js';
import { billableFigures, parseMarkupPercent, type BillableFigures } from '../utils/invoice-compute.js';

// Calendar arithmetic (U-86, review S3): the old `new Date(d).setDate(+n)`
// worked in local time, so in a US time zone a term window crossing the
// March DST change came out a day early. Kept for older callers; invoices
// resolve their terms with resolveInvoiceTerms (U-125).
export function computeDueDate(txnDate: string, terms: string | undefined): string | undefined {
  if (!terms) return undefined;
  if (terms === 'due_on_receipt') return txnDate;
  // Invoice dates are not schema-checked as YYYY-MM-DD; use the calendar
  // day they start with (a date-time keeps its date, as before).
  const day = txnDate.slice(0, 10);
  if (!isCalendarDate(day)) return undefined;
  switch (terms) {
    case 'net_15': return addCalendarDays(day, 15);
    case 'net_30': return addCalendarDays(day, 30);
    case 'net_60': return addCalendarDays(day, 60);
    case 'net_90': return addCalendarDays(day, 90);
    default: return undefined;
  }
}

// Invoice numbers (U-111): the company's counter (document-number.service
// claims it with one UPDATE ... RETURNING on the request's company row; it
// used to advance every company of the tenant). A typed number leaves the
// counter alone and is checked for duplicates among the company's invoices:
// 409 DOCUMENT_NUMBER_IN_USE, or a warning with warnOnly. There is no DB
// unique index on txn_number (numbers are informational by design).

async function getSystemAccount(executor: DbOrTx, tenantId: string, systemTag: string): Promise<string> {
  const [account] = await executor.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, systemTag)))
    .limit(1);
  if (!account) throw AppError.internal(`System account '${systemTag}' not found. Seed COA first.`);
  return account.id;
}

/**
 * The request's company row (U-122, U-124): its default sales tax rate and
 * payment terms. Without a company (MCP, older callers) the tenant's first
 * company, as before.
 */
export async function loadSalesCompany(executor: DbOrTx, tenantId: string, companyId?: string | null) {
  if (companyId) {
    const [row] = await executor.select().from(companies)
      .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId))).limit(1);
    if (row) return row;
  }
  const [first] = await executor.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  return first ?? null;
}

/** The request company's default sales tax rate (fraction string, "0" when unset). */
export async function getDefaultTaxRate(executor: DbOrTx, tenantId: string, companyId?: string | null): Promise<string> {
  return (await loadSalesCompany(executor, tenantId, companyId))?.defaultSalesTaxRate || '0';
}

function scopeError(message: string): AppError {
  return AppError.badRequest(message, 'VALIDATION_ERROR');
}

/** The invoice's customer: this tenant's, and of the company (or of none). */
async function loadCustomer(executor: DbOrTx, tenantId: string, contactId: string, companyId?: string | null) {
  const [row] = await executor.select().from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId))).limit(1);
  if (!row || ledger.inOtherCompany(row, companyId)) throw scopeError('Customer not found');
  return row;
}

/** Header tags must be this tenant's and of the company (or of none). */
async function assertTagsInScope(executor: DbOrTx, tenantId: string, companyId: string | null | undefined, tagIds: string[] | undefined) {
  const ids = [...new Set(tagIds ?? [])];
  if (ids.length === 0) return;
  const rows = await executor.select({ id: tags.id, companyId: tags.companyId }).from(tags)
    .where(and(eq(tags.tenantId, tenantId), inArray(tags.id, ids)));
  if (rows.length !== ids.length || rows.some((r) => ledger.inOtherCompany(r, companyId))) {
    throw scopeError('One or more tags do not belong to this company');
  }
}

type InvoiceLineInput = CreateInvoiceInput['lines'][number];

interface ResolvedInvoiceLine {
  accountId: string;
  itemId: string | null;
  itemType: SalesItemType | null;
  description?: string;
  quantity?: string;
  unitPrice?: string;
  discountPercent?: string;
  isTaxable: boolean;
  taxRate?: string;
  tagId?: string | null;
  serviceDate: string | null;
  item: { id: string; type: SalesItemType; unitPrice: string | null; discountPercent: string | null } | null;
  /** A billable cost line (U-128): the cost it bills, filled in by resolveBillableLines. */
  bill: {
    sourceLineId: string;
    markupPercent?: string;
    source?: billing.BillableSource;
    figures?: BillableFigures;
    markupAccountId?: string | null;
    existingLinkId?: string | null;
  } | null;
}

function billableError(message: string, code: string, details?: Record<string, unknown>): AppError {
  return AppError.badRequest(message, code, details);
}

/**
 * Lines with their item defaults (U-123): an item of the company supplies
 * the income account when accountId is omitted and the taxable flag when
 * isTaxable is omitted. Without an item an omitted flag is false (as the
 * schema default was). The item's kind, price and discount percent go to
 * the pricing step (U-129).
 */
async function resolveInvoiceLines(
  executor: DbOrTx, tenantId: string, companyId: string | null | undefined, lines: readonly InvoiceLineInput[],
): Promise<ResolvedInvoiceLine[]> {
  const ids = [...new Set(lines.filter((l) => !l.billableSourceLineId).map((l) => l.itemId).filter((v): v is string => !!v))];
  const rows = ids.length === 0 ? [] : await executor.select().from(items)
    .where(and(eq(items.tenantId, tenantId), inArray(items.id, ids)));
  if (rows.length !== ids.length || rows.some((r) => ledger.inOtherCompany(r, companyId))) {
    throw scopeError('One or more line items do not belong to this company');
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set<string>();
  return lines.map((l, i) => {
    // A billable cost (U-128): item, quantity and price come from the cost;
    // the income account is the owner's pick, required (Q-P20p).
    if (l.billableSourceLineId) {
      if (l.itemId || l.quantity !== undefined || l.unitPrice !== undefined || l.discountPercent !== undefined) {
        throw billableError(`lines[${i}]: a billable cost's item, quantity and price come from the cost; don't send them`,
          'BILLABLE_FIELDS_READONLY', { line: i });
      }
      if (!l.accountId) {
        throw billableError(`lines[${i}] needs the income account the cost is billed to (accountId)`, 'BILLABLE_INCOME_ACCOUNT_REQUIRED', { line: i });
      }
      if (seen.has(l.billableSourceLineId)) {
        throw billableError('The same cost appears twice on this invoice', 'BILLABLE_DUPLICATE_LINE', { sourceLineId: l.billableSourceLineId });
      }
      seen.add(l.billableSourceLineId);
      parseMarkupPercent(l.markupPercent, `lines[${i}].markupPercent`);
      return {
        accountId: l.accountId, itemId: null, itemType: null, description: l.description,
        isTaxable: l.isTaxable ?? true, taxRate: l.taxRate, tagId: l.tagId, serviceDate: l.serviceDate ?? null,
        item: null, bill: { sourceLineId: l.billableSourceLineId, markupPercent: l.markupPercent },
      };
    }
    const item = l.itemId ? byId.get(l.itemId) : undefined;
    const accountId = l.accountId ?? item?.incomeAccountId;
    if (!accountId) throw scopeError(`lines[${i}] needs an accountId or an itemId`);
    const itemType = (item?.itemType ?? null) as SalesItemType | null;
    return {
      accountId,
      itemId: item?.id ?? null,
      itemType,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountPercent: l.discountPercent,
      // A subtotal line is never taxed (U-129).
      isTaxable: itemType === 'subtotal' ? false : l.isTaxable ?? (item ? item.isTaxable !== false : false),
      taxRate: l.taxRate,
      tagId: l.tagId,
      serviceDate: l.serviceDate ?? null,
      item: item ? { id: item.id, type: itemType!, unitPrice: item.unitPrice, discountPercent: item.discountPercent } : null,
      bill: null,
    };
  });
}

interface BillingContext {
  /** The invoice being edited (or previewed as an edit); null on POST. */
  invoiceId: string | null;
  /** Take the source row locks in this transaction (POST / PUT). */
  lockTx?: Tx;
  /** Sources of the invoice's current links, locked with the requested ones. */
  alsoLockTxnIds?: string[];
  /** Preview: report costs another invoice holds per line instead of refusing. */
  preview?: boolean;
}

/**
 * The billable lines' costs (U-128 rule 1, rules 5-7): loaded (and locked,
 * in id order, on POST / PUT) and checked; the figures come from the
 * locked cost line, never from the request or a preview. The markup
 * account: the link's when this invoice already bills the cost (kept on
 * every edit), else the company's (400 MARKUP_ACCOUNT_REQUIRED when a
 * markup has none).
 */
async function resolveBillableLines(
  executor: DbOrTx, tenantId: string, companyId: string | null | undefined, customerId: string,
  company: { billableMarkupAccountId: string | null } | null, lines: ResolvedInvoiceLine[], ctx: BillingContext,
) {
  const ids = lines.flatMap((l) => (l.bill ? [l.bill.sourceLineId] : []));
  if (ids.length === 0) {
    if (ctx.lockTx && ctx.alsoLockTxnIds?.length) await lockSourceTransactions(ctx.lockTx, tenantId, ctx.alsoLockTxnIds);
    return new Map<string, { invoiceId: string | null; invoiceNumber: string | null }>();
  }
  const sources = await billing.loadBillableSources(executor, tenantId, ids, { lockTx: ctx.lockTx, alsoLockTxnIds: ctx.alsoLockTxnIds });
  const { alreadyBilled } = billing.checkBillableSources(sources, ids, {
    contactId: customerId, invoiceId: ctx.invoiceId, companyId, reportBilled: ctx.preview,
  });
  lines.forEach((l, i) => {
    if (!l.bill) return;
    const s = sources.get(l.bill.sourceLineId)!;
    const cost = new Decimal(s.line.debit || '0').minus(s.line.credit || '0');
    const figures = billableFigures(cost.toFixed(4), s.line.quantity, l.bill.markupPercent, `lines[${i}]`);
    const ours = s.link && ctx.invoiceId !== null && s.link.invoiceId === ctx.invoiceId ? s.link : null;
    const markupAccountId = ours?.markupAccountId ?? company?.billableMarkupAccountId ?? null;
    if (!new Decimal(figures.markupAmount).isZero() && !markupAccountId) {
      throw billableError('Set the account markups post to (company settings) before billing a cost with a markup.',
        'MARKUP_ACCOUNT_REQUIRED', { line: i });
    }
    l.bill = { ...l.bill, source: s, figures, markupAccountId, existingLinkId: ours?.id ?? null };
    if (l.description === undefined) l.description = s.line.description ?? undefined;
    if (!l.serviceDate) l.serviceDate = s.txn.txnDate;
  });
  return alreadyBilled;
}

const money4 = (v: string) => new Decimal(v).toFixed(4);
/** A signed amount as a journal side: positive credits, negative debits (or the reverse). */
function side(amount: string, positive: 'debit' | 'credit'): { debit: string; credit: string } {
  const d = new Decimal(amount);
  const abs = d.abs().toFixed(4);
  const other = positive === 'debit' ? 'credit' : 'debit';
  return d.isNegative() ? { [positive]: '0', [other]: abs } as { debit: string; credit: string }
    : { [positive]: abs, [other]: '0' } as { debit: string; credit: string };
}

/**
 * The invoice's journal lines from the computed figures (U-122): each line
 * credits its income account (a negative line debits it), A/R is debited
 * the total, Sales Tax Payable credited the tax. Line tax amounts are the
 * document tax's allocation, so they sum to the tax line exactly.
 */
async function buildInvoiceJournal(
  executor: DbOrTx, tenantId: string, lines: ResolvedInvoiceLine[], computed: InvoiceComputeResult,
) {
  const arAccountId = await getSystemAccount(executor, tenantId, 'accounts_receivable');
  const journal: ledger.PostTransactionInput['lines'] = [
    { accountId: arAccountId, ...side(computed.total, 'debit') },
    ...lines.flatMap((l, i): ledger.PostTransactionInput['lines'] => {
      const c = computed.lines[i]!;
      // A billable cost (U-128 rule 6): the cost line credits the line's own
      // income account for the cost and carries the line's tax; the markup
      // line (when not 0) credits the markup account, tax 0. One visible
      // line (Q-P20w): GET /invoices/:id billableCosts joins them again.
      if (l.bill?.figures && l.bill.source) {
        const f = l.bill.figures;
        const src = l.bill.source.line;
        const common = {
          description: l.description, isTaxable: c.isTaxable, taxRate: c.taxRate, tagId: l.tagId,
          serviceDate: l.serviceDate, unitPriceSource: 'billable_cost', billableSourceLineId: l.bill.sourceLineId,
        };
        const costLine = {
          accountId: l.accountId, ...side(f.costAmount, 'credit'), ...common,
          itemId: src.itemId, quantity: src.quantity ?? undefined, unitPrice: src.unitPrice ?? undefined,
          taxAmount: money4(c.taxAmount), lineRole: 'billable_cost',
        };
        if (new Decimal(f.markupAmount).isZero()) return [costLine];
        return [costLine, {
          accountId: l.bill.markupAccountId!, ...side(f.markupAmount, 'credit'), ...common,
          taxAmount: '0', lineRole: 'billable_markup',
        }];
      }
      return [{
        accountId: l.accountId,
        // A subtotal line's amount is shown only; it posts $0 (U-129).
        ...side(c.itemType === 'subtotal' ? '0' : c.amount, 'credit'),
        description: l.description,
        itemId: l.itemId,
        // The figures the pricing step used (U-129): a discount line keeps
        // its percent, a subtotal line posts $0 with no quantity or price.
        quantity: c.quantity ?? undefined,
        unitPrice: c.unitPrice ?? undefined,
        discountPercent: c.discountPercent,
        unitPriceSource: c.unitPriceSource,
        isTaxable: c.isTaxable,
        taxRate: c.taxRate,
        taxAmount: money4(c.taxAmount),
        // ADR 0XX — invoice revenue lines carry the user-selected tag.
        // AR and sales-tax lines remain untagged (internal postings).
        tagId: l.tagId,
        serviceDate: l.serviceDate,
      }];
    }),
  ];
  if (!new Decimal(computed.taxTotal).isZero()) {
    const taxAccountId = await getSystemAccount(executor, tenantId, 'sales_tax_payable');
    journal.push({ accountId: taxAccountId, ...side(computed.taxTotal, 'credit'), description: 'Sales Tax' });
  }
  return journal;
}

/**
 * Invoice terms (U-125, invoice-terms-v1): the invoice's paymentTerms, else
 * the client's default, else the company's; codes from PAYMENT_TERMS
 * (net 10/15/30/45/60/90, due on receipt, discount terms, custom with
 * termsDays). An explicit dueDate wins and is stored as overridden. A code
 * not in the table (free text from before it) is kept, with no computed
 * date. A txnDate that is not a calendar date computes no date (as before).
 */
export function resolveInvoiceTerms(
  req: { txnDate: string; paymentTerms?: string; termsDays?: number; dueDate?: string },
  client: { defaultPaymentTerms?: string | null; defaultTermsDays?: number | null } | null,
  company: { defaultPaymentTerms?: string | null } | null,
): Omit<ResolvedBillTerms, 'source'> & { source: 'input' | 'client' | 'company' | 'none' } {
  const defaults = client?.defaultPaymentTerms
    ? { defaultPaymentTerms: client.defaultPaymentTerms, defaultTermsDays: client.defaultTermsDays ?? null }
    : { defaultPaymentTerms: company?.defaultPaymentTerms ?? null, defaultTermsDays: null };
  const day = req.txnDate.slice(0, 10);
  if (!isCalendarDate(day)) {
    const code = req.paymentTerms || defaults.defaultPaymentTerms || null;
    return {
      paymentTerms: code, termsDays: req.termsDays ?? null, discountPercent: null, discountDays: null,
      dueDate: req.dueDate || null, discountDate: null, dueDateOverridden: !!req.dueDate, discountDateOverridden: false,
      source: req.paymentTerms ? 'input' : code ? (client?.defaultPaymentTerms ? 'client' : 'company') : 'none',
    };
  }
  const t = resolveBillTerms({ txnDate: day, paymentTerms: req.paymentTerms, termsDays: req.termsDays, dueDate: req.dueDate }, defaults);
  return {
    ...t,
    source: t.source === 'vendor' ? (client?.defaultPaymentTerms ? 'client' : 'company') : t.source,
  };
}

function termsColumns(t: Omit<ResolvedBillTerms, 'source'>) {
  return {
    paymentTerms: t.paymentTerms || null,
    termsDays: t.termsDays ?? null,
    discountPercent: t.discountPercent,
    discountDays: t.discountDays,
    discountDate: t.discountDate,
    dueDateOverridden: t.dueDateOverridden,
    discountDateOverridden: t.discountDateOverridden,
  };
}

/**
 * Header tags (U-123): `tagIds` sent replaces the invoice's own tags; with
 * TAGS_SPLIT_LEVEL_V2 the tags derived from the lines stay in the set (as
 * PUT /checks). `keep` (an edit that omits tagIds): header-only tags read
 * before the ledger rebuilt the set from the new lines.
 */
async function writeHeaderTags(
  tx: Tx, tenantId: string, txnId: string, companyId: string | null,
  tagIds: string[] | undefined, keep: string[],
) {
  if (tagIds === undefined && keep.length === 0) return;
  const set = new Set<string>(tagIds ?? keep);
  if (env.TAGS_SPLIT_LEVEL_V2) {
    const lines = await tx.select({ tagId: journalLines.tagId }).from(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId), eq(journalLines.isVoidReversal, false)));
    for (const id of deriveHeaderTags(lines)) set.add(id);
  }
  await tx.delete(transactionTags)
    .where(and(eq(transactionTags.tenantId, tenantId), eq(transactionTags.transactionId, txnId)));
  if (set.size > 0) {
    await tx.insert(transactionTags).values([...set].map((tagId) => ({ transactionId: txnId, tagId, tenantId, companyId })));
  }
}

/** Header-only tags of an invoice (not derived from its lines), read before an edit. */
async function headerOnlyTags(tx: Tx, tenantId: string, txnId: string): Promise<string[]> {
  if (!env.TAGS_SPLIT_LEVEL_V2) return [];
  const rows = await tx.select({ tagId: transactionTags.tagId }).from(transactionTags)
    .where(and(eq(transactionTags.tenantId, tenantId), eq(transactionTags.transactionId, txnId)));
  const lines = await tx.select({ tagId: journalLines.tagId }).from(journalLines)
    .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId), eq(journalLines.isVoidReversal, false)));
  const fromLines = new Set(deriveHeaderTags(lines));
  return rows.map((r) => r.tagId).filter((id) => !fromLines.has(id));
}

/**
 * The invoice's figures from its request (U-122, U-123, U-129): the lines
 * resolved against their items, priced with the client's level, and
 * computed by utils/invoice-compute.ts. POST /invoices/preview stops here;
 * POST and PUT post what this returns.
 */
async function computeInvoiceFigures(
  executor: DbOrTx, tenantId: string, input: CreateInvoiceInput, companyId: string | null | undefined,
  billingCtx: BillingContext = { invoiceId: null },
) {
  const company = await loadSalesCompany(executor, tenantId, companyId);
  const customer = await loadCustomer(executor, tenantId, input.contactId, companyId);
  const lines = await resolveInvoiceLines(executor, tenantId, companyId, input.lines);
  await assertTagsInScope(executor, tenantId, companyId, input.tagIds);
  const alreadyBilled = await resolveBillableLines(executor, tenantId, companyId, customer.id, company, lines, billingCtx);
  const priceLevel = await loadPricingLevel(executor, tenantId, customer.priceLevelId, companyId);
  // A billable line is a fixed amount: never priced by a level (S10).
  const computed = computeInvoice(lines.map((l) => ({ ...l, billable: l.bill?.figures ?? null })), {
    defaultTaxRate: company?.defaultSalesTaxRate || '0', priceLevel,
  });
  return { company, customer, lines, priceLevel, computed, alreadyBilled };
}

/** Everything the invoice posts from its request. */
async function prepareInvoice(
  tx: Tx, tenantId: string, input: CreateInvoiceInput, companyId: string | null | undefined, billingCtx: BillingContext,
) {
  const { company, customer, lines, computed } = await computeInvoiceFigures(tx, tenantId, input, companyId, billingCtx);
  const journal = await buildInvoiceJournal(tx, tenantId, lines, computed);
  const claims: billing.BillableClaim[] = lines.flatMap((l) => (l.bill?.figures && l.bill.source ? [{
    sourceLineId: l.bill.sourceLineId,
    sourceTransactionId: l.bill.source.txn.id,
    figures: l.bill.figures,
    markupAccountId: l.bill.markupAccountId ?? null,
    existingLinkId: l.bill.existingLinkId ?? null,
  }] : []));
  return { company, customer, computed, journal, claims };
}

/** A billable line's preview fields (U-128): its figures, and an error when another invoice holds the cost. */
function billablePreview(
  bill: NonNullable<ResolvedInvoiceLine['bill']>,
  alreadyBilled: Map<string, { invoiceId: string | null; invoiceNumber: string | null }>,
) {
  const f = bill.figures!;
  const held = alreadyBilled.get(bill.sourceLineId);
  return {
    billableSourceLineId: bill.sourceLineId,
    costAmount: f.costAmount,
    markupPercent: f.markupPercent,
    markupAmount: f.markupAmount,
    displayRate: f.displayRate,
    error: held ? { code: 'BILLABLE_ALREADY_BILLED', invoiceId: held.invoiceId, invoiceNumber: held.invoiceNumber } : null,
  };
}

/**
 * POST /invoices/preview (U-129, invoice-pricing-v1): what POST (or PUT,
 * with invoiceId) would post for this body, computed by the same code, with
 * nothing written: no number claimed, no audit row, no idempotency key.
 * contactBalanceAfter is the client's open balance (U-38) with this
 * invoice's total; with invoiceId, that invoice's posted total is taken out
 * first. dueDate as the terms resolve it (U-125; with invoiceId the
 * invoice's own terms when the body sends none).
 */
export async function previewInvoice(
  tenantId: string, input: CreateInvoiceInput & { invoiceId?: string }, companyId?: string,
) {
  let existing: typeof transactions.$inferSelect | undefined;
  if (input.invoiceId) {
    [existing] = await db.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, input.invoiceId))).limit(1);
    if (!existing || existing.status === 'deleted' || ledger.inOtherCompany(existing, companyId)) {
      throw AppError.notFound('Transaction not found');
    }
    if (existing.txnType !== 'invoice') throw AppError.badRequest('Not an invoice');
  }
  const scope = companyId ?? existing?.companyId ?? undefined;
  // The layout it would print with (U-130): checked as POST / PUT check it.
  await invoiceTemplates.assertInvoiceLayout(db, tenantId, input.layoutId, existing ? existing.companyId : scope);
  // Billable costs (U-128 S3): checked without a lock or a claim; a cost
  // another invoice holds is reported on its line (error), not refused.
  const { company, customer, lines, priceLevel, computed, alreadyBilled } = await computeInvoiceFigures(db, tenantId, input, scope, {
    invoiceId: existing?.id ?? null, preview: true,
  });
  const paymentTerms = input.paymentTerms ?? existing?.paymentTerms ?? undefined;
  const termsDays = input.termsDays ?? (input.paymentTerms === undefined ? existing?.termsDays ?? undefined : undefined);
  const terms = resolveInvoiceTerms({ txnDate: input.txnDate, paymentTerms, termsDays, dueDate: input.dueDate }, customer, company);

  const balances = await getBalances(tenantId, [customer.id], scope);
  let before = new Decimal(balances.get(customer.id)?.openBalance ?? '0');
  // The edited invoice's posted A/R leaves the balance (a void one has none).
  if (existing && existing.status === 'posted' && existing.contactId === customer.id) {
    before = before.minus(existing.total || '0');
  }
  const rate = new Decimal(company?.defaultSalesTaxRate || '0').toFixed(4);
  return {
    lines: computed.lines.map((c, i) => ({
      itemId: lines[i]!.itemId,
      itemType: c.itemType,
      quantity: c.quantity,
      unitPrice: c.unitPrice,
      unitPriceSource: c.unitPriceSource,
      discountPercent: c.discountPercent,
      amount: c.amount,
      isTaxable: c.isTaxable,
      taxRate: c.taxRate,
      taxAmount: c.taxAmount,
      ...(lines[i]!.bill?.figures ? billablePreview(lines[i]!.bill!, alreadyBilled) : {}),
    })),
    subtotal: computed.subtotal,
    taxableBase: computed.taxableBase,
    // The layout the invoice would print with (U-130): null = the company default.
    layoutId: input.layoutId !== undefined ? input.layoutId : existing?.layoutId ?? null,
    taxRate: rate,
    taxTotal: computed.taxTotal,
    total: computed.total,
    taxGroups: computed.taxGroups,
    paymentTerms: terms.paymentTerms ?? null,
    dueDate: terms.dueDate ?? null,
    priceLevel: priceLevel ? { id: priceLevel.id, name: priceLevel.name, percent: priceLevel.percent } : null,
    contactBalanceBefore: before.toFixed(2),
    contactBalanceAfter: before.plus(computed.total).toFixed(2),
  };
}

export async function createInvoice(tenantId: string, input: CreateInvoiceInput, userId?: string, companyId?: string) {
  return (await createInvoiceWithWarnings(tenantId, input, userId, companyId)).invoice;
}

/**
 * Creates an invoice (U-122..U-125). The figures are computed to the cent
 * (sales-cents-v1); the request's company supplies the default tax rate and
 * terms; the number is claimed (or a typed one checked) and the invoice
 * posted in one database transaction, so a refused post takes no number.
 * The idempotency key is claimed first, so a replay takes no counter lock.
 * Response: the posted row plus its warnings (U-111).
 */
export async function createInvoiceWithWarnings(
  tenantId: string, input: CreateInvoiceInput, userId?: string, companyId?: string,
) {
  if (input.releaseBillableSourceLineIds?.length) {
    throw AppError.badRequest('releaseBillableSourceLineIds is for editing an invoice', 'VALIDATION_ERROR');
  }
  return await billing.mapBillableDbErrors(() => db.transaction(async (tx) => {
    await claimIdempotency(tx);
    // Billable costs (U-128): their sources are locked (id order) and
    // checked before anything posts; claimed in this transaction below.
    const { company, customer, computed, journal, claims } = await prepareInvoice(tx, tenantId, input, companyId, {
      invoiceId: null, lockTx: tx,
    });
    const terms = resolveInvoiceTerms(input, customer, company);
    await invoiceTemplates.assertInvoiceLayout(tx, tenantId, input.layoutId, companyId);
    // A typed number skips the counter, so a one-off custom number doesn't
    // advance the sequence; otherwise the next free number is claimed.
    const { txnNumber, warnings } = await documentNumbers.numberForNew(tenantId, 'invoice', input.txnNumber, {
      companyId, warnOnly: input.warnOnly === true, executor: tx,
    });
    const invoice = await ledger.postTransaction(tenantId, {
      txnType: 'invoice',
      txnNumber,
      printLater: input.printLater === true,
      txnDate: input.txnDate,
      dueDate: terms.dueDate ?? undefined,
      contactId: input.contactId,
      memo: input.memo,
      internalNotes: input.internalNotes,
      paymentTerms: terms.paymentTerms ?? undefined,
      termsDays: terms.termsDays ?? undefined,
      discountPercent: terms.discountPercent,
      discountDays: terms.discountDays,
      discountDate: terms.discountDate,
      dueDateOverridden: terms.dueDateOverridden,
      discountDateOverridden: terms.discountDateOverridden,
      subtotal: money4(computed.subtotal),
      taxAmount: money4(computed.taxTotal),
      total: money4(computed.total),
      balanceDue: money4(computed.total),
      amountPaid: '0',
      status: 'posted',
      invoiceStatus: 'draft',
      lines: journal,
    }, userId, companyId, tx);
    const header = {
      poNumber: input.poNumber || null,
      customerMessage: input.customerMessage || null,
      hideZeroLines: input.hideZeroLines === true,
      layoutId: input.layoutId ?? null,
    };
    await tx.update(transactions).set(header)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, invoice.id)));
    await writeHeaderTags(tx, tenantId, invoice.id, invoice.companyId, input.tagIds, []);
    if (claims.length > 0) {
      const claimed = await billing.writeClaims(tx, tenantId, invoice.companyId, invoice.id, claims, userId);
      await auditLog(tenantId, 'update', 'invoice', invoice.id, null, { billableClaimed: claimed }, userId, tx);
    }
    return { invoice: { ...invoice, ...header }, warnings };
  }));
}

export async function updateInvoice(tenantId: string, invoiceId: string, input: CreateInvoiceInput, userId?: string, companyId?: string) {
  return (await updateInvoiceWithWarnings(tenantId, invoiceId, input, userId, companyId)).invoice;
}

/**
 * Edits an invoice in one database transaction (U-124, invoice-edit-v1):
 * the row is locked FOR UPDATE and `expectedUpdatedAt` checked (409 STALE);
 * a void or paid invoice is refused (400); the figures are recomputed to the
 * cent. Terms (U-125): an omitted paymentTerms keeps the invoice's; the due
 * date is recomputed when the date or the terms change (unless dueDate is
 * sent), else kept. Fields this edit omits (poNumber, customerMessage,
 * hideZeroLines, internalNotes, tagIds, printLater) keep their values.
 */
export async function updateInvoiceWithWarnings(
  tenantId: string, invoiceId: string, input: CreateInvoiceInput, userId?: string, companyId?: string,
) {
  const warnings = await billing.mapBillableDbErrors(() => db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const [existing] = await tx.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, invoiceId)))
      .for('update')
      .limit(1);
    if (!existing || existing.status === 'deleted' || ledger.inOtherCompany(existing, companyId)) {
      throw AppError.notFound('Transaction not found');
    }
    if (existing.txnType !== 'invoice') throw AppError.badRequest('Not an invoice');
    if (existing.status === 'void') throw AppError.badRequest('Cannot edit a void invoice');
    if (existing.invoiceStatus === 'paid') throw AppError.badRequest('Cannot edit a paid invoice');
    ledger.assertNotStale(existing, input.expectedUpdatedAt, 'This invoice');

    const scope = companyId ?? existing.companyId ?? undefined;
    await invoiceTemplates.assertInvoiceLayout(tx, tenantId, input.layoutId, existing.companyId);

    // Billable costs (U-128 rules 2-3, S2): every cost the invoice bills is
    // re-sent (kept) or named in releaseBillableSourceLineIds (released);
    // a PUT that just leaves one out (an older client) is 409
    // BILLABLE_LINES_MISSING and nothing is unbilled.
    const links = await activeLinksForInvoice(tx, tenantId, invoiceId);
    const sent = new Set(input.lines.flatMap((l) => (l.billableSourceLineId ? [l.billableSourceLineId] : [])));
    const release = new Set(input.releaseBillableSourceLineIds ?? []);
    const both = [...release].filter((id) => sent.has(id));
    if (both.length > 0) {
      throw AppError.badRequest('A cost can’t be both on the invoice and released from it', 'VALIDATION_ERROR', { sourceLineIds: both });
    }
    const missing = links.filter((l) => !sent.has(l.sourceLineId) && !release.has(l.sourceLineId)).map((l) => l.sourceLineId);
    if (missing.length > 0) {
      throw AppError.conflict(
        'This invoice bills costs this change leaves out. Send them again, or release them (releaseBillableSourceLineIds).',
        'BILLABLE_LINES_MISSING', { sourceLineIds: missing },
      );
    }
    const { company, customer, computed, journal, claims } = await prepareInvoice(tx, tenantId, input, scope, {
      invoiceId, lockTx: tx, alsoLockTxnIds: links.map((l) => l.sourceTransactionId),
    });
    // The total can't drop below what was paid (U-128 S6).
    const paid = new Decimal(existing.amountPaid || '0');
    if (paid.greaterThan(0) && new Decimal(computed.total).lessThan(paid)) {
      throw AppError.conflict('The invoice total would be less than what the customer already paid.',
        'INVOICE_TOTAL_BELOW_PAID', { total: computed.total, amountPaid: paid.toFixed(2) });
    }

    // Terms: the invoice's own when the edit sends none.
    const paymentTerms = input.paymentTerms ?? existing.paymentTerms ?? undefined;
    const termsDays = input.termsDays ?? (input.paymentTerms === undefined ? existing.termsDays ?? undefined : undefined);
    const changed = input.txnDate !== existing.txnDate
      || (paymentTerms ?? null) !== (existing.paymentTerms ?? null)
      || (termsDays ?? null) !== (existing.termsDays ?? null);
    const terms: Omit<ResolvedBillTerms, 'source'> = input.dueDate || changed
      ? resolveInvoiceTerms({ txnDate: input.txnDate, paymentTerms, termsDays, dueDate: input.dueDate }, customer, company)
      : {
        paymentTerms: existing.paymentTerms, termsDays: existing.termsDays,
        discountPercent: existing.discountPercent, discountDays: existing.discountDays,
        dueDate: existing.dueDate, discountDate: existing.discountDate,
        dueDateOverridden: existing.dueDateOverridden, discountDateOverridden: existing.discountDateOverridden,
      };

    // Allow editing the invoice number on an unpaid invoice. Only re-check
    // uniqueness when it actually changed, excluding this invoice itself.
    const newNumber = input.txnNumber?.trim();
    let warnings: documentNumbers.DocumentNumberWarning[] = [];
    if (newNumber && newNumber !== existing.txnNumber) {
      warnings = await documentNumbers.checkDuplicate(tenantId, 'invoice', newNumber, {
        companyId: scope, excludeId: invoiceId, warnOnly: input.warnOnly === true, executor: tx,
      });
    }

    const keepTags = input.tagIds === undefined ? await headerOnlyTags(tx, tenantId, invoiceId) : [];
    const balanceDue = new Decimal(computed.total).minus(existing.amountPaid || '0');
    await ledger.updateTransaction(tenantId, invoiceId, {
      txnType: 'invoice',
      ...(newNumber ? { txnNumber: newNumber } : {}),
      txnDate: input.txnDate,
      dueDate: terms.dueDate ?? undefined,
      contactId: input.contactId,
      memo: input.memo,
      internalNotes: input.internalNotes,
      paymentTerms: terms.paymentTerms ?? undefined,
      subtotal: money4(computed.subtotal),
      taxAmount: money4(computed.taxTotal),
      total: money4(computed.total),
      balanceDue: balanceDue.toFixed(4),
      lines: journal,
    }, userId, companyId, tx);

    // The invoice's own columns (the ledger edit doesn't write them), in the
    // same transaction, last, so the committed updatedAt is the final one.
    await tx.update(transactions).set({
      ...termsColumns(terms),
      ...(input.internalNotes !== undefined ? { internalNotes: input.internalNotes || null } : {}),
      ...(input.poNumber !== undefined ? { poNumber: input.poNumber || null } : {}),
      ...(input.customerMessage !== undefined ? { customerMessage: input.customerMessage || null } : {}),
      ...(input.hideZeroLines !== undefined ? { hideZeroLines: input.hideZeroLines } : {}),
      ...(input.layoutId !== undefined ? { layoutId: input.layoutId } : {}),
      updatedAt: new Date(),
    }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, invoiceId)));
    await writeHeaderTags(tx, tenantId, invoiceId, existing.companyId, input.tagIds, keepTags);
    // The ledger edit and the print-later mark commit together (U-113).
    if (input.printLater !== undefined) {
      await formsPrint.setPrintLater(tx, tenantId, invoiceId, input.printLater, scope);
    }
    // Released costs go back to unbilled; new ones are claimed; kept ones
    // keep their link and markup account (U-128 rules 2-3).
    const released = await releaseBilledCosts(tx, tenantId, invoiceId, 'removed', userId,
      links.filter((l) => release.has(l.sourceLineId)).map((l) => l.sourceLineId));
    const claimed = await billing.writeClaims(tx, tenantId, existing.companyId, invoiceId, claims, userId);
    if (claimed.length > 0 || released.length > 0) {
      await auditLog(tenantId, 'update', 'invoice', invoiceId, null, {
        billableClaimed: claimed, billableReleased: released.map((r) => r.sourceLineId),
      }, userId, tx);
    }
    return warnings;
  }));
  return { invoice: await getInvoice(tenantId, invoiceId, companyId), warnings };
}

/**
 * An invoice as GET /invoices/:id returns it: the transaction with its lines
 * (serviceDate included), its header tagIds and its sendHistory (U-126,
 * oldest first). A transaction of another company is 404 (rows without a
 * company pass); one that is not an invoice is 400.
 */
export async function getInvoice(tenantId: string, invoiceId: string, companyId?: string) {
  const txn = await ledger.getTransaction(tenantId, invoiceId);
  if (ledger.inOtherCompany(txn, companyId)) throw AppError.notFound('Transaction not found');
  if (txn.txnType !== 'invoice') throw AppError.badRequest('Not an invoice');
  const [tagRows, sendHistory] = await Promise.all([
    db.select({ tagId: transactionTags.tagId }).from(transactionTags)
      .where(and(eq(transactionTags.tenantId, tenantId), eq(transactionTags.transactionId, invoiceId))),
    listSendHistory(db, tenantId, invoiceId),
  ]);
  // One entry per billed cost (U-128): the form shows one row with these figures.
  const billableCosts = await billing.billableCostsForInvoice(db, tenantId, invoiceId, txn.lines);
  return { ...txn, tagIds: tagRows.map((r) => r.tagId), sendHistory, billableCosts };
}

/**
 * POST /invoices/:id/sent (U-126): records that the invoice was sent
 * (printed, emailed, or saved as a PDF and sent by other means). A void or
 * deleted invoice is 400 INVOICE_VOID.
 */
export async function recordInvoiceSent(
  tenantId: string, invoiceId: string,
  input: { method: DocumentSendMethod; recipients?: string[]; sentAt?: string },
  userId?: string, companyId?: string,
) {
  await db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const [row] = await tx.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, invoiceId)))
      .for('update').limit(1);
    if (!row || row.status === 'deleted' || ledger.inOtherCompany(row, companyId)) throw AppError.notFound('Transaction not found');
    if (row.txnType !== 'invoice') throw AppError.badRequest('Not an invoice');
    if (row.status === 'void') throw AppError.badRequest('A void invoice can’t be sent', 'INVOICE_VOID');
    await recordIdempotentEntity(tx, 'transaction', invoiceId);
    await recordSendEvent(tx, tenantId, row, {
      method: input.method, recipients: input.recipients, sentAt: input.sentAt ? new Date(input.sentAt) : undefined,
    }, userId);
  });
  return getInvoice(tenantId, invoiceId, companyId);
}

export async function markAsSent(tenantId: string, invoiceId: string, userId?: string, companyId?: string) {
  const txn = await getInvoice(tenantId, invoiceId, companyId);
  if (txn.invoiceStatus !== 'draft') throw AppError.badRequest('Only draft invoices can be marked as sent');

  // sent_at too (U-126), so the unsent list (sent=false) leaves it out.
  await db.update(transactions).set({
    invoiceStatus: 'sent',
    ...(txn.sentAt ? {} : { sentAt: new Date() }),
    updatedAt: new Date(),
  }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, invoiceId)));
  await auditLog(tenantId, 'update', 'invoice', invoiceId,
    { invoiceStatus: 'draft' }, { invoiceStatus: 'sent', via: 'mark_sent' }, userId);
}

export async function generateShareLink(tenantId: string, invoiceId: string, userId?: string, baseUrl?: string, companyId?: string): Promise<string> {
  const txn = await getInvoice(tenantId, invoiceId, companyId);

  const { generatePublicToken } = await import('./public-invoice.service.js');
  const token = await generatePublicToken(tenantId, invoiceId);

  // Auto-mark draft as sent when generating a share link
  if (txn.invoiceStatus === 'draft') {
    await db.update(transactions).set({
      invoiceStatus: 'sent',
      sentAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, invoiceId)));
  }

  // Audit share-link generation: it grants anonymous read + pay access to
  // the invoice, so we want a trail for who issued it and when.
  await auditLog(tenantId, 'create', 'invoice_share_link', invoiceId, null,
    { via: 'generate_share_link', previousStatus: txn.invoiceStatus }, userId);

  // Prefer the request-derived origin (issue #32): the merchant sees a
  // link matching the URL they're on, so mDNS / IP-port fallback users
  // get a link they can follow in their own clients. Falls back to
  // CORS_ORIGIN's first entry when called outside a request context
  // (e.g. scheduled jobs).
  const { firstConfiguredOrigin } = await import('../utils/base-url.js');
  const origin = baseUrl || firstConfiguredOrigin();
  return `${origin}/pay/${token}`;
}

export async function sendInvoice(tenantId: string, invoiceId: string, userId?: string, companyId?: string) {
  const txn = await getInvoice(tenantId, invoiceId, companyId);

  await db.update(transactions).set({
    invoiceStatus: 'sent',
    sentAt: new Date(),
    updatedAt: new Date(),
  }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, invoiceId)));
  await auditLog(tenantId, 'update', 'invoice', invoiceId,
    { invoiceStatus: txn.invoiceStatus }, { invoiceStatus: 'sent', via: 'send_invoice' }, userId);
}

export async function recordPayment(tenantId: string, invoiceId: string, input: RecordPaymentInput, userId?: string, companyId?: string) {
  const invoice = await getInvoice(tenantId, invoiceId, companyId);
  if (invoice.status === 'void') throw AppError.badRequest('Cannot pay a void invoice');

  const arAccountId = await getSystemAccount(db, tenantId, 'accounts_receivable');
  const paymentAmount = new Decimal(input.amount);
  const currentPaid = new Decimal(invoice.amountPaid || '0');
  const invoiceTotal = new Decimal(invoice.total || '0');
  const newPaid = currentPaid.plus(paymentAmount);
  const newBalance = invoiceTotal.minus(newPaid);

  // Both writes — the payment ledger post AND the invoice-header update
  // — run in a single outer transaction. postTransaction accepts our tx
  // and reuses it instead of opening its own, so a mid-flight crash
  // rolls back BOTH or COMMITS BOTH atomically. The prior implementation
  // committed the payment first and then performed a separate UPDATE;
  // a crash in the gap left the invoice header stale (amountPaid /
  // balanceDue / invoiceStatus out of sync with the journal).
  const tolerance = new Decimal('0.01');
  const invoiceStatus = newBalance.lessThanOrEqualTo(tolerance) ? 'paid' : 'partial';
  const clampedBalance = newBalance.isNegative() ? new Decimal('0') : newBalance;

  return await db.transaction(async (tx) => {
    const payment = await ledger.postTransaction(tenantId, {
      txnType: 'customer_payment',
      txnDate: input.txnDate,
      contactId: invoice.contactId || undefined,
      memo: input.memo || `Payment for invoice ${invoice.txnNumber || invoice.id}`,
      total: input.amount,
      appliedToInvoiceId: invoiceId,
      paymentMethod: input.paymentMethod,
      referenceNumber: input.refNo,
      lines: [
        { accountId: input.depositToAccountId, debit: input.amount, credit: '0' },
        { accountId: arAccountId, debit: '0', credit: input.amount },
      ],
    }, userId, companyId, tx);

    await tx.update(transactions).set({
      amountPaid: newPaid.toFixed(4),
      balanceDue: clampedBalance.toFixed(4),
      invoiceStatus,
      paidAt: invoiceStatus === 'paid' ? new Date() : null,
      updatedAt: new Date(),
    }).where(eq(transactions.id, invoiceId));

    return payment;
  });
}

/**
 * Voids an invoice (U-124): row lock, `expectedUpdatedAt` (409 STALE), the
 * closing date (closingPassword through the request's lock context), and
 * 409 INVOICE_HAS_PAYMENTS while a live payment or credit is applied. Of
 * another company: 404; not an invoice: 400.
 */
export async function voidInvoice(
  tenantId: string, invoiceId: string, reason: string, userId?: string,
  opts: { expectedUpdatedAt?: string; companyId?: string } = {},
) {
  return ledger.voidTransaction(tenantId, invoiceId, reason, userId, { ...opts, expectType: 'invoice' });
}

/**
 * A copy of a billed cost's lines is a plain line with no claim (U-128 S4):
 * the client would be billed again for the same cost, so the copy carries
 * this warning.
 */
export function billableCopyWarnings(lines: ReadonlyArray<{ billableSourceLineId?: string | null }>) {
  const ids = [...new Set(lines.flatMap((l) => (l.billableSourceLineId ? [l.billableSourceLineId] : [])))];
  return ids.length === 0 ? [] : [{
    code: 'BILLABLE_COPIED_AS_PLAIN',
    message: 'Billable costs were copied as ordinary lines; the costs stay billed on the original invoice.',
    sourceLineIds: ids,
  }];
}

export async function duplicateInvoice(tenantId: string, invoiceId: string, userId?: string, companyId?: string) {
  return (await duplicateInvoiceWithWarnings(tenantId, invoiceId, userId, companyId)).invoice;
}

export async function duplicateInvoiceWithWarnings(tenantId: string, invoiceId: string, userId?: string, companyId?: string) {
  const original = await getInvoice(tenantId, invoiceId, companyId);
  const warnings = billableCopyWarnings(original.lines);

  const lines = original.lines.map((line) => ({
    accountId: line.accountId,
    debit: line.debit,
    credit: line.credit,
    description: line.description || undefined,
    itemId: line.itemId || undefined,
    quantity: line.quantity || undefined,
    unitPrice: line.unitPrice || undefined,
    isTaxable: line.isTaxable ?? false,
    taxRate: line.taxRate || undefined,
    taxAmount: line.taxAmount || undefined,
    serviceDate: line.serviceDate || undefined,
    discountPercent: line.discountPercent ?? null,
    // A billed cost's copy is a plain line: no lineRole, no billableSourceLineId (U-128 S4).
    unitPriceSource: line.unitPriceSource === 'billable_cost' ? 'input' : line.unitPriceSource ?? null,
  }));

  const invoice = await ledger.postTransaction(tenantId, {
    txnType: 'invoice',
    txnDate: new Date().toISOString().split('T')[0]!,
    contactId: original.contactId || undefined,
    memo: original.memo || undefined,
    paymentTerms: original.paymentTerms || undefined,
    subtotal: original.subtotal || undefined,
    taxAmount: original.taxAmount || undefined,
    total: original.total || undefined,
    balanceDue: original.total || undefined,
    amountPaid: '0',
    invoiceStatus: 'draft',
    lines,
  }, userId, companyId);
  // The copy prints with the original's layout (U-130).
  if (original.layoutId) {
    await db.update(transactions).set({ layoutId: original.layoutId })
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, invoice.id)));
    return { invoice: { ...invoice, layoutId: original.layoutId }, warnings };
  }
  return { invoice, warnings };
}
