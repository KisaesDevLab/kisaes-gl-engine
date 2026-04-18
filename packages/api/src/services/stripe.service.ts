// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import Stripe from 'stripe';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { transactions, companies, stripeWebhookLog } from '../db/schema/index.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as paymentService from './payment.service.js';
import * as emailService from './email.service.js';

// ── Stripe Client ──

function getStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey);
}

// ── Configure Stripe ──

export async function configureStripe(
  tenantId: string,
  companyId: string,
  input: { secretKey: string; publishableKey: string; webhookSecret: string },
) {
  await db.update(companies)
    .set({
      stripeSecretKeyEncrypted: encrypt(input.secretKey),
      stripePublishableKey: input.publishableKey,
      stripeWebhookSecretEncrypted: encrypt(input.webhookSecret),
      onlinePaymentsEnabled: true,
      updatedAt: new Date(),
    })
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));

  await auditLog(tenantId, 'update', 'stripe_config', companyId, null, { action: 'configure' });
}

// ── Get Stripe Config (safe for frontend) ──

export async function getStripeConfig(tenantId: string, companyId?: string) {
  const { sql } = await import('drizzle-orm');
  const condition = companyId
    ? and(eq(companies.tenantId, tenantId), eq(companies.id, companyId))
    : eq(companies.tenantId, tenantId);

  // Never SELECT the encrypted secret key — only check if it's non-null
  const [company] = await db.select({
    stripePublishableKey: companies.stripePublishableKey,
    onlinePaymentsEnabled: companies.onlinePaymentsEnabled,
    hasSecretKey: sql<boolean>`${companies.stripeSecretKeyEncrypted} IS NOT NULL`.as('has_secret_key'),
  }).from(companies)
    .where(condition)
    .limit(1);

  return {
    configured: !!(company?.hasSecretKey && company?.stripePublishableKey),
    publishableKey: company?.stripePublishableKey || null,
    onlinePaymentsEnabled: company?.onlinePaymentsEnabled ?? false,
  };
}

// ── Remove Stripe Config ──

export async function removeStripeConfig(tenantId: string, companyId: string) {
  await db.update(companies)
    .set({
      stripeSecretKeyEncrypted: null,
      stripePublishableKey: null,
      stripeWebhookSecretEncrypted: null,
      onlinePaymentsEnabled: false,
      updatedAt: new Date(),
    })
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));

  await auditLog(tenantId, 'update', 'stripe_config', companyId, null, { action: 'remove' });
}

// ── Create Payment Intent ──

export async function createPaymentIntent(token: string, amountStr: string) {
  // Look up invoice by public token
  const [invoice] = await db.select().from(transactions)
    .where(eq(transactions.publicToken, token))
    .limit(1);

  if (!invoice) throw AppError.notFound('Invoice not found');
  if (invoice.invoiceStatus === 'void') throw AppError.badRequest('This invoice has been voided');
  if (invoice.invoiceStatus === 'paid') throw AppError.badRequest('This invoice is already paid');

  const balanceDue = parseFloat(invoice.balanceDue || invoice.total || '0');
  if (balanceDue <= 0) throw AppError.badRequest('No balance due on this invoice');

  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) throw AppError.badRequest('Amount must be greater than zero');

  // Get company Stripe config — use companyId from invoice if set
  const companyCondition = invoice.companyId
    ? and(eq(companies.tenantId, invoice.tenantId), eq(companies.id, invoice.companyId))
    : eq(companies.tenantId, invoice.tenantId);
  const [company] = await db.select({
    id: companies.id,
    stripeSecretKeyEncrypted: companies.stripeSecretKeyEncrypted,
    onlinePaymentsEnabled: companies.onlinePaymentsEnabled,
    currency: companies.currency,
  }).from(companies)
    .where(companyCondition)
    .limit(1);

  if (!company?.stripeSecretKeyEncrypted || !company.onlinePaymentsEnabled) {
    throw AppError.badRequest('Online payments are not enabled for this company');
  }

  // Stripe's per-currency minimum. USD/EUR are $0.50, GBP is £0.30, JPY is
  // ¥50, HKD is $4.00, etc. Previously hardcoded at $0.50, which then let
  // a JPY charge under the Stripe minimum slip past our validation and
  // fail with a confusing "amount_too_small" from Stripe. Computed after
  // the company lookup so we can use company.currency.
  const currencyCode = (company.currency || 'USD').toUpperCase();
  const minByCurrency: Record<string, number> = {
    USD: 0.50, EUR: 0.50, GBP: 0.30, AUD: 0.50, CAD: 0.50, CHF: 0.50,
    DKK: 2.50, JPY: 50, HKD: 4.00, MXN: 10, NOK: 3.00, NZD: 0.50,
    PLN: 2.00, SEK: 3.00, SGD: 0.50,
  };
  const minAmount = minByCurrency[currencyCode] ?? 0.50;
  if (amount < minAmount) {
    throw AppError.badRequest(`Minimum payment is ${minAmount} ${currencyCode}`);
  }
  if (amount > balanceDue + 0.01) throw AppError.badRequest(`Amount exceeds balance due (${balanceDue.toFixed(2)} ${currencyCode})`);

  const secretKey = decrypt(company.stripeSecretKeyEncrypted);
  const stripe = getStripeClient(secretKey);

  // PI creation abuse is mitigated by the 30 req/min/IP rate limit on the public route.
  // Uncaptured PIs expire automatically on Stripe's side after ~24 hours.

  // Create PaymentIntent (amount in cents)
  const amountCents = Math.round(amount * 100);
  const currency = (company.currency || 'USD').toLowerCase();

  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency,
    metadata: {
      invoiceId: invoice.id,
      tenantId: invoice.tenantId,
      companyId: company.id,
      publicToken: token,
      txnNumber: invoice.txnNumber || '',
    },
    description: `Invoice ${invoice.txnNumber || invoice.id.slice(0, 8)}`,
  });

  // Note: We do NOT store the PI on the invoice row because partial payments
  // can create multiple PIs for the same invoice. The invoiceId is in the PI
  // metadata, which the webhook handler reads to find the invoice.

  return {
    clientSecret: paymentIntent.client_secret!,
    paymentIntentId: paymentIntent.id,
  };
}

