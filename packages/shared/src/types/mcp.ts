// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

export type McpScope = 'all' | 'read' | 'write' | 'reports' | 'banking' | 'invoicing';
export type McpAuthMethod = 'api_key' | 'oauth';

export interface McpSystemConfig {
  isEnabled: boolean;
  maxKeysPerUser: number;
  systemRateLimitPerMinute: number;
  allowedScopes: McpScope[];
  oauthEnabled: boolean;
  requireKeyExpiration: boolean;
  maxKeyLifetimeDays: number | null;
}

export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  scopes: string;
  allowedCompanies: string | null;
  rateLimitPerMinute: number;
  rateLimitPerHour: number;
  isActive: boolean;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  totalRequests: number;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface OAuthClient {
  id: string;
  clientId: string;
  name: string;
  redirectUris: string;
  scopes: string;
  isActive: boolean;
  createdAt: string;
}

export interface McpRequestLogEntry {
  id: string;
  userId: string;
  authMethod: McpAuthMethod;
  toolName: string | null;
  resourceUri: string | null;
  companyId: string | null;
  status: string | null;
  errorCode: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface McpAuthContext {
  userId: string;
  tenantId: string;
  source: McpAuthMethod;
  keyId?: string;
  scopes: string[];
  allowedCompanies: string[] | null;
  activeCompanyId?: string;
  /** OAuth only: the client (oauth_clients.id) the token was issued to. */
  oauthClientId?: string;
}

/** A client's books as an MCP caller sees them: one entry per tenant the caller can open. */
export interface McpClientCompany {
  /** The company id tools take as `company_id`. */
  id: string;
  name: string;
  tenantId: string;
  /** The caller's role in this client (owner, accountant, bookkeeper, readonly, ...). */
  role: string;
  /** False until MCP is turned on in the company's settings; tools refuse it until then. */
  mcpEnabled: boolean;
}
