// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { SmsProvider, SendResult } from './sms-provider.interface.js';

export class TextLinkSmsProvider implements SmsProvider {
  name = 'textlinksms';
  private apiKey: string;
  private serviceName: string;

  constructor(apiKey: string, serviceName: string = 'Vibe MyBooks') {
    this.apiKey = apiKey;
    this.serviceName = serviceName;
  }

  async sendCode(phoneNumber: string, code: string, _appName: string): Promise<SendResult> {
    return this.sendText(
      phoneNumber,
      `Your ${this.serviceName} verification code is: ${code}. It expires in 5 minutes.`,
    );
  }

  async sendText(phoneNumber: string, body: string): Promise<SendResult> {
    try {
      const response = await fetch('https://textlinksms.com/api/send-sms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          phone_number: phoneNumber,
          text: body,
        }),
      });

      if (!response.ok) {
        const errBody = await response.text();
        return { success: false, error: `TextLinkSMS error (${response.status}): ${errBody}` };
      }

      const data = await response.json() as any;
      return { success: true, providerMessageId: data.id || data.message_id };
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to send SMS via TextLinkSMS' };
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch('https://textlinksms.com/api/send-sms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          phone_number: '+10000000000',
          text: 'Test connection from Vibe MyBooks',
        }),
      });
      // A 401/403 means bad credentials, anything else means connected
      return response.status !== 401 && response.status !== 403;
    } catch {
      return false;
    }
  }
}
