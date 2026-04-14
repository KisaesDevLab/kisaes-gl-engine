import { Router } from 'express';
import express from 'express';
import * as stripeService from '../services/stripe.service.js';

export const stripeWebhookRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function dispatch(rawBody: Buffer, signature: string, companyId: string, res: express.Response) {
  try {
    await stripeService.handleWebhookEvent(rawBody, signature, companyId);
    res.status(200).json({ received: true });
  } catch (err: any) {
    // Stripe retries on non-2xx, which we don't want for application-level
    // errors. Log internally; return 200. Signature failures end up here too.
    console.error('[Stripe Webhook] Error:', err.message);
    res.status(200).json({ received: true });
  }
}

// Preferred route: companyId comes from the URL path, so we never parse the
// untrusted request body to decide which webhook secret to verify against.
// New integrations should configure Stripe to POST here.
stripeWebhookRouter.post('/webhook/:companyId',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['stripe-signature'] as string;
    if (!signature) {
      res.status(400).json({ error: { message: 'Missing Stripe-Signature header' } });
      return;
    }
    const companyId = req.params.companyId;
    if (!UUID_RE.test(companyId)) {
      res.status(200).json({ received: true });
      return;
    }
    await dispatch(req.body as Buffer, signature, companyId, res);
  },
);

// Legacy route: existing installations configured Stripe to POST /webhook
// (no path parameter), so we read companyId from event metadata. The
// signature is still verified with the corresponding company's secret
// before any side effect, so a forged metadata.companyId without that
// company's webhook secret fails verification. Kept for backwards
// compatibility; prefer the path-scoped route above for new setups.
stripeWebhookRouter.post('/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['stripe-signature'] as string;
    if (!signature) {
      res.status(400).json({ error: { message: 'Missing Stripe-Signature header' } });
      return;
    }

    let companyId: string | undefined;
    try {
      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : String(req.body);
      const body = JSON.parse(rawBody);
      companyId = body?.data?.object?.metadata?.companyId;
    } catch {
      // Malformed JSON — return 200 so we don't leak parse success/failure
      // as a probe signal and so Stripe doesn't retry on our behalf.
      res.status(200).json({ received: true });
      return;
    }

    if (!companyId || !UUID_RE.test(companyId)) {
      res.status(200).json({ received: true });
      return;
    }

    await dispatch(req.body as Buffer, signature, companyId, res);
  },
);
