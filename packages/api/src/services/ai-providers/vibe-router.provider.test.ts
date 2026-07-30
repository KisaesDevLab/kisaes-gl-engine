// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// MIG-2 — router provider wire contract via injected fetch, no network.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  MYBOOKS_TASK_CLASSES,
  VibeRouterProvider,
  _setRouterProviderForTests,
  aiMode,
  registerMybooksTaskClasses,
  validateAiModeEnv,
} from './vibe-router.provider.js';
import { executeWithFallback } from './index.js';

const ENV_KEYS = ['VIBE_AI_MODE', 'VIBE_AI_ROUTER_URL', 'VIBE_AI_TOKEN'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env['VIBE_AI_MODE'] = 'router';
  process.env['VIBE_AI_ROUTER_URL'] = 'http://router.test:8220';
  process.env['VIBE_AI_TOKEN'] = 'tok';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  _setRouterProviderForTests(null);
});

function captureFetch(response: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  }) as typeof fetch;
  return { calls, fn };
}

const completionResponse = (content = '{"ok":true}'): Response =>
  new Response(
    JSON.stringify({
      model: 'ollama/qwen3:14b',
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

describe('mode', () => {
  it('aiMode + boot validation', () => {
    expect(aiMode()).toBe('router');
    delete process.env['VIBE_AI_TOKEN'];
    expect(validateAiModeEnv()).toMatch(/requires both/);
    process.env['VIBE_AI_MODE'] = 'direct';
    expect(validateAiModeEnv()).toBeNull();
  });
});

describe('VibeRouterProvider', () => {
  it('complete(): task-class header, attribution, json_object format, no model', async () => {
    const { calls, fn } = captureFetch(() => completionResponse());
    const p = new VibeRouterProvider({ baseUrl: 'http://router.test:8220', token: 'tok', fetchImpl: fn });
    const result = await p.complete({
      taskClass: MYBOOKS_TASK_CLASSES.TXN_CATEGORIZE,
      systemPrompt: 'sys',
      userPrompt: 'categorize',
      responseFormat: 'json',
      maxTokens: 512,
      userId: 'user-1',
      companyRef: 'company-9',
    });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-vibe-task-class']).toBe('mybooks_txn_categorize');
    expect(headers['x-vibe-user']).toBe('user-1');
    expect(headers['x-vibe-client']).toBe('company-9');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBeUndefined();
    expect(body.response_format).toEqual({ type: 'json_object' });

    expect(result.provider).toBe('vibe_router');
    expect(result.parsed).toEqual({ ok: true });
    expect(result.model).toBe('ollama/qwen3:14b');
  });

  it('completeWithImage(): images become data-URL parts', async () => {
    const { calls, fn } = captureFetch(() => completionResponse());
    const p = new VibeRouterProvider({ baseUrl: 'http://router.test:8220', token: 'tok', fetchImpl: fn });
    await p.completeWithImage({
      taskClass: MYBOOKS_TASK_CLASSES.RECEIPT_EXTRACT,
      systemPrompt: 'extract',
      userPrompt: 'read this receipt',
      responseFormat: 'json',
      images: [{ base64: 'QUJD', mimeType: 'image/png' }],
    });
    const body = JSON.parse(String(calls[0]!.init.body));
    const user = body.messages.find((m: { role: string }) => m.role === 'user');
    expect(user.content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } });
  });

  it('fails closed without a task class; never falls back on router errors', async () => {
    const { fn } = captureFetch(() => completionResponse());
    const p = new VibeRouterProvider({ baseUrl: 'http://router.test:8220', token: 'tok', fetchImpl: fn });
    await expect(p.complete({ systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow(
      /did not declare a task class/,
    );

    const { fn: failFn } = captureFetch(
      () =>
        new Response(JSON.stringify({ error: { code: 'policy_blocked', message: 'no policy' } }), {
          status: 403,
        }),
    );
    const p2 = new VibeRouterProvider({ baseUrl: 'http://router.test:8220', token: 'tok', fetchImpl: failFn });
    await expect(
      p2.complete({ taskClass: 'mybooks_chat', systemPrompt: 's', userPrompt: 'u' }),
    ).rejects.toThrow(/Vibe AI Router: no policy \(policy_blocked\)/);
  });
});

describe('executeWithFallback (router mode)', () => {
  it('short-circuits the fallback chain to the router provider', async () => {
    const { calls, fn } = captureFetch(() => completionResponse());
    _setRouterProviderForTests(
      new VibeRouterProvider({ baseUrl: 'http://router.test:8220', token: 'tok', fetchImpl: fn }),
    );
    const result = await executeWithFallback(
      { taskClass: MYBOOKS_TASK_CLASSES.VENDOR_ENRICH, systemPrompt: 's', userPrompt: 'u', responseFormat: 'json' },
      {}, // empty config — a direct path would report "no credentials"
      ['anthropic', 'openai'],
      'anthropic',
    );
    expect(result.provider).toBe('vibe_router');
    expect(calls.length).toBe(1); // one router call, no chain walking
  });
});

describe('registerMybooksTaskClasses', () => {
  it('declares all eight classes in router mode only', async () => {
    const { calls, fn } = captureFetch(
      () => new Response(JSON.stringify({ registered: [] }), { status: 200 }),
    );
    registerMybooksTaskClasses({ fetchImpl: fn, maxAttempts: 1, log: () => {} });
    await new Promise((r) => setTimeout(r, 30));
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.app).toBe('vibe-mybooks');
    expect(body.classes.map((c: { key: string }) => c.key).sort()).toEqual([
      'mybooks_bill_extract',
      'mybooks_chat',
      'mybooks_doc_classify',
      'mybooks_receipt_extract',
      'mybooks_report_narrative',
      'mybooks_statement_extract',
      'mybooks_txn_categorize',
      'mybooks_vendor_enrich',
    ]);

    process.env['VIBE_AI_MODE'] = 'direct';
    registerMybooksTaskClasses({ fetchImpl: fn, maxAttempts: 1, log: () => {} });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(1);
  });
});
