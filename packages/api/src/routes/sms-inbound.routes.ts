// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import express, { Router } from 'express';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { reminderSends } from '../db/schema/index.js';
import * as smsSuppression from '../services/sms-suppression.service.js';
import * as tfaConfigService from '../services/tfa-config.service.js';

// DOC_REQUEST_SMS_V1 — inbound SMS webhooks. Two providers wired:
//   POST /api/sms/inbound/twilio          — message webhook (STOP/START)
//   POST /api/sms/inbound/twilio/status   — delivery-status callback
//   POST /api/sms/inbound/textlinksms     — message webhook
// Mounted before express.json() so we can verify the raw body's HMAC
// signature (Twilio signs the form-urlencoded payload + URL).

export const smsInboundRouter = Router();

// Twilio sends application/x-www-form-urlencoded.
smsInboundRouter.use(express.urlencoded({ extended: false }));

// ── Twilio inbound message webhook ─────────────────────────────

smsInboundRouter.post('/twilio', async (req, res) => {
  if (!verifyTwilioSignature(req)) {
    res.status(403).type('application/xml').send('<Response/>');
    return;
  }
  const fromRaw = String((req.body?.From ?? '') as string);
  const body = String((req.body?.Body ?? '') as string);
  const classification = smsSuppression.classifyInboundBody(body);

  if (classification === 'stop') {
    await smsSuppression.applyStopKeyword(fromRaw);
    // Twilio expects valid TwiML. An empty <Response/> tells the
    // sidecar to send no automated reply (Twilio itself sends the
    // mandatory STOP confirmation per A2P registration).
    res.type('application/xml').send('<Response/>');
    return;
  }
  if (classification === 'start') {
    await smsSuppression.applyStartKeyword(fromRaw);
    res.type('application/xml').send('<Response><Message>You are re-subscribed to bookkeeping reminders.</Message></Response>');
    return;
  }
  res.type('application/xml').send('<Response/>');
});

// Twilio delivery-status callback. Hits when the message changes
// state (queued → sent → delivered → undelivered/failed). We update
// reminder_sends.provider_status + bounced_at.
smsInboundRouter.post('/twilio/status', async (req, res) => {
  if (!verifyTwilioSignature(req)) {
    res.status(403).end();
    return;
  }
  const messageSid = String((req.body?.MessageSid ?? '') as string);
  const status = String((req.body?.MessageStatus ?? '') as string);
  if (!messageSid) {
    res.status(204).end();
    return;
  }

  const patch: Record<string, unknown> = { providerStatus: status };
  if (status === 'delivered') patch['deliveredAt'] = new Date();
  if (status === 'undelivered' || status === 'failed') patch['bouncedAt'] = new Date();

  await db
    .update(reminderSends)
    .set(patch)
    .where(eq(reminderSends.providerMessageId, messageSid));
  res.status(204).end();
});

// ── TextLinkSMS inbound webhook ─────────────────────────────────

smsInboundRouter.post('/textlinksms', async (req, res) => {
  // TextLinkSMS doesn't publish a documented signature scheme as of
  // 2026-04. We accept the payload only when a shared-secret header
  // matches a value the operator configures as
  // SMS_TEXTLINKSMS_INBOUND_SECRET. If unset, the webhook is rejected
  // — fail closed rather than open.
  const expected = process.env['SMS_TEXTLINKSMS_INBOUND_SECRET'];
  const got = req.header('x-textlinksms-secret') ?? '';
  if (!expected || expected !== got) {
    res.status(403).end();
    return;
  }

  const fromRaw = String((req.body?.from ?? req.body?.phone_number ?? '') as string);
  const body = String((req.body?.text ?? req.body?.message ?? '') as string);
  const classification = smsSuppression.classifyInboundBody(body);

  if (classification === 'stop') await smsSuppression.applyStopKeyword(fromRaw);
  else if (classification === 'start') await smsSuppression.applyStartKeyword(fromRaw);

  res.status(200).json({ ok: true });
});

// ── Helpers ────────────────────────────────────────────────────

function verifyTwilioSignature(req: express.Request): boolean {
  // Twilio HMAC: SHA1(authToken + URL + sorted-form-fields)
  // (https://www.twilio.com/docs/usage/webhooks/webhooks-security)
  // We retrieve the auth token from tfa_config — the same singleton
  // that holds the outbound SMS provider config. If misconfigured,
  // we fail closed.
  const signature = req.header('x-twilio-signature');
  if (!signature) return false;

  // Synchronous fetch isn't possible; cache the auth token on first
  // hit. The token rarely rotates so a process-lifetime cache is fine.
  const authToken = getCachedTwilioAuthToken();
  if (!authToken) return false;

  // Forwarded host + protocol gets us the public-facing URL; behind a
  // tunnel/proxy this matters because Twilio signs the URL it called.
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol;
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.get('host');
  const url = `${proto}://${host}${req.originalUrl}`;
  const params = req.body && typeof req.body === 'object' ? (req.body as Record<string, string>) : {};
  const sortedKeys = Object.keys(params).sort();
  const data = url + sortedKeys.map((k) => k + (params[k] ?? '')).join('');
  const expected = crypto.createHmac('sha1', authToken).update(data).digest('base64');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

let cachedTwilioAuthToken: string | null | undefined;
function getCachedTwilioAuthToken(): string | null {
  if (cachedTwilioAuthToken !== undefined) return cachedTwilioAuthToken;
  // Initial fetch is async, so we kick it off and gate the very
  // first request through the slow path. Subsequent requests use the
  // cache. A short-circuit returning null on the first request is
  // safer than blocking — Twilio retries on 4xx.
  void (async () => {
    try {
      const cfg = await tfaConfigService.getRawConfig();
      cachedTwilioAuthToken = cfg.smsTwilioAuthToken ?? null;
    } catch {
      cachedTwilioAuthToken = null;
    }
  })();
  return null;
}

export function invalidateTwilioAuthTokenCache(): void {
  cachedTwilioAuthToken = undefined;
}