// ── Handle Payment Success (called from webhook) ──

export async function handlePaymentSuccess(paymentIntentId: string, piMetadata?: Record<string, string>) {
  // Look up the invoice from PI metadata (stored when we created the PI)
  const invoiceId = piMetadata?.['invoiceId'];
  const tenantId = piMetadata?.['tenantId'];

  if (!invoiceId || !tenantId) {
    console.warn(`[Stripe] PaymentIntent ${paymentIntentId} missing invoiceId/tenantId in metadata`);
    return;
  }

  const [invoice] = await db.select().from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, invoiceId)))
    .limit(1);

  if (!invoice) {
    console.warn(`[Stripe] Invoice ${invoiceId} not found for tenant ${tenantId}`);
    return;
  }

  // Skip if already paid (idempotency for full payment)
  if (invoice.invoiceStatus === 'paid') return;

  // Check if this specific PI was already processed. Previously this used
  // a memo LIKE — brittle because the memo field is editable by the
  // bookkeeper, and an edited memo would let the same PI post twice. Now
  // we use the dedicated stripePaymentIntentId column, which no user-
  // facing path lets anyone change.
  const [existingPayment] = await db.select({ id: transactions.id }).from(transactions)
    .where(and(
      eq(transactions.tenantId, tenantId),
      eq(transactions.txnType, 'customer_payment'),
      eq(transactions.stripePaymentIntentId, paymentIntentId),
    ))
    .limit(1);
  if (existingPayment) return; // This PI's payment was already recorded

  // Get the Payments Clearing account
  const { accounts } = await import('../db/schema/index.js');
  const clearingAccount = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'payments_clearing')),
  });

  if (!clearingAccount) {
    console.error(`[Stripe] No payments_clearing account for tenant ${tenantId}`);
    return;
  }

  // Get the PaymentIntent to know the exact amount
  const companyLookup = invoice.companyId
    ? and(eq(companies.tenantId, tenantId), eq(companies.id, invoice.companyId))
    : eq(companies.tenantId, tenantId);
  const [company] = await db.select({
    stripeSecretKeyEncrypted: companies.stripeSecretKeyEncrypted,
  }).from(companies)
    .where(companyLookup)
    .limit(1);

  if (!company?.stripeSecretKeyEncrypted) return;

  const stripe = getStripeClient(decrypt(company.stripeSecretKeyEncrypted));
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  const amountDollars = (pi.amount / 100).toFixed(2);

  // Use the existing receivePayment() for atomic ledger posting
  const paymentResult = await paymentService.receivePayment(
    tenantId,
    {
      customerId: invoice.contactId || '',
      date: new Date().toISOString().split('T')[0]!,
      amount: amountDollars,
      depositTo: clearingAccount.id,
      paymentMethod: 'credit_card',
      refNo: paymentIntentId,
      memo: `Online payment via Stripe (${paymentIntentId})`,
      applications: [{ invoiceId: invoice.id, amount: amountDollars }],
    },
    undefined, // no userId for webhook-initiated payments
    invoice.companyId || undefined,
  );

  // Stamp stripePaymentIntentId on the payment row. This is the stable,
  // non-user-editable column the idempotency check above keys on. Previously
  // idempotency relied on the memo field, which a bookkeeper could edit to
  // remove the PI id — a future retry then slipped through the check and
  // double-posted.
  if (paymentResult?.id) {
    await db.update(transactions)
      .set({ stripePaymentIntentId: paymentIntentId, updatedAt: new Date() })
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, paymentResult.id)));
  }

  // Send confirmation email (best effort — don't fail the webhook if email fails)
  try {
    if (paymentResult?.id) {
      await emailService.sendPaymentConfirmation(tenantId, paymentResult.id);
    }
  } catch (err) {
    console.warn('[Stripe] Failed to send payment confirmation email:', err);
  }

  await auditLog(tenantId, 'create', 'online_payment', invoice.id, null,
    { paymentIntentId, amount: amountDollars, source: 'stripe_webhook' });
}

