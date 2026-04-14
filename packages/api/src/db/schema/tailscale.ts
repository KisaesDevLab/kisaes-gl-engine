import { pgTable, bigserial, varchar, uuid, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

export const tailscaleAuditLog = pgTable('tailscale_audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  action: varchar('action', { length: 50 }).notNull(),
  actorUserId: uuid('actor_user_id'),
  target: varchar('target', { length: 255 }),
  details: jsonb('details').default({}),
  ipAddress: varchar('ip_address', { length: 45 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  createdIdx: index('idx_ts_audit_created').on(table.createdAt),
  actionIdx: index('idx_ts_audit_action').on(table.action),
}));
