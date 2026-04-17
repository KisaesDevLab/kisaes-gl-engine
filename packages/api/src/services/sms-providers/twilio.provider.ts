// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { SmsProvider, SendResult } from './sms-provider.interface.js';

export class TwilioProvider implements SmsProvider {
  name = 'twilio';
  private accountSid: string;
  private authToken: string;
  private fromNumber: string;

  constructor(accountSid: string, authToken: string, fromNumber: string) {
    this.accountSid = accountSid;
    this.authToken = authToken;
    this.fromNumber = fromNumber;
  }

  async sendCode(phoneNumber: string, code: string, appName: string): Promise<SendResult> {
    try {
      // twilio is an optional dependency — install with: npm i twilio
      const twilio = (await import('twilio' as any)).default as any;
      const client = twilio(this.accountSid, this.authToken);
      const message = await client.messages.create({
        to: phoneNumber,
        from: this.fromNumber,
        body: `Your ${appName} verification code is: ${code}. It expires in 5 minutes.`,
      });
      return { success: true, providerMessageId: message.sid };
    } catch (err: any) {
      if (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND') {
        return { success: false, error: 'Twilio package is not installed. Run: npm i twilio' };
      }
      return { success: false, error: err.message || 'Failed to send SMS via Twilio' };
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      const twilio = (await import('twilio' as any)).default as any;
      const client = twilio(this.accountSid, this.authToken);
      await client.api.accounts(this.accountSid).fetch();
      return true;
    } catch {
      return false;
    }
  }
}
