// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { withSchedulerLock } from '../utils/scheduler-lock.js';
import * as svc from './recurring-doc-request.service.js';
import * as remind from './portal-reminders.service.js';
import * as flags from './feature-flags.service.js';

// RECURRING_DOC_REQUESTS_V1 — calendar-cadence scheduler. Each tick
// finds rules whose next_issue_at <= now() (across all tenants),
// issues one document_requests row per rule (idempotent via the
// (recurring_id, period_label) unique index), and sends the opening
// email via the existing reminder template engine.
//
// Catch-up behavior: a missed tick (worker down on the 3rd, comes
// back on the 4th) issues the row with the original period label —
// the contact still gets "April statement" wording. The cadence-
// driven nudge loop then runs as if the request had been issued on
// the 4th, which is the conservative choice (cadence starts from
// requested_at).

const TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const INITIAL_DELAY_MS = 90 * 1000;     // 90s after boot

let timer: NodeJS.Timeout | null = null;

export async function processDueRules(): Promise<{ processed: number; issued: number; openersSent: number; skipped: number }> {
  const due = await svc.findDueRules();
  let processed = 0;
  let issued = 0;
  let openersSent = 0;
  let skipped = 0;

  // Group rules by tenant so the per-tenant feature-flag check is one
  // lookup per tenant instead of per rule.
  const tenants = new Map<string, string[]>();
  for (const r of due) {
    const list = tenants.get(r.tenantId) ?? [];
    list.push(r.id);
    tenants.set(r.tenantId, list);
  }

  for (const [tenantId, ruleIds] of tenants) {
    const enabled = await flags.isEnabled(tenantId, 'RECURRING_DOC_REQUESTS_V1');
    if (!enabled) {
      // Tenant has the feature off — leave rules unmodified. The CPA
      // can flip the flag and the scheduler will pick them up on the
      // next tick. Counted as skipped so the cycle log stays honest.
      skipped += ruleIds.length;
      continue;
    }
    for (const ruleId of ruleIds) {
      processed++;
      try {
        const result = await svc.issueOne(ruleId);
        if (!result) {
          skipped++;
          continue;
        }
        if (result.created) {
          issued++;
          const sendResult = await remind.sendOpenerForDocRequest(tenantId, result.rowId);
          if (sendResult === 'sent') openersSent++;
        }
      } catch (err) {
        // Log + continue. One bad rule shouldn't stop the cycle.
        // eslint-disable-next-line no-console
        console.error('[Recurring Doc Request Scheduler] rule', ruleId, 'failed:', err);
      }
    }
  }

  return { processed, issued, openersSent, skipped };
}

export function startRecurringDocRequestScheduler(): void {
  // eslint-disable-next-line no-console
  console.log('[Recurring Doc Request Scheduler] Registered (every 5 min, first run in 90s)');

  const runCycle = async () => {
    try {
      const result = await withSchedulerLock('recurring-doc-request-scheduler', processDueRules);
      if (result && (result.issued > 0 || result.openersSent > 0)) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          level: 'info',
          component: 'recurring-doc-request-scheduler',
          event: 'cycle',
          ...result,
        }));
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[Recurring Doc Request Scheduler] tick error', err);
    }
  };

  setTimeout(() => { void runCycle(); }, INITIAL_DELAY_MS);
  timer = setInterval(() => { void runCycle(); }, TICK_INTERVAL_MS);
}

export function stopRecurringDocRequestScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
