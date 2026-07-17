// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// tfa_config is a singleton, but the get-or-create can race and insert
// duplicates. Regression for the "admin saves appear to revert" bug:
// with two rows and no ORDER BY, each UPDATE physically relocated the
// written row so the next read returned the OTHER row. getOrCreateConfig
// must read deterministically (latest updated_at wins) and self-heal by
// deleting the stale duplicates.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db/index.js';
import { tfaConfig } from '../db/schema/index.js';
import * as tfaConfigService from './tfa-config.service.js';

beforeEach(async () => {
  await db.delete(tfaConfig); // global table — no tenant column; suites share it by design
});

describe('tfa_config singleton self-heal', () => {
  it('heals duplicate rows: keeps the most-recently-updated one and updates land on it', async () => {
    const now = Date.now();
    // Stale row (older updated_at) vs the row holding the admin's most
    // recent config (distinguishable via codeLength 8).
    await db.insert(tfaConfig).values({
      codeLength: 6, createdAt: new Date(now - 120_000), updatedAt: new Date(now - 60_000),
    });
    await db.insert(tfaConfig).values({
      codeLength: 8, createdAt: new Date(now - 90_000), updatedAt: new Date(now),
    });

    await tfaConfigService.updateConfig({ magicLinkEnabled: true } as Parameters<typeof tfaConfigService.updateConfig>[0]);

    const rows = await db.select().from(tfaConfig);
    expect(rows).toHaveLength(1); // duplicate deleted
    expect(rows[0]!.codeLength).toBe(8); // the newer row won
    expect(rows[0]!.magicLinkEnabled).toBe(true); // and the save landed on it

    // The read path sees the same row the write path used.
    const config = await tfaConfigService.getConfig();
    expect(config.codeLength).toBe(8);
  });

  it('passwordless toggles round-trip (save → read → save)', async () => {
    await tfaConfigService.updateConfig({ passkeysEnabled: true, magicLinkEnabled: true } as Parameters<typeof tfaConfigService.updateConfig>[0]);
    let rows = await db.select().from(tfaConfig);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.passkeysEnabled).toBe(true);
    expect(rows[0]!.magicLinkEnabled).toBe(true);

    await tfaConfigService.updateConfig({ magicLinkEnabled: false } as Parameters<typeof tfaConfigService.updateConfig>[0]);
    rows = await db.select().from(tfaConfig);
    expect(rows).toHaveLength(1); // still a singleton
    expect(rows[0]!.magicLinkEnabled).toBe(false);
    expect(rows[0]!.passkeysEnabled).toBe(true); // untouched field preserved
  });
});
