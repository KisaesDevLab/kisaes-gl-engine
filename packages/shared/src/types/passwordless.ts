export type LoginMethod = 'password' | 'magic_link' | 'passkey';

export interface Passkey {
  id: string;
  deviceName: string | null;
  aaguid: string | null;
  transports: string | null;
  backedUp: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface PasskeyRegistrationOptions {
  options: any; // PublicKeyCredentialCreationOptionsJSON from @simplewebauthn
}

export interface PasskeyAuthenticationOptions {
  options: any; // PublicKeyCredentialRequestOptionsJSON from @simplewebauthn
}

export interface MagicLinkSendResult {
  sent: boolean;
  expiresInMinutes: number;
}

export interface MagicLinkVerifyResult {
  valid: boolean;
  tfaToken?: string;
  availableMethods?: string[];
  preferredMethod?: string;
  phoneMasked?: string;
  emailMasked?: string;
  error?: string;
}

export interface AuthMethodsResponse {
  loginMethods: {
    password: boolean;
    magicLink: boolean;
    passkey: boolean;
  };
  tfaAvailable: boolean;
  smtpReady: boolean;
  smsReady: boolean;
  // Only present when email param provided and user exists
  userHasPasskeys?: boolean;
  userPreferredMethod?: LoginMethod;
}

export interface SystemCapabilities {
  smtpReady: boolean;
  smsReady: boolean;
  passkeysSupported: boolean;
  totpSupported: boolean;
}
