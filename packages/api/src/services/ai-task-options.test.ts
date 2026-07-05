// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { resolveTaskParams, resolveTaskExec } from './ai-task-options.js';

describe('resolveTaskParams', () => {
  const defaults = { maxTokens: 320, temperature: 0.1 };

  it('falls back to built-in defaults when no override exists', () => {
    expect(resolveTaskParams({ taskOptions: {} }, 'categorization', defaults)).toEqual({
      maxTokens: 320,
      temperature: 0.1,
    });
  });

  it('falls back to defaults when taskOptions is undefined', () => {
    expect(resolveTaskParams({}, 'ocr', defaults)).toEqual({ maxTokens: 320, temperature: 0.1 });
  });

  it('treats null override values as "use default" (no regression)', () => {
    const config = { taskOptions: { categorization: { maxTokens: null, temperature: null, thinking: null } } };
    expect(resolveTaskParams(config, 'categorization', defaults)).toEqual({ maxTokens: 320, temperature: 0.1 });
  });

  it('applies per-function overrides when set', () => {
    const config = { taskOptions: { categorization: { maxTokens: 1024, temperature: 0.5, thinking: 'off' as const } } };
    expect(resolveTaskParams(config, 'categorization', defaults)).toEqual({
      maxTokens: 1024,
      temperature: 0.5,
      thinking: 'off',
    });
  });

  it('only includes thinking when explicitly set', () => {
    const result = resolveTaskParams({ taskOptions: { ocr: { maxTokens: 2048 } } }, 'ocr', defaults);
    expect(result).not.toHaveProperty('thinking');
    expect(result.maxTokens).toBe(2048);
  });

  it('isolates functions — an override on one does not affect another', () => {
    const config = { taskOptions: { ocr: { maxTokens: 4096 } } };
    expect(resolveTaskParams(config, 'categorization', defaults)).toEqual({ maxTokens: 320, temperature: 0.1 });
  });
});

describe('resolveTaskExec', () => {
  const global = ['anthropic', 'openai', 'gemini', 'ollama'];

  it('uses the global fallback chain when no per-function override exists', () => {
    expect(resolveTaskExec({ taskOptions: {}, fallbackChain: global }, 'categorization')).toEqual({
      fallbackChain: global,
      enabled: true,
    });
  });

  it('uses a per-function fallback chain override when non-empty', () => {
    const config = { taskOptions: { categorization: { fallbackChain: ['ollama'] } }, fallbackChain: global };
    expect(resolveTaskExec(config, 'categorization')).toEqual({ fallbackChain: ['ollama'], enabled: true });
  });

  it('ignores an empty per-function fallback chain (falls back to global)', () => {
    const config = { taskOptions: { categorization: { fallbackChain: [] } }, fallbackChain: global };
    expect(resolveTaskExec(config, 'categorization')).toEqual({ fallbackChain: global, enabled: true });
  });

  it('includes timeoutMs only when overridden', () => {
    const withTimeout = resolveTaskExec(
      { taskOptions: { chat: { timeoutMs: 120000 } }, fallbackChain: global },
      'chat',
    );
    expect(withTimeout).toEqual({ timeoutMs: 120000, fallbackChain: global, enabled: true });

    const without = resolveTaskExec({ taskOptions: {}, fallbackChain: global }, 'chat');
    expect(without).not.toHaveProperty('timeoutMs');
  });

  it('resolves the "Enable this function" toggle (default true, null = default, false = disabled)', () => {
    expect(resolveTaskExec({ taskOptions: {}, fallbackChain: global }, 'categorization').enabled).toBe(true);
    expect(
      resolveTaskExec({ taskOptions: { categorization: { enabled: null } }, fallbackChain: global }, 'categorization').enabled,
    ).toBe(true);
    expect(
      resolveTaskExec({ taskOptions: { categorization: { enabled: false } }, fallbackChain: global }, 'categorization').enabled,
    ).toBe(false);
    // Per-function isolation: disabling one function leaves the others on.
    expect(
      resolveTaskExec({ taskOptions: { categorization: { enabled: false } }, fallbackChain: global }, 'chat').enabled,
    ).toBe(true);
  });
});
