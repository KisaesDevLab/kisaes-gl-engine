// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// WebSocket gateway for peer screen share. Mounted on the existing HTTP
// server at /ws/share (Phase 5). Design points:
//
//  - Origin validated on upgrade against the CORS allowlist (5.2).
//  - Auth is a FIRST-MESSAGE single-use ticket (5.3) — never query string or
//    cookie, so tokens don't land in proxy logs and CSWSH gets nothing.
//  - Only the sharer socket may send `events` (5.9); fan-out to viewers rides
//    Redis pub/sub so a multi-instance deployment works (6.1–6.2).
//  - No rrweb payload is ever persisted (6.8) — events transit memory and
//    Redis pub/sub only. The snapshot CACHE (6.6) is the single deliberate
//    exception: latest Meta+FullSnapshot pair, in Redis with session TTL.

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { env } from '../../config/env.js';
import { log } from '../../utils/logger.js';
import { buildOriginAllowlist } from '../../utils/cors-allowlist.js';
import * as shareRedis from './share-redis.js';
import * as shareService from './share.service.js';

const MAX_FRAME_BYTES = 256 * 1024; // 5.7
const AUTH_TIMEOUT_MS = 5_000; // 5.5
const HEARTBEAT_INTERVAL_MS = 20_000; // 5.8
const SNAPSHOT_DEBOUNCE_MS = 2_000; // 6.4
const POINTER_RATE_PER_SECOND = 10; // 11.5

// Close codes (documented for the client).
export const CLOSE_CODES = {
  AUTH_TIMEOUT: 4001,
  BAD_TICKET: 4003,
  ROLE_VIOLATION: 4005,
  FRAME_TOO_LARGE: 4007,
  BYTE_CAP: 4009,
  SESSION_ENDED: 4010,
  EJECTED: 4011,
  HEARTBEAT_LOST: 4012,
  SERVER_SHUTDOWN: 4013,
} as const;

interface SocketState {
  sessionId: string;
  userId: string;
  role: 'sharer' | 'viewer';
  participantId: string | null;
  alive: boolean;
  missedPongs: number;
  pointerTimestamps: number[]; // sliding-window rate limit
}

interface Envelope {
  v: 1;
  type: 'hello' | 'ready' | 'events' | 'snapshot-request' | 'pointer' | 'participant-update' | 'bye' | 'error';
  seq?: number;
  payload?: unknown;
}

// Per-session, per-instance socket registry.
const sharerSockets = new Map<string, WebSocket>(); // sessionId → sharer socket
const viewerSockets = new Map<string, Map<string, WebSocket>>(); // sessionId → participantId → socket
const states = new WeakMap<WebSocket, SocketState>();

// Per-session Redis subscription refcounts (this instance).
const subscribedStreams = new Map<string, number>();
const subscribedToSharer = new Set<string>();
const lastSnapshotRequestAt = new Map<string, number>();

let wss: WebSocketServer | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function send(ws: WebSocket, msg: Envelope): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendError(ws: WebSocket, message: string): void {
  send(ws, { v: 1, type: 'error', payload: { message } });
}

// ── Redis subscription management ───────────────────────────────────────────

async function ensureStreamSubscription(sessionId: string): Promise<void> {
  const n = subscribedStreams.get(sessionId) ?? 0;
  subscribedStreams.set(sessionId, n + 1);
  if (n === 0) await shareRedis.shareRedisSub().subscribe(shareRedis.streamChannel(sessionId));
}

async function releaseStreamSubscription(sessionId: string): Promise<void> {
  const n = (subscribedStreams.get(sessionId) ?? 1) - 1;
  if (n <= 0) {
    subscribedStreams.delete(sessionId);
    await shareRedis.shareRedisSub().unsubscribe(shareRedis.streamChannel(sessionId)).catch(() => undefined);
  } else {
    subscribedStreams.set(sessionId, n);
  }
}

async function ensureToSharerSubscription(sessionId: string): Promise<void> {
  if (subscribedToSharer.has(sessionId)) return;
  subscribedToSharer.add(sessionId);
  await shareRedis.shareRedisSub().subscribe(shareRedis.toSharerChannel(sessionId));
}

async function releaseToSharerSubscription(sessionId: string): Promise<void> {
  if (!subscribedToSharer.has(sessionId)) return;
  subscribedToSharer.delete(sessionId);
  await shareRedis.shareRedisSub().unsubscribe(shareRedis.toSharerChannel(sessionId)).catch(() => undefined);
}

