// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// security-audit is on every auth-path fail-open branch (HIBP,
// Turnstile, rate-limit-redis). The coalescing window is the only
// thing keeping a CF-siteverify outage from writing a million audit
// rows during a login storm, so the behavior is pinned explicitly
// here.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../middleware/audit.js', () => ({
  auditLog: vi.fn(async () => undefined),
}));

import { auditLog } from '../middleware/audit.js';
import { recordSecurityEvent, __internal } from './security-audit.js';

const auditLogMock = auditLog as unknown as ReturnType<typeof vi.fn>;

describe('recordSecurityEvent', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __internal.reset();
    auditLogMock.mockReset();
    auditLogMock.mockResolvedValue(undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it('writes an audit row and logs a warn on first firing', async () => {
    recordSecurityEvent({ component: 'hibp', reason: 'timeout' });
    // auditLog is fire-and-forget — flush the microtask queue so the
    // void Promise has a chance to reject/resolve before we assert.
    await new Promise((r) => setImmediate(r));

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toContain('[security-degraded] hibp fail-open: timeout');
    expect(auditLogMock).toHaveBeenCalledOnce();
    const call = auditLogMock.mock.calls[0]!;
    expect(call[0]).toBe('00000000-0000-0000-0000-000000000000'); // system tenant
    expect(call[1]).toBe('update');
    expect(call[2]).toBe('security_degraded');
    expect(call[5]).toMatchObject({ component: 'hibp', reason: 'timeout', suppressedCount: 0 });
  });

  it('coalesces repeated (component, reason) within the default window', async () => {
    recordSecurityEvent({ component: 'turnstile', reason: 'network_error' });
    recordSecurityEvent({ component: 'turnstile', reason: 'network_error' });
    recordSecurityEvent({ component: 'turnstile', reason: 'network_error' });
    await new Promise((r) => setImmediate(r));

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(auditLogMock).toHaveBeenCalledOnce();
  });

  it('treats different reasons as independent keys', async () => {
    recordSecurityEvent({ component: 'turnstile', reason: 'timeout' });
    recordSecurityEvent({ component: 'turnstile', reason: 'network_error' });
    await new Promise((r) => setImmediate(r));

    expect(auditLogMock).toHaveBeenCalledTimes(2);
  });

  it('treats different components as independent keys', async () => {
    recordSecurityEvent({ component: 'hibp', reason: 'timeout' });
    recordSecurityEvent({ component: 'rate_limit_redis', reason: 'timeout' });
    await new Promise((r) => setImmediate(r));

    expect(auditLogMock).toHaveBeenCalledTimes(2);
  });

  it('fires a second audit once the window elapses and reports the suppressed count', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T12:00:00Z'));

    recordSecurityEvent({ component: 'hibp', reason: 'timeout', windowMs: 1000 });
    recordSecurityEvent({ component: 'hibp', reason: 'timeout', windowMs: 1000 });
    recordSecurityEvent({ component: 'hibp', reason: 'timeout', windowMs: 1000 });
    expect(auditLogMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-04-20T12:00:02Z'));
    recordSecurityEvent({ component: 'hibp', reason: 'timeout', windowMs: 1000 });
    // Drain microtasks with real-time scheduling so the fire-and-forget
    // audit write lands before we assert.
    vi.useRealTimers();
    await new Promise((r) => setImmediate(r));

    expect(auditLogMock).toHaveBeenCalledTimes(2);
    const second = auditLogMock.mock.calls[1]!;
    expect(second[5]).toMatchObject({ component: 'hibp', reason: 'timeout', suppressedCount: 2 });
  });

  it('swallows audit write failures without throwing to the caller', async () => {
    auditLogMock.mockRejectedValueOnce(new Error('db down'));
    expect(() => recordSecurityEvent({ component: 'hibp', reason: 'timeout' })).not.toThrow();
    // The rejection handler is attached via .catch() on the returned
    // Promise — that needs at least two microtask flushes (one for the
    // mock to settle, one for the .catch callback) before the second
    // warn lands. Pump a few to be safe without using timers.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    // Both warns land on console.warn — the first as a single-string
    // message, the second as ('...audit write failed:', err.message).
    // Flatten all args per call into one string for matching.
    const messages = warnSpy.mock.calls.map((args) => args.map((a) => String(a ?? '')).join(' '));
    expect(messages.some((m) => m.includes('[security-degraded] hibp fail-open: timeout'))).toBe(true);
    expect(messages.some((m) => m.includes('audit write failed:') && m.includes('db down'))).toBe(true);
  });

  it('respects a custom windowMs override per call', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T12:00:00Z'));

    recordSecurityEvent({ component: 'hibp', reason: 'network_error', windowMs: 100 });
    vi.setSystemTime(new Date('2026-04-20T12:00:00.050Z'));
    recordSecurityEvent({ component: 'hibp', reason: 'network_error', windowMs: 100 });
    expect(auditLogMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-04-20T12:00:00.200Z'));
    recordSecurityEvent({ component: 'hibp', reason: 'network_error', windowMs: 100 });
    vi.useRealTimers();
    await new Promise((r) => setImmediate(r));

    expect(auditLogMock).toHaveBeenCalledTimes(2);
  });

  it('__internal.size tracks the number of live window keys', () => {
    expect(__internal.size()).toBe(0);
    recordSecurityEvent({ component: 'hibp', reason: 'timeout' });
    expect(__internal.size()).toBe(1);
    recordSecurityEvent({ component: 'turnstile', reason: 'timeout' });
    expect(__internal.size()).toBe(2);
    recordSecurityEvent({ component: 'hibp', reason: 'timeout' }); // coalesced, no new key
    expect(__internal.size()).toBe(2);
  });
});
