// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { resolveExtractProvider } from './ai-statement-parser.service.js';

type PublicConfig = Parameters<typeof resolveExtractProvider>[0];
type RawConfig = Parameters<typeof resolveExtractProvider>[1];

const pub = (over: Partial<PublicConfig>): PublicConfig =>
  ({
    statementExtractionProvider: 'local',
    statementExtractionModel: null,
    ocrProvider: null,
    categorizationProvider: null,
    ocrModel: null,
    ...over,
  }) as unknown as PublicConfig;

const raw = (openaiCompatBaseUrl: string | null): RawConfig =>
  ({ openaiCompatBaseUrl }) as unknown as RawConfig;

describe('resolveExtractProvider', () => {
  it('uses Anthropic when selected, with the model override', () => {
    const r = resolveExtractProvider(
      pub({ statementExtractionProvider: 'anthropic', statementExtractionModel: 'claude-sonnet-4-6' }),
      raw(null),
    );
    expect(r).toEqual({ providerName: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  it('reuses an already-configured self-hosted provider for local', () => {
    const r = resolveExtractProvider(
      pub({ statementExtractionProvider: 'local', ocrProvider: 'openai_compat', ocrModel: 'qwen3.5' }),
      raw('http://localhost:11434'),
    );
    expect(r.providerName).toBe('openai_compat');
    expect(r.model).toBe('qwen3.5');
  });

  it('falls back to openai_compat when only a base URL is set', () => {
    const r = resolveExtractProvider(pub({ statementExtractionProvider: 'local' }), raw('http://localhost:8000'));
    expect(r.providerName).toBe('openai_compat');
  });

  it('falls back to ollama when nothing local is configured', () => {
    const r = resolveExtractProvider(pub({ statementExtractionProvider: 'local' }), raw(null));
    expect(r.providerName).toBe('ollama');
  });

  it('prefers the statement model override over ocrModel for local', () => {
    const r = resolveExtractProvider(
      pub({ statementExtractionProvider: 'local', ocrProvider: 'ollama', ocrModel: 'a', statementExtractionModel: 'b' }),
      raw(null),
    );
    expect(r.model).toBe('b');
  });
});
