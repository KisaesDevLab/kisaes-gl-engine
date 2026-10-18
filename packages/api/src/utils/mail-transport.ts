// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * The one place the engine builds an SMTP transport. Every sender
 * (company/system email, portal mail, invites, remote-backup email, the
 * SMTP test) calls createMailTransport() instead of nodemailer directly.
 *
 * Server appliance: exactly `nodemailer.createTransport(opts)` — same
 * options, same nodemailer default timeouts, same errors.
 *
 * Desktop mode (CL_MODE=desktop) adds:
 *   - requireTLS (STARTTLS mandatory) unless the server is on loopback or
 *     the caller says otherwise;
 *   - bounded timeouts (connection 10 s, greeting 10 s, socket 30 s)
 *     unless the caller set its own, so a dead mail server cannot hold a
 *     request for nodemailer's default two minutes;
 *   - an offline fast-fail: sendMail() and verify() first call
 *     ensureOnline('smtp', host:port) (utils/offline.ts), and network
 *     errors from the send are mapped to OfflineUnavailableError (503
 *     OFFLINE_UNAVAILABLE);
 *   - the password comes from the session store (U-13): when `auth.user`
 *     is set, `auth.pass` is replaced by the `smtp.password` session
 *     secret, and 400 SMTP_NOT_CONFIGURED is thrown when there is none.
 *     Whatever the caller passed (a stored companies.smtp_pass, a test
 *     body) is never used, so the engine never needs the password at rest.
 */

import nodemailer from 'nodemailer';
import { isDesktop } from '../desktop/profile.js';
import { getSessionSecret } from '../desktop/session-secrets.js';
import { AppError } from './errors.js';
import { classifyNetworkError, ensureOnline, isLoopbackAddress, type NetTarget } from './offline.js';

export interface MailTransportOptions {
  host?: string;
  port?: number;
  secure?: boolean;
  auth?: { user?: string; pass?: string };
  requireTLS?: boolean;
  connectionTimeout?: number;
  greetingTimeout?: number;
  socketTimeout?: number;
}

/** Desktop defaults; a value the caller sets wins. */
export const DESKTOP_SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
} as const;

/** Where nodemailer will connect for these options (its own defaults). */
export function smtpTarget(opts: MailTransportOptions): NetTarget {
  return {
    host: opts.host && opts.host !== '' ? opts.host : 'localhost',
    port: opts.port ?? (opts.secure ? 465 : 587),
  };
}

type Callback = (err: Error | null, info?: unknown) => void;

function guard<A extends unknown[]>(
  target: NetTarget,
  call: (...args: A) => Promise<unknown>,
): (...args: unknown[]) => Promise<unknown> | undefined {
  const run = async (args: A): Promise<unknown> => {
    await ensureOnline('smtp', target);
    try {
      return await call(...args);
    } catch (err) {
      throw classifyNetworkError(err, 'smtp') ?? err;
    }
  };
  return (...args: unknown[]) => {
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      const cb = last as Callback;
      run(args.slice(0, -1) as A).then((info) => cb(null, info), (err: Error) => cb(err));
      return undefined;
    }
    return run(args as A);
  };
}

export function createMailTransport(opts: MailTransportOptions) {
  if (!isDesktop()) return nodemailer.createTransport(opts);

  const target = smtpTarget(opts);
  if (opts.auth?.user) {
    const pass = getSessionSecret('smtp.password');
    if (!pass) {
      throw AppError.badRequest(
        'The email password for this session has not been provided. Enter it in Settings → Email.',
        'SMTP_NOT_CONFIGURED',
      );
    }
    opts = { ...opts, auth: { user: opts.auth.user, pass } };
  }
  // Desktop default: never send the owner's SMTP password or mail in clear
  // text over the network. Port 465 is TLS from the start; on other ports
  // STARTTLS is required, except for a relay on this machine. A caller's
  // explicit requireTLS wins.
  const transport = nodemailer.createTransport({
    ...DESKTOP_SMTP_TIMEOUTS,
    requireTLS: !isLoopbackAddress(target.host),
    ...opts,
  });
  const t = transport as unknown as Record<string, unknown>;
  for (const method of ['sendMail', 'verify'] as const) {
    const orig = t[method];
    if (typeof orig !== 'function') continue;
    const bound = (orig as (...a: unknown[]) => Promise<unknown>).bind(transport);
    t[method] = guard(target, (...a: unknown[]) => bound(...a));
  }
  return transport;
}
