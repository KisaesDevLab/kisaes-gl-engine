// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// U-92: the document draft schemas. Readings are bounded JSON with
// decimal-string amounts (no fractional numbers), the convert body is
// parsed per kind without draftAttachmentId, and the reference
// normalization the duplicate check uses.

import { describe, it, expect } from 'vitest';
import {
  updateDocumentDraftSchema, convertDocumentDraftSchema, putVendorLayoutTemplateSchema, createDocumentDraftSchema,
  convertBodySchemaFor, normalizeDocumentReference, documentDraftListQuerySchema, DOCUMENT_DRAFT_LIMITS, DOCUMENT_REFERENCE_CASES, DOCUMENT_DRAFT_LIST_MAX_OFFSET,
} from './document-drafts.js';

const token = '2026-10-26T12:00:00.123Z';
const uuid = '7d3c0b8e-2f1a-4c5b-9e6d-0a1b2c3d4e5f';

describe('updateDocumentDraftSchema', () => {
  it('accepts a reading with decimal strings, basis points and integer boxes', () => {
    const r = updateDocumentDraftSchema.safeParse({
      expectedUpdatedAt: token, status: 'ready', kind: 'bill', reader: 'ocr',
      fields: { total: { value: '1,234.50', confidenceBp: 9100, page: 1, bbox: [0, 10, 9999, 10000] } },
      lines: [{ amount: '12.00', qty: '3', rate: '4.00' }], checks: [{ code: 'sum_mismatch' }],
      docTotal: '1234.5', docDate: '2026-02-28', docReference: 'INV-1', suggestedContactId: uuid,
    });
    expect(r.success).toBe(true);
  });

  it('refuses a fractional number anywhere, deep nesting, long strings and oversize lists', () => {
    const base = { expectedUpdatedAt: token, status: 'ready' as const };
    expect(updateDocumentDraftSchema.safeParse({ ...base, fields: { a: { b: [1.5] } } }).success).toBe(false);
    expect(updateDocumentDraftSchema.safeParse({ ...base, fields: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } }).success).toBe(false);
    expect(updateDocumentDraftSchema.safeParse({ ...base, fields: { a: 'x'.repeat(DOCUMENT_DRAFT_LIMITS.maxString + 1) } }).success).toBe(false);
    expect(updateDocumentDraftSchema.safeParse({ ...base, lines: Array.from({ length: DOCUMENT_DRAFT_LIMITS.maxLines + 1 }, () => ({})) }).success).toBe(false);
    expect(updateDocumentDraftSchema.safeParse({ ...base, fields: { n: 2_000_000_000 } }).success).toBe(false);
  });

  it('typed fields: decimal totals with at most 4 places, real dates; unknown keys and statuses refused', () => {
    const base = { expectedUpdatedAt: token, status: 'ready' as const };
    for (const bad of ['1e3', '-1.00', '1.23456', '12,50', ' 1.00', '']) {
      expect(updateDocumentDraftSchema.safeParse({ ...base, docTotal: bad }).success, bad).toBe(false);
    }
    expect(updateDocumentDraftSchema.safeParse({ ...base, docDate: '2026-02-30' }).success).toBe(false);
    expect(updateDocumentDraftSchema.safeParse({ ...base, status: 'converted' }).success).toBe(false);
    expect(updateDocumentDraftSchema.safeParse({ ...base, extra: true }).success).toBe(false);
    expect(updateDocumentDraftSchema.safeParse({ status: 'ready' }).success).toBe(false);
  });
});

