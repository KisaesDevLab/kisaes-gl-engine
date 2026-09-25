// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { notifyStaffOfSuggestions } from './client-suggestion-review.service.js';

// The portal now saves one answer at a time (a Save button per card), so
// "one staff email per submission" would become one email per answer.
// Coalesce: answers from the same client contact for the same company are
// summed and announced once the contact has been quiet for QUIET_MS, and
// never later than MAX_WAIT_MS after the first answer in the batch.
//
// In-process by design: the API runs as one process, and losing a pending
// notice on a restart only loses an email, never an answer (answers are
// already saved and listed on Practice -> Uncategorized).

export const QUIET_MS = 5 * 60 * 1000;
export const MAX_WAIT_MS = 30 * 60 * 1000;

type Send = typeof notifyStaffOfSuggestions;

interface Pending {
  tenantId: string;
  companyId: string;
  contactId: string;
  count: number;
  firstAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
let sendImpl: Send = notifyStaffOfSuggestions;

function flush(key: string): Promise<unknown> {
  const p = pending.get(key);
  if (!p) return Promise.resolve();
  pending.delete(key);
  clearTimeout(p.timer);
  return sendImpl(p.tenantId, p.companyId, { contactId: p.contactId }, p.count)
    .catch(() => { /* the notifier logs; never surfaces to the client */ });
}

export function queuePortalSuggestionNotice(
  tenantId: string,
  companyId: string,
  contactId: string,
  count: number,
  now: number = Date.now(),
): void {
  if (count <= 0) return;
  const key = `${tenantId}:${companyId}:${contactId}`;
  const existing = pending.get(key);
  const firstAt = existing?.firstAt ?? now;
  const total = (existing?.count ?? 0) + count;
  if (existing) clearTimeout(existing.timer);
  const delay = Math.max(0, Math.min(QUIET_MS, firstAt + MAX_WAIT_MS - now));
  const timer = setTimeout(() => { void flush(key); }, delay);
  if (typeof timer.unref === 'function') timer.unref();
  pending.set(key, { tenantId, companyId, contactId, count: total, firstAt, timer });
}

/** Send everything still waiting (graceful shutdown, before the DB pool closes). */
export async function flushAllSuggestionNotices(): Promise<void> {
  await Promise.all([...pending.keys()].map((key) => flush(key)));
}

/** Test seams. */
export function _setSendForTests(fn: Send | null): void { sendImpl = fn ?? notifyStaffOfSuggestions; }
export function _pendingForTests() { return pending; }
