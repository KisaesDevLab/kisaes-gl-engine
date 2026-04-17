// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { companies, userTenantAccess, users } from '../db/schema/index.js';
import type { McpAuthContext } from '@kis-books/shared';

// Active company session per auth context (in-memory, keyed by userId)
const activeSessions = new Map<string, string>();

export function setActiveCompany(userId: string, companyId: string) {
  activeSessions.set(userId, companyId);
}

export function getActiveCompany(userId: string): string | undefined {
  return activeSessions.get(userId);
}

export async function resolveCompany(auth: McpAuthContext, params: { company_id?: string }): Promise<string> {
  // 1. Explicit company_id in params
  if (params.company_id) {
    await validateCompanyAccess(auth, params.company_id);
    return params.company_id;
  }

  // 2. Active company from session
  const active = getActiveCompany(auth.userId);
  if (active) {
    try { await validateCompanyAccess(auth, active); return active; } catch { /* fall through */ }
  }

  // 3. User has exactly one company — use it
  const userCompanies = await getUserCompanies(auth.userId);
  if (userCompanies.length === 1) return userCompanies[0]!.id;

  // 4. Ambiguous
  throw new Error(JSON.stringify({
    code: 'COMPANY_REQUIRED',
    message: 'Multiple companies available. Please specify company_id or use set_active_company.',
    available_companies: userCompanies.map((c) => ({ id: c.id, name: c.businessName })),
  }));
}

async function validateCompanyAccess(auth: McpAuthContext, companyId: string) {
  const userCompanies = await getUserCompanies(auth.userId);
  const hasAccess = userCompanies.some((c) => c.id === companyId);
  if (!hasAccess) throw new Error('ACCESS_DENIED: You do not have access to this company');

  if (auth.allowedCompanies && !auth.allowedCompanies.includes(companyId)) {
    throw new Error('ACCESS_DENIED: This API key is not authorized for this company');
  }

  // Check company has MCP enabled
  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  if (company && (company as any).mcpEnabled === false) {
    throw new Error('MCP_DISABLED: MCP access is disabled for this company');
  }
}

export async function getUserCompanies(userId: string) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return [];

  // Get all companies via tenant access
  const tenantIds = [user.tenantId];
  const access = await db.select().from(userTenantAccess)
    .where(and(eq(userTenantAccess.userId, userId), eq(userTenantAccess.isActive, true)));
  for (const a of access) tenantIds.push(a.tenantId);

  const result = [];
  for (const tid of [...new Set(tenantIds)]) {
    const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, tid) });
    if (company) result.push(company);
  }
  return result;
}
