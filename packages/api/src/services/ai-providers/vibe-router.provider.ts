// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// MIG-2 (router-option addendum, Q-063/Q-064) — Vibe AI Router provider.
//
// When VIBE_AI_MODE=router, the shared execution helpers (executeWithFallback,
// completeVisionWithFallback) and the feature services' direct provider calls
// short-circuit to this provider: the app stops choosing providers and models
// — the task class is the only knob, and router policy decides model,
// fallback, budgets, PII scrubbing, and cost. The admin AI-config provider
// credentials and fallback chains become inert. The local document-extraction
// pipeline (qwen-client) and GLM-OCR page transcription stay direct in both
// modes (pinned-local infrastructure, D5).
//
// NO silent cross-mode fallback: a router outage surfaces through the same
// error paths the features already handle.

import { VibeAiClient, VibeAiError, type ChatMessage } from './vibe-ai-client.js';
import type { AiProvider, CompletionParams, CompletionResult, VisionParams } from './ai-provider.interface.js';
import { extractJsonForResult } from './json-utils.js';

export type AiMode = 'direct' | 'router';

export function aiMode(): AiMode {
  return process.env['VIBE_AI_MODE'] === 'router' ? 'router' : 'direct';
}

/** Boot-time validation; returns an error string or null. */
export function validateAiModeEnv(): string | null {
  const mode = process.env['VIBE_AI_MODE'];
  if (mode && mode !== 'direct' && mode !== 'router') {
    return `VIBE_AI_MODE must be "direct" or "router" (got "${mode}")`;
  }
  if (mode === 'router' && (!process.env['VIBE_AI_ROUTER_URL'] || !process.env['VIBE_AI_TOKEN'])) {
    return (
      'VIBE_AI_MODE=router requires both VIBE_AI_ROUTER_URL and VIBE_AI_TOKEN ' +
      '(the appliance mints the token during "vibe enable"), or set VIBE_AI_MODE=direct.'
    );
  }
  return null;
}

/**
 * This app's task classes. The first two are default-pack classes (reviewed
 * sensitivities); the rest are new and start local_only until widened.
 */
export const MYBOOKS_TASK_CLASSES = {
  /** Bank transaction categorization + personal/business judgment review (pack, local_only) */
  TXN_CATEGORIZE: 'mybooks_txn_categorize',
  /** Receipt OCR field extraction (pack, cloud_deidentified) */
  RECEIPT_EXTRACT: 'mybooks_receipt_extract',
  /** NEW: vendor bill / invoice extraction (distinct schema from receipts) */
  BILL_EXTRACT: 'mybooks_bill_extract',
  /** NEW: document type classification for routing */
  DOC_CLASSIFY: 'mybooks_doc_classify',
  /** NEW: bank-statement stage-2 extraction + check reads (full statements) */
  STATEMENT_EXTRACT: 'mybooks_statement_extract',
  /** NEW: merchant/vendor enrichment lookups */
  VENDOR_ENRICH: 'mybooks_vendor_enrich',
  /** NEW: bookkeeping chat assistant */
  CHAT: 'mybooks_chat',
  /** NEW: client-facing report narration */
  REPORT_NARRATIVE: 'mybooks_report_narrative',
} as const;

function requireTaskClass(params: CompletionParams): string {
  // Fail closed: an unmapped call site must not silently ride on some
  // default class — sensitivity, scrubbing, and budgets derive from it.
  if (!params.taskClass) {
    throw new Error(
      'Vibe AI Router mode: this call site did not declare a task class (params.taskClass) — ' +
        'see MYBOOKS_TASK_CLASSES in vibe-router.provider.ts.',
    );
  }
  return params.taskClass;
}

export interface VibeRouterProviderOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class VibeRouterProvider implements AiProvider {
  name = 'vibe_router';
  supportsVision = true;

