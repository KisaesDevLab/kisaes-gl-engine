// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { aiPromptTemplates } from '../db/schema/index.js';

export async function getActivePrompt(taskType: string, provider?: string | null) {
  // First try provider-specific
  if (provider) {
    const specific = await db.query.aiPromptTemplates.findFirst({
      where: and(eq(aiPromptTemplates.taskType, taskType), eq(aiPromptTemplates.provider, provider), eq(aiPromptTemplates.isActive, true)),
    });
    if (specific) return specific;
  }
  // Fall back to generic (provider = NULL)
  return db.query.aiPromptTemplates.findFirst({
    where: and(eq(aiPromptTemplates.taskType, taskType), eq(aiPromptTemplates.isActive, true)),
  });
}

export async function listPrompts() {
  return db.select().from(aiPromptTemplates).orderBy(aiPromptTemplates.taskType, aiPromptTemplates.version);
}

export async function createPrompt(input: { taskType: string; provider?: string | null; systemPrompt: string; userPromptTemplate: string; outputSchema?: any; notes?: string }) {
  // Get next version
  const existing = await db.select().from(aiPromptTemplates)
    .where(and(eq(aiPromptTemplates.taskType, input.taskType), input.provider ? eq(aiPromptTemplates.provider, input.provider) : undefined as any));
  const nextVersion = existing.length > 0 ? Math.max(...existing.map((e) => e.version)) + 1 : 1;

  // Deactivate previous versions
  for (const e of existing) {
    await db.update(aiPromptTemplates).set({ isActive: false }).where(eq(aiPromptTemplates.id, e.id));
  }

  const [prompt] = await db.insert(aiPromptTemplates).values({
    taskType: input.taskType,
    provider: input.provider || null,
    version: nextVersion,
    systemPrompt: input.systemPrompt,
    userPromptTemplate: input.userPromptTemplate,
    outputSchema: input.outputSchema || null,
    notes: input.notes || null,
    isActive: true,
  }).returning();

  return prompt;
}

export async function updatePrompt(id: string, input: { systemPrompt?: string; userPromptTemplate?: string; outputSchema?: any; notes?: string; isActive?: boolean }) {
  const updates: any = { updatedAt: new Date() };
  if (input.systemPrompt !== undefined) updates.systemPrompt = input.systemPrompt;
  if (input.userPromptTemplate !== undefined) updates.userPromptTemplate = input.userPromptTemplate;
  if (input.outputSchema !== undefined) updates.outputSchema = input.outputSchema;
  if (input.notes !== undefined) updates.notes = input.notes;
  if (input.isActive !== undefined) updates.isActive = input.isActive;

  const [updated] = await db.update(aiPromptTemplates).set(updates).where(eq(aiPromptTemplates.id, id)).returning();
  return updated;
}

export async function deletePrompt(id: string) {
  await db.delete(aiPromptTemplates).where(eq(aiPromptTemplates.id, id));
}

export function substituteVariables(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] || '');
}

// ─── Default Prompt Seed ───────────────────────────────────────

const DEFAULT_PROMPTS = [
  {
    taskType: 'categorize',
    systemPrompt: 'You are a bookkeeping assistant. Your job is to categorize bank transactions into the correct Chart of Accounts entry. You must return valid JSON only.',
    userPromptTemplate: 'Transaction: "{{description}}" | Amount: ${{amount}} | Date: {{date}}\n\nChart of Accounts:\n{{coa_list}}\n\nKnown vendors: {{vendor_list}}\n\nReturn JSON: { "account_name": "...", "vendor_name": "...", "memo": "...", "confidence": 0.0-1.0 }',
  },
  {
    taskType: 'ocr_receipt',
    systemPrompt: 'You are a receipt OCR assistant. Extract structured data from the receipt image. Return valid JSON only.',
    userPromptTemplate: 'Extract all information from this receipt.\n\nReturn JSON: { "vendor": "...", "date": "YYYY-MM-DD", "total": "0.00", "tax": "0.00", "line_items": [{"description": "...", "amount": "0.00", "quantity": 1}], "payment_method": "...", "confidence": 0.0-1.0 }',
  },
  {
    taskType: 'ocr_statement',
    systemPrompt: 'You are a bank statement parser. Extract all transactions from the bank statement image/document. Return valid JSON only.',
    userPromptTemplate: 'Extract all transactions from this bank statement. Include date, description, amount, type (debit/credit), and running balance if visible.\n\nReturn JSON: { "transactions": [{"date": "YYYY-MM-DD", "description": "...", "amount": "0.00", "type": "debit"|"credit", "balance": "0.00"}], "account_number_masked": "****1234", "statement_period": {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}, "opening_balance": "0.00", "closing_balance": "0.00", "confidence": 0.0-1.0 }',
  },
  {
    taskType: 'classify_document',
    systemPrompt: 'You are a document classifier. Identify the type of financial document in the image. Return valid JSON only.',
    userPromptTemplate: 'What type of financial document is this? Classify it.\n\nReturn JSON: { "type": "receipt"|"invoice"|"bank_statement"|"tax_form"|"other", "confidence": 0.0-1.0, "reason": "..." }',
  },
];

export async function seedDefaultPrompts() {
  for (const prompt of DEFAULT_PROMPTS) {
    const existing = await db.query.aiPromptTemplates.findFirst({
      where: and(eq(aiPromptTemplates.taskType, prompt.taskType), eq(aiPromptTemplates.isActive, true)),
    });
    if (existing) continue; // Don't overwrite user customizations

    await db.insert(aiPromptTemplates).values({
      taskType: prompt.taskType,
      version: 1,
      systemPrompt: prompt.systemPrompt,
      userPromptTemplate: prompt.userPromptTemplate,
      isActive: true,
      notes: 'Default prompt',
    });
  }
}
