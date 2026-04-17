// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

export type PlaidEnvironment = 'sandbox' | 'production';
export type PlaidItemStatus = 'active' | 'login_required' | 'pending_disconnect' | 'error' | 'revoked' | 'removed';
export type PlaidSyncStatus = 'success' | 'error' | 'pending';

export interface PlaidSystemConfig {
  environment: PlaidEnvironment;
  hasClientId: boolean;
  hasSandboxSecret: boolean;
  hasProductionSecret: boolean;
  webhookUrl: string | null;
  defaultProducts: string[];
  defaultCountryCodes: string[];
  defaultLanguage: string;
  maxHistoricalDays: number;
  isActive: boolean;
}

export interface PlaidItem {
  id: string;
  // System-scoped — no tenantId
  plaidItemId: string;
  plaidInstitutionId: string | null;
  institutionName: string | null;
  syncCursor: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: PlaidSyncStatus | null;
  lastSyncError: string | null;
  initialUpdateComplete: boolean;
  historicalUpdateComplete: boolean;
  itemStatus: PlaidItemStatus;
  errorCode: string | null;
  errorMessage: string | null;
  consentExpirationAt: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdByEmail: string | null;
  createdAt: string;
  accounts?: PlaidAccount[];
}

export interface PlaidAccount {
  id: string;
  // System-scoped — no tenantId
  plaidItemId: string;
  plaidAccountId: string;
  name: string | null;
  officialName: string | null;
  accountType: string | null;
  accountSubtype: string | null;
  mask: string | null;
  currentBalance: string | null;
  availableBalance: string | null;
  balanceCurrency: string;
  isActive: boolean;
  createdAt: string;
  // Populated from mapping (optional)
  mapping?: PlaidAccountMapping | null;
}

export interface PlaidAccountMapping {
  id: string;
  plaidAccountId: string;
  tenantId: string;
  mappedAccountId: string;
  syncStartDate: string | null;
  isSyncEnabled: boolean;
  mappedBy: string;
  mappedByName: string | null;
  createdAt: string;
}

export interface PlaidMappingSuggestion {
  coaAccountId: string;
  coaAccountName: string;
  coaAccountNumber: string | null;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

export interface PlaidWebhookLogEntry {
  id: string;
  receivedAt: string;
  plaidItemId: string | null;
  webhookType: string | null;
  webhookCode: string | null;
  processed: boolean;
  error: string | null;
}

export interface PlaidConnectionStats {
  totalItems: number;
  activeItems: number;
  needsAttention: number;
  totalAccounts: number;
  mappedAccounts: number;
}

export interface PlaidItemActivity {
  id: string;
  plaidItemId: string;
  tenantId: string | null;
  action: string;
  performedBy: string | null;
  performedByName: string | null;
  details: any;
  createdAt: string;
}
