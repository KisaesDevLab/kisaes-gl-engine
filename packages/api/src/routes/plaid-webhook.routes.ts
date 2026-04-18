// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router, type Request, type Response } from 'express';
import express from 'express';
import * as plaidClient from '../services/plaid-client.service.js';
import * as plaidWebhook from '../services/plaid-webhook.service.js';

// Dedicated router for the Plaid webhook. Must be mounted BEFORE
// express.json() in app.ts so it sees the raw bytes. Plaid signs the
// exact payload it sent; re-serialising a parsed body produces
// different bytes and verification always fails (or worse, succeeds
// only when key order coincidentally matches, making the signature
// path unreliable).
//
// Uses express.raw() with the application/json content type so req.body
// arrives as a Buffer. We pass that Buffer string through verifyWebhook
// and, once verified, JSON.parse it ourselves for handleWebhook.

export const plaidWebhookRouter = Router();

plaidWebhookRouter.post(
  '/',
  express.raw({ type: 'application/json', limit: '1mb' }),
  async (req: Request, res: Response) => {
    try {
      const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : '';
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, String(v)]),
      );
      const verified = await plaidClient.verifyWebhook(rawBody, headers);
      if (!verified) {
        res.status(401).json({ error: 'Webhook verification failed' });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        res.status(400).json({ error: 'Invalid JSON body' });
        return;
      }
      await plaidWebhook.handleWebhook(parsed as Parameters<typeof plaidWebhook.handleWebhook>[0]);
      res.json({ received: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Plaid Webhook] Error:', message);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  },
);
