// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Socket-level WS abuse suite (Phase 5 acceptance / 14.10) against a REAL
// gateway: real http server, real `ws` clients, real Redis (dedicated test
// instance — never the appliance Redis), real Postgres test DB.
//
// Requires a test Redis on 127.0.0.1:6390 (docker: vibe-test-redis).
// Skips itself when that Redis is unreachable so a minimal checkout can
// still run the rest of the suite.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

process.env['SHARE_ENABLED'] = 'true';
process.env['REDIS_URL'] = process.env['SHARE_TEST_REDIS_URL'] || 'redis://127.0.0.1:6390';

const ORIGIN = 'http://localhost:5173'; // matches default CORS_ORIGIN in tests

const { default: WebSocket } = await import('ws');

async function redisReachable(): Promise<boolean> {
  try {
    const RedisPkg = await import('ioredis');
    const Redis = (RedisPkg as unknown as { default: typeof import('ioredis').default }).default;
    const c = new Redis(process.env['REDIS_URL']!, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
    await c.connect();
    await c.ping();
    await c.quit();
    return true;
  } catch {
    return false;
  }
}

const haveRedis = await redisReachable();
const d = haveRedis ? describe : describe.skip;

// Imported lazily so env is set first.
const gateway = haveRedis ? await import('./share-gateway.js') : null;
const shareService = haveRedis ? await import('./share.service.js') : null;
const shareRedis = haveRedis ? await import('./share-redis.js') : null;
const dbMod = haveRedis ? await import('../../db/index.js') : null;
const schema = haveRedis ? await import('../../db/schema/index.js') : null;

let server: http.Server;
let port = 0;

interface TestActors {
  sessionId: string;
  joinCode: string;
  sharerId: string;
  viewerId: string;
  participantId: string;
  tenantId: string;
}

async function seedActors(): Promise<TestActors> {
  const db = dbMod!.db;
  const [tenant] = await db
    .insert(schema!.tenants)
    .values({ name: 'WS Gateway Firm', slug: `ws-gw-${randomUUID().slice(0, 12)}` })
    .returning();
  const [sharer] = await db
    .insert(schema!.users)
    .values({ tenantId: tenant!.id, email: `gw-sharer-${randomUUID().slice(0, 8)}@t.local`, passwordHash: 'x', role: 'owner', userType: 'staff', isActive: true })
    .returning();
  const [viewer] = await db
    .insert(schema!.users)
    .values({ tenantId: tenant!.id, email: `gw-viewer-${randomUUID().slice(0, 8)}@t.local`, passwordHash: 'x', role: 'accountant', userType: 'staff', isActive: true })
    .returning();
  const created = await shareService!.createSession(sharer!.id, tenant!.id, {});
  const reqd = await shareService!.requestJoin(viewer!.id, tenant!.id, created.joinCode, {});
  await shareService!.approveParticipant(created.sessionId, reqd.participantId, sharer!.id, {});
  return {
    sessionId: created.sessionId,
    joinCode: created.joinCode,
    sharerId: sharer!.id,
    viewerId: viewer!.id,
    participantId: reqd.participantId,
    tenantId: tenant!.id,
  };
}

function connect(opts: { origin?: string | null } = {}): InstanceType<typeof WebSocket> {
  const headers: Record<string, string> = {};
  if (opts.origin !== null) headers['origin'] = opts.origin ?? ORIGIN;
  return new WebSocket(`ws://127.0.0.1:${port}/ws/share`, { headers });
}

function nextClose(ws: InstanceType<typeof WebSocket>): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() }));
  });
}

