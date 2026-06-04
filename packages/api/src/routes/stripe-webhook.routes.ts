// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import express from 'express';
import * as stripeService from '../services/stripe.service.js';
import { stripeIpAllowlist } from '../utils/stripe-ip-allowlist.js';
import { AppError } from '../utils/errors.js';
import { log } from '../utils/logger.js';

export const stripeWebhookRouter = Router();

// Optional Stripe IP allowlist — see CLOUDFLARE_TUNNEL_PLAN Phase 7.
// Default off; enable with STRIPE_WEBHOOK_IP_ALLOWLIST_ENFORCED=1. The
// middleware no-ops when disabled so the existing signature-verify
// path remains the authoritative check either way.
stripeWebhookRouter.use(stripeIpAllowlist());

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function dispatch(rawBody: Buffer, signature: string, companyId: string, res: express.Response) {
  try {
    await stripeService.handleWebhookEvent(rawBody, signature, companyId);
    res.status(200).json({ received: true });
  } catch (err: unknown) {
    // Distinguish EXPECTED, terminal outcomes from UNEXPECTED, transient ones.
    // Expected = an AppError with a 4xx status (bad signature, company not
    // configured, malformed event): retrying won't change the result and a
    // non-2xx would just make Stripe hammer us, so ack with 200 — but LOG it
    // so a misconfigured webhook secret is observable rather than invisible.
    // Unexpected = anything else (DB outage, decrypt failure, downstream
    // throw): returning 200 here would drop a real event forever, so return
    // 5xx and let Stripe's retry pick it up once we recover.
    const expected = err instanceof AppError && err.statusCode >= 400 && err.statusCode < 500;
    const message = err instanceof Error ? err.message : String(err);
    if (expected) {
      log.warn({
        component: 'stripe-webhook',
        event: 'event_rejected',
        companyId,
        code: (err as AppError).code,
        status: (err as AppError).statusCode,
      });
      res.status(200).json({ received: true });
      return;
    }
    log.error({ component: 'stripe-webhook', event: 'handler_failed', companyId, message });
    res.status(500).json({ error: { message: 'Webhook processing failed' } });
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
