import { db } from '../db/index.js';
import { mcpRequestLog } from '../db/schema/index.js';
import type { McpAuthContext } from '@kis-books/shared';

const SENSITIVE_FIELDS = ['password', 'secret', 'token', 'key', 'api_key'];

function sanitizeParams(params: any): any {
  if (!params || typeof params !== 'object') return params;
  const sanitized: any = {};
  for (const [key, value] of Object.entries(params)) {
    if (SENSITIVE_FIELDS.some((f) => key.toLowerCase().includes(f))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'string' && value.length > 200) {
      sanitized[key] = value.slice(0, 200) + '...';
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export async function logMcpRequest(opts: {
  auth: McpAuthContext;
  toolName?: string;
  resourceUri?: string;
  companyId?: string;
  parameters?: any;
  status: 'success' | 'error' | 'rate_limited';
  errorCode?: string;
  responseSummary?: string;
  ipAddress?: string;
  userAgent?: string;
  durationMs?: number;
}) {
  await db.insert(mcpRequestLog).values({
    userId: opts.auth.userId,
    authMethod: opts.auth.source,
    apiKeyId: opts.auth.keyId || null,
    toolName: opts.toolName || null,
    resourceUri: opts.resourceUri || null,
    companyId: opts.companyId || null,
    parameters: opts.parameters ? sanitizeParams(opts.parameters) : null,
    status: opts.status,
    errorCode: opts.errorCode || null,
    responseSummary: opts.responseSummary?.slice(0, 500) || null,
    ipAddress: opts.ipAddress || null,
    userAgent: opts.userAgent || null,
    durationMs: opts.durationMs || null,
  });
}
