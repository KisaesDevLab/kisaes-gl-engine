// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Validation, consistency, confidence gating, and PII masking for extracted
// pages. The CPA-critical gate: nothing that fails a check is ever marked
// validated/auto-posted — it routes the document to the review queue.
//
// Steps (per page):
//   1. Zod schema validation against the docType result schema.
//   2. PII masking at rest (TIN/SSN, account numbers in descriptions).
//   3. Arithmetic/consistency checks (invoice totals, receipt tax).
//   4. Confidence gating against EXTRACTION_CONFIDENCE_THRESHOLD.
//
// Cross-page consistency (continuous running balance, duplicate transactions
// across page boundaries) is checked once at job finalize, where all pages
// are available — see checkCrossPageConsistency.

import { resultSchemaFor, type DocType } from '@kis-books/shared';

const MONEY_TOLERANCE = 0.01;

export interface ValidateOptions {
  threshold: number;
  /** Set when the model's JSON couldn't be parsed cleanly upstream. */
  parseError?: string | undefined;
}

export interface ValidationResult {
  ok: boolean;
  /** PII-masked, schema-conformant payload to persist. */
  payload: unknown;
  pageConfidence: number;
  /** Min of page + per-row confidence — stored on extracted_records. */
  minConfidence: number;
  /** Why the page was flagged (empty when ok). */
  reasons: string[];
}

// ── PII masking ───────────────────────────────────────────────────────────

function maskTin(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return (value as string) ?? null;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) return value;
  return `***-**-${digits.slice(-4)}`;
}

/** Mask runs of 6+ digits (account/routing/card numbers) keeping last 4. */
function maskAccountNumbers(text: unknown): unknown {
  if (typeof text !== 'string') return text;
  return text.replace(/\d{6,}/g, (m) => `****${m.slice(-4)}`);
}

function maskPiiAtRest(docType: DocType, data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  if (docType === 'w2') {
    out['employee_tin_masked'] = maskTin(out['employee_tin_masked']);
  } else if (docType === '1099') {
    out['recipient_tin_masked'] = maskTin(out['recipient_tin_masked']);
  } else if (docType === 'bank_statement') {
    const txns = Array.isArray(out['transactions']) ? (out['transactions'] as Record<string, unknown>[]) : [];
    out['transactions'] = txns.map((t) => ({ ...t, description: maskAccountNumbers(t['description']) }));
  }
  return out;
}

// ── Arithmetic / per-page consistency ─────────────────────────────────────

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function arithmeticChecks(docType: DocType, data: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  if (docType === 'invoice') {
    const subtotal = num(data['subtotal']);
    const tax = num(data['tax']);
    const total = num(data['total']);
    if (subtotal !== null && tax !== null && total !== null) {
      if (Math.abs(subtotal + tax - total) > MONEY_TOLERANCE) reasons.push('invoice_total_mismatch');
    }
    const lines = Array.isArray(data['line_items']) ? (data['line_items'] as Record<string, unknown>[]) : [];
    if (subtotal !== null && lines.length > 0) {
      const sum = lines.reduce((acc, l) => acc + (num(l['amount']) ?? 0), 0);
      if (Math.abs(sum - subtotal) > MONEY_TOLERANCE) reasons.push('invoice_lineitems_mismatch');
    }
  } else if (docType === 'receipt') {
    const tax = num(data['tax']);
    const total = num(data['total']);
    if (tax !== null && total !== null && tax > total + MONEY_TOLERANCE) reasons.push('receipt_tax_exceeds_total');
  }
  return reasons;
}

function collectRowConfidences(docType: DocType, data: Record<string, unknown>): number[] {
  if (docType === 'bank_statement') {
    const txns = Array.isArray(data['transactions']) ? (data['transactions'] as Record<string, unknown>[]) : [];
    return txns.map((t) => num(t['confidence'])).filter((c): c is number => c !== null);
  }
  const c = num(data['confidence']);
  return c !== null ? [c] : [];
}

