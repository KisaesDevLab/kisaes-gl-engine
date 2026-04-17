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
  if (isNaN(amount) || amount < 0.50) throw AppError.badRequest('Minimum payment is $0.50');
  if (amount > balanceDue + 0.01) throw AppError.badRequest(`Amount exceeds balance due ($${balanceDue.toFixed(2)})`);

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

  // Check if this specific PI was already processed (idempotency for partial + retries)
  const { sql } = await import('drizzle-orm');
  const [existingPayment] = await db.select({ id: transactions.id }).from(transactions)
    .where(and(
      eq(transactions.tenantId, tenantId),
      eq(transactions.txnType, 'customer_payment'),
      sql`${transactions.memo} LIKE ${'%' + paymentIntentId + '%'}`,
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
    }
    // Future: handle payment_intent.payment_failed, charge.refunded, etc.

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
