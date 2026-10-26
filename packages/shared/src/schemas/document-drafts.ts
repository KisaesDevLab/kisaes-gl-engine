// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Document drafts and vendor layout templates (U-92, document-drafts-v1).
// A draft is a client's reading of one vendor document; the engine stores it
// and converts it into a bill, card charge, check or cash expense on accept.
// The reading itself (fields, lines, checks, layout regions) is the client's
// data: the engine bounds it and never computes with it. Amounts in it are
// decimal strings; numbers must be integers (basis points, page boxes).

import { z } from 'zod';
import { createBillSchema } from './ap.js';
import { createExpenseSchema } from './transactions.js';
import { writeCheckSchema } from './checks.js';

export const DOCUMENT_DRAFT_KINDS = ['bill', 'card_charge', 'check', 'cash_expense', 'unknown'] as const;
export type DocumentDraftKind = typeof DOCUMENT_DRAFT_KINDS[number];

/** The kinds a draft converts into. */
export const DOCUMENT_CONVERT_KINDS = ['bill', 'card_charge', 'check', 'cash_expense'] as const;
export type DocumentConvertKind = typeof DOCUMENT_CONVERT_KINDS[number];

export const DOCUMENT_DRAFT_STATUSES = ['new', 'ready', 'failed', 'converted', 'discarded'] as const;
export type DocumentDraftStatus = typeof DOCUMENT_DRAFT_STATUSES[number];

/** Live drafts hold their file: it can't be deleted and the draft can still change. */
export const DOCUMENT_DRAFT_LIVE_STATUSES = ['new', 'ready', 'failed'] as const;

export const DOCUMENT_DRAFT_READERS = ['text_pdf', 'ocr', 'template', 'ollama', 'cloud', 'manual'] as const;
export type DocumentDraftReader = typeof DOCUMENT_DRAFT_READERS[number];

/** Bounds of the stored reading. */
export const DOCUMENT_DRAFT_LIMITS = {
  fieldsBytes: 64 * 1024,
  linesBytes: 256 * 1024,
  checksBytes: 64 * 1024,
  maxLines: 500,
  maxChecks: 200,
  templateRegionsBytes: 64 * 1024,
  templateLineTableBytes: 32 * 1024,
  templatesPerCompany: 500,
  maxDepth: 6,
  maxString: 2000,
  maxInteger: 1_000_000_000,
} as const;

// A JSON value as the client stores it: objects, arrays, strings up to
// maxString characters, booleans, null, and integers within +-maxInteger.
// A fractional number is refused so no amount is ever stored as a float.
function jsonValueOk(v: unknown, depth: number): string | null {
  if (v === null || typeof v === 'boolean') return null;
  if (typeof v === 'string') return v.length <= DOCUMENT_DRAFT_LIMITS.maxString ? null : 'string too long';
  if (typeof v === 'number') {
    return Number.isInteger(v) && Math.abs(v) <= DOCUMENT_DRAFT_LIMITS.maxInteger
      ? null : 'numbers must be integers (send amounts as decimal strings)';
  }
  if (depth >= DOCUMENT_DRAFT_LIMITS.maxDepth) return 'nested too deeply';
  if (Array.isArray(v)) {
    for (const x of v) { const e = jsonValueOk(x, depth + 1); if (e) return e; }
    return null;
  }
  if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k.length > 100) return 'key too long';
      const e = jsonValueOk(x, depth + 1);
      if (e) return e;
    }
    return null;
  }
  return 'not a JSON value';
}

function boundedJson<T extends z.ZodTypeAny>(base: T, maxBytes: number): z.ZodEffects<T> {
  return base.superRefine((v, ctx) => {
    const err = jsonValueOk(v, 0);
    if (err) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: err }); return; }
    if (new TextEncoder().encode(JSON.stringify(v)).length > maxBytes) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `larger than ${maxBytes} bytes` });
    }
  });
}

const jsonObject = z.record(z.unknown());

/** A plain decimal string >= 0 with at most 4 places (no exponent, no sign). */
export const DOCUMENT_DECIMAL_RE = /^\d{1,15}(\.\d{1,4})?$/;

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine((v) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, 'Not a valid date');

const updatedAtToken = z.string().datetime({ offset: true });

// POST /document-drafts: claim an uploaded draft attachment.
export const createDocumentDraftSchema = z.object({
  attachmentId: z.string().uuid(),
  kindHint: z.enum(DOCUMENT_DRAFT_KINDS).optional().default('unknown'),
}).strict();
export type CreateDocumentDraftInput = z.infer<typeof createDocumentDraftSchema>;

// PUT /document-drafts/:id: store a reading (ready) or a failure (failed).
// Omitted fields keep their stored value; null clears the typed ones.
export const updateDocumentDraftSchema = z.object({
  expectedUpdatedAt: updatedAtToken,
  status: z.enum(['ready', 'failed']),
  kind: z.enum(DOCUMENT_DRAFT_KINDS).optional(),
  reader: z.enum(DOCUMENT_DRAFT_READERS).nullable().optional(),
  fields: boundedJson(jsonObject, DOCUMENT_DRAFT_LIMITS.fieldsBytes).optional(),
  lines: boundedJson(z.array(z.unknown()).max(DOCUMENT_DRAFT_LIMITS.maxLines), DOCUMENT_DRAFT_LIMITS.linesBytes).optional(),
  checks: boundedJson(z.array(z.unknown()).max(DOCUMENT_DRAFT_LIMITS.maxChecks), DOCUMENT_DRAFT_LIMITS.checksBytes).optional(),
  failureReason: z.string().regex(/^[a-z0-9_]{1,40}$/).nullable().optional(),
  suggestedContactId: z.string().uuid().nullable().optional(),
  docReference: z.string().trim().min(1).max(100).nullable().optional(),
  docTotal: z.string().regex(DOCUMENT_DECIMAL_RE, 'A decimal string with at most 4 places').nullable().optional(),
  docDate: calendarDate.nullable().optional(),
}).strict();
export type UpdateDocumentDraftInput = z.infer<typeof updateDocumentDraftSchema>;