/**
 * Validate one extracted page. Never throws — a parse failure or any failed
 * check returns `ok: false` with reasons so the caller routes to review.
 */
export function validateExtractedPage(
  docType: DocType,
  raw: unknown,
  opts: ValidateOptions,
): ValidationResult {
  const parsed = resultSchemaFor(docType).safeParse(raw);
  if (!parsed.success) {
    return { ok: false, payload: raw ?? null, pageConfidence: 0, minConfidence: 0, reasons: ['schema_parse_failed'] };
  }

  const data = maskPiiAtRest(docType, parsed.data as Record<string, unknown>);
  const reasons: string[] = [];
  if (opts.parseError) reasons.push('model_parse_warning');
  reasons.push(...arithmeticChecks(docType, data));

  const pageConfidence = num(data['page_confidence']) ?? 0;
  const rowConfs = collectRowConfidences(docType, data);
  const minConfidence = Math.min(pageConfidence, ...(rowConfs.length ? rowConfs : [pageConfidence]));

  if (pageConfidence < opts.threshold) reasons.push('low_page_confidence');
  if (rowConfs.some((c) => c < opts.threshold)) reasons.push('low_row_confidence');

  return { ok: reasons.length === 0, payload: data, pageConfidence, minConfidence, reasons };
}

/**
 * Cross-page consistency, run once at finalize when all page payloads are
 * available. For bank statements: flags duplicate transactions spanning page
 * boundaries and breaks in the running-balance chain.
 */
export function checkCrossPageConsistency(docType: DocType, payloads: unknown[]): string[] {
  const reasons: string[] = [];
  if (docType !== 'bank_statement') return reasons;

  const allTxns = payloads.flatMap((p) => {
    const t = (p as Record<string, unknown> | null)?.['transactions'];
    return Array.isArray(t) ? (t as Record<string, unknown>[]) : [];
  });

  // Duplicate transaction across page boundaries.
  const seen = new Map<string, number>();
  for (const t of allTxns) {
    const key = `${t['date']}|${t['description']}|${t['amount']}|${t['type']}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  if ([...seen.values()].some((c) => c > 1)) reasons.push('bank_duplicate_txn_across_pages');

  // Running-balance continuity, where balances are present.
  const withBal = allTxns.filter(
    (t) => num(t['balance']) !== null && num(t['amount']) !== null && (t['type'] === 'debit' || t['type'] === 'credit'),
  );
  for (let i = 1; i < withBal.length; i += 1) {
    const prev = withBal[i - 1]!;
    const cur = withBal[i]!;
    const amount = num(cur['amount'])!;
    const delta = cur['type'] === 'credit' ? amount : -amount;
    if (Math.abs((num(prev['balance'])! + delta) - num(cur['balance'])!) > MONEY_TOLERANCE) {
      reasons.push('bank_running_balance_break');
      break;
    }
  }

  // Statement-level reconciliation: opening + net(transactions) == closing.
  // The strongest single correctness signal — a wrong/missed transaction
  // makes the books not balance. Only runs when the model captured both
  // header balances (first non-null opening, last non-null closing across
  // pages); skipped otherwise so statements without visible headers aren't
  // falsely flagged.
  const pages = payloads.filter((p): p is Record<string, unknown> => !!p && typeof p === 'object');
  const opening = pages.map((p) => num(p['opening_balance'])).find((v) => v !== null) ?? null;
  const closing = [...pages].reverse().map((p) => num(p['closing_balance'])).find((v) => v !== null) ?? null;
  if (opening !== null && closing !== null) {
    const net = allTxns.reduce((acc, t) => {
      const amount = num(t['amount']);
      if (amount === null || (t['type'] !== 'debit' && t['type'] !== 'credit')) return acc;
      return acc + (t['type'] === 'credit' ? amount : -amount);
    }, 0);
    if (Math.abs(opening + net - closing) > MONEY_TOLERANCE) reasons.push('bank_opening_closing_mismatch');
  }
  return reasons;
}
