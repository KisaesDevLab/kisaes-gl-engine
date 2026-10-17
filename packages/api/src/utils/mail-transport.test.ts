// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// utils/mail-transport.ts: the server path is plain nodemailer; the
// desktop path adds timeouts and the offline fast-fail. Mail servers here
// are loopback stubs or `.invalid` names, so nothing leaves the machine.

import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import nodemailer from 'nodemailer';
import { loadDesktopProfile, _resetDesktopProfileForTests } from '../desktop/profile.js';
import { createMailTransport, DESKTOP_SMTP_TIMEOUTS, smtpTarget } from './mail-transport.js';
import { OfflineUnavailableError, _resetConnectivityForTests } from './offline.js';
import { sendOrThrow } from '../services/email.service.js';
import { testSmtpConnection } from '../services/setup.service.js';

function desktop(offline?: 'auto' | 'on' | 'off') {
  loadDesktopProfile({
    CL_MODE: 'desktop',
    CL_TOKEN: 'm'.repeat(48),
    CL_BIND: '127.0.0.1:0',
    CL_DATA_DIR: path.join(os.tmpdir(), 'cl-mail-transport-test'),
    ...(offline ? { CL_OFFLINE: offline } : {}),
  });
}

const MAIL = { from: 'a@example.test', to: 'b@example.test', subject: 's', text: 't' };

afterEach(() => {
  vi.restoreAllMocks();
  _resetConnectivityForTests();
  _resetDesktopProfileForTests();
});

describe('server mode (CL_MODE unset)', () => {
  it('is plain nodemailer.createTransport with the same options and methods', () => {
    loadDesktopProfile({});
    const spy = vi.spyOn(nodemailer, 'createTransport');
    const opts = { host: 'smtp.example.test', port: 587, secure: false, auth: { user: 'u', pass: 'p' } };
    const t = createMailTransport(opts);
    expect(spy).toHaveBeenCalledTimes(1);
    // Exactly the caller's options: no timeouts, no requireTLS.
    expect(spy.mock.calls[0]![0]).toEqual(opts);
    // Not wrapped: sendMail is nodemailer's own prototype method.
    expect(Object.prototype.hasOwnProperty.call(t, 'sendMail')).toBe(false);
  });
});

