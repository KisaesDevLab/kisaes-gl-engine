// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Workstation request context (U-289, lan-profile-v1).
 *
 * In LAN mode (CL_LAN=1) the desktop app's host proxy forwards workstation
 * requests to this loopback engine with the workstation token, the peer's
 * address in `X-Forwarded-For` and the device's certificate fingerprint in
 * `X-CL-Device`. The desktop gate reads those two headers for workstation
 * requests only (a host request's are ignored) and runs the rest of the
 * request inside this context, so code far from the request (the audit
 * writer) can name the device without a new parameter.
 *
 * Never set on the server appliance or in desktop mode without LAN.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import net from 'node:net';
import type { Request } from 'express';

export interface LanRequestContext {
  /** Lower-case hex SHA-256 fingerprint of the workstation's device certificate. */
  device: string;
  /** The workstation's address as the host proxy saw it. */
  peerIp: string;
}

declare global {
  namespace Express {
    interface Request {
      /** LAN mode only: which launch token the request carried. */
      lanClass?: 'host' | 'workstation';
      /** Workstation requests only: the device fingerprint (X-CL-Device). */
      lanDevice?: string;
    }
  }
}

const storage = new AsyncLocalStorage<LanRequestContext>();

/** Runs `fn` with the workstation context. */
export function runWithLanContext<T>(ctx: LanRequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The workstation context of the current request, if any. */
export function currentLanContext(): LanRequestContext | undefined {
  return storage.getStore();
}

export const LAN_DEVICE_HEADER = 'x-cl-device';
const DEVICE_RE = /^[0-9a-fA-F]{64}$/;

/** `X-CL-Device`: one 64-character hex fingerprint, returned lower case; else null. */
export function parseLanDevice(raw: string | string[] | undefined): string | null {
  if (typeof raw !== 'string' || !DEVICE_RE.test(raw.trim())) return null;
  return raw.trim().toLowerCase();
}

/** `X-Forwarded-For` from the host proxy: exactly one hop, an IP literal; else null. */
export function parseLanPeer(raw: string | string[] | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (v.includes(',') || v.length > 45 || net.isIP(v) === 0) return null;
  return v.toLowerCase();
}

/**
 * Rate-limiter key for the caller: the device for a workstation request,
 * else the client address exactly as before (`ip:<address>`).
 */
export function limiterClientKey(req: Request): string {
  return req.lanDevice ? `device:${req.lanDevice}` : `ip:${req.ip || 'unknown'}`;
}

/**
 * Drop-in for express-rate-limit's default key (the bare `req.ip`): the
 * device for a workstation request, so a workstation cannot reset a limiter
 * by changing its address.
 */
export function limiterDefaultKey(req: Request): string {
  return req.lanDevice ? `device:${req.lanDevice}` : (req.ip ?? 'unknown');
}
