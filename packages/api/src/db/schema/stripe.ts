import { pgTable, uuid, varchar, boolean, timestamp, jsonb, text, index } from 'drizzle-orm/pg-core';

export const stripeWebhookLog = pgTable('stripe_webhook_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  eventId: varchar('event_id', { length: 255 }).notNull().unique(),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  paymentIntentId: varchar('payment_intent_id', { length: 255 }),
  payload: jsonb('payload').notNull(),
  processed: boolean('processed').default(false),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  eventIdx: index('idx_swl_event_type').on(table.eventType),
  piIdx: index('idx_swl_pi_lookup').on(table.paymentIntentId),
}));
