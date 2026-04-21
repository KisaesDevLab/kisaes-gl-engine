// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import net from 'net';
import { eq, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { staffIpAllowlist } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

// CLOUDFLARE_TUNNEL_PLAN Phase 6 — optional office-only staff lockdown.
// See 0064_staff_ip_allowlist.sql migration comment for the rationale.

export interface AllowlistEntry {
  id: string;
  cidr: string;
  description: string | null;
  createdAt: Date;
  createdBy: string | null;
}

// ─── CIDR parsing + membership ─────────────────────────────────
//
// Hand-rolled rather than pulling in `ipaddr.js` so the pre-existing
// dep tree isn't widened for a single feature. Supports IPv4 and
// IPv6; a single-address entry (no `/N` suffix) is treated as a /32
// or /128 respectively.

interface ParsedCidr {
  family: 4 | 6;
  bytes: Uint8Array;
  prefix: number;
}

function ipToBytes(ip: string): Uint8Array | null {
  const family = net.isIP(ip);
  if (family === 4) {
    const parts = ip.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    return new Uint8Array(parts);
  }
  if (family === 6) {
    // Expand to 16 bytes. Node's `net.isIP` has already validated the
    // shape, so a simple colon-split + `::` expansion is enough.
    const zoneStripped = ip.split('%')[0] || '';
    const [headRaw = '', tailRaw = ''] = zoneStripped.split('::', 2);
    const head = headRaw ? headRaw.split(':') : [];
    const tail = tailRaw ? tailRaw.split(':') : [];
    const missing = 8 - head.length - tail.length;
    const groups = missing >= 0 ? [...head, ...Array(missing).fill('0'), ...tail] : head.concat(tail);
    if (groups.length !== 8) return null;
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
      const v = parseInt(groups[i] || '0', 16);
      if (!Number.isInteger(v) || v < 0 || v > 0xffff) return null;
      bytes[i * 2] = (v >> 8) & 0xff;
      bytes[i * 2 + 1] = v & 0xff;
    }
    return bytes;
  }
  return null;
}

function parseCidr(cidr: string): ParsedCidr | null {
  const trimmed = cidr.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf('/');
  const ip = slash >= 0 ? trimmed.slice(0, slash) : trimmed;
  const bytes = ipToBytes(ip);
  if (!bytes) return null;
  const family: 4 | 6 = bytes.length === 4 ? 4 : 6;
  const maxPrefix = family === 4 ? 32 : 128;
  let prefix: number;
  if (slash >= 0) {
    const suffix = trimmed.slice(slash + 1);
    // Reject an empty suffix — Number('') coerces to 0, which would
    // silently turn `10.0.0.0/` into a /0 (match everything) range.
    if (!/^\d+$/.test(suffix)) return null;
    prefix = Number(suffix);
  } else {
    prefix = maxPrefix;
  }
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) return null;
  return { family, bytes, prefix };
}

function cidrContains(entry: ParsedCidr, ip: string): boolean {
  const probe = ipToBytes(ip);
  if (!probe) return false;
  if (probe.length !== entry.bytes.length) return false;
  let remaining = entry.prefix;
  for (let i = 0; i < entry.bytes.length && remaining > 0; i++) {
    const bits = Math.min(8, remaining);
    const mask = bits === 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((entry.bytes[i]! & mask) !== (probe[i]! & mask)) return false;
    remaining -= bits;
  }
  return true;
}

// Exposed for the express middleware so it can normalise the request
// IP the same way we do for CIDR entries.
export function normaliseRequestIp(ip: string | undefined): string | null {
  if (!ip) return null;
  let out = ip.trim();
  if (out.startsWith('::ffff:')) out = out.slice(7);
  const pct = out.indexOf('%');
  if (pct >= 0) out = out.slice(0, pct);
  return out || null;
}

export function isValidCidr(cidr: string): boolean {
  return parseCidr(cidr) !== null;
}

// ─── DB API ────────────────────────────────────────────────────

export async function listEntries(): Promise<AllowlistEntry[]> {
  const rows = await db.select().from(staffIpAllowlist).orderBy(desc(staffIpAllowlist.createdAt));
  return rows.map((r) => ({
    id: r.id,
    cidr: r.cidr,
    description: r.description ?? null,
    createdAt: r.createdAt,
    createdBy: r.createdBy ?? null,
  }));
}

export async function addEntry(input: { cidr: string; description?: string | null; createdBy?: string | null }): Promise<AllowlistEntry> {
  const cidr = input.cidr.trim();
  if (!isValidCidr(cidr)) {
    throw AppError.badRequest('Not a valid IPv4 or IPv6 CIDR (e.g. 203.0.113.0/24 or 2001:db8::/32).');
  }
  try {
    const [row] = await db.insert(staffIpAllowlist).values({
      cidr,
      description: input.description ?? null,
      createdBy: input.createdBy ?? null,
    }).returning();
    if (!row) throw AppError.internal('Insert returned nothing');
    return { id: row.id, cidr: row.cidr, description: row.description ?? null, createdAt: row.createdAt, createdBy: row.createdBy ?? null };
  } catch (err) {
    // Unique-violation on the cidr column: the operator tried to add a
    // range that was already on the list. Postgres returns SQLSTATE
    // 23505; drizzle wraps the error so we match on the code when
    // available and fall back to a substring check on the unique-
    // constraint name for older drivers.
    const code = (err as { code?: string; cause?: { code?: string } })?.code
      || (err as { cause?: { code?: string } })?.cause?.code;
    const msg = err instanceof Error ? err.message : '';
    if (code === '23505' || /staff_ip_allowlist_cidr_unique|duplicate key/i.test(msg)) {
      throw AppError.conflict('That CIDR is already in the allowlist.');
    }
    throw err;
  }
}

export async function removeEntry(id: string): Promise<void> {
  await db.delete(staffIpAllowlist).where(eq(staffIpAllowlist.id, id));
}

// ─── Membership check (middleware-facing) ──────────────────────

// Tiny in-process cache. The allowlist is queried on every request,
// so a refresh-on-write cache keeps us off the DB's hot path without
// making the feature eventually-consistent across processes. Single-
// container installs are the only deployment target today; when
// multi-instance lands, this becomes a Redis pub/sub invalidation.
let cachedEntries: ParsedCidr[] | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 5_000;

export function invalidateCache() {
  cachedEntries = null;
  cacheExpiresAt = 0;
}

async function getParsedEntries(): Promise<ParsedCidr[]> {
  if (cachedEntries && Date.now() < cacheExpiresAt) return cachedEntries;
  const rows = await db.select({ cidr: staffIpAllowlist.cidr }).from(staffIpAllowlist);
  const parsed: ParsedCidr[] = [];
  for (const r of rows) {
    const p = parseCidr(r.cidr);
    if (p) parsed.push(p);
  }
  cachedEntries = parsed;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return parsed;
}

/**
 * Whether an IP should be allowed through the staff-access gate.
 *
 * Empty allowlist ⇒ allow all (operator hasn't configured the feature
 * yet; being strict would turn the enforcement flag into a cold-start
 * lockout). The middleware also short-circuits when the env flag is
 * off, so this function's behaviour only matters when the operator has
 * both enabled enforcement AND populated entries.
 */
export async function isIpAllowed(ip: string | null | undefined): Promise<boolean> {
  const n = normaliseRequestIp(ip ?? undefined);
  if (!n) return false;
  const entries = await getParsedEntries();
  if (entries.length === 0) return true;
  for (const entry of entries) {
    if (cidrContains(entry, n)) return true;
  }
  return false;
}

export const __internal = { parseCidr, cidrContains, ipToBytes };
