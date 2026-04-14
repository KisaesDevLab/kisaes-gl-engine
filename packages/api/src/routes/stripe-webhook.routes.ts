import { Router } from 'express';
import express from 'express';
import * as stripeService from '../services/stripe.service.js';

export const stripeWebhookRouter = Router();

// Stripe requires raw body for signature verification — use express.raw()
stripeWebhookRouter.post('/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['stripe-signature'] as string;
    if (!signature) {
      res.status(400).json({ error: { message: 'Missing Stripe-Signature header' } });
      return;
    }

    // Extract companyId from the request.
    // The PaymentIntent metadata includes companyId — but we can't read the event body
    // before verifying the signature. Instead, we try parsing the raw body to get metadata,
    // then verify with the corresponding company's webhook secret.
    let companyId: string | undefined;
    try {
      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : String(req.body);
      const body = JSON.parse(rawBody);
      companyId = body?.data?.object?.metadata?.companyId;
    } catch {
      res.status(400).json({ error: { message: 'Invalid JSON body' } });
      return;
    }

    if (!companyId) {
      // If no companyId in metadata, we can't route the webhook.
      // Return 200 to prevent Stripe retries — log for debugging.
      console.warn('[Stripe Webhook] No companyId in event metadata');
      res.status(200).json({ received: true });
      return;
    }

    // Validate companyId is a UUID to prevent injection
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) {
      res.status(200).json({ received: true }); // Don't reveal validation details
      return;
    }

    try {
      await stripeService.handleWebhookEvent(req.body, signature, companyId);
      res.status(200).json({ received: true });
    } catch (err: any) {
      // Always return 200 to external callers — never reveal internal error details.
      // Stripe interprets non-2xx as failure and will retry, which we don't want
      // for application errors. Signature failures are logged but not surfaced.
      console.error('[Stripe Webhook] Error:', err.message);
      res.status(200).json({ received: true });
    }
  },
);
