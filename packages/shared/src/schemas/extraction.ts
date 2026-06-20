// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Zod schemas for the local document-extraction module. Two groups:
//   1. Request schemas — validate the API surface (upload fields, review
//      submit, list query).
//   2. Per-docType RESULT schemas — validate the local vision model's JSON
//      output before it touches the DB. HARD CONSTRAINT (brief #3): never
//      trust raw LLM JSON; everything is validated here first.
//
// `docTypeSchema` is the single source of truth for the DocType union;
// types/extraction.ts imports the inferred `DocType` from here.

import { z } from 'zod';

export const docTypeSchema = z.enum([
  'bank_statement',
  'invoice',
  'receipt',
  'w2',
  '1099',
  'generic',
]);
export type DocType = z.infer<typeof docTypeSchema>;
/** Readonly tuple of every supported docType — handy for iteration/seeding. */
export const DOC_TYPES = docTypeSchema.options;

// ── Shared field coercions ────────────────────────────────────────────────
// Local models are inconsistent about numeric formatting (they may return
// "$1,234.56", "1234.56", 1234.56, "", or null). Coerce leniently to a
// number-or-null rather than rejecting the whole page on a formatting quirk;
// the arithmetic/consistency checks in Phase 5 catch genuinely bad data.
const extractedNumber = z.preprocess((v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[$,\s]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}, z.number().nullable());

// Confidence is clamped to [0,1]; anything unparseable defaults to 0 so a
// missing/garbled confidence routes the page to review (fail-safe).
const confidenceSchema = z.preprocess((v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}, z.number().min(0).max(1));

// Dates are kept as nullable strings (the model is told to emit YYYY-MM-DD or
// null). Format is validated softly downstream so one malformed date doesn't
// reject an otherwise-good page.
const extractedDate = z.string().nullable();

// ── Per-docType result schemas ────────────────────────────────────────────

const bankTxnSchema = z.object({
  date: extractedDate,
  description: z.string().nullable(),
  amount: extractedNumber,
  type: z.enum(['debit', 'credit']).nullable(),
  balance: extractedNumber.optional(),
  confidence: confidenceSchema.optional(),
});

export const bankStatementResultSchema = z.object({
  page_confidence: confidenceSchema,
  transactions: z.array(bankTxnSchema).default([]),
});

const invoiceLineSchema = z.object({
  description: z.string().nullable(),
  quantity: extractedNumber.optional(),
  amount: extractedNumber,
});

export const invoiceResultSchema = z.object({
  page_confidence: confidenceSchema,
  vendor: z.string().nullable(),
  invoice_no: z.string().nullable(),
  date: extractedDate,
  due_date: extractedDate,
  line_items: z.array(invoiceLineSchema).default([]),
  subtotal: extractedNumber,
  tax: extractedNumber,
  total: extractedNumber,
  confidence: confidenceSchema.optional(),
});

export const receiptResultSchema = z.object({
  page_confidence: confidenceSchema,
  merchant: z.string().nullable(),
  date: extractedDate,
  total: extractedNumber,
  tax: extractedNumber,
  category_hint: z.string().nullable().optional(),
  confidence: confidenceSchema.optional(),
});

// W-2 / 1099 box amounts vary by form variant, so `boxes` is a flexible
// map of box label → amount. TINs/SSNs MUST already be masked by the model
// (the prompt instructs it); Phase 5 additionally masks at rest as defence
// in depth.
export const w2ResultSchema = z.object({
  page_confidence: confidenceSchema,
  employer: z.string().nullable().optional(),
  employee_tin_masked: z.string().nullable().optional(),
  tax_year: z.union([z.number(), z.string(), z.null()]).optional(),
  boxes: z.record(z.string(), extractedNumber).default({}),
  confidence: confidenceSchema.optional(),
});

export const form1099ResultSchema = z.object({
  page_confidence: confidenceSchema,
  /** NEC, MISC, INT, DIV, … */
  form_variant: z.string().nullable().optional(),
  payer: z.string().nullable().optional(),
  recipient_tin_masked: z.string().nullable().optional(),
  tax_year: z.union([z.number(), z.string(), z.null()]).optional(),
  boxes: z.record(z.string(), extractedNumber).default({}),
  confidence: confidenceSchema.optional(),
});

export const genericResultSchema = z.object({
  page_confidence: confidenceSchema,
  raw_text: z.string().nullable().optional(),
  key_values: z
    .array(z.object({ key: z.string(), value: z.string().nullable() }))
    .default([]),
});

/** docType → result schema. The extract worker picks the right validator. */
export const DOC_TYPE_RESULT_SCHEMAS = {
  bank_statement: bankStatementResultSchema,
  invoice: invoiceResultSchema,
  receipt: receiptResultSchema,
  w2: w2ResultSchema,
  '1099': form1099ResultSchema,
  generic: genericResultSchema,
} as const satisfies Record<DocType, z.ZodTypeAny>;

export function resultSchemaFor(docType: DocType): z.ZodTypeAny {
  return DOC_TYPE_RESULT_SCHEMAS[docType];
}

export type BankStatementResult = z.infer<typeof bankStatementResultSchema>;
export type BankStatementTxn = z.infer<typeof bankTxnSchema>;
export type InvoiceResult = z.infer<typeof invoiceResultSchema>;
export type ReceiptResult = z.infer<typeof receiptResultSchema>;
export type W2Result = z.infer<typeof w2ResultSchema>;
export type Form1099Result = z.infer<typeof form1099ResultSchema>;
export type GenericResult = z.infer<typeof genericResultSchema>;

// ── Request schemas ───────────────────────────────────────────────────────

/**
 * Multipart upload: one `file` part plus these scalar fields on req.body.
 */
export const extractUploadFieldsSchema = z.object({
  docType: docTypeSchema,
  companyId: z.string().uuid().optional(),
});

/**
 * Human review write-back. `correction` (optional) replaces the extracted
 * payload; `post` marks the record validated+posted.
 */
export const reviewSubmitSchema = z.object({
  correction: z.record(z.string(), z.unknown()).optional(),
  post: z.boolean().default(true),
  note: z.string().max(2000).optional(),
});

export const extractionListQuerySchema = z.object({
  status: z.string().optional(),
  docType: docTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ExtractUploadFields = z.infer<typeof extractUploadFieldsSchema>;
export type ReviewSubmitInput = z.infer<typeof reviewSubmitSchema>;
export type ExtractionListQuery = z.infer<typeof extractionListQuerySchema>;
