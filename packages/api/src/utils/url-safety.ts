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

// Loopback aliases. Blocked by default, but a legitimate target for
// self-hosted services (Ollama on the same host), so `allowPrivate`
// callers may use them.
const LOOPBACK_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
]);

// Cloud-metadata service names. NEVER a legitimate target — blocked even
// when `allowPrivate` is set, because the whole point of that flag is to
// reach a LAN box, not the instance metadata endpoint.
const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
]);

type IpClass =
  | 'link-local' // 169.254/16 + IPv6 fe80::/10 — cloud metadata / always unsafe
  | 'private' //    loopback + RFC-1918 + IPv6 ULA — unsafe unless allowPrivate
  | 'public'; //    not a recognised internal literal

// Classify a literal hostname. Note: link-local (169.254 / fe80) is kept
// distinct from private because it stays blocked even under allowPrivate —
// 169.254.169.254 is the AWS/GCP metadata endpoint, never a real Ollama host.
function classifyIpLiteral(host: string): IpClass {
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 169 && b === 254) return 'link-local'; // 169.254.0.0/16 (metadata)
    if (a === 127) return 'private'; // 127.0.0.0/8 loopback
    if (a === 10) return 'private'; // 10.0.0.0/8
    if (a === 0) return 'private'; // 0.0.0.0/8
    if (a === 192 && b === 168) return 'private'; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return 'private'; // 172.16.0.0/12
    return 'public';
  }
  // IPv6 — only classify when there's a colon, so hostnames that happen to
  // start with "fc"/"fd" (e.g. fc-barcelona.example) aren't mistaken for ULA.
  const lower = host.toLowerCase();
  if (lower.includes(':')) {
    if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return 'private';
    if (lower.startsWith('fe80:')) return 'link-local';
    if (lower.startsWith('fc') || lower.startsWith('fd')) return 'private'; // ULA fc00::/7
    if (lower.startsWith('::ffff:')) {
      return classifyIpLiteral(lower.replace(/^::ffff:/, '')); // IPv4-mapped
    }
  }
  return 'public';
}

export interface UrlSafetyOptions {
  /**
   * Allow loopback + RFC-1918 private + IPv6 ULA targets. Set for fields
   * whose purpose is to point at a self-hosted box on the operator's own
   * network — the Ollama / GLM-OCR / OpenAI-compatible AI endpoints. The
   * cloud-metadata endpoint (169.254.169.254 / metadata.*) stays blocked
   * regardless, since it is never a legitimate target.
   */
  allowPrivate?: boolean;
}

export function assertExternalUrlSafe(raw: string, label = 'URL', opts: UrlSafetyOptions = {}): void {
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
  const lowerHost = host.toLowerCase();

  if (METADATA_HOSTNAMES.has(lowerHost)) {
    throw new Error(`${label} points at a blocked metadata hostname`);
  }
  if (LOOPBACK_HOSTNAMES.has(lowerHost) && !opts.allowPrivate) {
    throw new Error(`${label} points at a blocked hostname`);
  }

  const ipClass = classifyIpLiteral(host);
  if (ipClass === 'link-local') {
    throw new Error(`${label} points at a blocked IP range (link-local / cloud metadata)`);
  }
  if (ipClass === 'private' && !opts.allowPrivate) {
    throw new Error(`${label} points at a blocked IP range (loopback, link-local, or private)`);
  }
}
