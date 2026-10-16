// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// report-export toPdf(): Chromium must not load anything but the injected
// document. puppeteer is mocked; the test checks the launch flags and what
// the request handler lets through.

import { describe, it, expect, vi } from 'vitest';

type Handler = (req: { url(): string; continue(): Promise<void>; abort(): Promise<void> }) => void;
const state = vi.hoisted(() => ({
  launchArgs: [] as string[],
  js: true as boolean,
  intercept: false as boolean,
  handler: null as null | ((req: { url(): string; continue(): Promise<void>; abort(): Promise<void> }) => void),
}));

vi.mock('puppeteer', () => ({
  default: {
    launch: async (opts: { args: string[] }) => {
      state.launchArgs = opts.args;
      return {
        newPage: async () => ({
          setJavaScriptEnabled: async (on: boolean) => { state.js = on; },
          setRequestInterception: async (on: boolean) => { state.intercept = on; },
          on: (_ev: string, h: Handler) => { state.handler = h; },
          setContent: async () => undefined,
          pdf: async () => new Uint8Array([37, 80, 68, 70]),
        }),
        close: async () => undefined,
      };
    },
  },
}));

import { toPdf } from './report-export.service.js';

describe('report-export toPdf network hardening', () => {
  it('disables background networking and JavaScript, and lets only data:/about: load', async () => {
    const pdf = await toPdf('<html><body><img src="https://tracker.example/x.png"></body></html>');
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(state.launchArgs).toContain('--disable-background-networking');
    expect(state.js).toBe(false);
    expect(state.intercept).toBe(true);
    const outcome = (url: string) => {
      let r = '';
      state.handler!({ url: () => url, continue: async () => { r = 'continue'; }, abort: async () => { r = 'abort'; } });
      return r;
    };
    expect(outcome('about:blank')).toBe('continue');
    expect(outcome('data:image/png;base64,AAAA')).toBe('continue');
    for (const url of ['https://tracker.example/x.png', 'http://127.0.0.1:3001/x', 'file:///etc/passwd', 'ws://example.test/']) {
      expect(outcome(url), url).toBe('abort');
    }
  });
});
