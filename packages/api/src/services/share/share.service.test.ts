// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Peer screen share — service tests (Phase 14.1, 14.4, 14.5, and the
// structural half of 14.7: a participant that is not `approved` can never
// obtain a WS ticket, and the gateway only relays to ticket-authenticated
// sockets, so zero events reach requested/denied/lapsed/ejected viewers).
//
// Redis is mocked in-memory (tickets/bytes/counters); Postgres is the real
// shared test database.

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';

process.env['SHARE_ENABLED'] = 'true';
process.env['SHARE_MAX_VIEWERS_PER_SESSION'] = '1'; // makes the cap testable
process.env['SHARE_APPROVAL_WINDOW_SECONDS'] = '60';

// ── In-memory Redis stand-in ────────────────────────────────────────────────
const tickets = new Map<string, unknown>();
const counters = new Map<string, number>();
const activity = new Map<string, number>();
const bytes = new Map<string, number>();
export const controlMessages: unknown[] = [];

vi.mock('./share-redis.js', () => ({
  issueTicket: vi.fn(async (payload: unknown) => {
    const t = randomUUID();
    tickets.set(t, payload);
    return t;
  }),
  consumeTicket: vi.fn(async (t: string) => {
    const p = tickets.get(t) ?? null;
    tickets.delete(t);
    return p;
  }),
  recordCodeFailure: vi.fn(async (userId: string) => {
    const n = (counters.get(userId) ?? 0) + 1;
    counters.set(userId, n);
    return n;
  }),
  clearCodeFailures: vi.fn(async (userId: string) => {
    counters.delete(userId);
  }),
  codeFailureCount: vi.fn(async (userId: string) => counters.get(userId) ?? 0),
  touchActivity: vi.fn(async (id: string) => {
    activity.set(id, Date.now());
  }),
  lastActivityAt: vi.fn(async (id: string) => activity.get(id) ?? null),
  addBytes: vi.fn(async (id: string, n: number) => {
    const t = (bytes.get(id) ?? 0) + n;
    bytes.set(id, t);
    return t;
  }),
  getBytes: vi.fn(async (id: string) => bytes.get(id) ?? 0),
  refreshPresence: vi.fn(async () => undefined),
  hasPresence: vi.fn(async () => true),
  cacheSnapshot: vi.fn(async () => undefined),
  getCachedSnapshot: vi.fn(async () => null),
  purgeSessionKeys: vi.fn(async () => undefined),
  publishControl: vi.fn(async (msg: unknown) => {
    controlMessages.push(msg);
  }),
}));

const shareService = await import('./share.service.js');
const { db } = await import('../../db/index.js');
const schema = await import('../../db/schema/index.js');
const { eq, and } = await import('drizzle-orm');

// ── Seed helpers ────────────────────────────────────────────────────────────

async function seedTenant(name: string) {
  const [t] = await db
    .insert(schema.tenants)
    .values({ name, slug: `share-test-${randomUUID().slice(0, 13)}` })
    .returning();
  return t!;
}

async function seedUser(tenantId: string, role = 'owner') {
  const [u] = await db
    .insert(schema.users)
    .values({
      tenantId,
      email: `share-${randomUUID().slice(0, 8)}@test.local`,
      passwordHash: 'x',
      role,
      userType: 'staff',
      isActive: true,
    })
    .returning();
  return u!;
}

async function seedCompany(tenantId: string, businessName: string) {
  const [c] = await db.insert(schema.companies).values({ tenantId, businessName }).returning();
  return c!;
}

let firmA: { id: string };
let firmB: { id: string };
let sharer: { id: string; tenantId: string };
let sameFirmViewer: { id: string; tenantId: string };
let crossFirmViewer: { id: string; tenantId: string };
let companyA: { id: string };

beforeAll(async () => {
  firmA = await seedTenant('Share Test Firm A');
  firmB = await seedTenant('Share Test Firm B');
  sharer = await seedUser(firmA.id);
  sameFirmViewer = await seedUser(firmA.id, 'accountant');
  crossFirmViewer = await seedUser(firmB.id);
  companyA = await seedCompany(firmA.id, 'Share Test Co A');
});

// ── Join codes (14.1) ───────────────────────────────────────────────────────

