export type TfaMethod = 'email' | 'sms' | 'totp';

export type SmsProviderType = 'twilio' | 'textlinksms';

export interface TfaSystemConfig {
  isEnabled: boolean;
  allowedMethods: TfaMethod[];
  trustDeviceEnabled: boolean;
  trustDeviceDurationDays: number;
  codeExpirySeconds: number;
  codeLength: number;
  maxAttempts: number;
  lockoutDurationMinutes: number;
  smsProvider: SmsProviderType | null;
  smsConfigured: boolean;
}

export interface TfaUserStatus {
  systemEnabled: boolean;
  userEnabled: boolean;
  methods: TfaMethod[];
  preferredMethod: TfaMethod | null;
  phoneMasked: string | null;
  totpConfigured: boolean;
  recoveryCodesRemaining: number;
  allowedMethods: TfaMethod[];
  trustDeviceEnabled: boolean;
  trustDeviceDurationDays: number;
}

export interface TfaLoginChallenge {
  tfa_required: true;
  tfa_token: string;
  available_methods: TfaMethod[];
  preferred_method: TfaMethod;
  phone_masked?: string;
  email_masked?: string;
}

export interface TfaVerifyInput {
  code: string;
  method: TfaMethod;
  trustDevice?: boolean;
  deviceFingerprint?: string;
}

export interface TfaVerifyResult {
  valid: boolean;
  remainingAttempts?: number;
  lockedUntil?: string;
}

export interface TfaSendCodeResult {
  method: TfaMethod;
  destinationMasked: string;
  expiresInSeconds: number;
}

export interface TfaTrustedDevice {
  id: string;
  deviceName: string | null;
  ipAddress: string | null;
  trustedAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

export interface TfaConfigUpdateInput {
  isEnabled?: boolean;
  allowedMethods?: TfaMethod[];
  trustDeviceEnabled?: boolean;
  trustDeviceDurationDays?: number;
  codeExpirySeconds?: number;
  codeLength?: number;
  maxAttempts?: number;
  lockoutDurationMinutes?: number;
  smsProvider?: SmsProviderType | null;
  smsTwilioAccountSid?: string;
  smsTwilioAuthToken?: string;
  smsTwilioFromNumber?: string;
  smsTextlinkApiKey?: string;
  smsTextlinkServiceName?: string;
}

export interface TotpSetupResult {
  secret: string;
  qrUri: string;
}
