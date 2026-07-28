// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Peer screen share — session lifecycle, per-viewer two-step consent,
// authorization/scope, limits, and audit. The WS gateway (share-gateway.ts)
// relays rrweb events; this module owns every state transition and writes an
// audit row for each one.
//
// Access model (addendum §3): no privileged viewer role. The load-bearing
// controls are (1) per-viewer approval — a join code alone grants nothing,
// (2) identity shown before approval, (3) the entity-scope warning, plus the
// Phase 13 rate/anomaly controls.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, count, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  shareSessions,
  shareSessionParticipants,
  shareSessionAudit,
  users,
  tenants,
  companies,
  userTenantAccess,
  accountantCompanyExclusions,
  systemSettings,
} from '../../db/schema/index.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { log } from '../../utils/logger.js';
import * as shareRedis from './share-redis.js';

export type ShareSession = typeof shareSessions.$inferSelect;
export type ShareParticipant = typeof shareSessionParticipants.$inferSelect;

const LIVE_STATUSES = ['pending', 'active'] as const;

// System-settings key for the runtime kill switch. Env SHARE_ENABLED is the
// boot-time master; this row lets an admin cut every live session without a
// restart (13.7). '1' = killed.
const KILL_SWITCH_KEY = 'share_kill_switch';

// ── Enablement resolution ───────────────────────────────────────────────────

export interface TenantShareSettings {
  enabled?: boolean | null; // null/absent → inherit global
  allowInboundCrossFirm?: boolean; // default true (global scope applies)
}

function tenantSettingsOf(row: { shareSettings?: unknown } | undefined | null): TenantShareSettings {
  const s = row?.shareSettings;
  return s && typeof s === 'object' ? (s as TenantShareSettings) : {};
}

export async function isKillSwitchOn(): Promise<boolean> {
  const row = await db.query.systemSettings.findFirst({ where: eq(systemSettings.key, KILL_SWITCH_KEY) });
  return row?.value === '1';
}

export async function setKillSwitch(on: boolean): Promise<void> {
  await db
    .insert(systemSettings)
    .values({ key: KILL_SWITCH_KEY, value: on ? '1' : '0', updatedAt: new Date() })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value: on ? '1' : '0', updatedAt: new Date() } });
  if (on) await shareRedis.publishControl({ type: 'kill-all', reason: 'kill_switch' });
}

/**
 * Effective share enablement for a user acting in a tenant. Layered:
 * global env flag → runtime kill switch → tenant setting → per-user override
 * (D9, tri-state inheriting the tenant). Disabled surfaces 404, not 403
 * (2.8), so callers get a boolean and the route returns NotFound.
 */
export async function shareEnabledFor(userId: string, tenantId: string): Promise<boolean> {
  if (!env.SHARE_ENABLED) return false;
  if (await isKillSwitchOn()) return false;
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) return false;
  const ts = tenantSettingsOf(tenant);
  if (ts.enabled === false) return false;
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || user.isActive === false) return false;
  if (user.shareAllowed === false) return false;
  return true;
}

// ── Join codes ──────────────────────────────────────────────────────────────

// Crockford base32 (I, L, O, U excluded by construction). 8 chars ≈ 40 bits —
// adequate only because submission is rate-limited and a code alone grants
// nothing without sharer approval (3.2).
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const JOIN_CODE_LENGTH = 8;

export function generateJoinCode(): string {
  const bytes = randomBytes(JOIN_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return code;
}

/** Normalize user-typed codes: uppercase, strip the display hyphen, map the
 *  glyphs Crockford treats as equivalent (I/L→1, O→0). */
export function normalizeJoinCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
}

export function hashJoinCode(code: string): string {
  // Server pepper derived from the appliance ENCRYPTION_KEY — a DB dump alone
  // cannot be brute-forced offline against the 40-bit code space.
  const pepper = createHash('sha256').update(`share-pepper:${env.ENCRYPTION_KEY}`).digest();
  return createHash('sha256').update(code).update(pepper).digest('hex');
}

/** Constant-time equality on hex hashes. */
export function codeHashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ── Audit ───────────────────────────────────────────────────────────────────

