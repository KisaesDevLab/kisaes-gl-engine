// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { assertExternalUrlSafe } from './url-safety.js';

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
