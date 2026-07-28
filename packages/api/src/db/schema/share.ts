// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Peer screen share (rrweb DOM mirroring) — see MYBOOKS ADDENDUM: SUPPORT
// SCREEN SHARE. Sessions are sharer-initiated; every viewer is individually
// approved (two-step consent). No rrweb event payloads are ever persisted —
// these tables hold lifecycle + audit metadata only.

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  boolean,
  bigint,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants, users } from './auth.js';

export const shareSessionStatus = pgEnum('share_session_status', [
  'pending', // created, no approved viewer yet
  'active', // at least one viewer approved at some point
  'ended', // sharer or system ended it normally
  'expired', // TTL/idle sweep ended it
  'revoked', // admin/kill-switch/per-user-disable ended it
]);

export const shareParticipantStatus = pgEnum('share_participant_status', [
  'requested', // code submitted, awaiting sharer approval
  'approved', // sharer clicked Allow — the sole gate that starts transmission
  'denied', // sharer clicked Deny — permanent for this user in this session
  'lapsed', // approval window ran out; may re-request
  'ejected', // sharer removed an approved viewer — permanent like denied
  'left', // viewer ended their own view
]);

export const shareSessions = pgTable(
  'share_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Sharer's tenant. Cross-firm viewers keep their own tenant on the
    // participant row.
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    sharerUserId: uuid('sharer_user_id')
      .notNull()
      .references(() => users.id),
    // sha256(joinCode + server pepper). The plaintext code is returned exactly
    // once at creation and never stored.
    joinCodeHash: text('join_code_hash').notNull(),
    status: shareSessionStatus('status').notNull().default('pending'),
    // Entity/book (company id) the sharer had open at session start — drives
    // the entity-scope comparison at approval time.
    entityContext: text('entity_context'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    endedReason: text('ended_reason'),
    sharerIp: text('sharer_ip'),
    sharerUserAgent: text('sharer_user_agent'),
    bytesRelayed: bigint('bytes_relayed', { mode: 'number' }).default(0).notNull(),
  },
  (t) => ({
    tenantCreatedIdx: index('share_sessions_tenant_created_idx').on(t.tenantId, t.createdAt.desc()),
    // One live session per join code hash; ended sessions free the hash.
    liveCodeIdx: uniqueIndex('share_sessions_live_code_idx')
      .on(t.joinCodeHash)
      .where(sql`status in ('pending', 'active')`),
  }),
);

export const shareSessionParticipants = pgTable(
  'share_session_participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => shareSessions.id, { onDelete: 'cascade' }),
    viewerUserId: uuid('viewer_user_id')
      .notNull()
      .references(() => users.id),
    viewerTenantId: uuid('viewer_tenant_id')
      .notNull()
      .references(() => tenants.id),
    status: shareParticipantStatus('status').notNull().default('requested'),
    // Computed server-side at request time (never trusted from the client)
    // and re-checked at approval: viewer holds no active tenancy in the
    // sharer's tenant.
    isCrossFirm: boolean('is_cross_firm').notNull(),
    scopeWarningShown: boolean('scope_warning_shown').default(false),
    requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    viewerIp: text('viewer_ip'),
    viewerUserAgent: text('viewer_user_agent'),
    bytesRelayed: bigint('bytes_relayed', { mode: 'number' }).default(0).notNull(),
  },
  (t) => ({
    sessionIdx: index('share_participants_session_idx').on(t.sessionId),
    // One participant row per user per session — a denied user cannot
    // re-request (lapsed rows are updated in place on re-request).
    uniqueViewer: uniqueIndex('share_participants_session_viewer_idx').on(t.sessionId, t.viewerUserId),
    viewerHistoryIdx: index('share_participants_viewer_requested_idx').on(
      t.viewerUserId,
      t.requestedAt.desc(),
    ),
  }),
);

// Append-only (enforced by a DB trigger, not a role grant — the appliance
// runs on a single database role, so a REVOKE would bind the migration role
// too; see migration 0143).
export const shareSessionAudit = pgTable(
  'share_session_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => shareSessions.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id').references(() => shareSessionParticipants.id, {
      onDelete: 'set null',
    }),
    at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
    actorUserId: uuid('actor_user_id'),
    event: text('event').notNull(),
    detail: jsonb('detail'),
  },
  (t) => ({
    sessionIdx: index('share_audit_session_idx').on(t.sessionId),
    atIdx: index('share_audit_at_idx').on(t.at),
  }),
);
