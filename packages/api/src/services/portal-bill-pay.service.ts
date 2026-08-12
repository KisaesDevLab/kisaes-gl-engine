// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// PORTAL_BILL_PAY_V1 — portal contacts view unpaid bills and mark them
// for payment. Marking posts real bill_payment transactions through
// payBills() (method 'check', printLater) so the checks land UNNUMBERED
// in the firm's print queue; nothing negotiable exists until a staff
// user prints through the normal flow (login + signature step-up).
//
// Control gates, in order: tenant flag (router) → per-contact
// bill_pay_access → per-company configured bank account. Everything is
// company-scoped with the same NULL-company rule as portal-banking.

import { eq, and, sql, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  transactions,
  billPaymentApplications,
  contacts,
  companies,
  users,
  portalContacts,
  portalContactCompanies,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { log } from '../utils/logger.js';
import * as billService from './bill.service.js';
import { payBills } from './bill-payment.service.js';
import { getCompanySettings } from './portal-contact.service.js';
import { tenantHasSingleCompany } from './portal-banking.service.js';
import * as systemEmail from './system-email.service.js';

export interface PortalBillPayCtx {
  tenantId: string;
  contactId: string;
  companyId: string;
}

export interface PortalBill {
  id: string;
  vendorName: string | null;
  vendorInvoiceNumber: string | null;
  txnDate: string;
  dueDate: string | null;
  total: string | null;
  amountPaid: string | null;
  balanceDue: string | null;
  billStatus: string | null;
  daysOverdue: number;
}

export interface PortalQueuedPayment {
  paymentId: string;
  vendorName: string | null;
  amount: string | null;
  txnDate: string;
  bills: Array<{ vendorInvoiceNumber: string | null; amount: string }>;
}

// Same shape as assertBankingAccess but for the bill-pay boolean.
export async function assertBillPayAccess(
  tenantId: string,
  contactId: string,
  companyId: string,
): Promise<void> {
  const link = await db
    .select({ billPayAccess: portalContactCompanies.billPayAccess })
    .from(portalContactCompanies)
    .innerJoin(companies, eq(companies.id, portalContactCompanies.companyId))
    .where(
      and(
        eq(portalContactCompanies.contactId, contactId),
        eq(portalContactCompanies.companyId, companyId),
        eq(companies.tenantId, tenantId),
      ),
    )
    .limit(1);
  if (link.length === 0 || !link[0]?.billPayAccess) {
    throw AppError.forbidden('Bill payments are not enabled for your account', 'BILL_PAY_NOT_ENABLED');
  }
}

async function queuedPaymentsForCompany(
  tenantId: string,
  companyId: string,
  includeNullCompany: boolean,
): Promise<PortalQueuedPayment[]> {
  const companyCond = includeNullCompany
    ? sql`(t.company_id = ${companyId} OR t.company_id IS NULL)`
    : sql`t.company_id = ${companyId}`;
  const result = await db.execute(sql`
    SELECT t.id, t.txn_date, t.total, c.display_name AS vendor_name,
           bpa.amount AS app_amount, b.vendor_invoice_number
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id
    LEFT JOIN bill_payment_applications bpa ON bpa.payment_id = t.id
    LEFT JOIN transactions b ON b.id = bpa.bill_id
    WHERE t.tenant_id = ${tenantId}
      AND t.txn_type = 'bill_payment'
      AND t.status = 'posted'
      AND t.print_status = 'queue'
      AND ${companyCond}
    ORDER BY t.created_at DESC, t.id, bpa.id
  `);
  interface QueuedRow {
    id: string;
    txn_date: string;
    total: string | null;
    vendor_name: string | null;
    app_amount: string | null;
    vendor_invoice_number: string | null;
  }
  const byPayment = new Map<string, PortalQueuedPayment>();
  for (const row of result.rows as unknown as QueuedRow[]) {
    let entry = byPayment.get(row.id);
    if (!entry) {
      entry = {
        paymentId: row.id,
        vendorName: row.vendor_name ?? null,
        amount: row.total ?? null,
        txnDate: row.txn_date,
        bills: [],
      };
      byPayment.set(row.id, entry);
    }
    if (row.app_amount != null) {
      entry.bills.push({ vendorInvoiceNumber: row.vendor_invoice_number ?? null, amount: row.app_amount });
    }
  }
  return [...byPayment.values()];
}

export async function listBillsForPortal(ctx: PortalBillPayCtx): Promise<{
  configured: boolean;
  bills: PortalBill[];
  queuedPayments: PortalQueuedPayment[];
}> {
  await assertBillPayAccess(ctx.tenantId, ctx.contactId, ctx.companyId);
  const [settings, singleCompany] = await Promise.all([
    getCompanySettings(ctx.tenantId, ctx.companyId),
    tenantHasSingleCompany(ctx.tenantId),
  ]);

  const { bills } = await billService.getPayableBills(ctx.tenantId, {
    companyId: ctx.companyId,
    companyIncludesNull: singleCompany,
  });

  return {
    configured: settings.billPayBankAccountId !== null,
    bills: bills.map((b) => ({
      id: b.id,
      vendorName: b.contactName,
      vendorInvoiceNumber: b.vendorInvoiceNumber,
      txnDate: b.txnDate,
      dueDate: b.dueDate,
      total: b.total,
      amountPaid: b.amountPaid,
      balanceDue: b.balanceDue,
      billStatus: b.billStatus,
      daysOverdue: b.daysOverdue,
    })),
    queuedPayments: await queuedPaymentsForCompany(ctx.tenantId, ctx.companyId, singleCompany),
  };
}

export async function markBillsForPayment(
  ctx: PortalBillPayCtx,
  billIds: string[],
): Promise<{
  payments: Array<{ vendorName: string | null; amount: string; billCount: number }>;
  skipped: string[];
}> {
  await assertBillPayAccess(ctx.tenantId, ctx.contactId, ctx.companyId);

  const settings = await getCompanySettings(ctx.tenantId, ctx.companyId);
  if (!settings.billPayBankAccountId) {
    throw AppError.badRequest(
      'Bill payments are not configured for your company yet. Please contact your accounting firm.',
      'PORTAL_BILL_PAY_UNCONFIGURED',
    );
  }

  const singleCompany = await tenantHasSingleCompany(ctx.tenantId);
  const companyCond = singleCompany
    ? sql`(${transactions.companyId} = ${ctx.companyId} OR ${transactions.companyId} IS NULL)`
    : eq(transactions.companyId, ctx.companyId);

  // Load the requested bills WITHIN the company scope. Any id that
  // doesn't resolve here is a 404 — same response whether it belongs to
  // another company, another tenant, or doesn't exist at all.
  const uniqueIds = [...new Set(billIds)];
  const rows = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.tenantId, ctx.tenantId),
        eq(transactions.txnType, 'bill'),
        inArray(transactions.id, uniqueIds),
        companyCond,
      ),
    );
  if (rows.length !== uniqueIds.length) {
    throw AppError.notFound('One or more bills not found');
  }

  // Partition: still payable vs already handled (paid/voided/zeroed
  // since the client loaded the list). Skipped ids are reported back,
  // not errored — a second tap on a stale list is a no-op, not a 500.
  const payable = rows.filter(
    (b) =>
      b.status === 'posted' &&
      b.billStatus !== 'paid' &&
      parseFloat(b.balanceDue ?? '0') > 0,
  );
  const skipped = rows.filter((b) => !payable.includes(b)).map((b) => b.id);
  if (payable.length === 0) {
    return { payments: [], skipped };
  }

  const today = new Date().toISOString().split('T')[0]!;
  let result;
  try {
    result = await payBills(
      ctx.tenantId,
      {
        bankAccountId: settings.billPayBankAccountId,
        txnDate: today,
        method: 'check',
        printLater: true,
        memo: 'Requested via client portal',
        bills: payable.map((b) => ({ billId: b.id, amount: b.balanceDue! })),
      },
      undefined,
      ctx.companyId,
      { source: 'client_portal', sourceId: ctx.contactId },
    );
  } catch (err) {
    // payBills re-validates under FOR UPDATE; a lost race against a
    // concurrent payment surfaces as its badRequest. Map to 409 so the
    // portal shows "refresh and try again" instead of a generic error.
    if (err instanceof AppError && err.statusCode === 400 && /already fully paid|exceeds balance due/i.test(err.message)) {
      throw AppError.conflict(
        'One or more bills were just paid by someone else. Refresh and try again.',
        'BILLS_JUST_PAID',
      );
    }
    throw err;
  }

  const paymentIds = result.payments.map((p) => p.id);
  const contact = await db.query.portalContacts.findFirst({
    where: eq(portalContacts.id, ctx.contactId),
  });
  await auditLog(ctx.tenantId, 'create', 'portal_payment_request', paymentIds[0] ?? null, null, {
    contactId: ctx.contactId,
    contactEmail: contact?.email ?? null,
    companyId: ctx.companyId,
    billIds: payable.map((b) => b.id),
    paymentIds,
    total: result.payments.reduce((s, p) => s + parseFloat(p.netPayment), 0).toFixed(2),
  });

  // Vendor names for the response + email.
  const vendorIds = [...new Set(result.payments.map((p) => p.contactId).filter((v): v is string => !!v))];
  const vendorRows = vendorIds.length
    ? await db.select({ id: contacts.id, name: contacts.displayName }).from(contacts).where(inArray(contacts.id, vendorIds))
    : [];
  const vendorName = (id: string | null) => vendorRows.find((v) => v.id === id)?.name ?? null;

  const payments = result.payments.map((p) => ({
    vendorName: vendorName(p.contactId),
    amount: p.netPayment,
    billCount: p.billsPaid,
  }));

  // Fire-and-forget: notification failure must never fail the payment.
  void notifyChecksQueued({
    tenantId: ctx.tenantId,
    companyId: ctx.companyId,
    contactName:
      [contact?.firstName, contact?.lastName].filter(Boolean).join(' ') || contact?.email || 'A portal user',
    contactEmail: contact?.email ?? '',
    notifyUserId: settings.billPayNotifyUserId,
    payments,
  }).catch((err) => {
    log.warn({
      component: 'portal-bill-pay',
      event: 'notify_failed',
      err: err instanceof Error ? err.message : String(err),
      tenantId: ctx.tenantId,
      companyId: ctx.companyId,
    });
  });

  return { payments, skipped };
}

