// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
/**
 * VENDORED from KisaesDevLab/Vibe-AI-Router packages/sdk @ sdk-v0.2.0 — DO NOT EDIT HERE.
 * The SDK is deliberately a single dependency-free file (global fetch only) precisely so
 * npm-workspace repos can vendor it; pnpm repos install it as a git dependency instead
 * (Q-065). To update: copy packages/sdk/src/index.ts over this file, keep this header,
 * bump the tag reference.
 */
/**
 * @kisaes/vibe-ai-client — the ONLY way Vibe apps talk to AI (12.1).
 * Zero provider SDKs inside; speaks the router's OpenAI-compatible wire contract
 * (docs/integration.md). Dependency-free: global fetch only.
 */

// ── error taxonomy (mirrors the router; frozen contract) ────────────────────

export type VibeAiErrorCode =
  | 'invalid_request'
  | 'auth_error'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'context_exceeded'
  | 'content_filtered'
  | 'policy_blocked'
  | 'scrubber_blocked'
  | 'capability_missing'
  | 'budget_exceeded'
  | 'unknown';

export class VibeAiError extends Error {
  readonly code: VibeAiErrorCode;
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;
  readonly detail: Record<string, unknown> | undefined;

  constructor(
    code: VibeAiErrorCode,
    status: number,
    message: string,
    retryAfterSeconds?: number,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'VibeAiError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.detail = detail;
  }

  get retryable(): boolean {
    return this.code === 'rate_limited' || this.code === 'provider_unavailable';
  }
}

// ── message / result shapes (OpenAI wire, typed) ────────────────────────────

export interface TextPart {
  type: 'text';
  text: string;
}
export interface ImagePart {
  type: 'image_url';
  image_url: { url: string };
}
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | (TextPart | ImagePart)[] | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface ToolDef {
  name: string;
  description?: string;
  /** JSON Schema for the arguments */
  parameters?: unknown;
}

