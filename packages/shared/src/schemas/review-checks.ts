// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';
import { FINDING_SEVERITIES, FINDING_STATUSES } from '../constants/review-checks.js';

// POST /run — body either empty (run for all companies in
// tenant) or scoped to a specific company. `periodStart` /
// `periodEnd` optionally scope the run to a close period
// (ISO date/timestamp bounds; periodEnd is exclusive
// first-of-next-month per ClosePeriodSelector). Omitting them
// runs all-time, preserving the nightly scheduler's behavior.
// Bounds must LEAD with a calendar date (bare YYYY-MM-DD or a full ISO
// timestamp) — the orchestrator writes the date part into the
// check_runs date columns, so an arbitrary string would surface as a
// raw Postgres cast error (500) instead of a 400.
const isoDateish = /^\d{4}-\d{2}-\d{2}(T.*)?$/;
export const runChecksSchema = z.object({
  companyId: z.string().uuid().optional(),
  periodStart: z.string().regex(isoDateish, 'Must be an ISO date').optional(),
  periodEnd: z.string().regex(isoDateish, 'Must be an ISO date').optional(),
});
export type RunChecksInput = z.infer<typeof runChecksSchema>;

// POST /run-ai-judgment — same body shape, but the orchestrator
// runs with includeAiHandlers=true so the judgment-category
// handlers fire. Separate route + audit entity so cost-tracking
// and the AI-credit dialog are explicit.
export const runAiJudgmentSchema = runChecksSchema;
export type RunAiJudgmentInput = z.infer<typeof runAiJudgmentSchema>;

export const findingsListQuerySchema = z.object({
  status: z.enum(FINDING_STATUSES).optional(),
  severity: z.enum(FINDING_SEVERITIES).optional(),
  checkKey: z.string().optional(),
  companyId: z.string().uuid().optional(),
  // Scope the list to a close period. Findings stamped with a run
  // period inside [periodStart, periodEnd) are returned; when omitted
  // the list is unscoped (all periods, matching prior behavior).
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type FindingsListQueryInput = z.infer<typeof findingsListQuerySchema>;

export const createSuppressionSchema = z.object({
  checkKey: z.string().min(1).max(80),
  companyId: z.string().uuid().nullable().optional(),
  matchPattern: z.object({
    transactionId: z.string().uuid().optional(),
    vendorId: z.string().uuid().optional(),
    payloadEquals: z.record(z.unknown()).optional(),
  }).refine(
    (v) => Object.keys(v).length > 0,
    { message: 'matchPattern must have at least one of transactionId, vendorId, or payloadEquals' },
  ),
  reason: z.string().max(500).optional(),
  expiresAt: z.string().optional(),
});
export type CreateSuppressionInput = z.infer<typeof createSuppressionSchema>;

export const setOverrideSchema = z.object({
  companyId: z.string().uuid().nullable().optional(),
  params: z.record(z.unknown()),
});
export type SetOverrideInput = z.infer<typeof setOverrideSchema>;

// POST /findings/:id/transition — single-row state change.
// `note` lands in finding_events; `resolutionNote` lands on the
// finding row itself when transitioning to 'resolved'.
export const transitionFindingSchema = z
  .object({
    status: z.enum(FINDING_STATUSES),
    note: z.string().max(2000).optional(),
    assignedTo: z.string().uuid().nullable().optional(),
    resolutionNote: z.string().max(2000).optional(),
  })
  .refine(
    (v) => v.status !== 'assigned' || (v.assignedTo !== undefined && v.assignedTo !== null),
    { message: 'assignedTo is required when transitioning to status=assigned', path: ['assignedTo'] },
  );
export type TransitionFindingInput = z.infer<typeof transitionFindingSchema>;

// POST /findings/bulk-transition — same semantics as the single
// route but applies to a list of finding ids in one call.
export const bulkTransitionFindingsSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(500),
    status: z.enum(FINDING_STATUSES),
    note: z.string().max(2000).optional(),
    assignedTo: z.string().uuid().nullable().optional(),
    resolutionNote: z.string().max(2000).optional(),
  })
  .refine(
    (v) => v.status !== 'assigned' || (v.assignedTo !== undefined && v.assignedTo !== null),
    { message: 'assignedTo is required when transitioning to status=assigned', path: ['assignedTo'] },
  );
export type BulkTransitionFindingsInput = z.infer<typeof bulkTransitionFindingsSchema>;
