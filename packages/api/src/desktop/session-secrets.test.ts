// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Session secrets store (E6): memory only, scrubber registration, egress
// allowances per docs/DESKTOP.md "Rules for features that open egress".

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as s from './session-secrets.js';
import { egressAllowlist, exemptDnsLookup, installEgressGuard, isLoopbackHost, _uninstallEgressGuardForTests } from './egress-guard.js';
import { scrubSecrets, _resetSecretScrubberForTests } from '../utils/secret-scrubber.js';

const KEY = 'sk-ant-api03-canary-' + 'Q'.repeat(40);

function allowed(source: string): Array<{ host: string; port: number | null }> {
  return egressAllowlist().filter((e) => e.source === source).map(({ host, port }) => ({ host, port }));
}

beforeEach(() => {
  _resetSecretScrubberForTests();
  s.clearAllSessionSecrets();
});

afterEach(() => {
  s.clearAllSessionSecrets();
  _resetSecretScrubberForTests();
  _uninstallEgressGuardForTests();
});

describe('session secrets store', () => {
  it('starts empty and reports every name with present:false', () => {
    expect(s.sessionSecretStatus()).toEqual({
      'ai.anthropic': { present: false },
      'ai.openai': { present: false },
      'ai.ollama.baseUrl': { present: false },
      'smtp.password': { present: false },
    });
  });

  it('a cloud key is stored, fingerprinted, scrubbed and opens exactly its fixed host', () => {
    s.setAnthropicKey(KEY);
    expect(s.getSessionSecret('ai.anthropic')).toBe(KEY);
    const status = s.sessionSecretStatus()['ai.anthropic'];
    expect(status.present).toBe(true);
    expect(status.fingerprint).toMatch(/^sha256:[0-9a-f]{8}$/);
    expect(JSON.stringify(s.sessionSecretStatus())).not.toContain(KEY);
    expect(scrubSecrets(`provider said: ${KEY}`)).not.toContain(KEY);
    expect(allowed('ai.anthropic')).toEqual([{ host: 'api.anthropic.com', port: 443 }]);
    expect(allowed('ai.openai')).toEqual([]);

    s.setOpenaiKey('sk-proj-' + 'z'.repeat(30));
    expect(allowed('ai.openai')).toEqual([{ host: 'api.openai.com', port: 443 }]);
  });

  it('fingerprints are stable and differ per value', () => {
    expect(s.fingerprint('abc')).toBe(s.fingerprint('abc'));
    expect(s.fingerprint('abc')).not.toBe(s.fingerprint('abd'));
  });

  it('deleting a key removes the allowance but keeps the scrubber registration', () => {
    s.setAnthropicKey(KEY);
    expect(s.deleteSessionSecret('ai.anthropic')).toBe(true);
    expect(s.hasSessionSecret('ai.anthropic')).toBe(false);
    expect(allowed('ai.anthropic')).toEqual([]);
    expect(scrubSecrets(KEY)).toBe('[redacted]');
    expect(s.deleteSessionSecret('ai.anthropic')).toBe(false);
  });

  it('clearAllSessionSecrets drops every value and allowance', async () => {
    s.setAnthropicKey(KEY);
    s.setOpenaiKey('sk-proj-' + 'z'.repeat(30));
    await s.setOllamaBaseUrl('http://192.168.1.20:11434', 'llama3.2');
    s.setSmtpPassword('hunter2hunter2');
    s.clearAllSessionSecrets();
    expect(Object.values(s.sessionSecretStatus()).every((v) => v.present === false)).toBe(true);
    expect(egressAllowlist().filter((e) => e.source !== 'static')).toEqual([]);
    expect(s.getSessionOllamaModel()).toBeNull();
  });
});