export interface RequestOptions {
  /** advisory — policy decides what actually serves */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  tools?: ToolDef[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  responseFormat?:
    | { type: 'text' }
    | { type: 'json_object' }
    | { type: 'json_schema'; name: string; schema: unknown; strict?: boolean };
  /** attribution → ledger dimensions + role gating + per-user budgets */
  userId?: string;
  userRole?: 'admin' | 'partner' | 'staff';
  engagementRef?: string;
  clientRef?: string;
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface CompletionResult {
  content: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  finishReason: string;
  model: string;
  usage: Usage;
  requestId: string;
  /** soft budget warnings, e.g. ["firm:87%"] */
  budgetWarnings: string[];
}

export interface StreamEvent {
  delta?: string;
  toolCallDelta?: { index: number; id?: string; name?: string; argumentsDelta?: string };
  finishReason?: string;
  usage?: Usage;
}

export interface TaskClassDeclaration {
  key: string;
  description?: string;
  requires?: { tools?: boolean; json_schema?: boolean; vision?: boolean; caching?: boolean };
  defaultMaxTokens?: number;
}

export interface VibeAiClientOptions {
  /** e.g. http://vibe-ai-router:8220 (internal docker DNS on the appliance) */
  baseUrl: string;
  /** app token minted at provisioning — never a provider key */
  token: string;
  fetch?: typeof fetch;
}

// ── client ───────────────────────────────────────────────────────────────────

interface WireCompletion {
  model: string;
  choices: {
    message: {
      content: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
    finish_reason: string;
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } };
}

function toUsage(u: WireCompletion['usage']): Usage {
  return {
    promptTokens: u?.prompt_tokens ?? 0,
    completionTokens: u?.completion_tokens ?? 0,
    cachedTokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

export class VibeAiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: VibeAiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? fetch;
  }

  private headers(taskClass: string, options?: RequestOptions): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.token}`,
      'x-vibe-task-class': taskClass,
      ...(options?.userId ? { 'x-vibe-user': options.userId } : {}),
      ...(options?.userRole ? { 'x-vibe-user-role': options.userRole } : {}),
      ...(options?.engagementRef ? { 'x-vibe-engagement': options.engagementRef } : {}),
      ...(options?.clientRef ? { 'x-vibe-client': options.clientRef } : {}),
    };
  }

  private body(messages: ChatMessage[], options: RequestOptions | undefined, stream: boolean): string {
    return JSON.stringify({
      messages,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.topP !== undefined ? { top_p: options.topP } : {}),
      ...(options?.stop ? { stop: options.stop } : {}),
      ...(options?.tools
        ? {
            tools: options.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
      ...(options?.toolChoice
        ? {
            tool_choice:
              typeof options.toolChoice === 'string'
                ? options.toolChoice
                : { type: 'function', function: { name: options.toolChoice.name } },
          }
        : {}),
      ...(options?.responseFormat
        ? {
            response_format:
              options.responseFormat.type === 'json_schema'
                ? {
                    type: 'json_schema',
                    json_schema: {
                      name: options.responseFormat.name,
                      schema: options.responseFormat.schema,
                      ...(options.responseFormat.strict !== undefined
                        ? { strict: options.responseFormat.strict }
                        : {}),
                    },
                  }
                : { type: options.responseFormat.type },
          }
        : {}),
    });
  }

  private async throwFor(res: Response): Promise<never> {
    let code: VibeAiErrorCode = 'unknown';
    let message = `HTTP ${res.status}`;
    let detail: Record<string, unknown> | undefined;
    try {
      const body = (await res.json()) as {
        error?: { code?: VibeAiErrorCode; message?: string; detail?: Record<string, unknown> };
      };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
      detail = body.error?.detail;
    } catch {
      /* non-JSON */
    }
    const retryAfter = res.headers.get('retry-after');
    throw new VibeAiError(code, res.status, message, retryAfter ? Number(retryAfter) : undefined, detail);
  }

  /** One-shot completion through the router. */
  async complete(
    taskClass: string,
    messages: ChatMessage[],
    options?: RequestOptions,
  ): Promise<CompletionResult> {
    const res = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(taskClass, options),
      body: this.body(messages, options, false),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    if (!res.ok) await this.throwFor(res);
    const wire = (await res.json()) as WireCompletion;
    const choice = wire.choices[0];
    return {
      content: choice?.message.content ?? '',
      toolCalls: (choice?.message.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })),
      finishReason: choice?.finish_reason ?? 'stop',
      model: wire.model,
      usage: toUsage(wire.usage),
      requestId: res.headers.get('x-request-id') ?? '',
      budgetWarnings: (res.headers.get('x-vibe-budget-warning') ?? '').split(',').filter(Boolean),
    };
  }

  /** Streaming completion; yields deltas, final event carries usage. */
  async *stream(
    taskClass: string,
    messages: ChatMessage[],
    options?: RequestOptions,
  ): AsyncGenerator<StreamEvent> {
    const res = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(taskClass, options),
      body: this.body(messages, options, true),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    if (!res.ok) await this.throwFor(res);
    if (!res.body) throw new VibeAiError('unknown', 502, 'no response body');

    const decoder = new TextDecoder();
    let buffer = '';
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const sep = buffer.search(/\r?\n\r?\n/);
          if (sep === -1) break;
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '');
          for (const line of rawEvent.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') return;
            let parsed: {
              choices?: {
                delta?: {
                  content?: string;
                  tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
                };
                finish_reason?: string | null;
              }[];
              usage?: WireCompletion['usage'];
              error?: { code?: VibeAiErrorCode; message?: string };
            };
            try {
              parsed = JSON.parse(data) as typeof parsed;
            } catch {
              continue;
            }
            if (parsed.error) {
              throw new VibeAiError(parsed.error.code ?? 'unknown', 502, parsed.error.message ?? 'stream error');
            }
            const choice = parsed.choices?.[0];
            if (choice?.delta?.content) yield { delta: choice.delta.content };
            for (const tc of choice?.delta?.tool_calls ?? []) {
              yield {
                toolCallDelta: {
                  index: tc.index,
                  ...(tc.id != null ? { id: tc.id } : {}),
                  ...(tc.function?.name != null ? { name: tc.function.name } : {}),
                  ...(tc.function?.arguments != null ? { argumentsDelta: tc.function.arguments } : {}),
                },
              };
            }
            if (choice?.finish_reason) yield { finishReason: choice.finish_reason };
            if (parsed.usage) yield { usage: toUsage(parsed.usage) };
          }
        }
      }
    } finally {
      reader.releaseLock();
      await res.body.cancel().catch(() => {});
    }
  }

  /**
   * Forced-JSON completion (R3): sends a json_schema response format and returns the parsed
   * object — the SDK equivalent of the "single required tool call" pattern the apps used
   * against Anthropic directly. Tolerates markdown fences around the JSON (local models).
   * Throws VibeAiError('unknown') when the response cannot be parsed against expectations;
   * schema VALIDATION stays the caller's job (apps already have zod at the call sites).
   */
  async completeJson<T>(
    taskClass: string,
    messages: ChatMessage[],
    schema: { name: string; schema: unknown; strict?: boolean },
    options?: Omit<RequestOptions, 'responseFormat'>,
  ): Promise<CompletionResult & { data: T }> {
    const result = await this.complete(taskClass, messages, {
      ...options,
      responseFormat: { type: 'json_schema', ...schema },
    });
    // some providers answer a forced-JSON request with a tool call instead of content
    const raw = result.content.trim() !== '' ? result.content : (result.toolCalls[0]?.arguments ?? '');
    const unfenced = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    try {
      return { ...result, data: JSON.parse(unfenced) as T };
    } catch {
      throw new VibeAiError('unknown', 502, `response for ${schema.name} was not valid JSON`, undefined, {
        requestId: result.requestId,
      });
    }
  }

  /** Declare this app's task classes at startup (12.2). Idempotent; new classes start local_only. */
  async registerTaskClasses(params: {
    app: string;
    version: string;
    classes: TaskClassDeclaration[];
  }): Promise<{ registered: { key: string; created: boolean; sensitivity: string }[] }> {
    const res = await this.fetchFn(`${this.baseUrl}/v1/task-classes/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify({
        app: params.app,
        version: params.version,
        classes: params.classes.map((c) => ({
          key: c.key,
          description: c.description ?? '',
          requires: c.requires ?? {},
          defaultMaxTokens: c.defaultMaxTokens ?? 1024,
        })),
      }),
    });
    if (!res.ok) await this.throwFor(res);
    return res.json() as Promise<{ registered: { key: string; created: boolean; sensitivity: string }[] }>;
  }

  /** Cost-recovery line items for a period (T&B billing feed). */
  async billingUsage(
    period: string,
    clientRef?: string,
  ): Promise<{ period: string; items: Record<string, unknown>[] }> {
    const params = new URLSearchParams({ period });
    if (clientRef) params.set('client_ref', clientRef);
    const res = await this.fetchFn(`${this.baseUrl}/v1/billing/usage?${params}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) await this.throwFor(res);
    return res.json() as Promise<{ period: string; items: Record<string, unknown>[] }>;
  }
}

/** Well-known suite task-class keys (default pack) — apps may declare more. */
export const TASK_CLASSES = {
  TB_CLASSIFICATION: 'tb_classification',
  TB_DOC_EXTRACT: 'tb_doc_extract',
  TB_RESEARCH_SUMMARY: 'tb_research_summary',
  V1099_PAYEE_MATCH: 'v1099_payee_match',
  V1099_W9_EXTRACT: 'v1099_w9_extract',
  V1099_CORRESPONDENCE: 'v1099_correspondence',
  MYBOOKS_TXN_CATEGORIZE: 'mybooks_txn_categorize',
  MYBOOKS_RECEIPT_EXTRACT: 'mybooks_receipt_extract',
  PAYROLL_ANOMALY_REVIEW: 'payroll_anomaly_review',
  TAXRESEARCH_CHAT: 'taxresearch_chat',
  TAXRESEARCH_MEMO_DRAFT: 'taxresearch_memo_draft',
  CONNECT_DOC_SUMMARIZE: 'connect_doc_summarize',
  TXCONV_STATEMENT_PARSE: 'txconv_statement_parse',
  TB_INVOICE_NARRATIVE: 'tb_invoice_narrative',
} as const;