  private readonly client: VibeAiClient;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: VibeRouterProviderOptions) {
    if (!opts.baseUrl || !opts.token) {
      throw new Error('vibe-router provider: baseUrl and token are required');
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.client = new VibeAiClient({
      baseUrl: opts.baseUrl,
      token: opts.token,
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    });
  }

  private async run(params: CompletionParams, images?: VisionParams['images']): Promise<CompletionResult> {
    const taskClass = requireTaskClass(params);
    const started = Date.now();
    const userContent =
      images && images.length > 0
        ? [
            { type: 'text' as const, text: params.userPrompt },
            ...images.map((img) => ({
              type: 'image_url' as const,
              image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
            })),
          ]
        : params.userPrompt;
    const messages: ChatMessage[] = [
      ...(params.systemPrompt ? [{ role: 'system' as const, content: params.systemPrompt }] : []),
      { role: 'user' as const, content: userContent },
    ];
    try {
      const result = await this.client.complete(taskClass, messages, {
        ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.responseFormat === 'json' ? { responseFormat: { type: 'json_object' as const } } : {}),
        ...(params.userId ? { userId: params.userId } : {}),
        ...(params.companyRef ? { clientRef: params.companyRef } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      const truncated = result.finishReason === 'length';
      const text = result.content;
      return {
        text,
        ...extractJsonForResult(text, params.responseFormat, { truncated }),
        ...(truncated ? { truncated } : {}),
        inputTokens: result.usage.promptTokens,
        outputTokens: result.usage.completionTokens,
        model: result.model,
        provider: this.name,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      if (err instanceof VibeAiError) {
        throw new Error(`Vibe AI Router: ${err.message} (${err.code})`);
      }
      throw new Error(
        `Vibe AI Router unreachable: ${err instanceof Error ? err.message : String(err)}. ` +
          'Router mode never falls back to a direct provider.',
      );
    }
  }

  complete(params: CompletionParams): Promise<CompletionResult> {
    return this.run(params);
  }

  completeWithImage(params: VisionParams): Promise<CompletionResult> {
    return this.run(params, params.images);
  }

  async testConnection(signal?: AbortSignal): Promise<{ success: boolean; error?: string; modelInfo?: string }> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/healthz`, {
        signal: signal ?? AbortSignal.timeout(10_000),
      });
      return res.ok
        ? { success: true, modelInfo: 'managed by Vibe AI Router' }
        : { success: false, error: `HTTP ${res.status}` };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Cost accounting lives in the router ledger in router mode; app-side
  // ai_usage_log records 0 so the (inert) local budget never double-counts.
  estimateCost(): number {
    return 0;
  }
}

// ── singleton + boot registration ────────────────────────────────────────

let cached: VibeRouterProvider | null = null;

export function routerProvider(): VibeRouterProvider {
  if (!cached) {
    cached = new VibeRouterProvider({
      baseUrl: process.env['VIBE_AI_ROUTER_URL'] ?? '',
      token: process.env['VIBE_AI_TOKEN'] ?? '',
    });
  }
  return cached;
}

/** Test seam. */
export function _setRouterProviderForTests(p: VibeRouterProvider | null): void {
  cached = p;
}

/**
 * Declare this app's task classes on the router (idempotent). Router mode
 * only; non-blocking with backoff — requests made before registration
 * completes fail closed at the router, which is correct.
 */
export function registerMybooksTaskClasses(o?: {
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}): void {
  if (aiMode() !== 'router') return;
  const log =
    o?.log ?? ((level, msg) => console[level === 'info' ? 'log' : level](`[vibe-router] ${msg}`));
  const client = new VibeAiClient({
    baseUrl: process.env['VIBE_AI_ROUTER_URL'] ?? '',
    token: process.env['VIBE_AI_TOKEN'] ?? '',
    ...(o?.fetchImpl ? { fetch: o.fetchImpl } : {}),
  });
  const maxAttempts = o?.maxAttempts ?? 10;
  let attempt = 0;

  const tryRegister = async (): Promise<void> => {
    attempt++;
    try {
      await client.registerTaskClasses({
        app: 'vibe-mybooks',
        version: process.env['npm_package_version'] ?? 'unknown',
        classes: [
          // Pack classes — declarations match the reviewed pack entries.
          { key: MYBOOKS_TASK_CLASSES.TXN_CATEGORIZE, description: 'Bank transaction categorization', requires: { json_schema: true }, defaultMaxTokens: 2048 },
          { key: MYBOOKS_TASK_CLASSES.RECEIPT_EXTRACT, description: 'Receipt/invoice OCR field extraction', requires: { json_schema: true, vision: true }, defaultMaxTokens: 4096 },
          // New classes — start local_only until the operator widens them.
          { key: MYBOOKS_TASK_CLASSES.BILL_EXTRACT, description: 'Vendor bill / invoice field extraction', requires: { json_schema: true, vision: true }, defaultMaxTokens: 4096 },
          { key: MYBOOKS_TASK_CLASSES.DOC_CLASSIFY, description: 'Document type classification for routing', requires: { json_schema: true, vision: true }, defaultMaxTokens: 1024 },
          { key: MYBOOKS_TASK_CLASSES.STATEMENT_EXTRACT, description: 'Bank-statement transaction extraction + check reads (full statements)', requires: { json_schema: true, vision: true }, defaultMaxTokens: 16384 },
          { key: MYBOOKS_TASK_CLASSES.VENDOR_ENRICH, description: 'Merchant/vendor enrichment lookups', requires: { json_schema: true }, defaultMaxTokens: 1024 },
          { key: MYBOOKS_TASK_CLASSES.CHAT, description: 'Bookkeeping chat assistant', requires: {}, defaultMaxTokens: 2048 },
          { key: MYBOOKS_TASK_CLASSES.REPORT_NARRATIVE, description: 'Client-facing report narration', requires: {}, defaultMaxTokens: 1024 },
        ],
      });
      log('info', 'task classes registered');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= maxAttempts) {
        log('error', `task-class registration failed after ${attempt} attempts: ${message}; AI features fail closed until the router is reachable`);
        return;
      }
      const delayMs = Math.min(60_000, 2_000 * 2 ** (attempt - 1));
      log('warn', `registration attempt ${attempt} failed (${message}); retrying in ${Math.round(delayMs / 1000)}s`);
      const timer = setTimeout(() => void tryRegister(), delayMs);
      timer.unref?.();
    }
  };

  void tryRegister();
}
