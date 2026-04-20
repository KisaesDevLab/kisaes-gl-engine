// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { auditLog } from '../../middleware/audit.js';

// Ungated from the unit-test mock in alert.service.test.ts — this
// file runs the real auditLog insert against the test DB so a uuid-
// column mismatch (e.g., passing a non-UUID entity_id) surfaces as a
// test failure here rather than a silent production crash at 3 am.
describe('cloudflared-alerter audit insert', () => {
  beforeEach(async () => {
    await db.execute(sql`DELETE FROM audit_log WHERE entity_type = 'tunnel_alert'`);
  });

  it('inserts a tunnel_alert row with null entityId and system tenant', async () => {
    await auditLog(
      '00000000-0000-0000-0000-000000000000',
      'update',
      'tunnel_alert',
      null,
      null,
      { component: 'cloudflared', downForSeconds: 130, reason: 'zero active connections', lastHealthyAt: '2026-04-20T00:00:00Z' },
    );
    const rows = await db.execute(sql`SELECT after_data FROM audit_log WHERE entity_type = 'tunnel_alert'`);
    expect(rows.rows.length).toBe(1);
    // The middleware stores afterData via JSON.stringify and pg returns
    // it as a string rather than parsing the jsonb. Parse it back
    // here so the assertion is on the actual shape.
    const raw = (rows.rows[0] as { after_data: unknown }).after_data;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    expect(parsed).toMatchObject({ component: 'cloudflared', reason: 'zero active connections' });
  });
});
