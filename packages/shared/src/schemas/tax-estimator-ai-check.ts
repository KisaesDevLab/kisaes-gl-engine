// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// AI parameter check (OPEN-QUESTIONS Q44): request schemas for the super-admin routes and the
// schema the model's JSON answer must match. The model's answer is UNTRUSTED input: it is parsed
// with aiCheckModelAnswerSchema and then re-validated server-side (ai-check-validate.ts).
import { z } from 'zod';
import { taxYearParamSchema, taxParameterKeySchema } from './tax-estimator.js';
import { stateCodeSchema, stateRuleKeySchema } from './tax-estimator-state-rules.js';

const MAX_QUOTE = 4000;
const MAX_TEXT = 4000;
const MAX_URL = 2000;

/**
 * POST /runs. `single` checks one row (`key`, plus `state` for a state rule); `federal` /
 * `state` / `all` check every NOT-verified row of the year (federal parameters, one state's
 * rules, or both). Every run is a background job (progress + cancel), even a single row.
 */
export const createAiCheckRunSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('single'), year: taxYearParamSchema, key: z.string().min(1).max(120), state: stateCodeSchema.optional() }),
  z.object({ scope: z.literal('federal'), year: taxYearParamSchema }),
  z.object({ scope: z.literal('state'), year: taxYearParamSchema, state: stateCodeSchema }),
  z.object({ scope: z.literal('all'), year: taxYearParamSchema }),
]).superRefine((v, ctx) => {
  if (v.scope !== 'single') return;
  const ok = v.state ? stateRuleKeySchema.safeParse(v.key).success : taxParameterKeySchema.safeParse(v.key).success;
  if (!ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid key', path: ['key'] });
});
export type CreateAiCheckRunInput = z.infer<typeof createAiCheckRunSchema>;

export const aiCheckRunIdParamsSchema = z.object({ id: z.string().uuid() });
export const aiCheckIdParamsSchema = z.object({ id: z.string().uuid() });

export const aiCheckRunsQuerySchema = z.object({
  year: taxYearParamSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** GET /latest: latest result per row for the year (federal, or one state's rules). */
export const aiCheckLatestQuerySchema = z.object({
  year: taxYearParamSchema,
  state: stateCodeSchema.optional(),
});

/** POST /checks/:id/apply. `expectedValue` = the current value the admin saw (409 when it moved). */
export const applyAiCheckSchema = z.object({
  expectedValue: z.unknown().refine((v) => v !== undefined, { message: 'expectedValue is required' }),
  /** Replace the row's citation with the AI source (default on in the UI). */
  updateCitation: z.boolean().default(true),
});

export const AI_CHECK_SOURCE_KINDS = [
  'statute', 'regulation', 'revenue_procedure', 'irs_notice', 'form_instructions', 'irs_publication',
  'state_statute', 'state_regulation', 'state_dor_guidance', 'state_form_instructions', 'other',
] as const;
export type AiCheckSourceKind = typeof AI_CHECK_SOURCE_KINDS[number];

/** Kinds whose text is the law itself (no per-year edition): a non-indexed value may be confirmed from them for any year. */
export const AI_CHECK_STATUTORY_SOURCE_KINDS: readonly AiCheckSourceKind[] = ['statute', 'regulation', 'state_statute', 'state_regulation'];

const nullableTrimmed = (max: number) => z.string().max(max).nullable().optional().transform((s) => {
  const t = (s ?? '').trim();
  return t === '' ? null : t;
});

/** The JSON object the model must answer with (system prompt "Output"). */
export const aiCheckModelAnswerSchema = z.object({
  verdict: z.enum(['matches', 'differs', 'unconfirmed']),
  /** The value found, as a STRING holding JSON in the stored value's shape (e.g. "176100", "0.062", "\"2026-04-15\"", "[[11925,0.1],[null,0.37]]"). */
  foundValue: z.union([z.string(), z.number(), z.boolean(), z.array(z.unknown()), z.record(z.unknown())]).nullable().optional(),
  quote: nullableTrimmed(MAX_QUOTE),
  sourceUrl: nullableTrimmed(MAX_URL),
  sourceTitle: nullableTrimmed(500),
  sourceDate: nullableTrimmed(100),
  sourceTaxYear: z.number().int().min(1900).max(2200).nullable().optional(),
  sourceKind: z.enum(AI_CHECK_SOURCE_KINDS).nullable().optional(),
  /** Whether the value is adjusted for inflation each year (null = unknown). */
  inflationIndexed: z.boolean().nullable().optional(),
  /** e.g. "Rev. Proc. 2025-32 §4.01" or "RSMo 143.761". */
  governingAuthority: nullableTrimmed(500),
  rationale: z.string().max(MAX_TEXT).default(''),
  confidence: z.enum(['low', 'medium', 'high']).default('low'),
});
export type AiCheckModelAnswer = z.infer<typeof aiCheckModelAnswerSchema>;
