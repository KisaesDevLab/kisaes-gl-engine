// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { aiPromptTemplates } from '../db/schema/index.js';
import { getCustomSystemPrompt, createPrompt } from './ai-prompt.service.js';

// Unique taskType per run so this is isolated from any other rows /
// parallel files. All inserts/deletes are scoped to these task types.
const TT = `test_categorize_${randomUUID().slice(0, 8)}`;
const TT2 = `test_ocr_${randomUUID().slice(0, 8)}`;

afterEach(async () => {
  await db.delete(aiPromptTemplates).where(eq(aiPromptTemplates.taskType, TT));
  await db.delete(aiPromptTemplates).where(eq(aiPromptTemplates.taskType, TT2));
});

describe('getCustomSystemPrompt', () => {
  it('returns null when no template exists (caller uses hardcoded default)', async () => {
    expect(await getCustomSystemPrompt(TT)).toBeNull();
  });

  it('ignores a seeded (is_custom=false) row — only admin-authored prompts are consumed', async () => {
    await db.insert(aiPromptTemplates).values({
      taskType: TT,
      version: 1,
      systemPrompt: 'SEEDED DEFAULT — must not be used',
      userPromptTemplate: 'x',
      isActive: true,
      isCustom: false,
    });
    expect(await getCustomSystemPrompt(TT)).toBeNull();
  });

  it('returns the admin-authored (is_custom=true) prompt', async () => {
    await createPrompt({ taskType: TT, systemPrompt: 'CUSTOM PROMPT', userPromptTemplate: 'y' });
    expect(await getCustomSystemPrompt(TT)).toBe('CUSTOM PROMPT');
  });

  it('prefers a provider-specific custom prompt over the generic one', async () => {
    await createPrompt({ taskType: TT2, systemPrompt: 'GENERIC', userPromptTemplate: 'y' });
    await createPrompt({ taskType: TT2, provider: 'ollama', systemPrompt: 'OLLAMA-SPECIFIC', userPromptTemplate: 'y' });
    expect(await getCustomSystemPrompt(TT2, 'ollama')).toBe('OLLAMA-SPECIFIC');
    // A provider with no specific row falls back to the generic custom prompt.
    expect(await getCustomSystemPrompt(TT2, 'anthropic')).toBe('GENERIC');
  });
});
