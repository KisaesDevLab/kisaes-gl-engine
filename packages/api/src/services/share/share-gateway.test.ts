// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Gateway unit tests. Full socket-level abuse coverage runs in the
// integration environment; these pin the properties that are cheap to lose
// silently in a refactor:
//   6.8 — no rrweb event payload is ever persisted to Postgres (structural:
//         the gateway module has no database import at all).
//   5.9 — role separation exists as code, not convention.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const gatewaySource = readFileSync(join(here, 'share-gateway.ts'), 'utf8');
const redisSource = readFileSync(join(here, 'share-redis.ts'), 'utf8');

describe('no-persistence posture (6.8)', () => {
  it('the gateway never touches the database layer', () => {
    // Event payloads flow socket ⇄ Redis pub/sub only. If someone adds a db
    // import to the gateway, they must consciously delete this test and
    // answer for it in review.
    expect(gatewaySource).not.toMatch(/from '\.\.\/\.\.\/db\//);
    expect(gatewaySource).not.toMatch(/drizzle/i);
  });

  it('the redis module never writes events to disk or Postgres', () => {
    expect(redisSource).not.toMatch(/node:fs/);
    expect(redisSource).not.toMatch(/from '\.\.\/\.\.\/db\//);
  });

  it('the only Redis persistence of stream content is the snapshot cache with a TTL', () => {
    // cacheSnapshot must always SET with an expiry — a snapshot that outlives
    // its session would be replayable after the fact.
    expect(redisSource).toMatch(/cacheSnapshot[\s\S]{0,200}'EX', ttlSeconds/);
  });
});

describe('role and origin enforcement exist (5.2, 5.9)', () => {
  it('viewer sockets sending events are closed with the role-violation code', () => {
    expect(gatewaySource).toMatch(/ROLE_VIOLATION, 'viewers cannot send events'/);
  });

  it('upgrade handler validates Origin before handing off to ws', () => {
    const upgradeBlock = gatewaySource.slice(gatewaySource.indexOf("on('upgrade'"));
    expect(upgradeBlock.indexOf('originAllowlist.matches')).toBeGreaterThan(-1);
    expect(upgradeBlock.indexOf('originAllowlist.matches')).toBeLessThan(upgradeBlock.indexOf('handleUpgrade'));
  });

  it('sharer disconnect ends the session (5.11)', () => {
    expect(gatewaySource).toMatch(/endSession\(st\.sessionId, 'sharer_disconnected'\)/);
  });
});