describe('Ollama base URL (U-11, DESKTOP.md L-6)', () => {
  beforeEach(() => {
    // Owner-named `.local` names resolve through the stub (never the network).
    s._setDnsLookupForTests(async (host) => {
      if (host === 'box.local') return [{ address: '192.168.1.44' }];
      if (host === 'mixed.local') return [{ address: '192.168.1.44' }, { address: '203.0.113.5' }];
      if (host === 'cgnat.local') return [{ address: '100.64.1.2' }];
      return [];
    });
  });
  afterEach(() => s._setDnsLookupForTests(null));

  it('loopback: stored and normalized, no allowance needed', async () => {
    await expect(s.setOllamaBaseUrl('http://localhost:11434/v1/', 'qwen3')).resolves.toBe('http://localhost:11434');
    expect(s.getSessionSecret('ai.ollama.baseUrl')).toBe('http://localhost:11434');
    expect(s.getSessionOllamaModel()).toBe('qwen3');
    expect(allowed('ai.ollama')).toEqual([]);
  });

  it("a LAN box is allowed on its port only, by the owner's explicit choice", async () => {
    await s.setOllamaBaseUrl('http://192.168.1.20:11434');
    expect(allowed('ai.ollama')).toEqual([{ host: '192.168.1.20', port: 11434 }]);
    await s.setOllamaBaseUrl('https://box.local');
    expect(allowed('ai.ollama')).toEqual([{ host: 'box.local', port: 443 }]);
    s.deleteSessionSecret('ai.ollama.baseUrl');
    expect(allowed('ai.ollama')).toEqual([]);
  });

  it.each(['http://10.1.2.3:11434', 'http://172.16.5.5:11434', 'http://[fd12::1]:11434', 'http://box.local:11434', 'http://localhost:11434', 'http://127.0.0.2:11434'])
  ('accepts the local-network host %s', async (url) => {
    await expect(s.validateOllamaBaseUrl(url)).resolves.toBeTruthy();
  });

  it.each(['https://api.example.com', 'http://8.8.8.8:11434', 'http://ollama.lan:11434', 'http://[2001:db8::1]:11434', 'http://box.local.example.com',
    'http://100.64.0.9:11434', 'http://mixed.local:11434', 'http://cgnat.local:11434', 'http://unknown.local:11434'])
  ('refuses %s with OLLAMA_HOST_NOT_LOCAL (public, CGNAT, unresolved or partly public .local)', async (url) => {
    await expect(s.setOllamaBaseUrl(url)).rejects.toMatchObject({ code: 'OLLAMA_HOST_NOT_LOCAL', statusCode: 400 });
    expect(s.hasSessionSecret('ai.ollama.baseUrl')).toBe(false);
    expect(allowed('ai.ollama')).toEqual([]);
  });

  it.each([
    ['ftp://10.0.0.5:11434', /http or https/],
    ['http://user:pw@10.0.0.5:11434', /credentials/],
    ['http://169.254.169.254/', /link-local/],
    ['http://metadata.google.internal/', /metadata/],
    ['not a url', /valid URL/],
  ])('refuses %s', async (url, re) => {
    await expect(s.validateOllamaBaseUrl(url)).rejects.toThrow(re);
    await expect(s.setOllamaBaseUrl(url)).rejects.toMatchObject({ code: 'OLLAMA_URL_INVALID', statusCode: 400 });
    expect(s.hasSessionSecret('ai.ollama.baseUrl')).toBe(false);
    expect(allowed('ai.ollama')).toEqual([]);
  });

  it('isLocalNetworkHost / isLocalNetworkAddress: CGNAT is carrier space, not local', () => {
    expect(['localhost', 'LOCALHOST', 'nas.local', '127.0.0.1', '::1', '[::1]', '10.0.0.1', '192.168.0.1', '172.31.255.255', 'fc00::1'].every(s.isLocalNetworkHost)).toBe(true);
    expect(['example.com', '8.8.8.8', '172.32.0.1', '100.64.0.1', '100.127.255.255', '100.128.0.1', '2001:db8::1', 'mail.lan', 'localhost.'].some(s.isLocalNetworkHost)).toBe(false);
    expect(s.isLocalNetworkAddress('100.64.0.1')).toBe(false);
    expect(s.isLocalNetworkAddress('nas.local')).toBe(false);
  });

  it('the base URL is not registered with the scrubber (it is not a secret)', async () => {
    await s.setOllamaBaseUrl('http://192.168.1.20:11434');
    expect(scrubSecrets('http://192.168.1.20:11434')).toBe('http://192.168.1.20:11434');
  });
});

