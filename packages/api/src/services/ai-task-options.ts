// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { AiFunctionKey, TaskOptions } from '@kis-books/shared';

// Pure per-function settings resolution (AI_FUNCTION_SETTINGS_PLAN.md).
// Kept dependency-free (no db/env imports) so it's unit-testable and so
// task services can resolve settings without pulling the whole config
// service graph. Re-exported from ai-config.service for ergonomics.
//
// Resolution rule: a per-function override wins; `null`/absent falls back
// to the supplied built-in default (or the global value for exec). This is
// what makes every new setting a no-op when unconfigured.

export interface ResolvedTaskParams {
  maxTokens: number;
  temperature: number;
  thinking?: 'on' | 'off';
}

export interface ResolvedTaskExec {
  timeoutMs?: number;
  fallbackChain: string[];
}

export function resolveTaskParams(
  config: { taskOptions?: TaskOptions },
  fn: AiFunctionKey,
  defaults: { maxTokens: number; temperature: number },
): ResolvedTaskParams {
  const opt = config.taskOptions?.[fn] ?? {};
  return {
    maxTokens: opt.maxTokens ?? defaults.maxTokens,
    temperature: opt.temperature ?? defaults.temperature,
    // Only include `thinking` when explicitly set so providers can tell
    // "unset" (provider default) from an explicit on/off.
    ...(opt.thinking ? { thinking: opt.thinking } : {}),
  };
}

export function resolveTaskExec(
  config: { taskOptions?: TaskOptions; fallbackChain: string[] },
  fn: AiFunctionKey,
): ResolvedTaskExec {
  const opt = config.taskOptions?.[fn] ?? {};
  return {
    ...(opt.timeoutMs ? { timeoutMs: opt.timeoutMs } : {}),
    fallbackChain: opt.fallbackChain && opt.fallbackChain.length > 0 ? opt.fallbackChain : config.fallbackChain,
  };
}
