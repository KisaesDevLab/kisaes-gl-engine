// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { resolveOllamaNative, nativeOllamaBaseUrl } from './index.js';

describe('resolveOllamaNative', () => {
  it('auto-detects Ollama by the :11434 port', () => {
    expect(resolveOllamaNative('http://192.168.68.105:11434/v1', 'auto')).toBe(true);
    expect(resolveOllamaNative('http://192.168.68.105:11434', undefined)).toBe(true);
  });

  it('auto-detects Ollama by an "ollama" hostname', () => {
    expect(resolveOllamaNative('http://ollama/v1', 'auto')).toBe(true);
    expect(resolveOllamaNative('http://my-ollama-box:8080/v1', 'auto')).toBe(true);
  });

  it('auto: non-Ollama backends stay on /v1 (compat)', () => {
    expect(resolveOllamaNative('http://localhost:8000/v1', 'auto')).toBe(false); // vLLM
    expect(resolveOllamaNative('http://llamacpp:8080/v1', 'auto')).toBe(false);
  });

  it('explicit native / compat override the heuristic', () => {
    expect(resolveOllamaNative('http://localhost:8000/v1', 'native')).toBe(true);
    expect(resolveOllamaNative('http://192.168.68.105:11434', 'compat')).toBe(false);
  });
});

describe('nativeOllamaBaseUrl', () => {
  it('strips a trailing /v1 and slashes so /api/chat is appended cleanly', () => {
    expect(nativeOllamaBaseUrl('http://ollama:11434/v1')).toBe('http://ollama:11434');
    expect(nativeOllamaBaseUrl('http://ollama:11434/')).toBe('http://ollama:11434');
    expect(nativeOllamaBaseUrl('http://ollama:11434')).toBe('http://ollama:11434');
  });
});
