// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';

// Regression: dispatch() returned 200 for EVERY error, so a transient
// internal failure (DB outage, decrypt error) was acked to Stripe and never
// retried — the event was lost forever. The fix returns 200 only for
// expected, terminal AppErrors (4xx) and 5xx for unexpected failures so
// Stripe's retry machinery picks them up.

const handleWebhookEvent = vi.fn();
vi.mock('../services/stripe.service.js', () => ({
  handleWebhookEvent: (...args: unknown[]) => handleWebhookEvent(...args),
}));

import { stripeWebhookRouter } from './stripe-webhook.routes.js';
import { AppError } from '../utils/errors.js';

const UUID = '00000000-0000-4000-8000-000000000000';
const HEADERS = { 'stripe-signature': 'sig', 'content-type': 'application/json' };

async function postWebhook(): Promise<number> {
  const app = express();
  app.use('/s', stripeWebhookRouter);
  const server = app.listen(0);
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://localhost:${port}/s/webhook/${UUID}`, {
      method: 'POST',
      headers: HEADERS,
      body: Buffer.from('{}'),
    });
    return res.status;
  } finally {
    server.close();
  }
}

describe('stripe webhook dispatch — expected vs unexpected error mapping', () => {
  beforeEach(() => handleWebhookEvent.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('acks 200 on success', async () => {
    handleWebhookEvent.mockResolvedValue(undefined);
    expect(await postWebhook()).toBe(200);
  });

  it('acks 200 on an EXPECTED AppError (bad signature) — Stripe should not retry', async () => {
    handleWebhookEvent.mockRejectedValue(
      AppError.badRequest('Webhook signature verification failed', 'BAD_SIGNATURE'),
    );
    expect(await postWebhook()).toBe(200);
  });

  it('returns 500 on an UNEXPECTED error (DB outage) so Stripe retries', async () => {
    handleWebhookEvent.mockRejectedValue(new Error('connection terminated unexpectedly'));
    expect(await postWebhook()).toBe(500);
  });

  it('returns 500 on an AppError.internal (5xx) so Stripe retries', async () => {
    handleWebhookEvent.mockRejectedValue(AppError.internal('boom'));
    expect(await postWebhook()).toBe(500);
  });
});
