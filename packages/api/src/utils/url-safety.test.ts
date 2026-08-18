// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { assertExternalUrlSafe, makeSafeLookup } from './url-safety.js';
import * as urlSafety from './url-safety.js';

describe('assertExternalUrlSafe — default (allowPrivate off)', () => {
  it('accepts a normal public https URL', () => {
    expect(() => assertExternalUrlSafe('https://api.example.com/v1')).not.toThrow();
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => assertExternalUrlSafe('ftp://example.com')).toThrow(/http or https/);
    expect(() => assertExternalUrlSafe('file:///etc/passwd')).toThrow(/http or https/);
  });

  it('rejects malformed URLs', () => {
    expect(() => assertExternalUrlSafe('not a url')).toThrow(/not a valid URL/);
  });

  it('blocks loopback, RFC-1918, and metadata by default', () => {
    expect(() => assertExternalUrlSafe('http://localhost:11434')).toThrow(/blocked hostname/);
    expect(() => assertExternalUrlSafe('http://127.0.0.1:11434')).toThrow(/blocked IP range/);
    expect(() => assertExternalUrlSafe('http://192.168.68.105:11434')).toThrow(/blocked IP range/);
    expect(() => assertExternalUrlSafe('http://10.0.0.5')).toThrow(/blocked IP range/);
    expect(() => assertExternalUrlSafe('http://172.16.0.1')).toThrow(/blocked IP range/);
    expect(() => assertExternalUrlSafe('http://169.254.169.254/latest/meta-data/')).toThrow(/blocked IP range/);
    expect(() => assertExternalUrlSafe('http://metadata.google.internal/')).toThrow(/blocked metadata hostname/);
  });
});

describe('assertExternalUrlSafe — allowPrivate (self-hosted AI endpoints)', () => {
  const allow = { allowPrivate: true };

  it('accepts the user-supplied LAN Ollama URL (192.168.68.105)', () => {
    expect(() => assertExternalUrlSafe('http://192.168.68.105:11434', 'Ollama', allow)).not.toThrow();
  });

  it('accepts loopback + other private ranges', () => {
    expect(() => assertExternalUrlSafe('http://localhost:11434', 'Ollama', allow)).not.toThrow();
    expect(() => assertExternalUrlSafe('http://127.0.0.1:11434', 'Ollama', allow)).not.toThrow();
    expect(() => assertExternalUrlSafe('http://10.1.2.3:8090', 'Ollama', allow)).not.toThrow();
    expect(() => assertExternalUrlSafe('http://172.16.5.5:11434', 'Ollama', allow)).not.toThrow();
    expect(() => assertExternalUrlSafe('http://[::1]:11434', 'Ollama', allow)).not.toThrow();
  });

  it('accepts Docker-network short names and .local hostnames', () => {
    expect(() => assertExternalUrlSafe('http://ollama:11434', 'Ollama', allow)).not.toThrow();
    expect(() => assertExternalUrlSafe('http://mybooks.local:11434', 'Ollama', allow)).not.toThrow();
  });

  it('STILL blocks the cloud-metadata endpoint even with allowPrivate', () => {
    expect(() => assertExternalUrlSafe('http://169.254.169.254/latest/meta-data/', 'Ollama', allow)).toThrow(
      /link-local \/ cloud metadata/,
    );
    expect(() => assertExternalUrlSafe('http://metadata.google.internal/', 'Ollama', allow)).toThrow(
      /blocked metadata hostname/,
    );
    expect(() => assertExternalUrlSafe('http://metadata/', 'Ollama', allow)).toThrow(/blocked metadata hostname/);
  });

  it('STILL blocks IPv6 link-local even with allowPrivate', () => {
    expect(() => assertExternalUrlSafe('http://[fe80::1]:11434', 'Ollama', allow)).toThrow(
      /link-local \/ cloud metadata/,
    );
  });

  it('still enforces scheme even with allowPrivate', () => {
    expect(() => assertExternalUrlSafe('ssh://192.168.68.105', 'Ollama', allow)).toThrow(/http or https/);
  });
});

describe('makeSafeLookup — connect-time DNS validation', () => {
  const doLookup = (hostname: string, opts?: Parameters<typeof makeSafeLookup>[0]) =>
    new Promise<string>((resolve, reject) => {
      const lookup = makeSafeLookup(opts) as (
        h: string,
        o: Record<string, unknown>,
        cb: (err: Error | null, address?: string, family?: number) => void,
      ) => void;
      lookup(hostname, {}, (err, address) => (err ? reject(err) : resolve(address!)));
    });

  it('blocks a hostname that resolves to loopback (the string check cannot see this)', async () => {
    await expect(doLookup('localhost')).rejects.toThrow(/blocked internal address/);
  });

  it('allows loopback-resolving hostnames under allowPrivate', async () => {
    await expect(doLookup('localhost', { allowPrivate: true })).resolves.toMatch(/^(127\.0\.0\.1|::1)$/);
  });

  it('errors (not hangs) on a non-existent hostname', async () => {
    await expect(doLookup('definitely-not-a-real-host.invalid')).rejects.toThrow();
  });
});