export async function audit(
  sessionId: string,
  event: string,
  opts: { participantId?: string | null; actorUserId?: string | null; detail?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    await db.insert(shareSessionAudit).values({
      sessionId,
      participantId: opts.participantId ?? null,
      actorUserId: opts.actorUserId ?? null,
      event,
      detail: opts.detail ?? null,
    });
  } catch (err) {
    // Audit writes must never sink a lifecycle transition, but they must be
    // loud — audit is a load-bearing control here.
    log.error({
      component: 'share',
      event: 'audit_write_failed',
      sessionId,
      auditEvent: event,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Admin alerting (13.2–13.4) ──────────────────────────────────────────────

async function alertTenantAdmins(tenantId: string, subject: string, html: string): Promise<void> {
  try {
    const admins = await db.query.users.findMany({
      where: and(eq(users.tenantId, tenantId), eq(users.role, 'owner'), eq(users.isActive, true)),
      columns: { email: true },
    });
    const { sendCustomEmail } = await import('../system-email.service.js');
    await Promise.allSettled(admins.slice(0, 5).map((a) => sendCustomEmail(a.email, subject, html)));
  } catch (err) {
    log.warn({
      component: 'share',
      event: 'admin_alert_failed',
      tenantId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Session lifecycle ───────────────────────────────────────────────────────

export interface CreateSessionResult {
  sessionId: string;
  joinCode: string; // returned exactly once, never re-retrievable
  expiresAt: Date;
}

export async function createSession(
  userId: string,
  tenantId: string,
  opts: { entityContext?: string | null; ip?: string | null; userAgent?: string | null },
): Promise<CreateSessionResult> {
  // Concurrent-session cap per tenant (13.5).
  const [liveCount] = await db
    .select({ n: count() })
    .from(shareSessions)
    .where(and(eq(shareSessions.tenantId, tenantId), inArray(shareSessions.status, [...LIVE_STATUSES])));
  if ((liveCount?.n ?? 0) >= env.SHARE_MAX_CONCURRENT_PER_TENANT) {
    throw AppError.badRequest('Too many active share sessions for this organization. Try again shortly.');
  }

  const expiresAt = new Date(Date.now() + env.SHARE_TTL_MINUTES * 60_000);

  // Collision retry, max 5 (3.2). The partial unique index on live sessions
  // is the arbiter.
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const joinCode = generateJoinCode();
    try {
      const [row] = await db
        .insert(shareSessions)
        .values({
          tenantId,
          sharerUserId: userId,
          joinCodeHash: hashJoinCode(joinCode),
          status: 'pending',
          entityContext: opts.entityContext ?? null,
          expiresAt,
          sharerIp: opts.ip ?? null,
          sharerUserAgent: opts.userAgent ?? null,
        })
        .returning();
      if (!row) throw new Error('insert returned no row');
      await audit(row.id, 'session_created', {
        actorUserId: userId,
        detail: { entityContext: row.entityContext, expiresAt: expiresAt.toISOString() },
      });
      await shareRedis.touchActivity(row.id);
      return { sessionId: row.id, joinCode, expiresAt };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < 5 && msg.includes('share_sessions_live_code_idx')) continue;
      throw err;
    }
  }
  throw AppError.internal('Could not allocate a join code');
}

async function getLiveSessionByCodeHash(codeHash: string): Promise<ShareSession | null> {
  const rows = await db
    .select()
    .from(shareSessions)
    .where(and(eq(shareSessions.joinCodeHash, codeHash), inArray(shareSessions.status, [...LIVE_STATUSES])))
    .limit(1);
  const row = rows[0] ?? null;
  if (!row) return null;
  // Defense in depth on top of the indexed lookup: constant-time re-compare.
  if (!codeHashEquals(row.joinCodeHash, codeHash)) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return row;
}

// ── Cross-firm + entity scope (Phase 4) ─────────────────────────────────────

/** A viewer is cross-firm when they hold no active tenancy in the sharer's
 *  tenant — neither their home tenant nor a user_tenant_access row. Computed
 *  server-side; never trusted from the client (4.5). */
export async function computeIsCrossFirm(viewerUserId: string, viewerHomeTenantId: string, sharerTenantId: string): Promise<boolean> {
  if (viewerHomeTenantId === sharerTenantId) return false;
  const access = await db.query.userTenantAccess.findFirst({
    where: and(
      eq(userTenantAccess.userId, viewerUserId),
      eq(userTenantAccess.tenantId, sharerTenantId),
      eq(userTenantAccess.isActive, true),
    ),
  });
  return !access;
}

/** Does this viewer have access to the entity (company) the sharer has open?
 *  Mirrors the product's own access rules: an active tenancy in the entity's
 *  tenant, minus any accountant company exclusion (4.7). */
export async function viewerHasEntityAccess(viewerUserId: string, viewerHomeTenantId: string, entityCompanyId: string | null): Promise<boolean | null> {
  if (!entityCompanyId) return null; // no entity context recorded → no comparison
  const company = await db.query.companies.findFirst({ where: eq(companies.id, entityCompanyId) });
  if (!company) return null;
  const inTenant =
    company.tenantId === viewerHomeTenantId ||
    !!(await db.query.userTenantAccess.findFirst({
      where: and(
        eq(userTenantAccess.userId, viewerUserId),
        eq(userTenantAccess.tenantId, company.tenantId),
        eq(userTenantAccess.isActive, true),
      ),
    }));
  if (!inTenant) return false;
  const excluded = await db.query.accountantCompanyExclusions.findFirst({
    where: and(
      eq(accountantCompanyExclusions.userId, viewerUserId),
      eq(accountantCompanyExclusions.companyId, entityCompanyId),
    ),
  });
  return !excluded;
}

/** SHARE_SCOPE enforcement (4.3). At `any` this is a pass-through, but the
 *  check exists so tightening is a config change, not a code change. */
async function scopePermitsViewer(viewerUserId: string, viewerHomeTenantId: string, sharerTenantId: string): Promise<boolean> {
  if (env.SHARE_SCOPE === 'any') return true;
  if (viewerHomeTenantId === sharerTenantId) return true;
  if (env.SHARE_SCOPE === 'tenant') return false;
  // tenant_and_linked: an active tenancy in the sharer's tenant qualifies.
  const linked = await db.query.userTenantAccess.findFirst({
    where: and(
      eq(userTenantAccess.userId, viewerUserId),
      eq(userTenantAccess.tenantId, sharerTenantId),
      eq(userTenantAccess.isActive, true),
    ),
  });
  return !!linked;
}

// ── Join request (Phase 3.5–3.7, 13.1–13.3) ────────────────────────────────

export const CODE_FAILURE_LOCKOUT = 10;

export interface JoinRequestResult {
  participantId: string;
  sessionId: string;
  sharerName: string;
  approvalWindowSeconds: number;
}

export async function requestJoin(
  viewerUserId: string,
  viewerTenantId: string,
  rawCode: string,
  opts: { ip?: string | null; userAgent?: string | null },
): Promise<JoinRequestResult> {
  // Brute-force lockout (13.2) — checked before touching the code at all.
  const failures = await shareRedis.codeFailureCount(viewerUserId);
  if (failures >= CODE_FAILURE_LOCKOUT) {
    throw AppError.tooManyRequests('Too many failed join attempts. Try again later.');
  }

  const code = normalizeJoinCode(rawCode);
  const session = code.length === JOIN_CODE_LENGTH ? await getLiveSessionByCodeHash(hashJoinCode(code)) : null;
  if (!session) {
    const n = await shareRedis.recordCodeFailure(viewerUserId);
    if (n === CODE_FAILURE_LOCKOUT) {
      const viewer = await db.query.users.findFirst({ where: eq(users.id, viewerUserId) });
      log.warn({ component: 'share', event: 'code_bruteforce_lockout', viewerUserId });
      await alertTenantAdmins(
        viewerTenantId,
        'MyBooks security: repeated failed screen-share join attempts',
        `<p>User <b>${viewer?.displayName ?? viewer?.email ?? viewerUserId}</b> entered ${CODE_FAILURE_LOCKOUT} consecutive invalid screen-share join codes and has been locked out of code entry for an hour. If this was not expected, review the account.</p>`,
      );
    }
    // Identical message for invalid and non-existent codes (10.2).
    throw AppError.notFound('That code is not valid.');
  }
  await shareRedis.clearCodeFailures(viewerUserId);

  if (session.sharerUserId === viewerUserId) {
    throw AppError.badRequest('You cannot view your own share session.');
  }

  // Viewer must themselves be allowed to use the feature (D9 covers viewing).
  if (!(await shareEnabledFor(viewerUserId, viewerTenantId))) {
    throw AppError.notFound('That code is not valid.');
  }

  // Scope + inbound cross-firm policy (4.3, 4.4).
  const isCrossFirm = await computeIsCrossFirm(viewerUserId, viewerTenantId, session.tenantId);
  if (!(await scopePermitsViewer(viewerUserId, viewerTenantId, session.tenantId))) {
    throw AppError.notFound('That code is not valid.');
  }
  if (isCrossFirm) {
    const sharerTenant = await db.query.tenants.findFirst({ where: eq(tenants.id, session.tenantId) });
    const ts = tenantSettingsOf(sharerTenant);
    if (ts.allowInboundCrossFirm === false) {
      throw AppError.notFound('That code is not valid.');
    }
  }

  // Existing participant row (1.5): denied/ejected are permanent for this
  // session; lapsed/left may re-request (row is reset in place); requested/
  // approved are conflicts.
  const existing = await db.query.shareSessionParticipants.findFirst({
    where: and(
      eq(shareSessionParticipants.sessionId, session.id),
      eq(shareSessionParticipants.viewerUserId, viewerUserId),
    ),
  });
  if (existing) {
    if (existing.status === 'denied' || existing.status === 'ejected') {
      // Distinct, non-enumerating message (10.3).
      throw AppError.forbidden('You cannot join this session.');
    }
    if (existing.status === 'requested') {
      throw AppError.conflict('Your request is already waiting for approval.');
    }
    if (existing.status === 'approved') {
      throw AppError.conflict('You are already approved for this session.');
    }
  }

  // Approved-viewer cap (3.6).
  const [approvedCount] = await db
    .select({ n: count() })
    .from(shareSessionParticipants)
    .where(and(eq(shareSessionParticipants.sessionId, session.id), eq(shareSessionParticipants.status, 'approved')));
  if ((approvedCount?.n ?? 0) >= env.SHARE_MAX_VIEWERS_PER_SESSION) {
    throw AppError.badRequest('This session already has the maximum number of viewers.');
  }

  let participantId: string;
  if (existing) {
    // lapsed / left → fresh request in place.
    await db
      .update(shareSessionParticipants)
      .set({
        status: 'requested',
        requestedAt: new Date(),
        approvedAt: null,
        endedAt: null,
        viewerIp: opts.ip ?? null,
        viewerUserAgent: opts.userAgent ?? null,
        isCrossFirm,
      })
      .where(eq(shareSessionParticipants.id, existing.id));
    participantId = existing.id;
  } else {
    const [row] = await db
      .insert(shareSessionParticipants)
      .values({
        sessionId: session.id,
        viewerUserId,
        viewerTenantId,
        status: 'requested',
        isCrossFirm,
        viewerIp: opts.ip ?? null,
        viewerUserAgent: opts.userAgent ?? null,
      })
      .returning();
    participantId = row!.id;
  }

  await audit(session.id, 'code_submitted', {
    participantId,
    actorUserId: viewerUserId,
    detail: { isCrossFirm },
  });

  // Anomaly signal (13.3): unusual number of distinct sharers in a short
  // window is a compromised-account pattern.
  void detectViewerAnomalies(viewerUserId, viewerTenantId).catch(() => undefined);

  // Nudge the sharer's socket (approval prompt) via the control channel.
  await shareRedis.publishControl({ type: 'participant-update', sessionId: session.id });

  const sharer = await db.query.users.findFirst({ where: eq(users.id, session.sharerUserId) });
  return {
    participantId,
    sessionId: session.id,
    sharerName: sharer?.displayName ?? sharer?.email ?? 'the sharer',
    approvalWindowSeconds: env.SHARE_APPROVAL_WINDOW_SECONDS,
  };
}

async function detectViewerAnomalies(viewerUserId: string, viewerTenantId: string): Promise<void> {
  const hourAgo = new Date(Date.now() - 3600_000);
  const dayAgo = new Date(Date.now() - 24 * 3600_000);
  const [distinctSharersRow] = await db
    .select({ n: sql<number>`count(distinct ${shareSessions.sharerUserId})::int` })
    .from(shareSessionParticipants)
    .innerJoin(shareSessions, eq(shareSessions.id, shareSessionParticipants.sessionId))
    .where(and(eq(shareSessionParticipants.viewerUserId, viewerUserId), gt(shareSessionParticipants.requestedAt, hourAgo)));
  const [crossFirmRow] = await db
    .select({ n: count() })
    .from(shareSessionParticipants)
    .where(
      and(
        eq(shareSessionParticipants.viewerUserId, viewerUserId),
        eq(shareSessionParticipants.isCrossFirm, true),
        eq(shareSessionParticipants.status, 'approved'),
        gt(shareSessionParticipants.requestedAt, dayAgo),
      ),
    );
  const distinctSharers = distinctSharersRow?.n ?? 0;
  const crossFirmViews = crossFirmRow?.n ?? 0;
  if (distinctSharers >= 5 || crossFirmViews >= 3) {
    const viewer = await db.query.users.findFirst({ where: eq(users.id, viewerUserId) });
    log.warn({
      component: 'share',
      event: 'viewer_anomaly',
      viewerUserId,
      distinctSharersLastHour: distinctSharers,
      crossFirmApprovedLastDay: crossFirmViews,
    });
    await alertTenantAdmins(
      viewerTenantId,
      'MyBooks security: unusual screen-share viewing pattern',
      `<p>User <b>${viewer?.displayName ?? viewer?.email ?? viewerUserId}</b> has requested to view ${distinctSharers} different users' screens in the last hour and holds ${crossFirmViews} cross-firm views in the last day. This resembles a compromised-account pattern — verify with the user.</p>`,
    );
  }
}

// ── Approval / denial / ejection (3.8–3.10, 4.6–4.9) ───────────────────────

export interface ApprovalContext {
  participant: ShareParticipant;
  viewerName: string;
  viewerEmail: string;
  viewerFirmName: string;
  isCrossFirm: boolean;
  /** null when the session recorded no entity context. */
  viewerHasEntityAccess: boolean | null;
  entityName: string | null;
}

/** Everything the approval dialog needs to show a NAMED person (not an
 *  anonymous code holder) with firm + entity-scope comparison. */
export async function approvalContext(sessionId: string, participantId: string): Promise<ApprovalContext> {
  const participant = await db.query.shareSessionParticipants.findFirst({
    where: and(eq(shareSessionParticipants.id, participantId), eq(shareSessionParticipants.sessionId, sessionId)),
  });
  if (!participant) throw AppError.notFound('Request not found');
  const session = await db.query.shareSessions.findFirst({ where: eq(shareSessions.id, sessionId) });
  if (!session) throw AppError.notFound('Session not found');
  const viewer = await db.query.users.findFirst({ where: eq(users.id, participant.viewerUserId) });
  const viewerTenant = await db.query.tenants.findFirst({ where: eq(tenants.id, participant.viewerTenantId) });
  // Re-check cross-firm at approval time (4.5) — access may have changed
  // between request and approval.
  const isCrossFirm = await computeIsCrossFirm(participant.viewerUserId, participant.viewerTenantId, session.tenantId);
  const entityAccess = await viewerHasEntityAccess(
    participant.viewerUserId,
    participant.viewerTenantId,
    session.entityContext,
  );
  let entityName: string | null = null;
  if (session.entityContext) {
    const company = await db.query.companies.findFirst({ where: eq(companies.id, session.entityContext) });
    entityName = company?.businessName ?? null;
  }
  return {
    participant,
    viewerName: viewer?.displayName ?? viewer?.email ?? 'Unknown user',
    viewerEmail: viewer?.email ?? '',
    viewerFirmName: viewerTenant?.name ?? 'Unknown firm',
    isCrossFirm,
    viewerHasEntityAccess: entityAccess,
    entityName,
  };
}

async function requireSharerSession(sessionId: string, actorUserId: string): Promise<ShareSession> {
  const session = await db.query.shareSessions.findFirst({ where: eq(shareSessions.id, sessionId) });
  if (!session) throw AppError.notFound('Session not found');
  // Enforced by user id, not role (4.9).
  if (session.sharerUserId !== actorUserId) throw AppError.forbidden('Only the sharer can do that.');
  return session;
}

export async function approveParticipant(
  sessionId: string,
  participantId: string,
  actorUserId: string,
  opts: { crossFirmConfirmed?: boolean; scopeWarningConfirmed?: boolean },
): Promise<void> {
  const session = await requireSharerSession(sessionId, actorUserId);
  if (!LIVE_STATUSES.includes(session.status as (typeof LIVE_STATUSES)[number])) {
    throw AppError.badRequest('This session has ended.');
  }
  const ctx = await approvalContext(sessionId, participantId);
  if (ctx.participant.status !== 'requested') {
    throw AppError.conflict(`Request is ${ctx.participant.status}, not awaiting approval.`);
  }
  // Approval window (3.11) — a stale prompt cannot be approved.
  const windowMs = env.SHARE_APPROVAL_WINDOW_SECONDS * 1000;
  if (Date.now() - ctx.participant.requestedAt.getTime() > windowMs) {
    await db
      .update(shareSessionParticipants)
      .set({ status: 'lapsed', endedAt: new Date() })
      .where(eq(shareSessionParticipants.id, participantId));
    await audit(sessionId, 'approval_lapsed', { participantId });
    throw AppError.conflict('The approval window for this request has passed. Ask them to re-enter the code.');
  }
  // D5: server-side enforcement of the second confirmation for any
  // cross-firm viewer — the UI cannot skip it.
  if (ctx.isCrossFirm && !opts.crossFirmConfirmed) {
    throw AppError.badRequest('Cross-firm viewers require the additional confirmation.');
  }
  // 4.8: entity mismatch requires its own confirmation.
  const entityMismatch = ctx.viewerHasEntityAccess === false;
  if (entityMismatch && !opts.scopeWarningConfirmed) {
    throw AppError.badRequest('The entity-access warning must be confirmed for this viewer.');
  }

  await db
    .update(shareSessionParticipants)
    .set({
      status: 'approved',
      approvedAt: new Date(),
      isCrossFirm: ctx.isCrossFirm,
      scopeWarningShown: entityMismatch,
    })
    .where(eq(shareSessionParticipants.id, participantId));
  await db
    .update(shareSessions)
    .set({ status: 'active' })
    .where(and(eq(shareSessions.id, sessionId), eq(shareSessions.status, 'pending')));

  await audit(sessionId, 'participant_approved', {
    participantId,
    actorUserId,
    detail: { isCrossFirm: ctx.isCrossFirm, entityMismatchWarned: entityMismatch },
  });
  if (ctx.isCrossFirm) {
    await audit(sessionId, 'cross_firm_confirmation_shown', { participantId, actorUserId });
    void notifyFirstCrossFirm(session, ctx).catch(() => undefined);
  }
  if (entityMismatch) {
    await audit(sessionId, 'entity_scope_warning_shown', {
      participantId,
      actorUserId,
      detail: { entity: session.entityContext, entityName: ctx.entityName },
    });
  }
  await shareRedis.publishControl({ type: 'participant-update', sessionId });
}

/** 13.4 — "was this expected?" signal on a user's first-ever cross-firm share. */
async function notifyFirstCrossFirm(session: ShareSession, ctx: ApprovalContext): Promise<void> {
  const [priorRow] = await db
    .select({ n: count() })
    .from(shareSessionParticipants)
    .innerJoin(shareSessions, eq(shareSessions.id, shareSessionParticipants.sessionId))
    .where(
      and(
        eq(shareSessions.sharerUserId, session.sharerUserId),
        eq(shareSessionParticipants.isCrossFirm, true),
        eq(shareSessionParticipants.status, 'approved'),
      ),
    );
  if ((priorRow?.n ?? 0) > 1) return; // not the first
  const sharer = await db.query.users.findFirst({ where: eq(users.id, session.sharerUserId) });
  await alertTenantAdmins(
    session.tenantId,
    'MyBooks: first cross-firm screen share for a user',
    `<p><b>${sharer?.displayName ?? sharer?.email ?? session.sharerUserId}</b> approved their first screen-share viewer from outside your firm (<b>${ctx.viewerName}</b>, ${ctx.viewerFirmName}). If this was expected, no action is needed.</p>`,
  );
}

export async function denyParticipant(sessionId: string, participantId: string, actorUserId: string): Promise<void> {
  await requireSharerSession(sessionId, actorUserId);
  const participant = await db.query.shareSessionParticipants.findFirst({
    where: and(eq(shareSessionParticipants.id, participantId), eq(shareSessionParticipants.sessionId, sessionId)),
  });
  if (!participant) throw AppError.notFound('Request not found');
  if (participant.status !== 'requested') throw AppError.conflict('Only a pending request can be denied.');
  await db
    .update(shareSessionParticipants)
    .set({ status: 'denied', endedAt: new Date() })
    .where(eq(shareSessionParticipants.id, participantId));
  await audit(sessionId, 'participant_denied', { participantId, actorUserId });
  await shareRedis.publishControl({ type: 'participant-update', sessionId });
}

export async function ejectParticipant(sessionId: string, participantId: string, actorUserId: string): Promise<void> {
  await requireSharerSession(sessionId, actorUserId);
  const participant = await db.query.shareSessionParticipants.findFirst({
    where: and(eq(shareSessionParticipants.id, participantId), eq(shareSessionParticipants.sessionId, sessionId)),
  });
  if (!participant) throw AppError.notFound('Participant not found');
  if (participant.status !== 'approved') throw AppError.conflict('Only an approved viewer can be removed.');
  await db
    .update(shareSessionParticipants)
    .set({ status: 'ejected', endedAt: new Date() })
    .where(eq(shareSessionParticipants.id, participantId));
  await audit(sessionId, 'participant_ejected', { participantId, actorUserId });
  // Close that viewer's socket without touching others (3.10).
  await shareRedis.publishControl({ type: 'eject-participant', sessionId, participantId });
  await shareRedis.publishControl({ type: 'participant-update', sessionId });
}

/** A viewer ending their own view (3.12). */
export async function leaveSession(sessionId: string, viewerUserId: string): Promise<void> {
  const participant = await db.query.shareSessionParticipants.findFirst({
    where: and(
      eq(shareSessionParticipants.sessionId, sessionId),
      eq(shareSessionParticipants.viewerUserId, viewerUserId),
    ),
  });
  if (!participant) throw AppError.notFound('Participant not found');
  if (participant.status === 'approved' || participant.status === 'requested') {
    await db
      .update(shareSessionParticipants)
      .set({ status: 'left', endedAt: new Date() })
      .where(eq(shareSessionParticipants.id, participant.id));
    await audit(sessionId, 'participant_left', { participantId: participant.id, actorUserId: viewerUserId });
    await shareRedis.publishControl({ type: 'eject-participant', sessionId, participantId: participant.id });
    await shareRedis.publishControl({ type: 'participant-update', sessionId });
  }
}

export async function endSession(
  sessionId: string,
  reason: string,
  actorUserId?: string | null,
): Promise<void> {
  const session = await db.query.shareSessions.findFirst({ where: eq(shareSessions.id, sessionId) });
  if (!session) throw AppError.notFound('Session not found');
  // Idempotent (3.12).
  if (!LIVE_STATUSES.includes(session.status as (typeof LIVE_STATUSES)[number])) return;

  const terminal = reason === 'expired' || reason === 'idle_timeout' ? 'expired' : reason === 'revoked' || reason === 'kill_switch' || reason === 'user_disabled' ? 'revoked' : 'ended';
  const bytes = await shareRedis.getBytes(sessionId);
  await db
    .update(shareSessions)
    .set({ status: terminal, endedAt: new Date(), endedReason: reason, bytesRelayed: bytes })
    .where(eq(shareSessions.id, sessionId));
  await db
    .update(shareSessionParticipants)
    .set({ status: 'left', endedAt: new Date() })
    .where(and(eq(shareSessionParticipants.sessionId, sessionId), inArray(shareSessionParticipants.status, ['approved', 'requested'])));
  await audit(sessionId, 'session_ended', { actorUserId: actorUserId ?? null, detail: { reason, bytesRelayed: bytes } });
  await shareRedis.publishControl({ type: 'end-session', sessionId, reason });
  // 13.10 — tickets expire on their own 30s TTL; purge everything else.
  await shareRedis.purgeSessionKeys(sessionId);
}

/** One-time extension with re-consent (9.12). */
export async function extendSession(sessionId: string, actorUserId: string): Promise<Date> {
  const session = await requireSharerSession(sessionId, actorUserId);
  if (!LIVE_STATUSES.includes(session.status as (typeof LIVE_STATUSES)[number])) {
    throw AppError.badRequest('This session has ended.');
  }
  const alreadyExtended = await db.query.shareSessionAudit.findFirst({
    where: and(eq(shareSessionAudit.sessionId, sessionId), eq(shareSessionAudit.event, 'session_extended')),
  });
  if (alreadyExtended) throw AppError.conflict('This session was already extended once.');
  const newExpiry = new Date(Date.now() + env.SHARE_TTL_MINUTES * 60_000);
  await db.update(shareSessions).set({ expiresAt: newExpiry }).where(eq(shareSessions.id, sessionId));
  await audit(sessionId, 'session_extended', { actorUserId, detail: { newExpiry: newExpiry.toISOString() } });
  return newExpiry;
}

// ── Tickets (Phase 5.3–5.4) ────────────────────────────────────────────────

export async function issueSharerTicket(sessionId: string, userId: string): Promise<string> {
  const session = await requireSharerSession(sessionId, userId);
  if (!LIVE_STATUSES.includes(session.status as (typeof LIVE_STATUSES)[number])) {
    throw AppError.badRequest('This session has ended.');
  }
  return shareRedis.issueTicket({ sessionId, userId, role: 'sharer', participantId: null });
}

export async function issueViewerTicket(participantId: string, userId: string): Promise<string> {
  const participant = await db.query.shareSessionParticipants.findFirst({
    where: eq(shareSessionParticipants.id, participantId),
  });
  if (!participant || participant.viewerUserId !== userId) throw AppError.notFound('Participant not found');
  // Ticket only after approval (5.4): requesting while `requested` is 409.
  if (participant.status === 'requested') throw AppError.conflict('Not yet approved.');
  if (participant.status !== 'approved') throw AppError.forbidden('You cannot join this session.');
  const session = await db.query.shareSessions.findFirst({ where: eq(shareSessions.id, participant.sessionId) });
  if (!session || !LIVE_STATUSES.includes(session.status as (typeof LIVE_STATUSES)[number])) {
    throw AppError.badRequest('This session has ended.');
  }
  return shareRedis.issueTicket({
    sessionId: participant.sessionId,
    userId,
    role: 'viewer',
    participantId,
  });
}

// ── Reads (3.13, 12.3, 12.4) ───────────────────────────────────────────────

export async function getSessionForUser(sessionId: string, userId: string): Promise<{
  session: Omit<ShareSession, 'joinCodeHash'>;
  participants: Array<ShareParticipant & { viewerName: string; viewerFirmName: string }>;
  role: 'sharer' | 'viewer' | 'admin';
} | null> {
  const session = await db.query.shareSessions.findFirst({ where: eq(shareSessions.id, sessionId) });
  if (!session) return null;
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const participants = await db.query.shareSessionParticipants.findMany({
    where: eq(shareSessionParticipants.sessionId, sessionId),
    orderBy: [desc(shareSessionParticipants.requestedAt)],
  });
  const mine = participants.find((p) => p.viewerUserId === userId);
  // Only the sharer, a participant, or a tenant admin may read (4.9).
  const isSharer = session.sharerUserId === userId;
  const isAdmin = !!user && user.tenantId === session.tenantId && user.role === 'owner';
  if (!isSharer && !mine && !isAdmin) return null;

  const viewerIds = [...new Set(participants.map((p) => p.viewerUserId))];
  const viewerRows = viewerIds.length
    ? await db.query.users.findMany({ where: inArray(users.id, viewerIds) })
    : [];
  const tenantIds = [...new Set(participants.map((p) => p.viewerTenantId))];
  const tenantRows = tenantIds.length
    ? await db.query.tenants.findMany({ where: inArray(tenants.id, tenantIds) })
    : [];
  const nameOf = new Map(viewerRows.map((u) => [u.id, u.displayName ?? u.email]));
  const firmOf = new Map(tenantRows.map((t) => [t.id, t.name]));

  const { joinCodeHash: _hash, ...safeSession } = session;
  return {
    session: safeSession,
    participants: participants.map((p) => ({
      ...p,
      viewerName: nameOf.get(p.viewerUserId) ?? 'Unknown user',
      viewerFirmName: firmOf.get(p.viewerTenantId) ?? 'Unknown firm',
    })),
    role: isSharer ? 'sharer' : mine ? 'viewer' : 'admin',
  };
}

export async function listMySessions(userId: string): Promise<{
  shared: Array<Omit<ShareSession, 'joinCodeHash'>>;
  viewed: Array<ShareParticipant & { sharerName: string; sessionCreatedAt: Date | null }>;
}> {
  const shared = await db.query.shareSessions.findMany({
    where: eq(shareSessions.sharerUserId, userId),
    orderBy: [desc(shareSessions.createdAt)],
    limit: 100,
  });
  const viewedRows = await db
    .select({
      participant: shareSessionParticipants,
      sharerUserId: shareSessions.sharerUserId,
      sessionCreatedAt: shareSessions.createdAt,
    })
    .from(shareSessionParticipants)
    .innerJoin(shareSessions, eq(shareSessions.id, shareSessionParticipants.sessionId))
    .where(eq(shareSessionParticipants.viewerUserId, userId))
    .orderBy(desc(shareSessionParticipants.requestedAt))
    .limit(100);
  const sharerIds = [...new Set(viewedRows.map((r) => r.sharerUserId))];
  const sharers = sharerIds.length ? await db.query.users.findMany({ where: inArray(users.id, sharerIds) }) : [];
  const nameOf = new Map(sharers.map((u) => [u.id, u.displayName ?? u.email]));
  return {
    shared: shared.map(({ joinCodeHash: _h, ...s }) => s),
    viewed: viewedRows.map((r) => ({
      ...r.participant,
      sharerName: nameOf.get(r.sharerUserId) ?? 'Unknown user',
      sessionCreatedAt: r.sessionCreatedAt,
    })),
  };
}

export interface AdminSessionRow {
  session: Omit<ShareSession, 'joinCodeHash'>;
  sharerName: string;
  participants: Array<{
    id: string;
    viewerName: string;
    viewerFirmName: string;
    status: string;
    isCrossFirm: boolean;
    scopeWarningShown: boolean;
    requestedAt: Date;
    approvedAt: Date | null;
    endedAt: Date | null;
  }>;
}

export async function listTenantSessions(
  tenantId: string,
  opts: { from?: Date; to?: Date; crossFirmOnly?: boolean; limit?: number; offset?: number } = {},
): Promise<AdminSessionRow[]> {
  const where = [eq(shareSessions.tenantId, tenantId)];
  if (opts.from) where.push(gt(shareSessions.createdAt, opts.from));
  if (opts.to) where.push(lt(shareSessions.createdAt, opts.to));
  const sessions = await db.query.shareSessions.findMany({
    where: and(...where),
    orderBy: [desc(shareSessions.createdAt)],
    limit: Math.min(opts.limit ?? 100, 500),
    offset: opts.offset ?? 0,
  });
  if (sessions.length === 0) return [];
  const sessionIds = sessions.map((s) => s.id);
  const participants = await db.query.shareSessionParticipants.findMany({
    where: inArray(shareSessionParticipants.sessionId, sessionIds),
  });
  const userIds = [...new Set([...sessions.map((s) => s.sharerUserId), ...participants.map((p) => p.viewerUserId)])];
  const userRows = userIds.length ? await db.query.users.findMany({ where: inArray(users.id, userIds) }) : [];
  const tenantIds = [...new Set(participants.map((p) => p.viewerTenantId))];
  const tenantRows = tenantIds.length ? await db.query.tenants.findMany({ where: inArray(tenants.id, tenantIds) }) : [];
  const nameOf = new Map(userRows.map((u) => [u.id, u.displayName ?? u.email]));
  const firmOf = new Map(tenantRows.map((t) => [t.id, t.name]));

  const rows = sessions.map((s) => {
    const { joinCodeHash: _h, ...safe } = s;
    const ps = participants
      .filter((p) => p.sessionId === s.id)
      .map((p) => ({
        id: p.id,
        viewerName: nameOf.get(p.viewerUserId) ?? 'Unknown user',
        viewerFirmName: firmOf.get(p.viewerTenantId) ?? 'Unknown firm',
        status: p.status,
        isCrossFirm: p.isCrossFirm,
        scopeWarningShown: !!p.scopeWarningShown,
        requestedAt: p.requestedAt,
        approvedAt: p.approvedAt,
        endedAt: p.endedAt,
      }));
    return { session: safe, sharerName: nameOf.get(s.sharerUserId) ?? 'Unknown user', participants: ps };
  });
  return opts.crossFirmOnly ? rows.filter((r) => r.participants.some((p) => p.isCrossFirm)) : rows;
}

// ── Admin controls (13.7–13.9) ─────────────────────────────────────────────

/** Firm admin terminates any live session in their tenant (13.8). */
export async function adminEndSession(sessionId: string, adminUserId: string, tenantId: string): Promise<void> {
  const session = await db.query.shareSessions.findFirst({ where: eq(shareSessions.id, sessionId) });
  if (!session || session.tenantId !== tenantId) throw AppError.notFound('Session not found');
  await endSession(sessionId, 'revoked', adminUserId);
}

/** Per-user disable (D9, 13.9): flips users.share_allowed and ends the
 *  user's live involvement — as sharer AND as viewer — immediately. */
export async function setUserShareAllowed(targetUserId: string, allowed: boolean | null, actorUserId: string): Promise<void> {
  await db.update(users).set({ shareAllowed: allowed }).where(eq(users.id, targetUserId));
  if (allowed === false) {
    const live = await db.query.shareSessions.findMany({
      where: and(eq(shareSessions.sharerUserId, targetUserId), inArray(shareSessions.status, [...LIVE_STATUSES])),
    });
    for (const s of live) await endSession(s.id, 'user_disabled', actorUserId);
    await shareRedis.publishControl({ type: 'end-user', userId: targetUserId, reason: 'user_disabled' });
    // Mark their live viewer rows ejected.
    const viewing = await db
      .select({ p: shareSessionParticipants })
      .from(shareSessionParticipants)
      .where(and(eq(shareSessionParticipants.viewerUserId, targetUserId), eq(shareSessionParticipants.status, 'approved')));
    for (const { p } of viewing) {
      await db
        .update(shareSessionParticipants)
        .set({ status: 'ejected', endedAt: new Date() })
        .where(eq(shareSessionParticipants.id, p.id));
      await audit(p.sessionId, 'participant_ejected', { participantId: p.id, actorUserId, detail: { reason: 'user_disabled' } });
      await shareRedis.publishControl({ type: 'eject-participant', sessionId: p.sessionId, participantId: p.id });
    }
  }
}

export async function setTenantShareSettings(tenantId: string, settings: TenantShareSettings): Promise<void> {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) throw AppError.notFound('Tenant not found');
  const merged = { ...tenantSettingsOf(tenant), ...settings };
  await db.update(tenants).set({ shareSettings: merged, updatedAt: new Date() }).where(eq(tenants.id, tenantId));
  if (settings.enabled === false) {
    const live = await db.query.shareSessions.findMany({
      where: and(eq(shareSessions.tenantId, tenantId), inArray(shareSessions.status, [...LIVE_STATUSES])),
    });
    for (const s of live) await endSession(s.id, 'revoked', null);
  }
}

export async function getTenantShareSettings(tenantId: string): Promise<TenantShareSettings & { globalEnabled: boolean }> {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  return { ...tenantSettingsOf(tenant), globalEnabled: env.SHARE_ENABLED && !(await isKillSwitchOn()) };
}

// ── Sweeps (3.13, 12.8, 13.6) ──────────────────────────────────────────────

export async function sweepExpiredSessions(): Promise<number> {
  const live = await db.query.shareSessions.findMany({
    where: inArray(shareSessions.status, [...LIVE_STATUSES]),
  });
  let ended = 0;
  const idleMs = env.SHARE_IDLE_TIMEOUT_SECONDS * 1000;
  for (const s of live) {
    if (s.expiresAt.getTime() <= Date.now()) {
      await endSession(s.id, 'expired');
      ended += 1;
      continue;
    }
    // Idle timeout (13.6) — only bites once a viewer has ever been approved
    // (an unclaimed pending session is bounded by the TTL alone) and only
    // while the recorder should be flowing.
    if (s.status === 'active') {
      const last = await shareRedis.lastActivityAt(s.id);
      if (last !== null && Date.now() - last > idleMs) {
        await endSession(s.id, 'idle_timeout');
        ended += 1;
      }
    }
  }
  return ended;
}

export async function sweepLapsedParticipants(): Promise<number> {
  const cutoff = new Date(Date.now() - env.SHARE_APPROVAL_WINDOW_SECONDS * 1000);
  const stale = await db.query.shareSessionParticipants.findMany({
    where: and(eq(shareSessionParticipants.status, 'requested'), lt(shareSessionParticipants.requestedAt, cutoff)),
  });
  for (const p of stale) {
    await db
      .update(shareSessionParticipants)
      .set({ status: 'lapsed', endedAt: new Date() })
      .where(and(eq(shareSessionParticipants.id, p.id), eq(shareSessionParticipants.status, 'requested')));
    await audit(p.sessionId, 'approval_lapsed', { participantId: p.id });
    await shareRedis.publishControl({ type: 'participant-update', sessionId: p.sessionId });
  }
  return stale.length;
}

/** Retention purge (12.8): audit rows past SHARE_AUDIT_RETENTION_DAYS, plus
 *  the session/participant rows they describe. Sets the session-local flag
 *  the append-only trigger honors. */
export async function purgeExpiredAudit(): Promise<number> {
  const cutoff = new Date(Date.now() - env.SHARE_AUDIT_RETENTION_DAYS * 24 * 3600_000);
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('mybooks.share_audit_retention', 'on', true)`);
    const oldSessions = await tx
      .select({ id: shareSessions.id })
      .from(shareSessions)
      .where(and(lt(shareSessions.createdAt, cutoff), inArray(shareSessions.status, ['ended', 'expired', 'revoked'])));
    if (oldSessions.length === 0) return 0;
    const ids = oldSessions.map((s) => s.id);
    // Audit rows cascade from sessions, but delete explicitly first so the
    // trigger flag is exercised deliberately rather than via cascade.
    await tx.delete(shareSessionAudit).where(inArray(shareSessionAudit.sessionId, ids));
    await tx.delete(shareSessionParticipants).where(inArray(shareSessionParticipants.sessionId, ids));
    await tx.delete(shareSessions).where(inArray(shareSessions.id, ids));
    return ids.length;
  });
  return result;
}

// Guard used by the byte-cap check in the gateway.
export async function enforceByteCap(sessionId: string, total: number): Promise<boolean> {
  if (total <= env.SHARE_MAX_BYTES_PER_SESSION) return false;
  await audit(sessionId, 'limit_breached', { detail: { limit: 'bytes', total } });
  await endSession(sessionId, 'byte_cap');
  return true;
}
