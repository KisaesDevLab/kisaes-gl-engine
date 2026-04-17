// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Minimal SSRF-defense helpers for URLs supplied by admins (Ollama endpoint,
// WebDAV backup target, etc.). These are *string-level* checks — they don't
// resolve DNS, so an attacker registering evil.example with A=127.0.0.1
// bypasses them. That's fine for the current threat model (misconfiguration
// by a trusted super-admin, not malicious super-admin): string guards catch
// the accidental `http://169.254.169.254/` paste and the obvious localhost
// redirect without adding the latency + TOCTOU surface of DNS resolution.

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
]);

// Numeric / CIDR-style checks on the literal hostname.
function isBlockedIpLiteral(host: string): boolean {
  // IPv4 loopback, link-local, private ranges
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (AWS/GCP metadata)
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    return false;
  }
  // IPv6 — crude: refuse loopback and link-local / unique-local
  const lower = host.toLowerCase();
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // IPv4-mapped IPv6
  if (lower.startsWith('::ffff:')) {
    const v4mapped = lower.replace(/^::ffff:/, '');
    return isBlockedIpLiteral(v4mapped);
  }
  return false;
}

export function assertExternalUrlSafe(raw: string, label = 'URL'): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use http or https`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (!host) throw new Error(`${label} must include a hostname`);
  if (BLOCKED_HOSTNAMES.has(host.toLowerCase())) {
    throw new Error(`${label} points at a blocked hostname`);
  }
  if (isBlockedIpLiteral(host)) {
    throw new Error(`${label} points at a blocked IP range (loopback, link-local, or private)`);
  }
}