describe('assertExternalUrlSafe — alternate IP encodings (2026-08-18 review)', () => {
  it('blocks IPv4-mapped / hex-tail IPv6 loopback and unspecified literals', () => {
    expect(() => assertExternalUrlSafe('http://[::ffff:127.0.0.1]:6379/')).toThrow(/blocked IP range/);
    expect(() => assertExternalUrlSafe('http://[::ffff:7f00:1]:6379/')).toThrow(/blocked IP range/);
    expect(() => assertExternalUrlSafe('http://[::ffff:a9fe:a9fe]/latest/')).toThrow(/blocked IP range/);
    expect(() => assertExternalUrlSafe('http://[::]:80/')).toThrow(/blocked IP range/);
    expect(() => assertExternalUrlSafe('http://[0:0:0:0:0:0:0:1]/')).toThrow(/blocked IP range/);
    expect(() => assertExternalUrlSafe('http://[64:ff9b::7f00:1]/')).toThrow(/blocked IP range/);
  });
  it('blocks CGNAT (tailnet) and multicast/reserved v4 ranges', () => {
    expect(() => assertExternalUrlSafe('http://100.91.61.19/')).toThrow(/blocked IP range/);
    expect(() => assertExternalUrlSafe('http://224.0.0.1/')).toThrow(/blocked IP range/);
  });
  it('still accepts public IPv6 and IPv4 literals', () => {
    expect(() => assertExternalUrlSafe('http://[2606:4700:4700::1111]/')).not.toThrow();
    expect(() => assertExternalUrlSafe('http://[::ffff:8.8.8.8]/')).not.toThrow();
    expect(() => assertExternalUrlSafe('http://8.8.8.8/')).not.toThrow();
  });
});

describe('QA follow-ups (2026-08-18): canonical loopback in assertHostSafe, SSRF_ALLOW_PRIVATE_TARGETS', () => {
  const { assertHostSafe, classifyIpLiteral } = urlSafety;
  it('classifies loopback / reserved distinctly from private', () => {
    expect(classifyIpLiteral('127.0.0.1')).toBe('loopback');
    expect(classifyIpLiteral('::1')).toBe('loopback');
    expect(classifyIpLiteral('::ffff:7f00:1')).toBe('loopback');
    expect(classifyIpLiteral('0:0:0:0:0:0:0:1')).toBe('loopback');
    expect(classifyIpLiteral('0.0.0.0')).toBe('reserved');
    expect(classifyIpLiteral('::')).toBe('reserved');
    expect(classifyIpLiteral('10.1.2.3')).toBe('private');
    expect(classifyIpLiteral('100.91.61.19')).toBe('private');
    expect(classifyIpLiteral('169.254.169.254')).toBe('link-local');
  });
  it('assertHostSafe(allowPrivate) still refuses non-canonical IPv6 loopback spellings', async () => {
    await expect(assertHostSafe('::ffff:7f00:1', 'SMTP host', { allowPrivate: true })).rejects.toThrow(/loopback/);
    await expect(assertHostSafe('0:0:0:0:0:0:0:1', 'SMTP host', { allowPrivate: true })).rejects.toThrow(/loopback/);
    await expect(assertHostSafe('[::ffff:127.0.0.1]', 'SMTP host', { allowPrivate: true })).rejects.toThrow(/loopback/);
    await expect(assertHostSafe('0.0.0.0', 'SMTP host', { allowPrivate: true })).rejects.toThrow(/reserved/);
    // LAN relay is fine under allowPrivate; loopback is fine only with allowLoopback.
    await expect(assertHostSafe('192.168.1.25', 'SMTP host', { allowPrivate: true })).resolves.toBeUndefined();
    await expect(assertHostSafe('127.0.0.1', 'SMTP host', { allowPrivate: true, allowLoopback: true })).resolves.toBeUndefined();
  });
  it('SSRF_ALLOW_PRIVATE_TARGETS=1 opens RFC-1918/CGNAT for non-allowPrivate callers but never loopback/link-local', async () => {
    const prev = process.env['SSRF_ALLOW_PRIVATE_TARGETS'];
    process.env['SSRF_ALLOW_PRIVATE_TARGETS'] = '1';
    try {
      expect(() => assertExternalUrlSafe('http://100.91.61.19:9000/')).not.toThrow();
      expect(() => assertExternalUrlSafe('http://192.168.1.50/dav/')).not.toThrow();
      expect(() => assertExternalUrlSafe('http://127.0.0.1:9000/')).toThrow(/blocked IP range/);
      expect(() => assertExternalUrlSafe('http://[::ffff:7f00:1]:9000/')).toThrow(/blocked IP range/);
      expect(() => assertExternalUrlSafe('http://169.254.169.254/latest/')).toThrow(/blocked IP range/);
      expect(() => assertExternalUrlSafe('http://0.0.0.0:9000/')).toThrow(/blocked IP range/);
      await expect(assertHostSafe('10.0.0.5', 'SFTP host')).resolves.toBeUndefined();
      await expect(assertHostSafe('127.0.0.1', 'SFTP host')).rejects.toThrow(/loopback/);
    } finally {
      if (prev === undefined) delete process.env['SSRF_ALLOW_PRIVATE_TARGETS']; else process.env['SSRF_ALLOW_PRIVATE_TARGETS'] = prev;
    }
    // Default (unset) — private is blocked again for non-allowPrivate callers.
    expect(() => assertExternalUrlSafe('http://100.91.61.19:9000/')).toThrow(/blocked IP range/);
  });
});
