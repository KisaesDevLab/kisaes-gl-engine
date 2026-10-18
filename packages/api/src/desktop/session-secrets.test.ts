// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Session secrets store (E6): memory only, scrubber registration, egress
// allowances per docs/DESKTOP.md "Rules for features that open egress".

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as s from './session-secrets.js';
import { egressAllowlist, _uninstallEgressGuardForTests } from './egress-guard.js';
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

  it('clearAllSessionSecrets drops every value and allowance', () => {
    s.setAnthropicKey(KEY);
    s.setOpenaiKey('sk-proj-' + 'z'.repeat(30));
    s.setOllamaBaseUrl('http://192.168.1.20:11434', 'llama3.2');
    s.setSmtpPassword('hunter2hunter2');
    s.clearAllSessionSecrets();
    expect(Object.values(s.sessionSecretStatus()).every((v) => v.present === false)).toBe(true);
    expect(egressAllowlist().filter((e) => e.source !== 'static')).toEqual([]);
    expect(s.getSessionOllamaModel()).toBeNull();
  });
});

describe('Ollama base URL (U-11, DESKTOP.md L-6)', () => {
  it('loopback: stored and normalized, no allowance needed', () => {
    expect(s.setOllamaBaseUrl('http://localhost:11434/v1/', 'qwen3')).toBe('http://localhost:11434');
    expect(s.getSessionSecret('ai.ollama.baseUrl')).toBe('http://localhost:11434');
    expect(s.getSessionOllamaModel()).toBe('qwen3');
    expect(allowed('ai.ollama')).toEqual([]);
  });

  it('a LAN box is allowed on its port only, by the owner\'s explicit choice', () => {
    s.setOllamaBaseUrl('http://192.168.1.20:11434');
    expect(allowed('ai.ollama')).toEqual([{ host: '192.168.1.20', port: 11434 }]);
    s.setOllamaBaseUrl('https://ollama.lan');
    expect(allowed('ai.ollama')).toEqual([{ host: 'ollama.lan', port: 443 }]);
    s.deleteSessionSecret('ai.ollama.baseUrl');
    expect(allowed('ai.ollama')).toEqual([]);
  });

  it.each([
    ['ftp://10.0.0.5:11434', /http or https/],
    ['http://user:pw@10.0.0.5:11434', /credentials/],
    ['http://169.254.169.254/', /link-local/],
    ['http://metadata.google.internal/', /metadata/],
    ['not a url', /valid URL/],
  ])('refuses %s', (url, re) => {
    expect(() => s.validateOllamaBaseUrl(url)).toThrow(re);
    try {
      s.setOllamaBaseUrl(url);
    } catch (err) {
      expect((err as { code?: string }).code).toBe('OLLAMA_URL_INVALID');
      expect((err as { statusCode?: number }).statusCode).toBe(400);
    }
    expect(s.hasSessionSecret('ai.ollama.baseUrl')).toBe(false);
    expect(allowed('ai.ollama')).toEqual([]);
  });

  it('the base URL is not registered with the scrubber (it is not a secret)', () => {
    s.setOllamaBaseUrl('http://192.168.1.20:11434');
    expect(scrubSecrets('http://192.168.1.20:11434')).toBe('http://192.168.1.20:11434');
  });
});

describe('SMTP (U-13)', () => {
  it('the password is scrubbed and opens nothing by itself', () => {
    s.setSmtpPassword('hunter2hunter2');
    expect(scrubSecrets('535 hunter2hunter2 rejected')).toBe('535 [redacted] rejected');
    expect(allowed('smtp')).toEqual([]);
  });

  it('ensureSmtpEgress allows a validated host on a mail port; the password clear removes it', async () => {
    s.setSmtpPassword('hunter2hunter2');
    await s.ensureSmtpEgress({ host: '10.0.0.25', port: 587 });
    expect(allowed('smtp')).toEqual([{ host: '10.0.0.25', port: 587 }]);
    await s.ensureSmtpEgress({ host: '10.0.0.25', port: 465 });
    expect(allowed('smtp')).toEqual([{ host: '10.0.0.25', port: 465 }]);
    s.deleteSessionSecret('smtp.password');
    expect(allowed('smtp')).toEqual([]);
  });

  it('loopback relays need no allowance', async () => {
    await s.ensureSmtpEgress({ host: '127.0.0.1', port: 1025 });
    expect(allowed('smtp')).toEqual([]);
  });

  it.each([
    [{ host: '10.0.0.25', port: 8025 }, /port 8025/],
    [{ host: '169.254.169.254', port: 587 }, /link-local/],
    [{ host: 'metadata', port: 25 }, /metadata/],
  ])('refuses %o', async (target, re) => {
    await expect(s.ensureSmtpEgress(target)).rejects.toMatchObject({ code: 'SMTP_HOST_BLOCKED', statusCode: 400 });
    await expect(s.ensureSmtpEgress(target)).rejects.toThrow(re);
    expect(allowed('smtp')).toEqual([]);
  });
});
