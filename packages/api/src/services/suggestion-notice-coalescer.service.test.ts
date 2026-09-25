// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  queuePortalSuggestionNotice, flushAllSuggestionNotices, _setSendForTests, _pendingForTests,
  QUIET_MS, MAX_WAIT_MS,
} from './suggestion-notice-coalescer.service.js';

const send = vi.fn().mockResolvedValue({ sent: 1, skipped: null });

beforeEach(() => {
  vi.useFakeTimers();
  send.mockClear();
  _setSendForTests(send as never);
});
afterEach(async () => {
  await flushAllSuggestionNotices();
  _setSendForTests(null);
  vi.useRealTimers();
});

describe('portal suggestion notice coalescing', () => {
  it('sends one email with the total after the client goes quiet', async () => {
    const t0 = Date.now();
    queuePortalSuggestionNotice('t', 'c', 'contact', 1, t0);
    await vi.advanceTimersByTimeAsync(60_000);
    queuePortalSuggestionNotice('t', 'c', 'contact', 1, t0 + 60_000);
    queuePortalSuggestionNotice('t', 'c', 'contact', 2, t0 + 60_000);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('t', 'c', { contactId: 'contact' }, 4);
  });

  it('never waits longer than the cap for a client who keeps saving', async () => {
    const t0 = Date.now();
    for (let m = 0; m * 60_000 < MAX_WAIT_MS + 60_000; m++) {
      queuePortalSuggestionNotice('t', 'c', 'contact', 1, t0 + m * 60_000);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(send).toHaveBeenCalled();
  });

  it('keeps different clients separate and flushes on shutdown', async () => {
    queuePortalSuggestionNotice('t', 'c', 'a', 1);
    queuePortalSuggestionNotice('t', 'c', 'b', 3);
    expect(_pendingForTests().size).toBe(2);
    await flushAllSuggestionNotices();
    expect(send).toHaveBeenCalledTimes(2);
    expect(_pendingForTests().size).toBe(0);
  });
});
