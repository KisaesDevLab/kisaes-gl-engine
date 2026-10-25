// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// bill-ocr-v2 (U-89): per-field and per-line confidence as words, amounts as
// plain decimal strings or null (never JSON numbers), thresholds in the
// engine, document-level `confidence` kept. The provider is a stub.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const chain = (): any => {
  const p: any = Promise.resolve([]);
  for (const m of ['from', 'where', 'limit', 'offset', 'orderBy', 'leftJoin', 'innerJoin', 'groupBy', 'values', 'returning', 'onConflictDoUpdate', 'set']) {
    p[m] = () => chain();
  }
  return p;
};

vi.mock('fs', () => ({ default: { readFileSync: () => Buffer.from('%PDF-1.7 fake bytes') } }));
vi.mock('./storage/cache.service.js', () => ({ ensureLocal: async () => '/tmp/x.pdf' }));
vi.mock('./ai-prompt.service.js', () => ({ getCustomSystemPrompt: async () => null }));
vi.mock('./pii-sanitizer.service.js', () => ({ sanitize: (t: string) => ({ text: t, detected: [] }) }));
vi.mock('./local-ocr.service.js', () => ({
  extractLocally: async () => ({ kind: 'pdf_text', text: 'invoice text', numPages: 1 }),
  extractTextFromPdf: async () => ({ text: '', numPages: 1, isTextBased: false }),
}));
vi.mock('../db/index.js', () => ({
  db: {
    query: {
      attachments: {
        findFirst: async () => ({ id: 'a1', tenantId: 't1', companyId: 'c1', filePath: '/x.pdf', mimeType: 'application/pdf' }),
      },
      contacts: { findFirst: async () => null },
      accounts: { findFirst: async () => null },
    },
    select: () => chain(),
    update: () => chain(),
    insert: () => chain(),
  },
}));
// U-90: the service reads the file through attachmentService.getById (the
// company scope rule); a row stamped with another company is 404.
vi.mock('./attachment.service.js', async () => {
  const { AppError } = await import('../utils/errors.js');
  const row = { id: 'a1', tenantId: 't1', companyId: 'c1', filePath: '/x.pdf', mimeType: 'application/pdf' };
  return {
    getById: async (_t: string, _id: string, companyId?: string | null) => {
      if (companyId && row.companyId !== companyId) throw AppError.notFound('Attachment not found');
      return row;
    },
  };
});

vi.mock('./ai-config.service.js', () => ({
  getConfig: async () => ({ isEnabled: true, ocrProvider: 'anthropic', categorizationProvider: 'anthropic', ocrModel: null }),
  getRawConfig: async () => ({ openaiCompatBaseUrl: null }),
  resolveTaskParams: () => ({ maxTokens: 2048, temperature: 0.1 }),
  resolveTaskExec: () => ({ fallbackChain: [], enabled: true, timeoutMs: 0 }),
  resolveGlmOcrConfig: async () => ({ enabled: false, renderDpi: 150 }),
}));
vi.mock('./ai-orchestrator.service.js', () => ({
  createJob: async () => ({ id: 'job1' }),
  completeJob: async () => undefined,
  failJob: async () => undefined,
  isSelfHostedProvider: () => false,
  assertCloudVisionAllowed: async () => undefined,
  piiModeFor: () => 'standard',
  withAiMetadata: (p: unknown) => p,
}));

let modelReply: Record<string, unknown> = {};
vi.mock('./ai-providers/index.js', () => ({
  getProvider: () => ({
    complete: async () => ({
      provider: 'anthropic', model: 'stub', content: JSON.stringify(modelReply), parsed: modelReply,
      inputTokens: 1, outputTokens: 1, durationMs: 1,
    }),
  }),
}));
vi.mock('./ai-vision-fallback.js', () => ({ completeVisionWithFallback: async () => { throw new Error('not used'); } }));

import {
  extractBillFromAttachment,
  normalizeBillMoney,
  normalizeBillDate,
  bucketConfidence,
  BILL_OCR_CONFIDENCE_THRESHOLDS,
} from './ai-bill-ocr.service.js';

beforeEach(() => { modelReply = {}; });

/** Every money-looking leaf in the response must be a string or null. */
function assertNoNumberMoney(x: Awaited<ReturnType<typeof extractBillFromAttachment>>) {
  for (const k of ['total', 'subtotal', 'tax'] as const) expect(x[k] === null || typeof x[k] === 'string').toBe(true);
  for (const li of x.lineItems) expect(li.amount === null || typeof li.amount === 'string').toBe(true);
}