describe('desktop mode', () => {
  it('adds bounded timeouts; a caller value wins', () => {
    desktop();
    const spy = vi.spyOn(nodemailer, 'createTransport');
    createMailTransport({ host: 'smtp.example.test', port: 587 });
    expect(spy.mock.calls[0]![0]).toMatchObject(DESKTOP_SMTP_TIMEOUTS);
    createMailTransport({ host: 'smtp.example.test', port: 587, socketTimeout: 5_000 });
    expect(spy.mock.calls[1]![0]).toMatchObject({ connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 5_000 });
  });

  it('requires TLS by default, except for a loopback relay; a caller value wins', () => {
    desktop();
    const spy = vi.spyOn(nodemailer, 'createTransport');
    createMailTransport({ host: 'smtp.example.test', port: 587 });
    createMailTransport({ host: '127.0.0.1', port: 25 });
    createMailTransport({ host: 'localhost', port: 25 });
    createMailTransport({ host: 'smtp.example.test', port: 587, requireTLS: false });
    expect(spy.mock.calls.map((c) => (c[0] as { requireTLS?: boolean }).requireTLS)).toEqual([true, false, false, false]);
  });

  it('CL_OFFLINE=on: sendMail and verify fail with OFFLINE_UNAVAILABLE at once, no socket', async () => {
    desktop('on');
    const connect = vi.spyOn(net, 'connect');
    const t = createMailTransport({ host: 'smtp.example.test', port: 587 });
    const t0 = Date.now();
    await expect(t.sendMail(MAIL)).rejects.toBeInstanceOf(OfflineUnavailableError);
    await expect(t.verify()).rejects.toMatchObject({ code: 'OFFLINE_UNAVAILABLE', feature: 'smtp' });
    expect(Date.now() - t0).toBeLessThan(200);
    expect(connect).not.toHaveBeenCalled();
  });

  it('auto + unresolvable host: OFFLINE_UNAVAILABLE in < 2 s', async () => {
    desktop();
    const t = createMailTransport({ host: 'smtp.cl-offline.invalid', port: 587 });
    const t0 = Date.now();
    await expect(t.sendMail(MAIL)).rejects.toBeInstanceOf(OfflineUnavailableError);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('callback form gets the same error', async () => {
    desktop('on');
    const t = createMailTransport({ host: 'smtp.example.test', port: 587 });
    const err = await new Promise<Error | null>((resolve) => {
      (t.sendMail as unknown as (m: unknown, cb: (e: Error | null) => void) => void)(MAIL, (e) => resolve(e));
    });
    expect(err).toBeInstanceOf(OfflineUnavailableError);
  });

  it('a reachable server that misbehaves gives the ordinary SMTP error, not OFFLINE', async () => {
    desktop();
    const srv = net.createServer((s) => {
      s.on('error', () => undefined);
      s.end('554 go away\r\n');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    try {
      const t = createMailTransport({ host: '127.0.0.1', port, secure: false, connectionTimeout: 2_000, greetingTimeout: 2_000 });
      const err = await t.sendMail(MAIL).then(() => null, (e: { code?: string }) => e);
      expect(err).not.toBeNull();
      expect(err).not.toBeInstanceOf(OfflineUnavailableError);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe('callers keep OFFLINE_UNAVAILABLE', () => {
  it('sendOrThrow passes an AppError through instead of SMTP_SEND_FAILED', async () => {
    desktop('on');
    const t = createMailTransport({ host: 'smtp.example.test', port: 587 });
    await expect(sendOrThrow(t, MAIL)).rejects.toMatchObject({ code: 'OFFLINE_UNAVAILABLE', statusCode: 503 });
  });

  it('testSmtpConnection throws OFFLINE_UNAVAILABLE on desktop and still returns {success:false} on the server', async () => {
    desktop('on');
    const cfg = { host: 'smtp.example.test', port: 587, from: 'a@example.test' };
    await expect(testSmtpConnection(cfg)).rejects.toBeInstanceOf(OfflineUnavailableError);
    _resetDesktopProfileForTests();
    loadDesktopProfile({});
    const r = await testSmtpConnection({ ...cfg, host: '127.0.0.1' });
    expect(r.success).toBe(false);
  });

  it('SMTP test: the host safety check runs before any connectivity probe', async () => {
    desktop();
    const connect = vi.spyOn(net, 'connect');
    for (const host of ['169.254.169.254', 'localhost', '127.0.0.1']) {
      const r = await testSmtpConnection({ host, port: 587, from: 'a@example.test' });
      expect(r.success, host).toBe(false);
      expect(r.error, host).toMatch(/SMTP host/);
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it('a loopback mail relay is not "offline", even with CL_OFFLINE=on', async () => {
    desktop('on');
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    await new Promise<void>((r) => srv.close(() => r()));
    const t = createMailTransport({ host: '127.0.0.1', port, connectionTimeout: 1_000 });
    const err = await t.sendMail(MAIL).then(() => null, (e: { code?: string }) => e);
    expect(err).not.toBeInstanceOf(OfflineUnavailableError);
    expect((err as { code?: string }).code).toBe('ESOCKET');
  });

  it('smtpTarget follows nodemailer defaults', () => {
    expect(smtpTarget({})).toEqual({ host: 'localhost', port: 587 });
    expect(smtpTarget({ host: 'm.example.test', secure: true })).toEqual({ host: 'm.example.test', port: 465 });
    expect(smtpTarget({ host: 'm.example.test', port: 2525 })).toEqual({ host: 'm.example.test', port: 2525 });
  });
});