// ── Handle Charge Refunded ──
//
// Stripe fires `charge.refunded` on partial and full refunds. We post a
// reversing customer_refund transaction for the refunded portion so the
// ledger stays in sync with Stripe / the bank. Idempotent against multiple
// deliveries via the webhook-log eventId uniqueness + a memo LIKE check.

async function handleChargeRefunded(charge: Stripe.Charge, tenantId: string) {
  const piId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
  if (!piId) {
    console.warn(`[Stripe] charge.refunded ${charge.id} has no payment_intent`);
    return;
  }

  // Find the payment transaction this refund relates to. The payment row
  // records the PI id on both memo and stripePaymentIntentId (if present).
  const { sql } = await import('drizzle-orm');
  const [payment] = await db.select().from(transactions)
    .where(and(
      eq(transactions.tenantId, tenantId),
      eq(transactions.txnType, 'customer_payment'),
      sql`(${transactions.stripePaymentIntentId} = ${piId} OR ${transactions.memo} LIKE ${'%' + piId + '%'})`,
    ))
    .limit(1);
  if (!payment) {
    console.warn(`[Stripe] charge.refunded ${charge.id}: no matching payment for PI ${piId}`);
    return;
  }

  // Idempotency: skip if we already have a refund row for this charge.
  const refundMarker = `stripe-refund:${charge.id}`;
  const [existing] = await db.select({ id: transactions.id }).from(transactions)
    .where(and(
      eq(transactions.tenantId, tenantId),
      eq(transactions.txnType, 'customer_refund'),
      sql`${transactions.memo} LIKE ${'%' + refundMarker + '%'}`,
    ))
    .limit(1);
  if (existing) return;

  const refundedAmount = (charge.amount_refunded / 100).toFixed(2);
  const priorRefunds = (await db.select({ total: transactions.total }).from(transactions)
    .where(and(
      eq(transactions.tenantId, tenantId),
      eq(transactions.txnType, 'customer_refund'),
      sql`${transactions.memo} LIKE ${'%stripe-refund:%'}`,
      sql`${transactions.appliedToInvoiceId} = ${payment.appliedToInvoiceId || ''}`,
    )))
    .reduce((s, r) => s + parseFloat(r.total || '0'), 0);
  const newRefundAmount = (parseFloat(refundedAmount) - priorRefunds).toFixed(2);
  if (parseFloat(newRefundAmount) <= 0) return;

  // Reverse into Payments Clearing: credit the clearing account (reducing
  // the funds sitting there) and debit a customer-refund account or AR.
  // Implementation uses the same clearing account the original payment
  // posted to, routed through paymentService.recordRefund so the ledger
  // side is atomic.
  const { accounts } = await import('../db/schema/index.js');
  const clearing = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'payments_clearing')),
  });
  if (!clearing) {
    console.error(`[Stripe] charge.refunded: no payments_clearing account for tenant ${tenantId}`);
    return;
  }
  const ar = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'accounts_receivable')),
  });
  if (!ar) {
    console.error(`[Stripe] charge.refunded: no AR account for tenant ${tenantId}`);
    return;
  }

  const ledger = await import('./ledger.service.js');
  const date = new Date().toISOString().split('T')[0]!;
  await ledger.postTransaction(tenantId, {
    txnType: 'customer_refund',
    txnDate: date,
    contactId: payment.contactId || undefined,
    memo: `Stripe refund for ${piId} (${refundMarker})`,
    total: newRefundAmount,
    appliedToInvoiceId: payment.appliedToInvoiceId || undefined,
    lines: [
      { accountId: ar.id, debit: newRefundAmount, credit: '0' },
      { accountId: clearing.id, debit: '0', credit: newRefundAmount },
    ],
  }, undefined, payment.companyId || undefined);

  // If the refund brings the invoice's balance-due up from zero, also
  // flip invoiceStatus back to 'partial' or 'sent' so the bookkeeper sees
  // the outstanding amount. Best-effort: only runs when we can identify
  // the linked invoice.
  if (payment.appliedToInvoiceId) {
    const [invoice] = await db.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, payment.appliedToInvoiceId)))
      .limit(1);
    if (invoice && invoice.invoiceStatus === 'paid') {
      await db.update(transactions).set({
        invoiceStatus: parseFloat(newRefundAmount) >= parseFloat(invoice.total || '0') ? 'sent' : 'partial',
        paidAt: null,
        updatedAt: new Date(),
      }).where(eq(transactions.id, invoice.id));
    }
  }

  await auditLog(tenantId, 'create', 'stripe_refund', payment.id, null,
    { paymentIntentId: piId, chargeId: charge.id, amount: newRefundAmount });
}

