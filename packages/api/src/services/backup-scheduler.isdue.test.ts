// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// The scheduler's due-check drives both the full-bundle cadence and the new
// DB-only cadence, each tracked by its own last-run key.

import { describe, it, expect, afterEach } from 'vitest';
import { isDue } from './backup-scheduler.service.js';
import { setSetting } from './admin.service.js';

const KEY = 'backup_db_last_run';
afterEach(async () => { await setSetting(KEY, ''); });

describe('isDue', () => {
  it('is false for none / unset / unknown cadences', async () => {
    expect(await isDue('none', KEY)).toBe(false);
    expect(await isDue(null, KEY)).toBe(false);
    expect(await isDue('hourly', KEY)).toBe(false);
  });

  it('is true when never run before (last run = 0)', async () => {
    await setSetting(KEY, '');
    expect(await isDue('daily', KEY)).toBe(true);
  });

  it('fails SAFE — a corrupt/unparseable last-run is treated as due', async () => {
    await setSetting(KEY, 'not-a-date');
    expect(await isDue('daily', KEY)).toBe(true); // must back up, not stall forever
  });

  it('is false right after a run, true once the interval elapses', async () => {
    await setSetting(KEY, new Date().toISOString());
    expect(await isDue('daily', KEY)).toBe(false);

    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    await setSetting(KEY, twoDaysAgo);
    expect(await isDue('daily', KEY)).toBe(true);
    // Weekly interval hasn't elapsed after only 2 days.
    expect(await isDue('weekly', KEY)).toBe(false);
  });
});
