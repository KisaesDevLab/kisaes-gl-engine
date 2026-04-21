// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  isNewerVersion,
  getCurrentVersion,
  checkForUpdate,
  __internal,
} from './updates.service.js';

describe('isNewerVersion', () => {
  it.each([
    ['v1.2.3', 'v1.2.4', true],
    ['v1.2.3', 'v1.3.0', true],
    ['v1.2.3', 'v2.0.0', true],
    ['1.2.3', 'v1.2.3', false],
    ['v1.2.3', 'v1.2.3', false],
    ['v1.2.3', 'v1.2.2', false],
    ['v1.2.3', 'v0.9.9', false],
    // Mixed prefix — parser strips the leading `v` before comparing.
    ['v1.0.0', '1.0.1', true],
    ['1.0.0', 'v1.0.1', true],
  ])('%s → %s is newer=%s', (cur, cand, expected) => {
    expect(isNewerVersion(cur, cand)).toBe(expected);
  });

  it('returns false when the current version is unparseable', () => {
    expect(isNewerVersion('unknown', 'v1.2.3')).toBe(false);
    expect(isNewerVersion('dev', 'v1.2.3')).toBe(false);
    expect(isNewerVersion('latest', 'v1.2.3')).toBe(false);
  });

  it('returns false when the candidate version is unparseable', () => {
    expect(isNewerVersion('v1.2.3', 'main')).toBe(false);
    expect(isNewerVersion('v1.2.3', 'v1.2.3-rc.1')).toBe(false);
  });
});

describe('getCurrentVersion', () => {
  // env.ts loads at module-init time, so we can't mutate env.
  // VIBE_MYBOOKS_VERSION here at runtime. We exercise the VIBE_MYBOOKS_TAG
  // fallback and the hardcoded "unknown" safety net instead.
  let originalTag: string | undefined;

  beforeEach(() => {
    originalTag = process.env['VIBE_MYBOOKS_TAG'];
  });
  afterEach(() => {
    if (originalTag === undefined) delete process.env['VIBE_MYBOOKS_TAG'];
    else process.env['VIBE_MYBOOKS_TAG'] = originalTag;
  });

  it('falls back to VIBE_MYBOOKS_TAG when the build stamp is absent', () => {
    process.env['VIBE_MYBOOKS_TAG'] = 'v9.9.9';
    // env.VIBE_MYBOOKS_VERSION is undefined in the test env, so the
    // function falls through to the tag.
    const v = getCurrentVersion();
    // When run from source via vitest, env.VIBE_MYBOOKS_VERSION is
    // undefined. Either the stamp-path or tag-path should land on
    // something truthy and non-"unknown".
    expect(v).not.toBe('unknown');
  });

  it('returns "unknown" when neither the stamp nor the tag is set', () => {
    delete process.env['VIBE_MYBOOKS_TAG'];
    // This test is only meaningful when env.VIBE_MYBOOKS_VERSION is
    // also absent — which it is in `npm run test`.
    expect(getCurrentVersion()).toBe('unknown');
  });
});

describe('checkForUpdate', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __internal.reset();
    fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockRelease(body: Partial<{
    tag_name: string;
    html_url: string;
    published_at: string;
    body: string;
  }>) {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response);
  }

  function mockHttpError(status: number) {
    fetchSpy.mockResolvedValue({ ok: false, status } as unknown as Response);
  }

  it('returns latest + isNewer=true when the release is ahead of current', async () => {
    process.env['VIBE_MYBOOKS_TAG'] = 'v1.0.0';
    mockRelease({
      tag_name: 'v1.2.0',
      html_url: 'https://github.com/KisaesDevLab/Vibe-MyBooks/releases/tag/v1.2.0',
      published_at: '2026-04-01T00:00:00Z',
      body: 'Fixes and features',
    });

    const r = await checkForUpdate();
    expect(r.latest).toBe('v1.2.0');
    expect(r.isNewer).toBe(true);
    expect(r.releaseUrl).toContain('/releases/tag/v1.2.0');
    expect(r.releaseNotes).toBe('Fixes and features');
    expect(r.error).toBeUndefined();
    delete process.env['VIBE_MYBOOKS_TAG'];
  });

  it('returns isNewer=false when current matches latest', async () => {
    process.env['VIBE_MYBOOKS_TAG'] = 'v1.2.0';
    mockRelease({
      tag_name: 'v1.2.0',
      html_url: 'https://example.com',
      published_at: '2026-04-01T00:00:00Z',
    });

    const r = await checkForUpdate();
    expect(r.isNewer).toBe(false);
    delete process.env['VIBE_MYBOOKS_TAG'];
  });

  it('truncates long release notes at 8KB', async () => {
    const huge = 'a'.repeat(10_000);
    mockRelease({ tag_name: 'v1.0.0', html_url: '', published_at: '', body: huge });

    const r = await checkForUpdate();
    expect(r.releaseNotes!.length).toBeLessThanOrEqual(8 * 1024 + 20 /* truncation marker */);
    expect(r.releaseNotes).toContain('…(truncated)');
  });

  it('caches successful results for the TTL window', async () => {
    mockRelease({ tag_name: 'v1.0.0', html_url: '', published_at: '' });

    await checkForUpdate();
    await checkForUpdate();
    await checkForUpdate();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('force=true bypasses the cache', async () => {
    mockRelease({ tag_name: 'v1.0.0', html_url: '', published_at: '' });

    await checkForUpdate();
    await checkForUpdate(true);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('surfaces the error + caches it briefly on HTTP failure', async () => {
    mockHttpError(503);

    const r = await checkForUpdate();
    expect(r.latest).toBeNull();
    expect(r.isNewer).toBe(false);
    expect(r.error).toMatch(/503/);

    // Second call within the short failure-cache window should not
    // re-fetch — this is the "transient GitHub outage" protection.
    await checkForUpdate();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('surfaces the error when GitHub responds 200 with a malformed body', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);

    const r = await checkForUpdate();
    expect(r.error).toMatch(/tag_name/);
  });

  it('returns error on network timeout / abort', async () => {
    fetchSpy.mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    const r = await checkForUpdate();
    expect(r.error).toBe('aborted');
    expect(r.latest).toBeNull();
  });

  it('sends a User-Agent (GitHub API requires it)', async () => {
    mockRelease({ tag_name: 'v1.0.0', html_url: '', published_at: '' });

    await checkForUpdate();
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.['User-Agent']).toBeTruthy();
  });
});

describe('__internal.parseSemver', () => {
  it('accepts v-prefixed and bare versions', () => {
    expect(__internal.parseSemver('v1.2.3')).toEqual([1, 2, 3]);
    expect(__internal.parseSemver('1.2.3')).toEqual([1, 2, 3]);
  });

  it('rejects prereleases and non-numeric identifiers', () => {
    expect(__internal.parseSemver('v1.2.3-rc.1')).toBeNull();
    expect(__internal.parseSemver('latest')).toBeNull();
    expect(__internal.parseSemver('dev')).toBeNull();
    expect(__internal.parseSemver('')).toBeNull();
  });
});