describe('convert and create schemas', () => {
  it('convert takes a kind, a body, the token and acknowledged ids; the body parses per kind', () => {
    expect(convertDocumentDraftSchema.safeParse({ kind: 'bill', body: {}, expectedUpdatedAt: token }).success).toBe(true);
    expect(convertDocumentDraftSchema.safeParse({ kind: 'unknown', body: {}, expectedUpdatedAt: token }).success).toBe(false);
    expect(convertDocumentDraftSchema.safeParse({ kind: 'bill', body: {}, expectedUpdatedAt: token, acknowledgeDuplicateOf: ['x'] }).success).toBe(false);
    const bill = convertBodySchemaFor('bill').parse({
      contactId: uuid, txnDate: '2026-05-01', lines: [{ accountId: uuid, amount: '10.00' }], draftAttachmentId: uuid, closingPassword: 'x',
    }) as Record<string, unknown>;
    expect(bill['draftAttachmentId']).toBeUndefined();
    expect(bill['closingPassword']).toBeUndefined();
    const check = convertBodySchemaFor('check').parse({
      bankAccountId: uuid, payeeNameOnCheck: 'A', txnDate: '2026-05-01', amount: '1.00', lines: [{ accountId: uuid, amount: '1.00' }], draftAttachmentId: uuid,
    }) as Record<string, unknown>;
    expect(check['draftAttachmentId']).toBeUndefined();
    expect(convertBodySchemaFor('card_charge').safeParse({ txnDate: '2026-05-01' }).success).toBe(false);
  });

  it('create defaults kindHint to unknown', () => {
    expect(createDocumentDraftSchema.parse({ attachmentId: uuid }).kindHint).toBe('unknown');
  });

  it('list status takes a comma-joined set', () => {
    expect(documentDraftListQuerySchema.parse({ status: 'new,ready' }).status).toEqual(['new', 'ready']);
    expect(documentDraftListQuerySchema.safeParse({ status: 'new,posted' }).success).toBe(false);
  });

  it('list query: offset capped at DOCUMENT_DRAFT_LIST_MAX_OFFSET; view full (default) or summary', () => {
    expect(documentDraftListQuerySchema.parse({}).view).toBe('full');
    expect(documentDraftListQuerySchema.parse({ view: 'summary' }).view).toBe('summary');
    expect(documentDraftListQuerySchema.safeParse({ view: 'compact' }).success).toBe(false);
    expect(documentDraftListQuerySchema.parse({ offset: String(DOCUMENT_DRAFT_LIST_MAX_OFFSET) }).offset).toBe(DOCUMENT_DRAFT_LIST_MAX_OFFSET);
    expect(documentDraftListQuerySchema.safeParse({ offset: String(DOCUMENT_DRAFT_LIST_MAX_OFFSET + 1) }).success).toBe(false);
  });

  it('templates: fingerprint charset and length, bounded regions, a required token (null to create)', () => {
    const base = { contactId: uuid, fingerprint: 'fp:abcdefgh', fieldRegions: { total: { box: [1, 2, 3, 4] } } };
    expect(putVendorLayoutTemplateSchema.safeParse({ ...base, expectedUpdatedAt: null }).success).toBe(true);
    expect(putVendorLayoutTemplateSchema.safeParse(base).success).toBe(false);
    expect(putVendorLayoutTemplateSchema.safeParse({ ...base, fingerprint: 'fp a b c d e', expectedUpdatedAt: null }).success).toBe(false);
    expect(putVendorLayoutTemplateSchema.safeParse({ ...base, fieldRegions: { x: 0.25 }, expectedUpdatedAt: null }).success).toBe(false);
  });
});

describe('normalizeDocumentReference', () => {
  it.each(DOCUMENT_REFERENCE_CASES.map((c) => [c.in, c.out]))('shared case %j -> %j', (input, out) => {
    expect(normalizeDocumentReference(input)).toBe(out);
  });

  it.each([
    ['INV-0042', 'inv42'],
    ['inv 0042', 'inv42'],
    ['  #00-12/A ', '012a'],
    ['A-1/05', 'a15'],
    [null, ''],
    ['Façade-7', 'faade7'],
  ])('%j -> %j', (input, out) => {
    expect(normalizeDocumentReference(input)).toBe(out);
  });
});