function nextMessage(ws: InstanceType<typeof WebSocket>, type?: string, timeoutMs = 4000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type ?? 'message'}`)), timeoutMs);
    const onMsg = (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (!type || msg['type'] === type) {
          clearTimeout(timer);
          ws.off('message', onMsg);
          resolve(msg);
        }
      } catch {
        /* ignore */
      }
    };
    ws.on('message', onMsg);
  });
}

async function authed(ticket: string): Promise<InstanceType<typeof WebSocket>> {
  const ws = connect();
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  ws.send(JSON.stringify({ v: 1, type: 'hello', payload: { ticket } }));
  await nextMessage(ws, 'ready');
  return ws;
}

d('share WS gateway — abuse and relay (integration)', () => {
  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    gateway!.attachShareGateway(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await gateway!.shutdownShareGateway();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('rejects a foreign Origin at the upgrade (CSWSH defense, 5.2)', async () => {
    const ws = connect({ origin: 'https://evil.example.com' });
    const err = await new Promise<Error>((resolve) => ws.on('error', resolve));
    expect(String(err.message)).toMatch(/403/);
  });

  it('rejects an upgrade with no Origin header', async () => {
    const ws = connect({ origin: null });
    const err = await new Promise<Error>((resolve) => ws.on('error', resolve));
    expect(String(err.message)).toMatch(/403/);
  });

  it('closes a socket whose first message is not hello (5.3)', async () => {
    const ws = connect();
    await new Promise<void>((r) => ws.on('open', () => r()));
    ws.send(JSON.stringify({ v: 1, type: 'events', payload: { events: [] } }));
    const { code } = await nextClose(ws);
    expect(code).toBe(gateway!.CLOSE_CODES.BAD_TICKET);
  });

  it('closes on an invalid ticket, and a ticket is single-use (5.3)', async () => {
    const bad = connect();
    await new Promise<void>((r) => bad.on('open', () => r()));
    bad.send(JSON.stringify({ v: 1, type: 'hello', payload: { ticket: 'nope' } }));
    expect((await nextClose(bad)).code).toBe(gateway!.CLOSE_CODES.BAD_TICKET);

    const actors = await seedActors();
    const ticket = await shareService!.issueViewerTicket(actors.participantId, actors.viewerId);
    const first = await authed(ticket); // consumes the ticket
    const replay = connect();
    await new Promise<void>((r) => replay.on('open', () => r()));
    replay.send(JSON.stringify({ v: 1, type: 'hello', payload: { ticket } }));
    expect((await nextClose(replay)).code).toBe(gateway!.CLOSE_CODES.BAD_TICKET);
    first.close();
    await shareService!.endSession(actors.sessionId, 'ended_by_sharer', actors.sharerId);
  });

  it('closes a viewer that sends events with the role-violation code (5.9)', async () => {
    const actors = await seedActors();
    const viewerWs = await authed(await shareService!.issueViewerTicket(actors.participantId, actors.viewerId));
    viewerWs.send(JSON.stringify({ v: 1, type: 'events', payload: { events: [{ type: 3 }] } }));
    expect((await nextClose(viewerWs)).code).toBe(gateway!.CLOSE_CODES.ROLE_VIOLATION);
    await shareService!.endSession(actors.sessionId, 'ended_by_sharer', actors.sharerId);
  });

  it('drops oversized frames (5.7)', async () => {
    const actors = await seedActors();
    const sharerWs = await authed(await shareService!.issueSharerTicket(actors.sessionId, actors.sharerId));
    // > 256 KB frame — ws maxPayload closes the connection (1009).
    sharerWs.send(JSON.stringify({ v: 1, type: 'events', payload: { events: [{ blob: 'x'.repeat(300 * 1024) }] } }));
    const { code } = await nextClose(sharerWs);
    expect(code).toBe(1009);
    // Sharer socket loss ends the session (5.11).
    await new Promise((r) => setTimeout(r, 300));
    const row = await dbMod!.db.query.shareSessions.findFirst({
      where: (await import('drizzle-orm')).eq(schema!.shareSessions.id, actors.sessionId),
    });
    expect(['ended', 'expired', 'revoked']).toContain(row!.status);
  });

  it('relays sharer events to the approved viewer and serves late-join snapshots (6.3/6.5)', async () => {
    const actors = await seedActors();
    const sharerWs = await authed(await shareService!.issueSharerTicket(actors.sessionId, actors.sharerId));
    const viewerWs = await authed(await shareService!.issueViewerTicket(actors.participantId, actors.viewerId));

    // Joining viewer triggers a debounced snapshot-request to the sharer.
    const snapReq = await nextMessage(sharerWs, 'snapshot-request');
    expect(snapReq['type']).toBe('snapshot-request');

    // Sharer emits Meta + FullSnapshot + an incremental; viewer receives them.
    const batch = { v: 1, type: 'events', payload: { events: [{ type: 4, data: { width: 1440 } }, { type: 2, data: { node: {} } }, { type: 3, data: {} }] } };
    sharerWs.send(JSON.stringify(batch));
    const got = await nextMessage(viewerWs, 'events');
    const events = (got['payload'] as { events: Array<{ type: number }> }).events;
    expect(events.map((e) => e.type)).toEqual([4, 2, 3]);

    // Pointer goes viewer → sharer only, normalized and clamped (11.1).
    viewerWs.send(JSON.stringify({ v: 1, type: 'pointer', payload: { x: 1.7, y: -0.2 } }));
    const pointer = await nextMessage(sharerWs, 'pointer');
    const p = pointer['payload'] as { x: number; y: number; participantId: string };
    expect(p.x).toBe(1);
    expect(p.y).toBe(0);
    expect(p.participantId).toBe(actors.participantId);

    // Ejecting closes ONLY that viewer's socket, with the eject code (3.10).
    const closed = nextClose(viewerWs);
    await shareService!.ejectParticipant(actors.sessionId, actors.participantId, actors.sharerId);
    expect((await closed).code).toBe(gateway!.CLOSE_CODES.EJECTED);
    expect(sharerWs.readyState).toBe(WebSocket.OPEN);

    sharerWs.close();
    await shareService!.endSession(actors.sessionId, 'ended_by_sharer', actors.sharerId);
  });

  it('kill switch terminates every live socket (13.7)', async () => {
    const actors = await seedActors();
    const sharerWs = await authed(await shareService!.issueSharerTicket(actors.sessionId, actors.sharerId));
    const closed = nextClose(sharerWs);
    await shareRedis!.publishControl({ type: 'kill-all', reason: 'kill_switch' });
    expect((await closed).code).toBe(gateway!.CLOSE_CODES.SESSION_ENDED);
    await shareService!.endSession(actors.sessionId, 'kill_switch', null);
  });

  it('never relays to a participant who is only `requested` (14.7, socket level)', async () => {
    // Fresh session with an UNAPPROVED second viewer: the REST layer refuses
    // the ticket (409) — asserted in the service tests — so there is no
    // credential with which a socket could ever authenticate. Belt: an
    // invalid-hello socket gets nothing either (already covered above).
    const db = dbMod!.db;
    const [tenant] = await db
      .insert(schema!.tenants)
      .values({ name: 'WS 14.7 Firm', slug: `ws-147-${randomUUID().slice(0, 12)}` })
      .returning();
    const [sharer] = await db
      .insert(schema!.users)
      .values({ tenantId: tenant!.id, email: `gw-s2-${randomUUID().slice(0, 8)}@t.local`, passwordHash: 'x', role: 'owner', userType: 'staff', isActive: true })
      .returning();
    const [pending] = await db
      .insert(schema!.users)
      .values({ tenantId: tenant!.id, email: `gw-p2-${randomUUID().slice(0, 8)}@t.local`, passwordHash: 'x', role: 'accountant', userType: 'staff', isActive: true })
      .returning();
    const created = await shareService!.createSession(sharer!.id, tenant!.id, {});
    const reqd = await shareService!.requestJoin(pending!.id, tenant!.id, created.joinCode, {});
    await expect(shareService!.issueViewerTicket(reqd.participantId, pending!.id)).rejects.toThrow(/not yet approved/i);
    await shareService!.endSession(created.sessionId, 'ended_by_sharer', sharer!.id);
  });
});