describe('join codes', () => {
  it('generates 8 chars from the Crockford alphabet (no I, L, O, U)', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = shareService.generateJoinCode();
      expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
    }
  });

  it('two consecutive codes differ (entropy sanity)', () => {
    expect(shareService.generateJoinCode()).not.toBe(shareService.generateJoinCode());
  });

  it('normalizes typed codes: case, hyphen, Crockford aliases', () => {
    expect(shareService.normalizeJoinCode('4f7k-9rb2')).toBe('4F7K9RB2');
    expect(shareService.normalizeJoinCode('IL O u')).toBe('110V');
  });

  it('hash comparison is length-guarded and content-exact', () => {
    const h = shareService.hashJoinCode('4F7K9RB2');
    expect(shareService.codeHashEquals(h, h)).toBe(true);
    expect(shareService.codeHashEquals(h, shareService.hashJoinCode('4F7K9RB3'))).toBe(false);
    expect(shareService.codeHashEquals(h, 'abcd')).toBe(false);
  });
});

// ── Cross-firm + entity scope (14.4) ────────────────────────────────────────

describe('scope computation', () => {
  it('same home tenant is never cross-firm', async () => {
    expect(await shareService.computeIsCrossFirm(sameFirmViewer.id, firmA.id, firmA.id)).toBe(false);
  });

  it('a different tenant with no tenancy is cross-firm', async () => {
    expect(await shareService.computeIsCrossFirm(crossFirmViewer.id, firmB.id, firmA.id)).toBe(true);
  });

  it('an active user_tenant_access row clears cross-firm', async () => {
    const linked = await seedUser(firmB.id);
    await db.insert(schema.userTenantAccess).values({ userId: linked.id, tenantId: firmA.id, isActive: true });
    expect(await shareService.computeIsCrossFirm(linked.id, firmB.id, firmA.id)).toBe(false);
  });

  it('entity access: in-tenant viewer yes, cross-firm viewer no, exclusion strips it', async () => {
    expect(await shareService.viewerHasEntityAccess(sameFirmViewer.id, firmA.id, companyA.id)).toBe(true);
    expect(await shareService.viewerHasEntityAccess(crossFirmViewer.id, firmB.id, companyA.id)).toBe(false);
    await db.insert(schema.accountantCompanyExclusions).values({ userId: sameFirmViewer.id, companyId: companyA.id });
    expect(await shareService.viewerHasEntityAccess(sameFirmViewer.id, firmA.id, companyA.id)).toBe(false);
    await db
      .delete(schema.accountantCompanyExclusions)
      .where(eq(schema.accountantCompanyExclusions.userId, sameFirmViewer.id));
  });

  it('returns null when the session recorded no entity context', async () => {
    expect(await shareService.viewerHasEntityAccess(sameFirmViewer.id, firmA.id, null)).toBeNull();
  });
});

// ── Lifecycle + participant state machine (14.5, 14.6, structural 14.7) ────

