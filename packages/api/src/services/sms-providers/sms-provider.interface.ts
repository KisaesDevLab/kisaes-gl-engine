// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

export interface SendResult {
  success: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface SmsProvider {
  name: string;
  sendCode(phoneNumber: string, code: string, appName: string): Promise<SendResult>;
  /**
   * Send an arbitrary transactional message — e.g. a W-9 collection
   * link, a portal invitation, a reminder. Provider implementations
   * should keep the body under 160 characters for single-segment
   * delivery; the caller is responsible for trimming if necessary.
   */
  sendText(phoneNumber: string, body: string): Promise<SendResult>;
  testConnection(): Promise<boolean>;
}