// ── Handle Webhook Event ──

export async function handleWebhookEvent(
  rawBody: Buffer,
  signature: string,
  companyId: string,
) {
  // Look up the company's webhook secret
  const [company] = await db.select({
    tenantId: companies.tenantId,
    stripeWebhookSecretEncrypted: companies.stripeWebhookSecretEncrypted,
    stripeSecretKeyEncrypted: companies.stripeSecretKeyEncrypted,
  }).from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  if (!company?.stripeWebhookSecretEncrypted || !company?.stripeSecretKeyEncrypted) {
    throw AppError.badRequest('Stripe not configured for this company');
  }

  const webhookSecret = decrypt(company.stripeWebhookSecretEncrypted);
  const stripe = getStripeClient(decrypt(company.stripeSecretKeyEncrypted));

  // Verify signature
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err: any) {
    throw AppError.badRequest(`Webhook signature verification failed: ${err.message}`);
  }

  // Idempotency: skip if already processed. eventId has a UNIQUE constraint
  // at the DB level (schema: stripe_webhook_log.event_id unique), so the
  // INSERT itself is the atomic barrier — two concurrent deliveries cannot
  // both claim the row. The pre-check keeps the hot path fast; if two
  // workers race past it the second INSERT will fail with 23505 and we
  // treat that as "already processed" rather than letting the error escape.
  const [existing] = await db.select({ id: stripeWebhookLog.id })
    .from(stripeWebhookLog)
    .where(eq(stripeWebhookLog.eventId, event.id))
    .limit(1);

  if (existing) return; // Already processed

  try {
    await db.insert(stripeWebhookLog).values({
      tenantId: company.tenantId,
      eventId: event.id,
      eventType: event.type,
      paymentIntentId: (event.data.object as any)?.id || null,
      payload: event.data.object as any,
      processed: false,
    });
  } catch (err: any) {
    if (err?.code === '23505' || /unique/i.test(err?.message || '')) {
      return; // another delivery beat us to it
    }
    throw err;
  }

  // Dispatch by event type
  try {
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object as Stripe.PaymentIntent;
      await handlePaymentSuccess(pi.id, pi.metadata as Record<string, string>);
    } else if (event.type === 'charge.refunded') {
      const charge = event.data.object as Stripe.Charge;
      await handleChargeRefunded(charge, company.tenantId);
    } else if (event.type === 'payment_intent.payment_failed') {
      // Record the failure in the audit log so the bookkeeper can see why
      // the payment never completed. No ledger effect — the successful PI
      // path is the only one that creates a payment transaction.
      const pi = event.data.object as Stripe.PaymentIntent;
      const invoiceId = pi.metadata?.['invoiceId'];
      await auditLog(
        company.tenantId,
        'update',
        'online_payment_failed',
        invoiceId || null,
        null,
        {
          paymentIntentId: pi.id,
          amount: pi.amount,
          currency: pi.currency,
          reason: pi.last_payment_error?.message ?? null,
          code: pi.last_payment_error?.code ?? null,
        },
      );
    }

    // Mark as processed
    await db.update(stripeWebhookLog)
      .set({ processed: true, processedAt: new Date() })
      .where(eq(stripeWebhookLog.eventId, event.id));
  } catch (err: any) {
    // Log error but still return 200 to Stripe to avoid retries on application errors
    await db.update(stripeWebhookLog)
      .set({ processed: true, processedAt: new Date(), error: err.message })
      .where(eq(stripeWebhookLog.eventId, event.id));
    console.error(`[Stripe Webhook] Error processing ${event.type}:`, err);
  }
}
