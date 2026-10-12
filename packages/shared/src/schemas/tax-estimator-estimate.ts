// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Phase 10b request schemas — payment ledger, estimate compute,
// Schedule AI snapshot capture. None accepts a firm id or a tenant list (D1).
import { z } from 'zod';

export const PAYMENT_SOURCES = ['gl', 'manual', 'prior_year_overpayment'] as const;
const MAX_MEMO = 2000;

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const ym = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const positiveMoney = z.union([z.number(), z.string().trim().regex(/^\d+(\.\d{1,4})?$/)])
  .transform((v) => String(v)).refine((v) => Number(v) > 0, 'Must be greater than zero');
const jurisdiction = z.string().trim().transform((s) => (s.toLowerCase() === 'federal' ? 'federal' : s.toUpperCase()))
  .refine((s) => s === 'federal' || /^[A-Z]{2}$/.test(s), 'federal or a two-letter state code');

export const paymentIdParamsSchema = z.object({ paymentId: uuid });
export const estimateParamsSchema = z.object({ id: uuid, taxYear: z.coerce.number().int().min(2000).max(2100), scenarioId: uuid });

const paymentBase = z.object({
  /** null = every scenario of the year. */
  scenarioId: uuid.nullable().optional(),
  jurisdiction,
  date: isoDate.nullable().optional(),
  amount: positiveMoney,
  source: z.enum(PAYMENT_SOURCES).default('manual'),
  /** Pins / annotates a GL transaction (dedupes the live GL row). Needs tenantId. */
  tenantId: uuid.nullable().optional(),
  transactionId: uuid.nullable().optional(),
  memo: z.string().trim().max(MAX_MEMO).nullable().optional(),
});

function checkPayment(v: Partial<z.infer<typeof paymentBase>>, ctx: z.RefinementCtx) {
  if (v.source === 'gl' && (!v.transactionId || !v.tenantId)) {
    ctx.addIssue({ code: 'custom', path: ['transactionId'], message: 'A GL payment needs tenantId and transactionId' });
  }
  if (v.transactionId && !v.tenantId) {
    ctx.addIssue({ code: 'custom', path: ['tenantId'], message: 'transactionId needs tenantId' });
  }
}

export const createPaymentSchema = paymentBase.superRefine((v, ctx) => {
  checkPayment(v, ctx);
  if (v.source !== 'prior_year_overpayment' && !v.date) {
    ctx.addIssue({ code: 'custom', path: ['date'], message: 'A payment needs a date' });
  }
});
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
/** PATCH takes any subset; the service re-validates the merged row. */
export const updatePaymentSchema = paymentBase.partial().superRefine(checkPayment);
export type UpdatePaymentInput = z.infer<typeof updatePaymentSchema>;

export const paymentsQuerySchema = z.object({
  scenarioId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

/** POST .../estimate body. */
export const computeEstimateSchema = z.object({
  /** Range end for every linked entity ('YYYY-MM'); default = each entity's last closed / complete month. */
  throughMonth: ym.optional(),
  /** Bypass the Redis estimate cache (the P&L provider cache still applies). */
  refresh: z.boolean().default(false),
}).strict();
export type ComputeEstimateInput = z.infer<typeof computeEstimateSchema>;

/** POST .../sch-ai-snapshots body: capture (or re-capture) Schedule AI period actuals. */
export const captureSchAiSnapshotsSchema = z.object({
  /** 0..2 (3/31, 5/31, 8/31); omitted = every reached period. */
  periodIndex: z.number().int().min(0).max(2).optional(),
  /** Replace snapshots that already exist. */
  replace: z.boolean().default(false),
}).strict();
export type CaptureSchAiSnapshotsInput = z.infer<typeof captureSchAiSnapshotsSchema>;

// ── Phase 12: immutable estimate snapshots ──
const SNAPSHOT_REASON_VALUES = ['finalize', 'vouchers', 'pdf', 'report_pack'] as const;
const MAX_SNAPSHOT_NOTE = 2000;

export const snapshotIdParamsSchema = z.object({ snapshotId: uuid });

/** POST .../scenarios/:scenarioId/snapshots — finalize: compute fresh and freeze. */
export const createSnapshotSchema = z.object({
  throughMonth: ym.optional(),
  reason: z.enum(SNAPSHOT_REASON_VALUES).default('finalize'),
  note: z.string().trim().max(MAX_SNAPSHOT_NOTE).nullable().optional(),
}).strict();
export type CreateSnapshotInput = z.infer<typeof createSnapshotSchema>;

export const snapshotsQuerySchema = z.object({
  scenarioId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type SnapshotsQuery = z.infer<typeof snapshotsQuerySchema>;
