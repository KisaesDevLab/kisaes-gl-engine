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
  testConnection(): Promise<boolean>;
}