async function notifyChecksQueued(params: {
  tenantId: string;
  companyId: string;
  contactName: string;
  contactEmail: string;
  notifyUserId: string | null;
  payments: Array<{ vendorName: string | null; amount: string; billCount: number }>;
}): Promise<void> {
  // Recipient: the per-company selected staff user, if still active in
  // this tenant; otherwise every active owner (capped, best-effort).
  let recipients: string[] = [];
  if (params.notifyUserId) {
    const u = await db.query.users.findFirst({
      where: and(eq(users.id, params.notifyUserId), eq(users.tenantId, params.tenantId)),
    });
    if (u && u.isActive) recipients = [u.email];
  }
  if (recipients.length === 0) {
    const owners = await db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.tenantId, params.tenantId), eq(users.role, 'owner'), eq(users.isActive, true)));
    recipients = owners.slice(0, 5).map((o) => o.email);
  }
  if (recipients.length === 0) return;

  const company = await db.query.companies.findFirst({
    where: eq(companies.id, params.companyId),
  });
  const companyName = company?.businessName ?? 'a client company';

  const money = (v: string) => `$${parseFloat(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const total = params.payments.reduce((s, p) => s + parseFloat(p.amount), 0);
  const lines = params.payments
    .map((p) => `${p.vendorName ?? 'Vendor'} — ${money(p.amount)}${p.billCount > 1 ? ` (${p.billCount} bills)` : ''}`)
    .join('\n');
  const bodyText =
    `${params.contactName}${params.contactEmail ? ` (${params.contactEmail})` : ''} marked ` +
    `${params.payments.reduce((s, p) => s + p.billCount, 0)} bill(s) for payment in the client portal for ${companyName}.\n\n` +
    `${lines}\n\n` +
    `Total: ${money(total.toFixed(2))}. The checks are queued and unnumbered until you print them.`;

  const baseUrl = process.env['CORS_ORIGIN'] || 'http://localhost:5173';
  const results = await Promise.allSettled(
    recipients.map((to) =>
      systemEmail.sendActionEmail({
        to,
        subject: `Checks ready to print — ${companyName}`,
        bodyText,
        cta: { label: 'Open print queue', url: `${baseUrl}/checks/print` },
      }),
    ),
  );
  for (const r of results) {
    if (r.status === 'rejected') {
      log.warn({
        component: 'portal-bill-pay',
        event: 'notify_email_failed',
        err: r.reason instanceof Error ? r.reason.message : String(r.reason),
        tenantId: params.tenantId,
      });
    }
  }
}
