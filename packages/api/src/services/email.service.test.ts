// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { sendOrThrow } from './email.service.js';
import { AppError } from '../utils/errors.js';

const mail = { from: 'a@example.com', to: 'b@example.com', subject: 's', text: 't' };

function failingTransport(err: unknown) {
  return { sendMail: async () => { throw err; } };
}

describe('sendOrThrow', () => {
  it('passes through a successful send', async () => {
    let sent = false;
    await sendOrThrow({ sendMail: async () => { sent = true; } }, mail);
    expect(sent).toBe(true);
  });

  it('maps nodemailer EAUTH to SMTP_AUTH_FAILED', async () => {
    const err = Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'), { code: 'EAUTH' });
    await expect(sendOrThrow(failingTransport(err), mail)).rejects.toMatchObject({
      code: 'SMTP_AUTH_FAILED', statusCode: 400,
    });
  });

  it('maps a bare 535 message (no code) to SMTP_AUTH_FAILED', async () => {
    await expect(sendOrThrow(failingTransport(new Error('535 BadCredentials')), mail))
      .rejects.toMatchObject({ code: 'SMTP_AUTH_FAILED' });
  });

  it('maps other transport failures to SMTP_SEND_FAILED', async () => {
    await expect(sendOrThrow(failingTransport(new Error('Connection closed unexpectedly')), mail))
      .rejects.toMatchObject({ code: 'SMTP_SEND_FAILED' });
  });

  it('throws AppError instances (not raw nodemailer errors)', async () => {
    const p = sendOrThrow(failingTransport(new Error('boom')), mail);
    await expect(p).rejects.toBeInstanceOf(AppError);
  });
});