describe('normalizeBillMoney', () => {
  it.each([
    ['1234.56', '1234.56'],
    [1234.56, '1234.56'],
    [12.5, '12.5'],
    [0, '0'],
    ['$1,234.56', '1234.56'],
    ['USD 99.00', '99.00'],
    [' 7.10 ', '7.10'],
    ['(12.00)', '-12.00'],
    ['-$5.25', '-5.25'],
    ['$-5.25', '-5.25'],
    ['.50', '0.50'],
    ['007.50', '7.50'],
    ['-0.00', '0.00'],
    ['12.', '12'],
  ])('%j → %j', (raw, want) => {
    expect(normalizeBillMoney(raw)).toBe(want);
  });

  it.each([
    [null], [undefined], [''], ['abc'], ['12,50'], ['1.234,56'], ['1,23'], [1e21], [Number.NaN],
    [Infinity], ['1e5'], [{}], [true],
  ])('%j → null', (raw) => {
    expect(normalizeBillMoney(raw)).toBeNull();
  });

  it('a JSON number whose integer part is not a safe integer is null', () => {
    expect(normalizeBillMoney(1e20)).toBeNull();
    expect(normalizeBillMoney(9007199254740993)).toBeNull();
    expect(normalizeBillMoney(-1e17)).toBeNull();
    expect(normalizeBillMoney(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
    expect(normalizeBillMoney(123456789.25)).toBe('123456789.25');
  });
});

describe('normalizeBillDate', () => {
  it.each([['2026-07-01'], ['2024-02-29'], [' 2026-12-31 ']])('%j is kept', (raw) => {
    expect(normalizeBillDate(raw)).toBe(raw.trim());
  });

  it.each([
    ['2026-02-30'], ['2025-02-29'], ['2026-13-01'], ['2026-00-10'], ['2026-04-31'], ['2026-7-1'],
    ['07/01/2026'], ['2026-07-01T00:00:00Z'], ['July 1, 2026'], [''], [20260701], [null], [undefined],
  ])('%j → null', (raw) => {
    expect(normalizeBillDate(raw)).toBeNull();
  });
});

describe('bucketConfidence', () => {
  it('uses the engine thresholds', () => {
    expect(BILL_OCR_CONFIDENCE_THRESHOLDS).toEqual({ high: 0.85, medium: 0.6 });
    expect(bucketConfidence(0.85)).toBe('high');
    expect(bucketConfidence(0.8499)).toBe('medium');
    expect(bucketConfidence(0.6)).toBe('medium');
    expect(bucketConfidence(0.5999)).toBe('low');
    expect(bucketConfidence(0)).toBe('low');
    expect(bucketConfidence(1)).toBe('high');
  });

  it('accepts words, numeric strings and percentages; rejects the rest', () => {
    expect(bucketConfidence('HIGH')).toBe('high');
    expect(bucketConfidence(' low ')).toBe('low');
    expect(bucketConfidence('0.7')).toBe('medium');
    expect(bucketConfidence(92)).toBe('high');
    expect(bucketConfidence(-0.1)).toBeNull();
    expect(bucketConfidence(101)).toBeNull();
    expect(bucketConfidence('sure')).toBeNull();
    expect(bucketConfidence(null)).toBeNull();
  });
});

describe('extractBillFromAttachment — bill-ocr-v2 response', () => {
  it('JSON-number amounts from the model come back as decimal strings', async () => {
    modelReply = {
      vendor: 'ACME', bill_date: '2026-07-01', due_date: '2026-07-31', vendor_invoice_number: 'INV-1',
      payment_terms: 'net_30', subtotal: 100, tax: 8.25, total: 108.25,
      line_items: [{ description: 'Widget', amount: 100, quantity: 2 }],
      confidence: 0.9,
    };
    const x = await extractBillFromAttachment('t1', 'a1');
    expect(x.total).toBe('108.25');
    expect(x.subtotal).toBe('100');
    expect(x.tax).toBe('8.25');
    expect(x.lineItems[0]!.amount).toBe('100');
    assertNoNumberMoney(x);
    // Serialized form has no JSON-number money either.
    const json = JSON.parse(JSON.stringify(x));
    expect(typeof json.total).toBe('string');
    expect(typeof json.lineItems[0].amount).toBe('string');
  });

  it('without per-field scores, every filled field takes the document bucket; empty fields are low', async () => {
    modelReply = {
      vendor: 'ACME', bill_date: '2026-07-01', due_date: null, vendor_invoice_number: null,
      payment_terms: null, subtotal: null, tax: null, total: '50.00',
      line_items: [{ description: 'Svc', amount: '50.00' }], confidence: 0.7,
    };
    const x = await extractBillFromAttachment('t1', 'a1');
    expect(x.confidence).toBe(0.7);
    expect(x.fieldConfidence).toEqual({
      vendor: 'medium', billDate: 'medium', dueDate: 'low', vendorInvoiceNumber: 'low',
      total: 'medium', subtotal: 'low', tax: 'low', paymentTerms: 'low',
    });
    expect(x.lineItems[0]!.confidence).toBe('medium');
  });

  it("uses the model's per-field and per-line scores (numbers or words)", async () => {
    modelReply = {
      vendor: 'ACME', bill_date: '2026-07-01', due_date: '2026-07-31', vendor_invoice_number: 'A1',
      payment_terms: 'net_30', subtotal: '90.00', tax: '10.00', total: '100.00',
      line_items: [
        { description: 'A', amount: '60.00', confidence: 0.95 },
        { description: 'B', amount: '30.00', confidence: 'low' },
      ],
      confidence: 0.7,
      field_confidence: { vendor: 0.99, total: 'high', bill_date: 0.3, due_date: 'nonsense' },
    };
    const x = await extractBillFromAttachment('t1', 'a1');
    expect(x.fieldConfidence.vendor).toBe('high');
    expect(x.fieldConfidence.total).toBe('high');
    expect(x.fieldConfidence.billDate).toBe('low');
    // An unusable score falls back to the document bucket.
    expect(x.fieldConfidence.dueDate).toBe('medium');
    expect(x.fieldConfidence.subtotal).toBe('medium');
    expect(x.lineItems.map((l) => l.confidence)).toEqual(['high', 'low']);
  });

  it('an amount that does not read is null with low confidence, even when the model was sure', async () => {
    modelReply = {
      vendor: 'ACME', total: '1.234,56', subtotal: 'n/a', tax: '0.00',
      line_items: [{ description: 'X', amount: 'twelve', confidence: 0.99 }],
      confidence: 0.95, field_confidence: { total: 0.99, subtotal: 0.99 },
    };
    const x = await extractBillFromAttachment('t1', 'a1');
    expect(x.total).toBeNull();
    expect(x.subtotal).toBeNull();
    expect(x.tax).toBe('0.00');
    expect(x.fieldConfidence.total).toBe('low');
    expect(x.fieldConfidence.subtotal).toBe('low');
    expect(x.fieldConfidence.tax).toBe('high');
    expect(x.lineItems[0]).toMatchObject({ amount: null, confidence: 'low' });
  });

  it('a blank field is empty: low confidence, even when the model was sure', async () => {
    modelReply = {
      vendor: '   ', vendor_invoice_number: '', payment_terms: '\t', bill_date: '2026-07-01', total: '5.00',
      confidence: 0.95, field_confidence: { vendor: 0.99, vendor_invoice_number: 'high', payment_terms: 0.99 },
    };
    const x = await extractBillFromAttachment('t1', 'a1');
    expect(x.fieldConfidence.vendor).toBe('low');
    expect(x.fieldConfidence.vendorInvoiceNumber).toBe('low');
    expect(x.fieldConfidence.paymentTerms).toBe('low');
    expect(x.fieldConfidence.billDate).toBe('high');
  });

  it('line quantity gets the amount clean-up: a decimal string or null', async () => {
    modelReply = {
      vendor: 'ACME', total: '10.00',
      line_items: [
        { description: 'A', amount: '1.00', quantity: 2 },
        { description: 'B', amount: '1.00', quantity: ' 1,500 ' },
        { description: 'C', amount: '1.00', quantity: '1.5' },
        { description: 'D', amount: '1.00', quantity: 'two boxes' },
        { description: 'E', amount: '1.00', quantity: 1e21 },
        { description: 'F', amount: '1.00' },
      ],
      confidence: 0.9,
    };
    const x = await extractBillFromAttachment('t1', 'a1');
    expect(x.lineItems.map((l) => l.quantity)).toEqual(['2', '1500', '1.5', null, null, null]);
  });

  it('a bill or due date that is not a real YYYY-MM-DD is null with low confidence', async () => {
    modelReply = {
      vendor: 'ACME', bill_date: '2026-02-30', due_date: '07/31/2026', total: '5.00',
      confidence: 0.95, field_confidence: { bill_date: 0.99, due_date: 0.99 },
    };
    const x = await extractBillFromAttachment('t1', 'a1');
    expect(x.billDate).toBeNull();
    expect(x.dueDate).toBeNull();
    expect(x.fieldConfidence.billDate).toBe('low');
    expect(x.fieldConfidence.dueDate).toBe('low');
  });

  it('a malformed field_confidence does not fail the read', async () => {
    modelReply = { vendor: 'ACME', total: '5.00', confidence: '0.9', field_confidence: ['high'] };
    const x = await extractBillFromAttachment('t1', 'a1');
    expect(x.confidence).toBe(0.9);
    expect(x.fieldConfidence.vendor).toBe('high');
    expect(x.fieldConfidence.total).toBe('high');
  });
});
