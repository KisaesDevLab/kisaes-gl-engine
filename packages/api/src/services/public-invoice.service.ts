import * as crypto from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { transactions, companies, contacts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

// ── Types ──

export interface PublicInvoiceData {
  _tenantId?: string; // Internal use only — stripped before sending to client
  invoiceId: string;
  txnNumber: string | null;
  txnDate: string;
  dueDate: string | null;
  invoiceStatus: string | null;
  memo: string | null;
  paymentTerms: string | null;
  subtotal: string | null;
  taxAmount: string | null;
  total: string | null;
  amountPaid: string | null;
  balanceDue: string | null;
  // Company branding
  companyName: string;
  companyAddress: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  };
  companyPhone: string | null;
  companyEmail: string | null;
  companyLogoUrl: string | null;
  // Customer
  customerName: string | null;
  customerEmail: string | null;
  // Stripe
  stripePublishableKey: string | null;
  onlinePaymentsEnabled: boolean;
  // Line items (loaded separately via journal_lines)
  lines: Array<{
    description: string | null;
    quantity: string | null;
    unitPrice: string | null;
    amount: string | null;
  }>;
}

// ── Helpers ──

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***@***';
  const masked = local.length <= 2
    ? local[0] + '***'
    : local[0] + '***' + local[local.length - 1];
  return `${masked}@${domain}`;
}

// ── Generate Public Token ──

export async function generatePublicToken(tenantId: string, invoiceId: string): Promise<string> {
  const [invoice] = await db.select({
    id: transactions.id,
    publicToken: transactions.publicToken,
    txnType: transactions.txnType,
    tenantId: transactions.tenantId,
  }).from(transactions)
    .where(and(
      eq(transactions.tenantId, tenantId),
      eq(transactions.id, invoiceId),
    ))
    .limit(1);

  if (!invoice) throw AppError.notFound('Invoice not found');
  if (invoice.txnType !== 'invoice') throw AppError.badRequest('Only invoices can have public tokens');

  // Idempotent: return existing token if already set
  if (invoice.publicToken) return invoice.publicToken;

  // 20 bytes → 27-char base64url token (160-bit entropy). This token is a
  // bearer credential — anyone with it can view the invoice and pay online —
  // so it must be well past the range where online brute force is feasible
  // even with slack rate limits.
  const token = crypto.randomBytes(20).toString('base64url');

  await db.update(transactions)
    .set({ publicToken: token, updatedAt: new Date() })
    .where(eq(transactions.id, invoiceId));

  return token;
}

// ── Get Invoice by Public Token ──

export async function getInvoiceByToken(token: string): Promise<PublicInvoiceData> {
  if (!token || token.length < 10 || token.length > 64) throw AppError.notFound('Invoice not found');

  const [invoice] = await db.select().from(transactions)
    .where(eq(transactions.publicToken, token))
    .limit(1);

  if (!invoice) throw AppError.notFound('Invoice not found');
  if (invoice.txnType !== 'invoice') throw AppError.notFound('Invoice not found');

  // Get company — use companyId from invoice if set, fall back to tenantId
  const companyCondition = invoice.companyId
    ? and(eq(companies.tenantId, invoice.tenantId), eq(companies.id, invoice.companyId))
    : eq(companies.tenantId, invoice.tenantId);
  const [company] = await db.select().from(companies)
    .where(companyCondition)
    .limit(1);

  if (!company) throw AppError.notFound('Invoice not found');

  // Get customer
  let customerName: string | null = null;
  let customerEmail: string | null = null;
  if (invoice.contactId) {
    const [contact] = await db.select({
      displayName: contacts.displayName,
      email: contacts.email,
    }).from(contacts)
      .where(and(
        eq(contacts.tenantId, invoice.tenantId),
        eq(contacts.id, invoice.contactId),
      ))
      .limit(1);
    if (contact) {
      customerName = contact.displayName;
      customerEmail = contact.email;
    }
  }

  // Get line items from journal_lines
  const { journalLines } = await import('../db/schema/index.js');
  const lines = await db.select({
    description: journalLines.description,
    quantity: journalLines.quantity,
    unitPrice: journalLines.unitPrice,
    debit: journalLines.debit,
    credit: journalLines.credit,
  }).from(journalLines)
    .where(eq(journalLines.transactionId, invoice.id))
    .orderBy(journalLines.lineOrder);

  // Display lines: show lines with descriptions (these are the customer-visible line items)
  // Invoice revenue lines are credits to revenue accounts; the debit is to AR (hidden from customer)
  const displayLines = lines
    .filter(l => l.description && l.description.trim())
    .filter(l => parseFloat(l.credit || '0') > 0 || (l.quantity && l.unitPrice)) // Revenue/item lines
    .map(l => {
      const amount = l.quantity && l.unitPrice
        ? (parseFloat(l.quantity) * parseFloat(l.unitPrice)).toFixed(2)
        : parseFloat(l.credit || '0') > 0 ? l.credit : l.debit;
      return {
        description: l.description,
        quantity: l.quantity ? String(l.quantity) : null,
        unitPrice: l.unitPrice ? String(l.unitPrice) : null,
        amount: amount ? String(amount) : null,
      };
    });

  // Mask customer email for public display — show "j***@example.com" not full address
  const maskedEmail = customerEmail ? maskEmail(customerEmail) : null;

  return {
    _tenantId: invoice.tenantId, // Internal use only (PDF generation) — NOT exposed to public API response
    invoiceId: invoice.id,
    txnNumber: invoice.txnNumber,
    txnDate: invoice.txnDate,
    dueDate: invoice.dueDate,
    invoiceStatus: invoice.invoiceStatus,
    memo: invoice.memo,
    paymentTerms: invoice.paymentTerms,
    subtotal: invoice.subtotal,
    taxAmount: invoice.taxAmount,
    total: invoice.total,
    amountPaid: invoice.amountPaid,
    balanceDue: invoice.balanceDue,
    companyName: company.businessName,
    companyAddress: {
      line1: company.addressLine1,
      line2: company.addressLine2,
      city: company.city,
      state: company.state,
      zip: company.zip,
    },
    companyPhone: company.phone,
    companyEmail: company.email,
    companyLogoUrl: company.logoUrl,
    customerName,
    customerEmail: maskedEmail,
    stripePublishableKey: company.onlinePaymentsEnabled ? company.stripePublishableKey : null,
    onlinePaymentsEnabled: company.onlinePaymentsEnabled ?? false,
    lines: displayLines,
  };
}

// ── Mark Viewed ──

export async function markViewed(token: string): Promise<void> {
  if (!token || token.length < 10 || token.length > 64) return;

  const { sql, isNull } = await import('drizzle-orm');

  // Idempotent: only update if viewedAt is NULL (first view)
  await db.update(transactions)
    .set({
      viewedAt: new Date(),
      // Only transition to 'viewed' if currently 'sent' — don't regress partial/paid
      invoiceStatus: sql`CASE WHEN ${transactions.invoiceStatus} = 'sent' THEN 'viewed' ELSE ${transactions.invoiceStatus} END`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(transactions.publicToken, token),
      isNull(transactions.viewedAt),
    ));
}
