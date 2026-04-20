// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import net from 'net';
import type { Request, Response, NextFunction } from 'express';

// Stripe publishes the IP ranges webhook callers originate from at
// https://stripe.com/files/ips/ips_webhooks.json. We pin the ranges
// rather than fetch them at runtime so a DNS or upstream hiccup can't
// silently open the webhook endpoint to the world. Refresh via the
// quarterly maintenance checklist.
//
// Last sync: 2026-04-20. Source:
//   https://stripe.com/files/ips/ips_webhooks.json
// If Stripe adds new ranges, webhook signature verification is still
// the authoritative check — a rotated range only causes the
// allowlist to 403 until this file is updated.

const STRIPE_WEBHOOK_IPS_V4: ReadonlyArray<string> = [
  '3.18.12.63',
  '3.130.192.231',
  '13.235.14.237',
  '13.235.122.149',
  '18.211.135.69',
  '35.154.171.200',
  '52.15.183.38',
  '54.88.130.119',
  '54.88.130.237',
  '54.187.174.169',
  '54.187.205.235',
  '54.187.216.72',
];

// Stripe currently publishes only IPv4 ranges for webhook senders.
// Leaving this array in place so adding IPv6 support is a one-liner
// when the list changes.
const STRIPE_WEBHOOK_IPS_V6: ReadonlyArray<string> = [];

// Normalise a request IP:
//   1. Strip the IPv4-mapped IPv6 prefix (`::ffff:1.2.3.4` → `1.2.3.4`)
//      so the string-equality check against the IPv4 allowlist matches.
//   2. Strip any IPv6 zone suffix (`fe80::1%eth0` → `fe80::1`).
function normalize(ip: string | undefined): string | null {
  if (!ip) return null;
  let out = ip.trim();
  if (out.startsWith('::ffff:')) out = out.slice(7);
  const pct = out.indexOf('%');
  if (pct >= 0) out = out.slice(0, pct);
  return out || null;
}

function isAllowed(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return STRIPE_WEBHOOK_IPS_V4.includes(ip);
  if (family === 6) return STRIPE_WEBHOOK_IPS_V6.includes(ip);
  return false;
}

/**
 * Optional Express middleware that rejects Stripe webhook requests
 * whose source IP isn't in the published allowlist. Signature
 * verification (inside stripe.service.handleWebhookEvent) is the
 * authoritative check — this is defense-in-depth.
 *
 * Off by default. Set `STRIPE_WEBHOOK_IP_ALLOWLIST_ENFORCED=1` to
 * enable. The appliance's front nginx / Cloudflare Tunnel relays the
 * real client IP via X-Forwarded-For, so `app.set('trust proxy', true)`
 * (also set in app.ts for CORS + baseUrlFor) is a prerequisite —
 * without it req.ip returns the proxy's IP and the check would always
 * fail.
 *
 * Returns 403 on a denied IP and logs the rejection so operators can
 * see if a new Stripe range has rolled out before they've refreshed
 * the pinned list.
 */
export function stripeIpAllowlist() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (process.env['STRIPE_WEBHOOK_IP_ALLOWLIST_ENFORCED'] !== '1') {
      next();
      return;
    }
    const ip = normalize(req.ip);
    if (ip && isAllowed(ip)) {
      next();
      return;
    }
    console.warn(`[Stripe Webhook] Denied request from ${ip ?? 'unknown IP'}. Refresh the pinned allowlist if Stripe has rotated ranges.`);
    res.status(403).json({ error: { message: 'Forbidden' } });
  };
}

// Exposed for unit tests and for a future admin diagnostics view.
export const __internal = { STRIPE_WEBHOOK_IPS_V4, STRIPE_WEBHOOK_IPS_V6, normalize, isAllowed };
