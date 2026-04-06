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
}
