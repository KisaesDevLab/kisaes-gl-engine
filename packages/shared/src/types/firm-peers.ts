// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Vibe Practice Management peer integration — wire types shared by the
// firm settings UI and the API (docs/vibe-pm-integration.md).

export type PeerKeyMode = 'pem' | 'jwks';
export type PeerKeyKind = 'rsa' | 'ec';
export type PeerErrorCode = 'sig_invalid' | 'unknown_kid' | 'expired' | 'replay' | 'jwks_fetch_failed' | 'no_link';

export interface VibePmSettingsView {
  provider: 'vibe_pm';
  isEnabled: boolean;
  issuer: string | null;
  keyMode: PeerKeyMode | null;
  keyKind: PeerKeyKind | null;
  keyDetail: string | null;
  keyFingerprint: string | null;
  publicKeyPem: string | null;
  jwksUrl: string | null;
  lastSeenAt: string | null;
  lastError: PeerErrorCode | null;
  lastErrorAt: string | null;
  updatedAt: string | null;
}

export type PeerTestTokenResult =
  | { ok: true; issuer: string; claims: { sub?: string; jti: string; iat: number; exp: number; pm_client_id?: string; actor?: { email: string; name?: string } } }
  | { ok: false; code: string };

export interface PmClientLinkView {
  id: string;
  pmClientId: string;
  tenant: { id: string; name: string };
  company: { id: string; name: string };
  contact: { id: string; email: string; firstName: string | null; lastName: string | null; status: string };
  /** Every per-request condition holds right now (see resolveLink). */
  active: boolean;
  createdAt: string;
}

export interface PmLinkOptions {
  tenant: { id: string; name: string };
  companies: Array<{ id: string; name: string }>;
  contacts: Array<{ id: string; email: string; firstName: string | null; lastName: string | null; status: string; companyIds: string[] }>;
}