describe('SMTP (U-13)', () => {
  afterEach(() => s._setDnsLookupForTests(null));

  it('a name is resolved past the installed guard and checked; no answer fails closed', async () => {
    installEgressGuard({});
    const seen: string[] = [];
    s._setDnsLookupForTests(async (host) => {
      seen.push(host);
      if (host === 'mail.example.test') return [{ address: '203.0.113.9' }];
      if (host === 'meta.example.test') return [{ address: '203.0.113.9' }, { address: '169.254.169.254' }];
      if (host === 'loop.example.test') return [{ address: '127.0.0.1' }];
      return [];
    });
    await s.allowSmtpEgress({ host: 'mail.example.test', port: 587 });
    expect(allowed('smtp')).toEqual([{ host: 'mail.example.test', port: 587 }]);
    for (const host of ['meta.example.test', 'loop.example.test', 'dead.example.test']) {
      await expect(s.allowSmtpEgress({ host, port: 587 })).rejects.toMatchObject({ code: 'SMTP_HOST_BLOCKED' });
    }
    expect(seen).toEqual(['mail.example.test', 'meta.example.test', 'loop.example.test', 'dead.example.test']);
    // The previous allowance survives refused requests.
    expect(allowed('smtp')).toEqual([{ host: 'mail.example.test', port: 587 }]);
  });

  it('exemptDnsLookup bypasses the guard (localhost resolves with it installed)', async () => {
    installEgressGuard({});
    const answers = await exemptDnsLookup('localhost');
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.every((a) => isLoopbackHost(a.address))).toBe(true);
  });

  it("security 'none' with a .local name needs the name to resolve locally", async () => {
    s._setDnsLookupForTests(async (host) => (host === 'relay.local' ? [{ address: '10.0.0.7' }] : [{ address: '203.0.113.9' }]));
    await s.allowSmtpEgress({ host: 'relay.local', port: 25, security: 'none' });
    expect(s.getSessionSmtpServer()?.security).toBe('none');
    await expect(s.allowSmtpEgress({ host: 'far.local', port: 25, security: 'none' })).rejects.toMatchObject({ code: 'SMTP_SECURITY_REQUIRED' });
  });
  it('the password is scrubbed and opens nothing by itself', () => {
    s.setSmtpPassword('hunter2hunter2');
    expect(scrubSecrets('535 hunter2hunter2 rejected')).toBe('535 [redacted] rejected');
    expect(allowed('smtp')).toEqual([]);
  });

  it('allowSmtpEgress allows a validated host on a mail port; the password clear removes it', async () => {
    s.setSmtpPassword('hunter2hunter2');
    await s.allowSmtpEgress({ host: '10.0.0.25', port: 587 });
    expect(allowed('smtp')).toEqual([{ host: '10.0.0.25', port: 587 }]);
    expect(s.getSessionSmtpServer()).toEqual({ host: '10.0.0.25', port: 587, security: 'starttls' });
    await s.allowSmtpEgress({ host: '10.0.0.25', port: 465 });
    expect(allowed('smtp')).toEqual([{ host: '10.0.0.25', port: 465 }]);
    expect(s.getSessionSmtpServer()).toEqual({ host: '10.0.0.25', port: 465, security: 'tls' });
    s.deleteSessionSecret('smtp.password');
    expect(allowed('smtp')).toEqual([]);
    expect(s.getSessionSmtpServer()).toBeNull();
  });

  it('loopback relays need no allowance', async () => {
    await s.allowSmtpEgress({ host: '127.0.0.1', port: 1025, security: 'none' });
    expect(allowed('smtp')).toEqual([]);
    expect(s.getSessionSmtpServer()).toEqual({ host: '127.0.0.1', port: 1025, security: 'none' });
  });

  it("security 'none' is only accepted for a local-network host", async () => {
    await s.allowSmtpEgress({ host: '192.168.1.5', port: 25, security: 'none' });
    expect(s.getSessionSmtpServer()?.security).toBe('none');
    await expect(s.allowSmtpEgress({ host: '203.0.113.9', port: 25, security: 'none' }))
      .rejects.toMatchObject({ code: 'SMTP_SECURITY_REQUIRED', statusCode: 400 });
    // The previous server is untouched by the refused request.
    expect(s.getSessionSmtpServer()).toEqual({ host: '192.168.1.5', port: 25, security: 'none' });
    expect(allowed('smtp')).toEqual([{ host: '192.168.1.5', port: 25 }]);
    await s.allowSmtpEgress({ host: '203.0.113.9', port: 587, security: 'starttls' });
    expect(allowed('smtp')).toEqual([{ host: '203.0.113.9', port: 587 }]);
  });

  it.each([
    [{ host: '10.0.0.25', port: 8025 }, /port 8025/],
    [{ host: '169.254.169.254', port: 587 }, /link-local/],
    [{ host: 'metadata', port: 25 }, /metadata/],
  ])('refuses %o', async (target, re) => {
    await expect(s.allowSmtpEgress(target)).rejects.toMatchObject({ code: 'SMTP_HOST_BLOCKED', statusCode: 400 });
    await expect(s.allowSmtpEgress(target)).rejects.toThrow(re);
    expect(allowed('smtp')).toEqual([]);
  });
});
