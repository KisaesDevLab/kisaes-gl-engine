// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Peer screen share REST surface. Everything except the WS gateway.
//
// Feature-off posture (2.8): every route 404s — indistinguishable from the
// feature not existing — so disabled tenants cannot fingerprint it.

import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { getRateLimitStore } from '../utils/rate-limit-store.js';
import * as shareService from '../services/share/share.service.js';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';

export const shareRouter = Router();

// ── Feature gate ────────────────────────────────────────────────────────────

async function requireShareEnabled(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    if (!(await shareService.shareEnabledFor(req.userId, req.tenantId))) {
      next(AppError.notFound('Not found'));
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}

// ── Rate limits (13.1) ─────────────────────────────────────────────────────

const createLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 5, // 5 session creations per user per hour
  keyGenerator: (req) => `share-create:${req.userId ?? req.ip}`,
  store: getRateLimitStore('share-create'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many share sessions created. Try again later.' } },
});

const submitUserLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 10, // 10 code submissions per user per hour
  keyGenerator: (req) => `share-submit-user:${req.userId ?? req.ip}`,
  store: getRateLimitStore('share-submit-user'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many join attempts. Try again later.' } },
});

const submitIpLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 20, // 20 per IP per hour
  keyGenerator: (req) => `share-submit-ip:${req.ip}`,
  store: getRateLimitStore('share-submit-ip'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many join attempts from this address. Try again later.' } },
});

// ── Capabilities probe for the web UI ──────────────────────────────────────

// Intentionally NOT behind requireShareEnabled: the client uses it to decide
// whether to render the Share button at all. It reveals only the boolean the
// UI needs; when the feature is globally off it 404s like everything else.
shareRouter.get('/capabilities', authenticate, async (req, res) => {
  const enabled = await shareService.shareEnabledFor(req.userId, req.tenantId);
  if (!enabled) {
    res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } });
    return;
  }
  res.json({ canShare: true, canView: true });
});

// ── Session lifecycle (Phase 3) ─────────────────────────────────────────────

const createSessionSchema = z.object({
  entityContext: z.string().uuid().nullable().optional(),
});