export const documentDraftListQuerySchema = z.object({
  status: z.string().optional().transform((v, ctx) => {
    if (v === undefined || v === '') return undefined;
    const parts = v.split(',');
    for (const p of parts) {
      if (!(DOCUMENT_DRAFT_STATUSES as readonly string[]).includes(p)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown status ${p.slice(0, 20)}` });
        return z.NEVER;
      }
    }
    return parts as DocumentDraftStatus[];
  }),
  kind: z.enum(DOCUMENT_DRAFT_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type DocumentDraftListQuery = z.infer<typeof documentDraftListQuerySchema>;

// The posting body of each kind, exactly as the kind's own route takes it,
// without draftAttachmentId (convert relinks the draft's file itself) and,
// for bills, without expectedUpdatedAt (create only).
export const convertBillBodySchema = createBillSchema.omit({ draftAttachmentId: true, expectedUpdatedAt: true });
export const convertExpenseBodySchema = createExpenseSchema;
export const convertCheckBodySchema = writeCheckSchema.omit({ draftAttachmentId: true });

/** The body schema for `kind`. */
export function convertBodySchemaFor(kind: DocumentConvertKind) {
  switch (kind) {
    case 'bill': return convertBillBodySchema;
    case 'check': return convertCheckBodySchema;
    case 'card_charge':
    case 'cash_expense': return convertExpenseBodySchema;
  }
}

// POST /document-drafts/:id/convert. `body` is validated per kind by the
// route (400 VALIDATION_ERROR); closingPassword is read at the top level only
// (lock context) and never reaches this schema.
export const convertDocumentDraftSchema = z.object({
  kind: z.enum(DOCUMENT_CONVERT_KINDS),
  body: jsonObject,
  expectedUpdatedAt: updatedAtToken,
  acknowledgeDuplicateOf: z.array(z.string().uuid()).max(50).optional().default([]),
  overrideConfirmed: z.boolean().optional(),
}).strict();
export type ConvertDocumentDraftInput = z.infer<typeof convertDocumentDraftSchema>;

// Vendor layout templates.
export const vendorLayoutTemplateListQuerySchema = z.object({
  contactId: z.string().uuid().optional(),
});

export const putVendorLayoutTemplateSchema = z.object({
  contactId: z.string().uuid(),
  fingerprint: z.string().regex(/^[A-Za-z0-9:_.-]{8,128}$/, '8-128 of [A-Za-z0-9:_.-]'),
  fieldRegions: boundedJson(jsonObject, DOCUMENT_DRAFT_LIMITS.templateRegionsBytes),
  lineTable: boundedJson(jsonObject, DOCUMENT_DRAFT_LIMITS.templateLineTableBytes).nullable().optional(),
  samples: z.number().int().min(1).max(1_000_000).optional(),
  lastUsedAt: z.string().datetime({ offset: true }).nullable().optional(),
  // null: create only (409 STALE when the layout is already stored).
  expectedUpdatedAt: updatedAtToken.nullable(),
}).strict();
export type PutVendorLayoutTemplateInput = z.infer<typeof putVendorLayoutTemplateSchema>;

// DELETE /vendor-layout-templates/:id query.
export const deleteVendorLayoutTemplateSchema = z.object({
  expectedUpdatedAt: updatedAtToken.optional(),
});

/**
 * Normalizes a document reference for the duplicate check, as ClientLedger's
 * cl-docread `dupes::normalize_reference` does: leading zeros of every digit
 * run dropped (an all-zero run keeps one 0), lower case, ASCII letters and
 * digits only ('INV-00123' -> 'inv123', 'RB-2026-0042' -> 'rb202642',
 * '0000' -> '0'). The engine applies the same rule in SQL
 * (document-draft.service.ts normalizedRefSql).
 */
export function normalizeDocumentReference(ref: string | null | undefined): string {
  if (!ref) return '';
  let out = '';
  let run = '';
  const flush = () => {
    if (run) {
      const t = run.replace(/^0+/, '');
      out += t === '' ? '0' : t;
      run = '';
    }
  };
  for (const ch of ref) {
    if (ch >= '0' && ch <= '9') { run += ch; continue; }
    flush();
    if (/^[A-Za-z]$/.test(ch)) out += ch.toLowerCase();
  }
  flush();
  return out;
}

/** The reference cases shared with ClientLedger (fixtures/docs/rule-cases.json `reference`). */
export const DOCUMENT_REFERENCE_CASES: ReadonlyArray<{ in: string; out: string }> = [
  { in: 'INV-00123', out: 'inv123' },
  { in: ' inv 123 ', out: 'inv123' },
  { in: 'Inv.20417', out: 'inv20417' },
  { in: '#4521', out: '4521' },
  { in: '004521', out: '4521' },
  { in: 'A-1/0', out: 'a10' },
  { in: '0000', out: '0' },
  { in: 'RB-2026-0042', out: 'rb202642' },
  { in: '---', out: '' },
  { in: '', out: '' },
];
