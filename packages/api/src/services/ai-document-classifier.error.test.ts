// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, vi } from 'vitest';
import { AppError } from '../utils/errors.js';

// Regression: classifyDocument's catch returned { type:'other', confidence:0 }
// for EVERY failure, masking caller-actionable AppErrors (consent/budget/
// cloud-vision) as a silent "unclassified". The fix rethrows AppErrors and
// only falls back to "other" (with a log) on genuine model/parse failures.
//
// The promise outcome is captured via .then(onFulfilled, onRejected) into a
// tagged value so assertions never go through .rejects/.resolves — that path
// trips vitest's unhandled-rejection heuristic on this mock-heavy flow.

const mocks = vi.hoisted(() => ({ getRawConfig: vi.fn() }));

vi.mock('fs', () => ({ default: { readFileSync: () => Buffer.from('data'), existsSync: () => true } }));
vi.mock('./storage/cache.service.js', () => ({ ensureLocal: async () => '/tmp/x' }));
vi.mock('./pii-sanitizer.service.js', () => ({ sanitize: () => ({ text: '', detected: [] }) }));
vi.mock('./local-ocr.service.js', () => ({ extractLocally: async () => ({ kind: 'none' }) }));

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      attachments: {
        findFirst: async () => ({ id: 'a1', tenantId: 't1', filePath: '/x', mimeType: 'application/pdf' }),
      },
    },
  },
}));

vi.mock('./ai-config.service.js', () => ({
  getConfig: async () => ({
    isEnabled: true,
    documentClassificationProvider: 'anthropic',
    categorizationProvider: 'anthropic',
    documentClassificationModel: null,
  }),
  getRawConfig: (...a: unknown[]) => mocks.getRawConfig(...a),
  // classifyDocument resolves per-function token/temperature/thinking via
  // this helper before the getRawConfig call under test. Stub it to the
  // classifier's built-in defaults so the failure paths below still fire
  // on getRawConfig as intended.
  resolveTaskParams: () => ({ maxTokens: 128, temperature: 0.1 }),
  // classifyDocument also checks the per-function "Enable this function"
  // toggle via resolveTaskExec; keep it enabled here.
  resolveTaskExec: () => ({ fallbackChain: [], enabled: true }),
}));

// Mechanism B: the classifier now resolves a custom prompt before the
// getRawConfig call under test. Stub it to "no custom prompt" so the
// built-in default is used and the failure paths still fire on getRawConfig.
vi.mock('./ai-prompt.service.js', () => ({ getCustomSystemPrompt: async () => null }));

vi.mock('./ai-orchestrator.service.js', () => ({
  createJob: async () => ({ id: 'job1' }),
  failJob: async () => undefined,
  completeJob: async () => undefined,
  isSelfHostedProvider: () => false,
  assertCloudVisionAllowed: async () => undefined,
  piiModeFor: () => 'redact',
  withAiMetadata: (p: unknown) => p,
}));

import { classifyDocument } from './ai-document-classifier.service.js';

type Outcome =
  | { kind: 'resolve'; value: { type: string; confidence: number } }
  | { kind: 'reject'; error: unknown };

function settle(): Promise<Outcome> {
  return classifyDocument('t1', 'a1').then(
    (value): Outcome => ({ kind: 'resolve', value }),
    (error): Outcome => ({ kind: 'reject', error }),
  );
}

describe('classifyDocument — error classification', () => {
  it('RETHROWS an expected AppError (budget exceeded) instead of swallowing to "other"', async () => {
    mocks.getRawConfig.mockReset();
    mocks.getRawConfig.mockImplementation(() => {
      throw AppError.unprocessableEntity('AI budget exceeded', 'AI_BUDGET_EXCEEDED');
    });
    const outcome = await settle();
    expect(outcome.kind).toBe('reject');
    if (outcome.kind === 'reject') {
      expect(outcome.error).toBeInstanceOf(AppError);
      expect((outcome.error as AppError).code).toBe('AI_BUDGET_EXCEEDED');
    }
  });

  it('falls back to { type:"other" } on a genuine unexpected model failure', async () => {
    mocks.getRawConfig.mockReset();
    mocks.getRawConfig.mockImplementation(() => {
      throw new Error('model exploded');
    });
    const outcome = await settle();
    expect(outcome).toEqual({ kind: 'resolve', value: { type: 'other', confidence: 0 } });
  });
});