shareRouter.post(
  '/sessions',
  authenticate,
  requireShareEnabled,
  createLimiter,
  validate(createSessionSchema),
  async (req, res) => {
    const result = await shareService.createSession(req.userId, req.tenantId, {
      entityContext: req.body.entityContext ?? null,
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
    // joinCode is returned exactly once and never re-retrievable (3.1).
    res.status(201).json(result);
  },
);

const requestJoinSchema = z.object({
  code: z.string().min(4).max(32),
});

shareRouter.post(
  '/sessions/request',
  authenticate,
  requireShareEnabled,
  submitUserLimiter,
  submitIpLimiter,
  validate(requestJoinSchema),
  async (req, res) => {
    const result = await shareService.requestJoin(req.userId, req.tenantId, req.body.code, {
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
    res.status(202).json(result);
  },
);

// Approval context for the sharer's prompt (identity + firm + entity scope).
shareRouter.get('/sessions/:sessionId/participants/:participantId/context', authenticate, requireShareEnabled, async (req, res) => {
  const sessionId = String(req.params['sessionId']);
  const session = await shareService.getSessionForUser(sessionId, req.userId);
  if (!session || session.role !== 'sharer') throw AppError.notFound('Session not found');
  const ctx = await shareService.approvalContext(sessionId, String(req.params['participantId']));
  res.json({
    participantId: ctx.participant.id,
    status: ctx.participant.status,
    viewerName: ctx.viewerName,
    viewerEmail: ctx.viewerEmail,
    viewerFirmName: ctx.viewerFirmName,
    isCrossFirm: ctx.isCrossFirm,
    viewerHasEntityAccess: ctx.viewerHasEntityAccess,
    entityName: ctx.entityName,
    requestedAt: ctx.participant.requestedAt,
    approvalWindowSeconds: env.SHARE_APPROVAL_WINDOW_SECONDS,
  });
});

const approveSchema = z.object({
  crossFirmConfirmed: z.boolean().optional(),
  scopeWarningConfirmed: z.boolean().optional(),
});

shareRouter.post(
  '/sessions/:sessionId/participants/:participantId/approve',
  authenticate,
  requireShareEnabled,
  validate(approveSchema),
  async (req, res) => {
    await shareService.approveParticipant(
      String(req.params['sessionId']),
      String(req.params['participantId']),
      req.userId,
      {
        crossFirmConfirmed: req.body.crossFirmConfirmed === true,
        scopeWarningConfirmed: req.body.scopeWarningConfirmed === true,
      },
    );
    res.json({ approved: true });
  },
);

shareRouter.post('/sessions/:sessionId/participants/:participantId/deny', authenticate, requireShareEnabled, async (req, res) => {
  await shareService.denyParticipant(String(req.params['sessionId']), String(req.params['participantId']), req.userId);
  res.json({ denied: true });
});

shareRouter.post('/sessions/:sessionId/participants/:participantId/eject', authenticate, requireShareEnabled, async (req, res) => {
  await shareService.ejectParticipant(String(req.params['sessionId']), String(req.params['participantId']), req.userId);
  res.json({ ejected: true });
});

// Sharer WS ticket.
shareRouter.post('/sessions/:sessionId/ticket', authenticate, requireShareEnabled, async (req, res) => {
  const ticket = await shareService.issueSharerTicket(String(req.params['sessionId']), req.userId);
  res.json({ ticket });
});

// Viewer WS ticket — only issuable once approved (5.4).
shareRouter.post('/participants/:participantId/ticket', authenticate, requireShareEnabled, async (req, res) => {
  const ticket = await shareService.issueViewerTicket(String(req.params['participantId']), req.userId);
  res.json({ ticket });
});

shareRouter.post('/sessions/:sessionId/end', authenticate, requireShareEnabled, async (req, res) => {
  const sessionId = String(req.params['sessionId']);
  const data = await shareService.getSessionForUser(sessionId, req.userId);
  if (!data) throw AppError.notFound('Session not found');
  if (data.role === 'sharer') {
    await shareService.endSession(sessionId, 'ended_by_sharer', req.userId);
  } else if (data.role === 'viewer') {
    await shareService.leaveSession(sessionId, req.userId);
  } else {
    await shareService.adminEndSession(sessionId, req.userId, req.tenantId);
  }
  res.json({ ended: true });
});

shareRouter.post('/sessions/:sessionId/extend', authenticate, requireShareEnabled, async (req, res) => {
  const newExpiry = await shareService.extendSession(String(req.params['sessionId']), req.userId);
  res.json({ expiresAt: newExpiry });
});

shareRouter.get('/sessions/mine', authenticate, requireShareEnabled, async (req, res) => {
  res.json(await shareService.listMySessions(req.userId));
});

shareRouter.get('/sessions/:sessionId', authenticate, requireShareEnabled, async (req, res) => {
  const data = await shareService.getSessionForUser(String(req.params['sessionId']), req.userId);
  if (!data) throw AppError.notFound('Session not found');
  res.json(data);
});

// ── Admin (Phase 12.4–12.6, 13.8; tenant owners only) ──────────────────────

async function requireTenantOwner(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, req.userId) });
  if (!user || user.role !== 'owner' || user.userType !== 'staff') {
    next(AppError.notFound('Not found'));
    return;
  }
  next();
}

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

shareRouter.get('/admin/sessions', authenticate, requireShareEnabled, requireTenantOwner, async (req, res) => {
  const from = req.query['from'] ? new Date(String(req.query['from'])) : undefined;
  const to = req.query['to'] ? new Date(String(req.query['to'])) : undefined;
  const crossFirmOnly = req.query['crossFirm'] === '1';
  const rows = await shareService.listTenantSessions(req.tenantId, {
    from: from && !Number.isNaN(from.getTime()) ? from : undefined,
    to: to && !Number.isNaN(to.getTime()) ? to : undefined,
    crossFirmOnly,
    limit: req.query['limit'] ? Number(req.query['limit']) : undefined,
    offset: req.query['offset'] ? Number(req.query['offset']) : undefined,
  });
  if (req.query['format'] === 'csv') {
    const header = 'session_id,created_at,ended_at,ended_reason,status,sharer,entity_context,viewer,viewer_firm,cross_firm,scope_warning_shown,viewer_status,requested_at,approved_at,viewer_ended_at';
    const lines: string[] = [header];
    for (const r of rows) {
      if (r.participants.length === 0) {
        lines.push([r.session.id, r.session.createdAt?.toISOString(), r.session.endedAt?.toISOString() ?? '', r.session.endedReason ?? '', r.session.status, r.sharerName, r.session.entityContext ?? '', '', '', '', '', '', '', '', ''].map(csvEscape).join(','));
      }
      for (const p of r.participants) {
        lines.push(
          [
            r.session.id,
            r.session.createdAt?.toISOString(),
            r.session.endedAt?.toISOString() ?? '',
            r.session.endedReason ?? '',
            r.session.status,
            r.sharerName,
            r.session.entityContext ?? '',
            p.viewerName,
            p.viewerFirmName,
            p.isCrossFirm ? 'yes' : 'no',
            p.scopeWarningShown ? 'yes' : 'no',
            p.status,
            p.requestedAt.toISOString(),
            p.approvedAt?.toISOString() ?? '',
            p.endedAt?.toISOString() ?? '',
          ].map(csvEscape).join(','),
        );
      }
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="share-sessions.csv"');
    res.send(lines.join('\n'));
    return;
  }
  res.json({ sessions: rows });
});

// Operational metrics (12.7) — aggregates only, no content (none exists).
shareRouter.get('/admin/metrics', authenticate, requireShareEnabled, requireTenantOwner, async (req, res) => {
  const { db: database } = await import('../db/index.js');
  const { sql } = await import('drizzle-orm');
  const [row] = (await database.execute(sql`
    SELECT
      count(*)::int AS sessions_total,
      count(*) FILTER (WHERE s.status IN ('pending','active'))::int AS sessions_live,
      count(*) FILTER (WHERE s.ended_reason IN ('expired','idle_timeout','byte_cap','sharer_disconnected','kill_switch','user_disabled'))::int AS abnormal_terminations,
      COALESCE(sum(s.bytes_relayed),0)::bigint AS bytes_relayed,
      COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (s.ended_at - s.created_at))) FILTER (WHERE s.ended_at IS NOT NULL), 0) AS median_duration_s,
      COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (s.ended_at - s.created_at))) FILTER (WHERE s.ended_at IS NOT NULL), 0) AS p95_duration_s,
      (SELECT count(*)::int FROM share_session_participants p JOIN share_sessions s2 ON s2.id = p.session_id WHERE s2.tenant_id = ${req.tenantId} AND p.status = 'approved') AS approvals,
      (SELECT count(*)::int FROM share_session_participants p JOIN share_sessions s2 ON s2.id = p.session_id WHERE s2.tenant_id = ${req.tenantId} AND p.status = 'denied') AS denials,
      (SELECT count(*)::int FROM share_session_participants p JOIN share_sessions s2 ON s2.id = p.session_id WHERE s2.tenant_id = ${req.tenantId} AND p.status = 'lapsed') AS lapses,
      (SELECT count(*)::int FROM share_session_participants p JOIN share_sessions s2 ON s2.id = p.session_id WHERE s2.tenant_id = ${req.tenantId} AND p.status = 'ejected') AS ejections,
      (SELECT count(*)::int FROM share_session_participants p JOIN share_sessions s2 ON s2.id = p.session_id WHERE s2.tenant_id = ${req.tenantId} AND p.is_cross_firm) AS cross_firm_participants
    FROM share_sessions s
    WHERE s.tenant_id = ${req.tenantId}
  `)).rows as Array<Record<string, unknown>>;
  res.json({ metrics: row ?? {} });
});

shareRouter.post('/admin/sessions/:sessionId/end', authenticate, requireShareEnabled, requireTenantOwner, async (req, res) => {
  await shareService.adminEndSession(String(req.params['sessionId']), req.userId, req.tenantId);
  res.json({ ended: true });
});

const tenantSettingsSchema = z.object({
  enabled: z.boolean().nullable().optional(),
  allowInboundCrossFirm: z.boolean().optional(),
});

// Settings are readable/writable even when the tenant has turned the feature
// off — otherwise a disabling admin could never re-enable it. Still requires
// the GLOBAL flag (env + kill switch), since 2.8 only demands that disabled
// TENANTS cannot fingerprint the feature.
async function requireGloballyEnabled(_req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!env.SHARE_ENABLED || (await shareService.isKillSwitchOn())) {
    next(AppError.notFound('Not found'));
    return;
  }
  next();
}

shareRouter.get('/admin/settings', authenticate, requireGloballyEnabled, requireTenantOwner, async (req, res) => {
  res.json(await shareService.getTenantShareSettings(req.tenantId));
});

shareRouter.put('/admin/settings', authenticate, requireGloballyEnabled, requireTenantOwner, validate(tenantSettingsSchema), async (req, res) => {
  await shareService.setTenantShareSettings(req.tenantId, req.body);
  res.json(await shareService.getTenantShareSettings(req.tenantId));
});

const userOverrideSchema = z.object({
  shareAllowed: z.boolean().nullable(),
});

shareRouter.put('/admin/users/:userId/share-allowed', authenticate, requireGloballyEnabled, requireTenantOwner, validate(userOverrideSchema), async (req, res) => {
  const target = await db.query.users.findFirst({ where: eq(users.id, String(req.params['userId'])) });
  if (!target || target.tenantId !== req.tenantId) throw AppError.notFound('User not found');
  await shareService.setUserShareAllowed(target.id, req.body.shareAllowed, req.userId);
  res.json({ userId: target.id, shareAllowed: req.body.shareAllowed });
});