describe('session lifecycle', () => {
  it('runs the full multi-viewer arc: create → request → approve/deny → eject → end', async () => {
    const created = await shareService.createSession(sharer.id, firmA.id, { entityContext: companyA.id });
    expect(created.joinCode).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);

    // The DB stores only the hash — the plaintext code is unrecoverable.
    const row = await db.query.shareSessions.findFirst({ where: eq(schema.shareSessions.id, created.sessionId) });
    expect(row!.joinCodeHash).not.toContain(created.joinCode);
    expect(row!.status).toBe('pending');

    // Sharer cannot view their own session.
    await expect(
      shareService.requestJoin(sharer.id, firmA.id, created.joinCode, {}),
    ).rejects.toThrow(/own share session/i);

    // Wrong code: identical not-found message + failure counter.
    await expect(
      shareService.requestJoin(sameFirmViewer.id, firmA.id, 'AAAAAAAA', {}),
    ).rejects.toThrow(/not valid/i);

    // Right code → requested participant. No ticket yet (14.7 gate): 409.
    const reqd = await shareService.requestJoin(sameFirmViewer.id, firmA.id, created.joinCode, {});
    await expect(shareService.issueViewerTicket(reqd.participantId, sameFirmViewer.id)).rejects.toThrow(/not yet approved/i);

    // Only the sharer may approve — a participant cannot approve themselves (4.10).
    await expect(
      shareService.approveParticipant(created.sessionId, reqd.participantId, sameFirmViewer.id, {}),
    ).rejects.toThrow(/only the sharer/i);

    // Approve (same-firm, entity matches → no confirmations needed).
    await shareService.approveParticipant(created.sessionId, reqd.participantId, sharer.id, {});
    const ticket = await shareService.issueViewerTicket(reqd.participantId, sameFirmViewer.id);
    expect(ticket).toBeTruthy();

    // Viewer cap (env pinned to 1): a second viewer is rejected.
    await expect(
      shareService.requestJoin(crossFirmViewer.id, firmB.id, created.joinCode, {}),
    ).rejects.toThrow(/maximum number of viewers/i);

    // Eject → permanent for that user in this session.
    await shareService.ejectParticipant(created.sessionId, reqd.participantId, sharer.id);
    await expect(
      shareService.requestJoin(sameFirmViewer.id, firmA.id, created.joinCode, {}),
    ).rejects.toThrow(/cannot join/i);
    // An ejected viewer's ticket path is dead too (4.10).
    await expect(shareService.issueViewerTicket(reqd.participantId, sameFirmViewer.id)).rejects.toThrow(/cannot join/i);

    // End is idempotent.
    await shareService.endSession(created.sessionId, 'ended_by_sharer', sharer.id);
    await shareService.endSession(created.sessionId, 'ended_by_sharer', sharer.id);
    const ended = await db.query.shareSessions.findFirst({ where: eq(schema.shareSessions.id, created.sessionId) });
    expect(ended!.status).toBe('ended');
  });

  it('cross-firm approval requires the D5 confirmation server-side', async () => {
    const created = await shareService.createSession(sharer.id, firmA.id, { entityContext: companyA.id });
    const reqd = await shareService.requestJoin(crossFirmViewer.id, firmB.id, created.joinCode, {});

    // Approval context names the person, their firm, and the entity mismatch.
    const ctx = await shareService.approvalContext(created.sessionId, reqd.participantId);
    expect(ctx.isCrossFirm).toBe(true);
    expect(ctx.viewerHasEntityAccess).toBe(false);
    expect(ctx.viewerFirmName).toContain('Firm B');

    // Missing confirmations are rejected regardless of what the UI sends.
    await expect(
      shareService.approveParticipant(created.sessionId, reqd.participantId, sharer.id, {}),
    ).rejects.toThrow(/cross-firm/i);
    await expect(
      shareService.approveParticipant(created.sessionId, reqd.participantId, sharer.id, { crossFirmConfirmed: true }),
    ).rejects.toThrow(/entity-access warning/i);

    await shareService.approveParticipant(created.sessionId, reqd.participantId, sharer.id, {
      crossFirmConfirmed: true,
      scopeWarningConfirmed: true,
    });
    const p = await db.query.shareSessionParticipants.findFirst({
      where: eq(schema.shareSessionParticipants.id, reqd.participantId),
    });
    expect(p!.status).toBe('approved');
    expect(p!.scopeWarningShown).toBe(true);

    // Audit rows record both warnings (12.1).
    const auditRows = await db.query.shareSessionAudit.findMany({
      where: eq(schema.shareSessionAudit.sessionId, created.sessionId),
    });
    const events = auditRows.map((a) => a.event);
    expect(events).toContain('cross_firm_confirmation_shown');
    expect(events).toContain('entity_scope_warning_shown');

    await shareService.endSession(created.sessionId, 'ended_by_sharer', sharer.id);
  });

  it('denied users cannot re-request; lapsed users can', async () => {
    const created = await shareService.createSession(sharer.id, firmA.id, {});
    const reqd = await shareService.requestJoin(sameFirmViewer.id, firmA.id, created.joinCode, {});
    await shareService.denyParticipant(created.sessionId, reqd.participantId, sharer.id);
    await expect(
      shareService.requestJoin(sameFirmViewer.id, firmA.id, created.joinCode, {}),
    ).rejects.toThrow(/cannot join/i);

    // Lapse another viewer's fresh request by aging it, then sweep.
    const reqd2 = await shareService.requestJoin(crossFirmViewer.id, firmB.id, created.joinCode, {});
    await db
      .update(schema.shareSessionParticipants)
      .set({ requestedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(schema.shareSessionParticipants.id, reqd2.participantId));
    await shareService.sweepLapsedParticipants();
    const lapsed = await db.query.shareSessionParticipants.findFirst({
      where: eq(schema.shareSessionParticipants.id, reqd2.participantId),
    });
    expect(lapsed!.status).toBe('lapsed');

    // Lapsed → re-request resets the SAME row (unique index holds).
    const again = await shareService.requestJoin(crossFirmViewer.id, firmB.id, created.joinCode, {});
    expect(again.participantId).toBe(reqd2.participantId);

    await shareService.endSession(created.sessionId, 'ended_by_sharer', sharer.id);
  });

  it('sweeps expired sessions and enforces the one-time extension', async () => {
    const created = await shareService.createSession(sharer.id, firmA.id, {});
    await shareService.extendSession(created.sessionId, sharer.id);
    await expect(shareService.extendSession(created.sessionId, sharer.id)).rejects.toThrow(/already extended/i);

    await db
      .update(schema.shareSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.shareSessions.id, created.sessionId));
    await shareService.sweepExpiredSessions();
    const row = await db.query.shareSessions.findFirst({ where: eq(schema.shareSessions.id, created.sessionId) });
    expect(row!.status).toBe('expired');
  });

  it('byte cap ends the session with an audit trail (13.6)', async () => {
    const created = await shareService.createSession(sharer.id, firmA.id, {});
    const over = 200 * 1024 * 1024;
    expect(await shareService.enforceByteCap(created.sessionId, over)).toBe(true);
    const row = await db.query.shareSessions.findFirst({ where: eq(schema.shareSessions.id, created.sessionId) });
    expect(row!.status).toBe('ended');
    const auditRows = await db.query.shareSessionAudit.findMany({
      where: and(
        eq(schema.shareSessionAudit.sessionId, created.sessionId),
        eq(schema.shareSessionAudit.event, 'limit_breached'),
      ),
    });
    expect(auditRows.length).toBe(1);
  });

  it('per-user disable ends live sessions as sharer AND viewer (13.9)', async () => {
    const created = await shareService.createSession(sharer.id, firmA.id, {});
    const victim = await seedUser(firmA.id);
    const reqd = await shareService.requestJoin(victim.id, firmA.id, created.joinCode, {});
    await shareService.approveParticipant(created.sessionId, reqd.participantId, sharer.id, {});

    await shareService.setUserShareAllowed(victim.id, false, sharer.id);
    const p = await db.query.shareSessionParticipants.findFirst({
      where: eq(schema.shareSessionParticipants.id, reqd.participantId),
    });
    expect(p!.status).toBe('ejected');
    // Feature is now invisible to the disabled user (2.8 posture).
    expect(await shareService.shareEnabledFor(victim.id, firmA.id)).toBe(false);
    await shareService.endSession(created.sessionId, 'ended_by_sharer', sharer.id);
  });
});