function onRedisMessage(channel: string, message: string): void {
  if (channel === shareRedis.CONTROL_CHANNEL) {
    handleControl(message);
    return;
  }
  const streamMatch = channel.match(/^share:session:([0-9a-f-]+):stream$/);
  if (streamMatch) {
    const sessionId = streamMatch[1]!;
    const sockets = viewerSockets.get(sessionId);
    if (!sockets) return;
    for (const ws of sockets.values()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(message);
    }
    return;
  }
  const sharerMatch = channel.match(/^share:session:([0-9a-f-]+):to-sharer$/);
  if (sharerMatch) {
    const ws = sharerSockets.get(sharerMatch[1]!);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(message);
  }
}

function handleControl(message: string): void {
  let msg: shareRedis.ShareControlMessage;
  try {
    msg = JSON.parse(message) as shareRedis.ShareControlMessage;
  } catch {
    return;
  }
  if (msg.type === 'end-session') {
    closeSessionSockets(msg.sessionId, CLOSE_CODES.SESSION_ENDED, msg.reason);
  } else if (msg.type === 'kill-all') {
    for (const sessionId of [...sharerSockets.keys(), ...viewerSockets.keys()]) {
      closeSessionSockets(sessionId, CLOSE_CODES.SESSION_ENDED, 'kill_switch');
    }
  } else if (msg.type === 'end-user') {
    for (const [sessionId, ws] of sharerSockets) {
      const st = states.get(ws);
      if (st?.userId === msg.userId) closeSessionSockets(sessionId, CLOSE_CODES.SESSION_ENDED, msg.reason);
    }
    for (const [, sockets] of viewerSockets) {
      for (const [, ws] of sockets) {
        const st = states.get(ws);
        if (st?.userId === msg.userId) ws.close(CLOSE_CODES.EJECTED, msg.reason);
      }
    }
  } else if (msg.type === 'eject-participant') {
    const sockets = viewerSockets.get(msg.sessionId);
    const ws = sockets?.get(msg.participantId);
    if (ws) ws.close(CLOSE_CODES.EJECTED, 'removed by sharer');
  } else if (msg.type === 'participant-update') {
    // Refresh the sharer's banner/prompt list (5.10).
    void pushParticipantUpdate(msg.sessionId);
  }
}

