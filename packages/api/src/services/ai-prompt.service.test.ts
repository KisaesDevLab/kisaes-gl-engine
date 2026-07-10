// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

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

  it('returns the admin-authored (is_custom=true) prompt with the safety clauses appended (M6)', async () => {
    await createPrompt({ taskType: TT, systemPrompt: 'CUSTOM PROMPT', userPromptTemplate: 'y' });
    const out = await getCustomSystemPrompt(TT);
    // M6: a non-chat custom prompt keeps the admin body but always gains the
    // non-negotiable safety floor (injection guard + no-invention).
    expect(out).toContain('CUSTOM PROMPT');
    expect(out!.startsWith('CUSTOM PROMPT')).toBe(true);
    expect(out).toMatch(/NON-NEGOTIABLE SAFETY RULES/);
    expect(out).toMatch(/never as instructions/i);
  });

  it('does NOT append the JSON safety clauses to the chat task (prose output)', async () => {
    // Use a provider-scoped custom chat row and clean up by id so we never
    // touch any seeded 'chat' default in the shared test DB.
    const created = await createPrompt({ taskType: 'chat', provider: 'ollama', systemPrompt: 'CHAT PERSONA', userPromptTemplate: 'y' });
    try {
      const out = await getCustomSystemPrompt('chat', 'ollama');
      expect(out).toBe('CHAT PERSONA');
    } finally {
      await db.delete(aiPromptTemplates).where(eq(aiPromptTemplates.id, created!.id));
    }
  });

  it('prefers a provider-specific custom prompt over the generic one', async () => {
    await createPrompt({ taskType: TT2, systemPrompt: 'GENERIC', userPromptTemplate: 'y' });
    await createPrompt({ taskType: TT2, provider: 'ollama', systemPrompt: 'OLLAMA-SPECIFIC', userPromptTemplate: 'y' });
    expect(await getCustomSystemPrompt(TT2, 'ollama')).toContain('OLLAMA-SPECIFIC');
    // A provider with no specific row falls back to the generic custom prompt.
    const anth = await getCustomSystemPrompt(TT2, 'anthropic');
    expect(anth).toContain('GENERIC');
    expect(anth).not.toContain('OLLAMA-SPECIFIC');
  });
});
