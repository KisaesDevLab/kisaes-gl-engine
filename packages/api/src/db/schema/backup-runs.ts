// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Backup run log — one row per backup execution (scheduled or manual),
// inserted when a run starts and updated at completion, including the
// failure paths. See services/backup-run-log.service.ts for the writers
// and 0139_backup_runs.sql for the column-by-column rationale.

import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  bigint,
  index,
} from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';

export const backupRuns = pgTable('backup_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  // tenant_backup | system_backup | db_backup | dr_bundle | verify
  kind: varchar('kind', { length: 20 }).notNull(),
  // NULL for system-wide runs; set for per-tenant backups.
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
  // scheduled | manual
  trigger: varchar('trigger', { length: 10 }).notNull().default('scheduled'),
  // running | success | partial | failed
  status: varchar('status', { length: 10 }).notNull().default('running'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  // Base artifact name (part suffix stripped for multi-part series so
  // the verifier's unit name matches).
  artifactName: text('artifact_name'),
  // { local: {...}, remote: {...}, mirror: {...} } per-destination results.
  destinations: jsonb('destinations').notNull().default({}),
  // Backup-verifier proof for this run's artifact, when it has run.
  verify: jsonb('verify'),
  error: text('error'),
}, (table) => ({
  startedAtIdx: index('idx_backup_runs_started_at').on(table.startedAt),
  kindStartedIdx: index('idx_backup_runs_kind_started').on(table.kind, table.startedAt),
}));