async function pushParticipantUpdate(sessionId: string): Promise<void> {
  const ws = sharerSockets.get(sessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const st = states.get(ws);
  if (!st) return;
  try {
    const data = await shareService.getSessionForUser(sessionId, st.userId);
    if (data) {
      send(ws, {
        v: 1,
        type: 'participant-update',
        payload: {
          participants: data.participants.map((p) => ({
            id: p.id,
            viewerName: p.viewerName,
            viewerFirmName: p.viewerFirmName,
            status: p.status,
            isCrossFirm: p.isCrossFirm,
            requestedAt: p.requestedAt,
          })),
        },
      });
    }
  } catch (err) {
    log.warn({
      component: 'share-gateway',
      event: 'participant_update_failed',
      sessionId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function closeSessionSockets(sessionId: string, code: number, reason: string): void {
  const sharer = sharerSockets.get(sessionId);
  if (sharer) sharer.close(code, reason.slice(0, 100));
  const sockets = viewerSockets.get(sessionId);
  if (sockets) for (const ws of sockets.values()) ws.close(code, reason.slice(0, 100));
}

// ── Snapshot requests (6.3–6.4) ─────────────────────────────────────────────

async function requestSnapshot(sessionId: string): Promise<void> {
  const last = lastSnapshotRequestAt.get(sessionId) ?? 0;
  if (Date.now() - last < SNAPSHOT_DEBOUNCE_MS) return;
  lastSnapshotRequestAt.set(sessionId, Date.now());
  await shareRedis
    .shareRedis()
    .publish(shareRedis.toSharerChannel(sessionId), JSON.stringify({ v: 1, type: 'snapshot-request' } satisfies Envelope));
}

// ── Message handling ────────────────────────────────────────────────────────

async function handleAuthenticated(ws: WebSocket, st: SocketState, msg: Envelope, rawSize: number): Promise<void> {
  switch (msg.type) {
    case 'events': {
      // Only the sharer socket may send events (5.9).
      if (st.role !== 'sharer') {
        ws.close(CLOSE_CODES.ROLE_VIOLATION, 'viewers cannot send events');
        return;
      }
      const total = await shareRedis.addBytes(st.sessionId, rawSize);
      if (await shareService.enforceByteCap(st.sessionId, total)) return; // session ended
      await shareRedis.touchActivity(st.sessionId);
      await shareRedis.refreshPresence(st.sessionId);
      // Cache Meta+FullSnapshot pairs for late joiners (6.6). rrweb type 4 =
      // Meta, type 2 = FullSnapshot.
      const payload = msg.payload as { events?: Array<{ type?: number }> } | undefined;
      const evs = Array.isArray(payload?.events) ? payload.events : [];
      if (evs.some((e) => e?.type === 2)) {
        const ttl = env.SHARE_TTL_MINUTES * 60;
        void shareRedis
          .cacheSnapshot(st.sessionId, JSON.stringify(msg), ttl)
          .catch(() => undefined);
      }
      await shareRedis.shareRedis().publish(shareRedis.streamChannel(st.sessionId), JSON.stringify(msg));
      break;
    }
    case 'pointer': {
      // Viewer → sharer only (11.1, 11.4), rate limited (11.5).
      if (st.role !== 'viewer') return;
      const now = Date.now();
      st.pointerTimestamps = st.pointerTimestamps.filter((t) => now - t < 1000);
      if (st.pointerTimestamps.length >= POINTER_RATE_PER_SECOND) return; // drop silently
      st.pointerTimestamps.push(now);
      const p = (msg.payload ?? {}) as { x?: number; y?: number };
      if (typeof p.x !== 'number' || typeof p.y !== 'number') return;
      await shareRedis.shareRedis().publish(
        shareRedis.toSharerChannel(st.sessionId),
        JSON.stringify({
          v: 1,
          type: 'pointer',
          payload: { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)), participantId: st.participantId },
        } satisfies Envelope),
      );
      break;
    }
    case 'snapshot-request': {
      if (st.role !== 'viewer') return;
      await requestSnapshot(st.sessionId);
      break;
    }
    case 'bye': {
      ws.close(1000, 'bye');
      break;
    }
    default:
      // hello after auth, ready, unknown → ignore.
      break;
  }
}

async function attachSharer(ws: WebSocket, st: SocketState): Promise<void> {
  // A reconnecting sharer replaces the previous socket.
  const prev = sharerSockets.get(st.sessionId);
  if (prev && prev !== ws) prev.close(CLOSE_CODES.SESSION_ENDED, 'replaced by new sharer connection');
  sharerSockets.set(st.sessionId, ws);
  await ensureToSharerSubscription(st.sessionId);
  await shareRedis.refreshPresence(st.sessionId);
  await shareRedis.touchActivity(st.sessionId);
  send(ws, { v: 1, type: 'ready', payload: { role: 'sharer' } });
  void pushParticipantUpdate(st.sessionId);
}

async function attachViewer(ws: WebSocket, st: SocketState): Promise<void> {
  let sockets = viewerSockets.get(st.sessionId);
  if (!sockets) {
    sockets = new Map();
    viewerSockets.set(st.sessionId, sockets);
  }
  const prev = sockets.get(st.participantId!);
  if (prev && prev !== ws) prev.close(CLOSE_CODES.SESSION_ENDED, 'replaced by new connection');
  sockets.set(st.participantId!, ws);
  await ensureStreamSubscription(st.sessionId);
  send(ws, { v: 1, type: 'ready', payload: { role: 'viewer' } });
  // Late joiner: serve the cached snapshot immediately if present (6.6), and
  // ask the sharer for a fresh one either way (6.3, debounced 6.4). Never
  // any history from before this participant's approval — the cache never
  // holds more than the latest checkout.
  const cached = await shareRedis.getCachedSnapshot(st.sessionId);
  if (cached && ws.readyState === WebSocket.OPEN) ws.send(cached);
  await requestSnapshot(st.sessionId);
  await shareRedis.publishControl({ type: 'participant-update', sessionId: st.sessionId });
}

async function detach(ws: WebSocket): Promise<void> {
  const st = states.get(ws);
  if (!st) return;
  if (st.role === 'sharer') {
    if (sharerSockets.get(st.sessionId) === ws) {
      sharerSockets.delete(st.sessionId);
      await releaseToSharerSubscription(st.sessionId);
      // Sharer gone ⇒ session over (5.11). A dropped sharer must never leave
      // a session viewers can silently rejoin.
      await shareService.endSession(st.sessionId, 'sharer_disconnected').catch(() => undefined);
    }
  } else {
    const sockets = viewerSockets.get(st.sessionId);
    if (sockets && st.participantId && sockets.get(st.participantId) === ws) {
      sockets.delete(st.participantId);
      if (sockets.size === 0) viewerSockets.delete(st.sessionId);
      await releaseStreamSubscription(st.sessionId);
      await shareRedis.publishControl({ type: 'participant-update', sessionId: st.sessionId });
    }
  }
}

// ── Server wiring ───────────────────────────────────────────────────────────

export function attachShareGateway(server: HttpServer): void {
  if (wss) return;
  wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const originAllowlist = buildOriginAllowlist(env.CORS_ORIGIN);

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== '/ws/share') return; // not ours — leave for other handlers
    // Feature off ⇒ the endpoint does not exist (2.8).
    if (!env.SHARE_ENABLED) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // Origin check (5.2). Same-origin browsers always send Origin on WS.
    const origin = req.headers.origin;
    if (!origin || !originAllowlist.matches(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    // Unauthenticated sockets get 5 seconds to present a ticket (5.5).
    const authTimer = setTimeout(() => {
      if (!states.get(ws)) ws.close(CLOSE_CODES.AUTH_TIMEOUT, 'authentication timeout');
    }, AUTH_TIMEOUT_MS);

    ws.on('message', (data: RawData, isBinary: boolean) => {
      void (async () => {
        if (isBinary) {
          ws.close(CLOSE_CODES.ROLE_VIOLATION, 'binary frames not accepted');
          return;
        }
        const raw = data.toString();
        let msg: Envelope;
        try {
          msg = JSON.parse(raw) as Envelope;
        } catch {
          sendError(ws, 'malformed frame');
          return;
        }
        if (!msg || msg.v !== 1 || typeof msg.type !== 'string') {
          sendError(ws, 'malformed envelope');
          return;
        }

        const st = states.get(ws);
        if (!st) {
          // First message must be hello + ticket (5.3).
          if (msg.type !== 'hello') {
            ws.close(CLOSE_CODES.BAD_TICKET, 'expected hello');
            return;
          }
          const ticket = (msg.payload as { ticket?: string } | undefined)?.ticket ?? '';
          const claims = await shareRedis.consumeTicket(ticket);
          if (!claims) {
            ws.close(CLOSE_CODES.BAD_TICKET, 'invalid ticket');
            return;
          }
          clearTimeout(authTimer);
          const state: SocketState = {
            sessionId: claims.sessionId,
            userId: claims.userId,
            role: claims.role,
            participantId: claims.participantId,
            alive: true,
            missedPongs: 0,
            pointerTimestamps: [],
          };
          states.set(ws, state);
          if (claims.role === 'sharer') await attachSharer(ws, state);
          else await attachViewer(ws, state);
          return;
        }
        await handleAuthenticated(ws, st, msg, Buffer.byteLength(raw));
      })().catch((err) => {
        log.warn({
          component: 'share-gateway',
          event: 'message_handler_error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
    });

    ws.on('pong', () => {
      const st = states.get(ws);
      if (st) {
        st.alive = true;
        st.missedPongs = 0;
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      void detach(ws);
    });
    ws.on('error', () => {
      clearTimeout(authTimer);
      // 'close' fires after 'error'; detach happens there.
    });
  });

  // Heartbeat (5.8): ping every 20s, terminate after two missed pongs.
  heartbeatTimer = setInterval(() => {
    if (!wss) return;
    for (const ws of wss.clients) {
      const st = states.get(ws);
      if (!st) continue; // unauthenticated sockets are bounded by authTimer
      if (!st.alive) {
        st.missedPongs += 1;
        if (st.missedPongs >= 2) {
          ws.close(CLOSE_CODES.HEARTBEAT_LOST, 'heartbeat lost');
          continue;
        }
      }
      st.alive = false;
      try {
        ws.ping();
      } catch {
        /* socket already dying */
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  // Control-channel subscription (kill switch, ejects, cross-instance).
  void shareRedis
    .shareRedisSub()
    .subscribe(shareRedis.CONTROL_CHANNEL)
    .then(() => shareRedis.shareRedisSub().on('message', onRedisMessage))
    .catch((err: Error) => {
      log.error({ component: 'share-gateway', event: 'control_subscribe_failed', message: err.message });
    });

  log.info({ component: 'share-gateway', event: 'mounted', path: '/ws/share' });
}

export async function shutdownShareGateway(): Promise<void> {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (wss) {
    for (const ws of wss.clients) ws.close(CLOSE_CODES.SERVER_SHUTDOWN, 'server shutting down');
    await new Promise<void>((resolve) => wss!.close(() => resolve()));
    wss = null;
  }
  await shareRedis.closeShareRedis();
}

// Test hooks.
export const __internal = { sharerSockets, viewerSockets, states, handleControl, onRedisMessage };
