// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, isNull } from 'drizzle-orm';
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

// The task types whose system prompt an admin may override, with the
// human label + the per-function key they map to. Drives the admin
// prompt-editor UI and validates the defaults endpoint.
export const CUSTOMIZABLE_TASK_TYPES = [
  { taskType: 'categorize', label: 'Categorization' },
  { taskType: 'ocr_receipt', label: 'OCR — Receipts' },
  { taskType: 'ocr_invoice', label: 'OCR — Bills / Invoices' },
  { taskType: 'ocr_statement', label: 'OCR — Bank Statements' },
  { taskType: 'classify_document', label: 'Document Classification' },
  { taskType: 'chat', label: 'Chat Assistant' },
] as const;

/**
 * Runtime consumption path for per-function prompt customization
 * (Mechanism B). Returns the admin-authored system prompt for a task,
 * or null when none exists — in which case the caller MUST fall back to
 * its built-in hardcoded prompt. Only `is_custom = true` rows are
 * returned, so system-seeded defaults never silently change behaviour.
 * Provider-specific override wins over the generic (provider = NULL) one.
 */
export async function getCustomSystemPrompt(taskType: string, provider?: string | null): Promise<string | null> {
  if (provider) {
    const specific = await db.query.aiPromptTemplates.findFirst({
      where: and(
        eq(aiPromptTemplates.taskType, taskType),
        eq(aiPromptTemplates.provider, provider),
        eq(aiPromptTemplates.isActive, true),
        eq(aiPromptTemplates.isCustom, true),
      ),
    });
    if (specific) return specific.systemPrompt;
  }
  // Generic = provider-agnostic (provider IS NULL). A provider-specific
  // override must not leak to other providers, so we don't match any-provider
  // here.
  const generic = await db.query.aiPromptTemplates.findFirst({
    where: and(
      eq(aiPromptTemplates.taskType, taskType),
      isNull(aiPromptTemplates.provider),
      eq(aiPromptTemplates.isActive, true),
      eq(aiPromptTemplates.isCustom, true),
    ),
  });
  return generic ? generic.systemPrompt : null;
}

export async function listPrompts() {
  return db.select().from(aiPromptTemplates).orderBy(aiPromptTemplates.taskType, aiPromptTemplates.version);
}

// outputSchema is a JSON-Schema-style descriptor for the LLM response.
// Shape varies by provider and template; storing the JSONB blob as-is
// is intentional. `unknown` over `any` keeps consumers honest.
export async function createPrompt(input: { taskType: string; provider?: string | null; systemPrompt: string; userPromptTemplate: string; outputSchema?: unknown; notes?: string }) {
  // Get next version. The `undefined` cast here suppresses a Drizzle
  // overload that can't pick the correct condition when `provider` is
  // missing — semantically still correct: no provider filter means
  // match-any.
  const existing = await db.select().from(aiPromptTemplates)
    .where(and(eq(aiPromptTemplates.taskType, input.taskType), input.provider ? eq(aiPromptTemplates.provider, input.provider) : undefined));
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
    // Admin-authored via the API → consumed at runtime.
    isCustom: true,
  }).returning();

  return prompt;
}

export async function updatePrompt(id: string, input: { systemPrompt?: string; userPromptTemplate?: string; outputSchema?: any; notes?: string; isActive?: boolean }) {
  const updates: any = { updatedAt: new Date() };
  // Editing prompt content promotes a (possibly seeded) row to a custom
  // one so the runtime starts consuming it.
  if (input.systemPrompt !== undefined) { updates.systemPrompt = input.systemPrompt; updates.isCustom = true; }
  if (input.userPromptTemplate !== undefined) { updates.userPromptTemplate = input.userPromptTemplate; updates.isCustom = true; }
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
  {
    taskType: 'ocr_invoice',
    systemPrompt: 'You are a vendor invoice / bill OCR assistant. Extract the structured data from the bill. Return valid JSON only.',
    userPromptTemplate: 'Extract the bill details.\n\nReturn JSON: { "vendor": "...", "vendor_invoice_number": "...", "bill_date": "YYYY-MM-DD", "due_date": "YYYY-MM-DD", "payment_terms": "net_30", "subtotal": "0.00", "tax": "0.00", "total": "0.00", "line_items": [{"description": "...", "amount": "0.00", "quantity": "1"}], "confidence": 0.0-1.0 }',
  },
  {
    taskType: 'chat',
    systemPrompt: 'You are a helpful assistant for Vibe MyBooks, a bookkeeping app. Answer questions about using the app and general accounting concepts. Be concise and accurate; never invent figures from the user’s books.',
    userPromptTemplate: '{{message}}',
  },
];

export async function seedDefaultPrompts() {
  // Source each default SYSTEM prompt from the SAME constant the task service
  // falls back to at runtime, so the editor shows exactly what the app uses
  // (CPA-grade; the bank-statement one is ported from Vibe-Transaction-Convertor).
  // Dynamic import avoids a static cycle — the task services statically import
  // THIS module for getCustomSystemPrompt; by seed time (startup) they're loaded.
  const runtimeSystemPrompts: Record<string, string> = {};
  try {
    const [cat, rec, bill, cls, stmt] = await Promise.all([
      import('./ai-categorization.service.js'),
      import('./ai-receipt-ocr.service.js'),
      import('./ai-bill-ocr.service.js'),
      import('./ai-document-classifier.service.js'),
      import('./ai-statement-parser.service.js'),
    ]);
    runtimeSystemPrompts['categorize'] = cat.categorizeSystemPrompt;
    runtimeSystemPrompts['ocr_receipt'] = rec.receiptSystemPrompt;
    runtimeSystemPrompts['ocr_invoice'] = bill.billSystemPrompt;
    runtimeSystemPrompts['classify_document'] = cls.classifierSystemPrompt;
    runtimeSystemPrompts['ocr_statement'] = stmt.stage2SystemPrompt;
  } catch {
    // If a module can't be loaded, fall back to the literal defaults below.
  }

  for (const prompt of DEFAULT_PROMPTS) {
    const existing = await db.query.aiPromptTemplates.findFirst({
      where: and(eq(aiPromptTemplates.taskType, prompt.taskType), eq(aiPromptTemplates.isActive, true)),
    });
    if (existing) continue; // Don't overwrite user customizations

    await db.insert(aiPromptTemplates).values({
      taskType: prompt.taskType,
      version: 1,
      systemPrompt: runtimeSystemPrompts[prompt.taskType] ?? prompt.systemPrompt,
      userPromptTemplate: prompt.userPromptTemplate,
      isActive: true,
      notes: 'Default prompt',
    });
  }
}
