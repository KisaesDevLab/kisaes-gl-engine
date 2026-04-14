import { desc, and, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { TailscaleAuditEntry, TailscaleAuditFilters } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { tailscaleAuditLog, users } from '../../db/schema/index.js';

export interface AuditContext {
  actorUserId?: string | null;
  ipAddress?: string | null;
}

export async function logTailscaleAudit(
  action: string,
  ctx: AuditContext,
  target: string | null,
  details: Record<string, unknown>,
): Promise<number> {
  const [row] = await db
    .insert(tailscaleAuditLog)
    .values({
      action,
      actorUserId: ctx.actorUserId ?? null,
      target,
      details,
      ipAddress: ctx.ipAddress ?? null,
    })
    .returning({ id: tailscaleAuditLog.id });
  return row?.id ?? 0;
}

export interface AuditPage {
  entries: TailscaleAuditEntry[];
  total: number;
  page: number;
  limit: number;
}

export async function listTailscaleAudit(filters: TailscaleAuditFilters): Promise<AuditPage> {
  const conditions: SQL[] = [];
  if (filters.action) conditions.push(eq(tailscaleAuditLog.action, filters.action));
  if (filters.actorUserId) conditions.push(eq(tailscaleAuditLog.actorUserId, filters.actorUserId));
  if (filters.fromDate) conditions.push(gte(tailscaleAuditLog.createdAt, new Date(filters.fromDate)));
  if (filters.toDate) conditions.push(lte(tailscaleAuditLog.createdAt, new Date(filters.toDate)));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const offset = (filters.page - 1) * filters.limit;

  const rows = await db
    .select({
      id: tailscaleAuditLog.id,
      action: tailscaleAuditLog.action,
      actorUserId: tailscaleAuditLog.actorUserId,
      actorEmail: users.email,
      target: tailscaleAuditLog.target,
      details: tailscaleAuditLog.details,
      ipAddress: tailscaleAuditLog.ipAddress,
      createdAt: tailscaleAuditLog.createdAt,
    })
    .from(tailscaleAuditLog)
    .leftJoin(users, eq(users.id, tailscaleAuditLog.actorUserId))
    .where(whereClause)
    .orderBy(desc(tailscaleAuditLog.createdAt))
    .limit(filters.limit)
    .offset(offset);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tailscaleAuditLog)
    .where(whereClause);

  const entries: TailscaleAuditEntry[] = rows.map((r) => ({
    id: r.id,
    action: r.action,
    actorUserId: r.actorUserId,
    actorEmail: r.actorEmail ?? null,
    target: r.target,
    details: (r.details as Record<string, unknown>) ?? {},
    ipAddress: r.ipAddress,
    createdAt: r.createdAt ? r.createdAt.toISOString() : new Date(0).toISOString(),
  }));

  return {
    entries,
    total: countRow?.count ?? 0,
    page: filters.page,
    limit: filters.limit,
  };
}