// ── Append-only audit + retention (1.10, 12.8) ─────────────────────────────

describe('audit immutability and retention', () => {
  it('blocks UPDATE and DELETE on audit rows outside the retention path', async () => {
    const created = await shareService.createSession(sharer.id, firmA.id, {});
    const auditRow = await db.query.shareSessionAudit.findFirst({
      where: eq(schema.shareSessionAudit.sessionId, created.sessionId),
    });
    expect(auditRow).toBeTruthy();
    // Drizzle wraps the Postgres error; the trigger message rides `cause`.
    const messageChain = (err: unknown): string =>
      `${String(err)} ${String((err as { cause?: unknown })?.cause ?? '')}`;
    await expect(
      db.update(schema.shareSessionAudit).set({ event: 'tampered' }).where(eq(schema.shareSessionAudit.id, auditRow!.id))
        .catch((err) => Promise.reject(new Error(messageChain(err)))),
    ).rejects.toThrow(/append-only/i);
    await expect(
      db.delete(schema.shareSessionAudit).where(eq(schema.shareSessionAudit.id, auditRow!.id))
        .catch((err) => Promise.reject(new Error(messageChain(err)))),
    ).rejects.toThrow(/append-only/i);
    await shareService.endSession(created.sessionId, 'ended_by_sharer', sharer.id);
  });

  it('the retention purge deletes old ended sessions with their audit', async () => {
    const created = await shareService.createSession(sharer.id, firmA.id, {});
    await shareService.endSession(created.sessionId, 'ended_by_sharer', sharer.id);
    await db
      .update(schema.shareSessions)
      .set({ createdAt: new Date(Date.now() - 4 * 365 * 24 * 3600_000) })
      .where(eq(schema.shareSessions.id, created.sessionId));
    const purged = await shareService.purgeExpiredAudit();
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(
      await db.query.shareSessions.findFirst({ where: eq(schema.shareSessions.id, created.sessionId) }),
    ).toBeUndefined();
  });
});

// ── Enablement layering (Phase 2) ───────────────────────────────────────────

describe('enablement resolution', () => {
  it('tenant off → disabled for everyone in the tenant; user override blocks one user', async () => {
    const t = await seedTenant('Share Test Firm C');
    const u = await seedUser(t.id);
    expect(await shareService.shareEnabledFor(u.id, t.id)).toBe(true);

    await shareService.setTenantShareSettings(t.id, { enabled: false });
    expect(await shareService.shareEnabledFor(u.id, t.id)).toBe(false);

    await shareService.setTenantShareSettings(t.id, { enabled: null });
    expect(await shareService.shareEnabledFor(u.id, t.id)).toBe(true);

    await shareService.setUserShareAllowed(u.id, false, u.id);
    expect(await shareService.shareEnabledFor(u.id, t.id)).toBe(false);
  });
});
