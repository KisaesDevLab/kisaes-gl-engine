// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// SSRF-defense helpers for URLs supplied through the app.
//
// Two tiers, matched to who can set the URL:
//
//  - assertExternalUrlSafe: *string-level* checks only — no DNS. Catches the
//    accidental `http://169.254.169.254/` paste and obvious localhost
//    targets. Sufficient for super-admin-only fields (Ollama / AI endpoints)
//    where the threat model is misconfiguration, not malice.
//
//  - makeSafeLookup / makeSafeAgents: connect-time DNS validation for URLs
//    settable by TENANT users (remote-backup WebDAV/S3, storage-provider
//    endpoints — gated on company_settings, not super-admin). String checks
//    alone are bypassable there: a hostname the user controls can resolve
//    (or rebind between validation and use) to loopback/RFC-1918, making the
//    server probe internal services or deliver backup contents to them.
//    The lookup wrapper classifies EVERY address on EVERY socket connect,
//    so validation and use cannot be separated by a rebind.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

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
export function classifyIpLiteral(host: string): IpClass {
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 169 && b === 254) return 'link-local'; // 169.254.0.0/16 (metadata)
    if (a === 127) return 'private'; // 127.0.0.0/8 loopback
    if (a === 10) return 'private'; // 10.0.0.0/8
    if (a === 0) return 'private'; // 0.0.0.0/8
    if (a === 192 && b === 168) return 'private'; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return 'private'; // 172.16.0.0/12
    if (a === 100 && b >= 64 && b <= 127) return 'private'; // 100.64.0.0/10 CGNAT (Tailscale lives here)
    if (a === 198 && (b === 18 || b === 19)) return 'private'; // 198.18.0.0/15 benchmarking
    if (a >= 224) return 'private'; // 224/4 multicast + 240/4 reserved + broadcast
    return 'public';
  }
  // IPv6 — only classify when there's a colon, so hostnames that happen to
  // start with "fc"/"fd" (e.g. fc-barcelona.example) aren't mistaken for ULA.
  const lower = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower.includes(':')) {
    // Canonicalise first: `new URL('http://[::ffff:127.0.0.1]/').hostname`
    // is `[::ffff:7f00:1]` (hex-tail mapped form), `0:0:0:0:0:0:0:1` is
    // loopback, etc. SocketAddress folds every spelling into one shape so
    // the checks below can't be dodged by an alternate encoding.
    let canon = lower;
    if (net.isIPv6(lower)) {
      try { canon = new net.SocketAddress({ address: lower, family: 'ipv6' }).address.toLowerCase(); } catch { /* keep as-is */ }
    }
    if (canon === '::1' || canon === '::') return 'private'; // loopback / unspecified
    if (canon.startsWith('fe80:')) return 'link-local';
    if (canon.startsWith('fc') || canon.startsWith('fd')) return 'private'; // ULA fc00::/7
    if (canon.startsWith('::ffff:')) {
      const tail = canon.slice('::ffff:'.length);
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return classifyIpLiteral(tail); // IPv4-mapped (canonical dotted)
      return 'private'; // any other mapped spelling we failed to canonicalise: fail closed
    }
    if (canon.startsWith('64:ff9b:')) return 'private'; // NAT64 well-known prefix (embeds an IPv4)
    if (canon.startsWith('2002:')) return 'private'; // 6to4 (embeds an IPv4)
  }
  return 'public';
}

export interface UrlSafetyOptions {
  /**
   * Allow loopback + RFC-1918 private + IPv6 ULA targets. Set for fields
   * whose purpose is to point at a self-hosted box on the operator's own
   * network — the Ollama / OpenAI-compatible AI endpoints. The
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
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host) || /^\d+(\.\d+){1,2}$/.test(host)) {
    // WHATWG URL already normalises decimal/hex/short IPv4 forms
    // (http://2130706433/, http://0x7f000001/, http://127.1/) to dotted
    // quads, so seeing one here means parsing failed to — refuse.
    throw new Error(`${label} uses an unsupported IP literal form`);
  }
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

/**
 * A net/tls-compatible `lookup` that resolves via dns.lookup and rejects the
 * connection when ANY returned address is link-local (always) or
 * private/loopback (unless allowPrivate). Because it runs at socket-connect
 * time — inside http.Agent / https.Agent / http.request — there is no
 * validate-then-connect gap for DNS rebinding to slip through.
 */
export function makeSafeLookup(opts: UrlSafetyOptions = {}): net.LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (...args: never[]) => void) => {
    const cb = callback as unknown as (
      err: NodeJS.ErrnoException | null,
      address?: string | dns.LookupAddress[],
      family?: number,
    ) => void;
    // NOTE: Node skips the custom `lookup` entirely when the host is already
    // an IP literal (net.isIP(host) !== 0), so literals must be classified
    // by the caller before connecting — see makeSafeAgents' createConnection.
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err);
      const list = addresses as dns.LookupAddress[];
      if (!list.length) return cb(Object.assign(new Error(`No addresses found for ${hostname}`), { code: 'ENOTFOUND' }));
      for (const a of list) {
        const cls = classifyIpLiteral(a.address);
        if (cls === 'link-local' || (cls === 'private' && !opts.allowPrivate)) {
          return cb(Object.assign(
            new Error(`${hostname} resolves to a blocked internal address (${a.address})`),
            { code: 'EBLOCKEDHOST' },
          ));
        }
      }
      if (options.all) return cb(null, list);
      const first = list[0]!;
      cb(null, first.address, first.family);
    });
  }) as net.LookupFunction;
}

/**
 * http/https Agents wired to makeSafeLookup — for HTTP clients that take an
 * agent (AWS SDK NodeHttpHandler, node http/https.request) so every
 * connection they open re-validates the DNS answer it is about to dial.
 */
export function makeSafeAgents(opts: UrlSafetyOptions = {}): { httpAgent: http.Agent; httpsAgent: https.Agent } {
  const lookup = makeSafeLookup(opts);
  // Node bypasses `lookup` for IP-literal hosts, so a URL like
  // http://[::ffff:7f00:1]:6379/ would dial loopback without ever hitting
  // the DNS guard. Classify literals at connect time so the guarantee
  // "every socket this agent opens is checked" actually holds.
  const literalGuard = (host: string | undefined): void => {
    if (!host) return;
    const bare = host.replace(/^\[|\]$/g, '');
    if (!net.isIP(bare)) return;
    const cls = classifyIpLiteral(bare);
    if (cls === 'link-local' || (cls === 'private' && !opts.allowPrivate)) {
      throw Object.assign(new Error(`${host} is a blocked internal address`), { code: 'EBLOCKEDHOST' });
    }
  };
  class SafeHttpAgent extends http.Agent {
    override createConnection(options: net.NetConnectOpts & { host?: string }, callback?: (err: Error | null, stream: net.Socket) => void): net.Socket {
      literalGuard(options.host);
      // @ts-expect-error — http.Agent#createConnection exists at runtime (net.createConnection wrapper)
      return super.createConnection(options, callback);
    }
  }
  class SafeHttpsAgent extends https.Agent {
    override createConnection(options: net.NetConnectOpts & { host?: string }, callback?: (err: Error | null, stream: net.Socket) => void): net.Socket {
      literalGuard(options.host);
      // @ts-expect-error — https.Agent#createConnection exists at runtime (tls.connect wrapper)
      return super.createConnection(options, callback);
    }
  }
  return {
    httpAgent: new SafeHttpAgent({ lookup }),
    httpsAgent: new SafeHttpsAgent({ lookup }),
  };
}
