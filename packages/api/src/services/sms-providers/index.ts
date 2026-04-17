// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { SmsProvider } from './sms-provider.interface.js';
import { TwilioProvider } from './twilio.provider.js';
import { TextLinkSmsProvider } from './textlinksms.provider.js';
import { AppError } from '../../utils/errors.js';

export type { SmsProvider, SendResult } from './sms-provider.interface.js';

interface SmsConfig {
  smsProvider: string | null;
  smsTwilioAccountSid?: string | null;
  smsTwilioAuthToken?: string | null;
  smsTwilioFromNumber?: string | null;
  smsTextlinkApiKey?: string | null;
  smsTextlinkServiceName?: string | null;
}

export function getSmsProvider(config: SmsConfig): SmsProvider {
  if (!config.smsProvider) {
    throw AppError.badRequest('No SMS provider configured. Configure one in Admin > Two-Factor Auth settings.');
  }

  if (config.smsProvider === 'twilio') {
    if (!config.smsTwilioAccountSid || !config.smsTwilioAuthToken || !config.smsTwilioFromNumber) {
      throw AppError.badRequest('Twilio credentials are incomplete. Configure Account SID, Auth Token, and From Number.');
    }
    return new TwilioProvider(config.smsTwilioAccountSid, config.smsTwilioAuthToken, config.smsTwilioFromNumber);
  }

  if (config.smsProvider === 'textlinksms') {
    if (!config.smsTextlinkApiKey) {
      throw AppError.badRequest('TextLinkSMS API key is not configured.');
    }
    return new TextLinkSmsProvider(config.smsTextlinkApiKey, config.smsTextlinkServiceName || 'Vibe MyBooks');
  }

  throw AppError.badRequest(`Unknown SMS provider: ${config.smsProvider}`);
}
