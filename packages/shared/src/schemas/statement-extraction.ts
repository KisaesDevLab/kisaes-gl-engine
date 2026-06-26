// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Canonical bank/credit-card statement extraction schema for the GLM-OCR
// pipeline (statement import redesign). The Stage-2 text LLM converts the
// per-page OCR/text-layer markdown into a single JSON object that validates
// against `ExtractionResult`; `ExtractionJsonSchema` is the hand-written JSON
// Schema handed to the model's `response_format`.
//
// Money is **signed integer cents** to keep the model honest (no floats, no
// currency symbols). Sign convention is decided once, in the Stage-2 prompt:
//   * Bank:        money OUT (debits/fees) = NEGATIVE; money IN (deposits) = POSITIVE
//   * Credit card: charges/purchases       = POSITIVE; payments/credits    = NEGATIVE
// so that `opening_cents + Σ amount_cents = closing_cents` holds for both.
// Dates are ISO 8601 strings (YYYY-MM-DD).
//
// This is distinct from `schemas/extraction.ts` (the DOCUMENT_EXTRACTION_V1
// vision module); that one keeps unsigned `amount` + a `type` field, this one
// is the converter-style signed-cents model used for reconciliation.

import { z } from 'zod';

// OFX-ish transaction-type hint. The model may emit null/omit; downstream the
// type is derived from the amount sign + description, with this as a hint.
export const StatementTrntypeEnum = z.enum([
  'CREDIT',
  'DEBIT',
  'INT',
  'DIV',
  'FEE',
  'SRVCHG',
  'DEP',
  'ATM',
  'POS',
  'XFER',
  'CHECK',
  'PAYMENT',
  'CASH',
  'DIRECTDEP',
  'DIRECTDEBIT',
  'REPEATPMT',
  'HOLD',
  'OTHER',
]);
export type StatementTrntype = z.infer<typeof StatementTrntypeEnum>;

export const StatementAccountTypeEnum = z.enum([
  'CHECKING',
  'SAVINGS',
  'CREDITCARD',
  'LINEOFCREDIT',
  'MONEYMRKT',
  'OTHER',
]);
export type StatementAccountType = z.infer<typeof StatementAccountTypeEnum>;

export const StatementDateFormatEnum = z.enum(['MDY', 'DMY', 'YMD', 'TEXTUAL', 'AMBIGUOUS']);
export type StatementDateFormat = z.infer<typeof StatementDateFormatEnum>;

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD required');

export const StatementExtractionTransaction = z.object({
  posted_date: DateString,
  description: z.string().min(1).max(500),
  amount_cents: z.number().int(),
  running_balance_cents: z.number().int().nullable().optional(),
  check_number: z.string().max(40).nullable().optional(),
  // Who a check is made out to ("Pay to the order of"), read from a check-image
  // thumbnail when present. Null for non-check rows or when not visible.
  payee: z.string().max(200).nullable().optional(),
  // null ("type unknown") and omitted both mean "infer downstream"; normalize
  // null → undefined so the hint type stays `StatementTrntype | undefined`.
  trntype: StatementTrntypeEnum.nullish().transform((v) => v ?? undefined),
  source_page: z.number().int().min(1).default(1),
  confidence: z.number().min(0).max(1).default(1),
});
export type StatementExtractionTransaction = z.infer<typeof StatementExtractionTransaction>;

export const StatementExtractionAccount = z.object({
  masked_number: z.string().nullable().optional(),
  type_hint: StatementAccountTypeEnum.nullable().optional(),
});

export const StatementExtractionInstitution = z.object({
  name: z.string().nullable().optional(),
  intu_org_hint: z.string().nullable().optional(),
});

export const StatementExtractionPeriod = z.object({
  start: DateString.nullable().optional(),
  end: DateString.nullable().optional(),
});

export const StatementExtractionBalances = z.object({
  opening_cents: z.number().int().nullable().optional(),
  closing_cents: z.number().int().nullable().optional(),
});

export const StatementExtractionDateFormatInfo = z.object({
  format: StatementDateFormatEnum.default('AMBIGUOUS'),
  confidence: z.number().min(0).max(1).default(0),
  evidence: z.string().nullable().optional(),
  sample: z.string().nullable().optional(),
});

export const StatementExtractionResult = z.object({
  account: StatementExtractionAccount.default({}),
  institution: StatementExtractionInstitution.default({}),
  period: StatementExtractionPeriod.default({}),
  balances: StatementExtractionBalances.default({}),
  transactions: z.array(StatementExtractionTransaction).default([]),
  source_date_format: StatementExtractionDateFormatInfo.default({}),
  // Dropped rows, discrepancies, illegible cells — surfaced for review.
  notes: z.string().max(2000).nullable().optional(),
  // Statement-level confidence; absent → derived from per-row min downstream.
  confidence: z.number().min(0).max(1).nullable().optional(),
});
export type StatementExtractionResult = z.infer<typeof StatementExtractionResult>;

// Hand-written JSON Schema (we deliberately avoid a zod-to-json-schema dep).
// Passed to the LLM as `response_format: { type: 'json_schema', json_schema }`
// (or `json_object` on servers that don't honor schemas — Zod re-validates the
// parsed result regardless).
const transactionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['posted_date', 'description', 'amount_cents'],
  properties: {
    posted_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    description: { type: 'string', minLength: 1, maxLength: 500 },
    amount_cents: {
      type: 'integer',
      description:
        'Signed integer cents. Bank: out=negative, in=positive. Credit card: ' +
        'charges=positive, payments=negative.',
    },
    running_balance_cents: { type: ['integer', 'null'] },
    check_number: { type: ['string', 'null'], maxLength: 40 },
    payee: {
      type: ['string', 'null'],
      maxLength: 200,
      description: 'Check "Pay to the order of" payee; null for non-checks or when not visible.',
    },
    trntype: { type: ['string', 'null'], enum: [...StatementTrntypeEnum.options, null] },
    source_page: { type: 'integer', minimum: 1 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

export const StatementExtractionJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['transactions'],
  properties: {
    account: {
      type: 'object',
      additionalProperties: false,
      properties: {
        masked_number: { type: ['string', 'null'], description: 'Last-4 of the account, or null.' },
        type_hint: { type: ['string', 'null'], enum: [...StatementAccountTypeEnum.options, null] },
      },
    },
    institution: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: ['string', 'null'] },
        intu_org_hint: { type: ['string', 'null'] },
      },
    },
    period: {
      type: 'object',
      additionalProperties: false,
      properties: {
        start: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        end: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
    },
    balances: {
      type: 'object',
      additionalProperties: false,
      properties: {
        opening_cents: { type: ['integer', 'null'] },
        closing_cents: { type: ['integer', 'null'] },
      },
    },
    source_date_format: {
      type: 'object',
      additionalProperties: false,
      properties: {
        format: { type: 'string', enum: [...StatementDateFormatEnum.options] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        evidence: { type: ['string', 'null'] },
        sample: { type: ['string', 'null'] },
      },
    },
    transactions: { type: 'array', items: transactionJsonSchema },
    notes: { type: ['string', 'null'], maxLength: 2000 },
    confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 },
  },
} as const;
