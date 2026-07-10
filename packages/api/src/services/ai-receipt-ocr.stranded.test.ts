// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// M10: when the consent/budget gate (createJob) throws, the attachment must NOT
// be left stuck on ocrStatus='processing' with no job to ever clear it. The fix
// runs createJob BEFORE flipping the status to 'processing'.

import { describe, it, expect, vi } from 'vitest';

const setCalls: Array<Record<string, unknown>> = [];

const chain = (): any => {
  const p: any = Promise.resolve([]);
  for (const m of ['from', 'where', 'limit', 'offset', 'orderBy', 'leftJoin', 'innerJoin', 'groupBy', 'values', 'returning', 'onConflictDoUpdate']) {
    p[m] = () => chain();
  }
  p.set = (payload: Record<string, unknown>) => { setCalls.push(payload); return chain(); };
  return p;
};

vi.mock('fs', () => ({ default: { readFileSync: () => Buffer.from('img') } }));
vi.mock('./storage/cache.service.js', () => ({ ensureLocal: async () => '/tmp/x.jpg' }));
vi.mock('./pii-sanitizer.service.js', () => ({ sanitize: (t: string) => ({ text: t, detected: [] }) }));
vi.mock('./local-ocr.service.js', () => ({ extractLocally: async () => ({ kind: 'none' }) }));
vi.mock('./ai-prompt.service.js', () => ({ getCustomSystemPrompt: async () => null }));

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      attachments: { findFirst: async () => ({ id: 'a1', tenantId: 't1', companyId: 'c1', filePath: '/x.jpg', mimeType: 'image/jpeg' }) },
      contacts: { findFirst: async () => null },
    },
    select: () => chain(),
    update: () => chain(),
    insert: () => chain(),
  },
}));

vi.mock('./ai-config.service.js', () => ({
  getConfig: async () => ({ isEnabled: true, ocrProvider: 'anthropic', categorizationProvider: 'anthropic', ocrModel: null }),
  getRawConfig: async () => ({ openaiCompatBaseUrl: null }),
  resolveTaskParams: () => ({ maxTokens: 1024, temperature: 0.1 }),
  resolveTaskExec: () => ({ fallbackChain: [], enabled: true }),
}));

import { AppError } from '../utils/errors.js';

vi.mock('./ai-orchestrator.service.js', () => ({
  // The consent gate blocks the company → createJob throws.
  createJob: async () => { throw AppError.badRequest('This company has not opted in to AI processing.', 'ai_consent_blocked'); },
  completeJob: async () => undefined,
  failJob: async () => undefined,
  isSelfHostedProvider: () => false,
  assertCloudVisionAllowed: async () => undefined,
  piiModeFor: () => 'strict',
  withAiMetadata: (p: unknown) => p,
}));

import { processReceipt } from './ai-receipt-ocr.service.js';

describe('processReceipt — no stranded status on a blocked job (M10)', () => {
  it('never writes ocrStatus="processing" when createJob throws', async () => {
    setCalls.length = 0;
    await expect(processReceipt('t1', 'a1')).rejects.toBeInstanceOf(AppError);
    const wroteProcessing = setCalls.some((c) => c['ocrStatus'] === 'processing');
    expect(wroteProcessing).toBe(false);
  });
});
