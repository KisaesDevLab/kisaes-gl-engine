// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// U-13: in desktop mode the SMTP password comes from the session store and
// nowhere else. nodemailer is mocked so the options the transport is built
// with can be inspected; no network.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ created: [] as Array<Record<string, unknown>> }));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: (opts: Record<string, unknown>) => {
      mocks.created.push(opts);
      return { options: opts, verify: async () => true, sendMail: async () => ({ messageId: 'm' }) };
    },
  },
}));

import { loadDesktopProfile, _resetDesktopProfileForTests } from '../desktop/profile.js';
import * as secrets from '../desktop/session-secrets.js';
import { createMailTransport } from './mail-transport.js';

function desktop(): void {
  loadDesktopProfile({ CL_MODE: 'desktop', CL_TOKEN: 'mail_' + 'm'.repeat(44), CL_BIND: '127.0.0.1:0', CL_DATA_DIR: path.join(os.tmpdir(), 'cl-mail-test'), CL_OFFLINE: 'off' });
}

beforeEach(() => { mocks.created.length = 0; secrets.clearAllSessionSecrets(); });
afterEach(() => { secrets.clearAllSessionSecrets(); _resetDesktopProfileForTests(); });

describe('desktop mail transport password', () => {
  it('replaces a stored password with the session secret', async () => {
    desktop();
    secrets.setSmtpPassword('session-pw-123456');
    const t = createMailTransport({ host: 'smtp.example.test', port: 587, auth: { user: 'owner', pass: 'db-stored-pw' } });
    expect(mocks.created[0]!['auth']).toEqual({ user: 'owner', pass: 'session-pw-123456' });
    expect(JSON.stringify(mocks.created[0])).not.toContain('db-stored-pw');
    await expect(t.verify()).resolves.toBe(true);
  });

  it('throws 400 SMTP_NOT_CONFIGURED when the server needs a login and no session password exists', () => {
    desktop();
    expect(() => createMailTransport({ host: 'smtp.example.test', port: 587, auth: { user: 'owner', pass: 'db-stored-pw' } }))
      .toThrow(expect.objectContaining({ statusCode: 400, code: 'SMTP_NOT_CONFIGURED' }));
    expect(mocks.created).toHaveLength(0);
  });

  it('a server without a login needs no password', () => {
    desktop();
    createMailTransport({ host: '127.0.0.1', port: 1025 });
    expect(mocks.created[0]!['auth']).toBeUndefined();
    createMailTransport({ host: 'relay.lan', port: 25, auth: { user: '' } });
    expect(mocks.created).toHaveLength(2);
  });

  it('clearing the session password takes effect on the next transport', () => {
    desktop();
    secrets.setSmtpPassword('session-pw-123456');
    createMailTransport({ host: 'smtp.example.test', port: 587, auth: { user: 'owner' } });
    secrets.deleteSessionSecret('smtp.password');
    expect(() => createMailTransport({ host: 'smtp.example.test', port: 587, auth: { user: 'owner' } }))
      .toThrow(expect.objectContaining({ code: 'SMTP_NOT_CONFIGURED' }));
  });
});

describe('desktop transport security from the session server', () => {
  it.each([
    ['tls', 465, { secure: true, requireTLS: false }],
    ['starttls', 587, { secure: false, requireTLS: true }],
  ] as const)('%s on port %i', async (security, port, expected) => {
    desktop();
    secrets.setSmtpPassword('session-pw-123456');
    await secrets.allowSmtpEgress({ host: '203.0.113.9', port, security });
    createMailTransport({ host: '203.0.113.9', port, secure: port === 465, auth: { user: 'owner' } });
    expect(mocks.created[0]).toMatchObject({ host: '203.0.113.9', port, ...expected, auth: { user: 'owner', pass: 'session-pw-123456' } });
  });

  it("'none' turns TLS off for a local-network relay only", async () => {
    desktop();
    await secrets.allowSmtpEgress({ host: '192.168.1.5', port: 25, security: 'none' });
    createMailTransport({ host: '192.168.1.5', port: 25 });
    expect(mocks.created[0]).toMatchObject({ secure: false, requireTLS: false });
  });

  it('a server other than the session one keeps the desktop default (STARTTLS required off loopback)', async () => {
    desktop();
    await secrets.allowSmtpEgress({ host: '192.168.1.5', port: 25, security: 'none' });
    createMailTransport({ host: 'other.example.test', port: 587 });
    expect(mocks.created[0]).toMatchObject({ requireTLS: true });
  });
});

describe('server mail transport (unchanged)', () => {
  it('uses the password it was given and ignores the session store', () => {
    secrets.setSmtpPassword('session-pw-123456');
    createMailTransport({ host: 'smtp.example.test', port: 587, auth: { user: 'owner', pass: 'db-stored-pw' } });
    expect(mocks.created[0]).toEqual({ host: 'smtp.example.test', port: 587, auth: { user: 'owner', pass: 'db-stored-pw' } });
    createMailTransport({ host: 'smtp.example.test', port: 587, auth: { user: 'owner' } });
    expect(mocks.created[1]!['auth']).toEqual({ user: 'owner' });
  });
});
