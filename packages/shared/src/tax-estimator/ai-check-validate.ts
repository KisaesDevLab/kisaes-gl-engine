// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Server-side validation of an AI parameter check (OPEN-QUESTIONS Q48). The model's answer is
// never trusted: this module re-derives the verdict from what the web tools actually returned.
//
//   1. a model "unconfirmed" stays unconfirmed (nothing to check);
//   2. the source URL must be http(s), on the trusted list for the jurisdiction, and one the
//      search / fetch tools actually returned during THIS call;
//   3. the quote must appear (whitespace-, quote- and dash-normalized) in text the tools
//      returned for that URL: fetched page text, text extracted from a fetched PDF, or the
//      server-produced `cited_text` of a citation (web search results arrive encrypted, so for a
//      search-only answer the citations are the only readable retrieved text);
//   4. the source must apply to the checked tax year, unless it is the statute / regulation
//      itself and the value is not inflation-indexed;
//   5. the found value must parse in the parameter's type (the registry validator decides);
//   6. for scalar amounts, rates and counts the quote must actually state the found value;
//   7. the SERVER decides matches vs differs by comparing the parsed value with the stored one:
//      exact for money, dates, lists and objects; numbers are compared after removing binary
//      float noise only (1e-9 relative) — no substantive tolerance for any unit.
// Any failure of 2–6 downgrades the result to `unconfirmed` with the reason in `notes`.
//
// Pure (no IO) so it is unit-tested directly; the API service feeds it the response blocks.
import { AI_CHECK_STATUTORY_SOURCE_KINDS, type AiCheckModelAnswer } from '../schemas/tax-estimator-ai-check.js';
import { isUrlAllowed, urlHost } from './ai-check-sources.js';

/** Text the web tools returned during the call. `url` is null for a document citation whose page is not identified. */
export interface RetrievedText {
  url: string | null;
  text: string;
  origin: 'fetch' | 'pdf' | 'search_citation' | 'document_citation';
}

export interface AiCheckValidationInput {
  /** Registry value type (parameter or state-rule type), e.g. 'money', 'rate', 'bracket_table', 'farmer_rule'. */
  valueType: string;
  /** Registry validator for the key: error message, or null when valid. */
  validateValue: (value: unknown) => string | null;
  storedValue: unknown;
  taxYear: number;
  allowedDomains: readonly string[];
  /** Every URL the search / fetch tools returned. */
  retrievedUrls: readonly string[];
  retrieved: readonly RetrievedText[];
  answer: AiCheckModelAnswer;
}

export interface AiCheckValidationResult {
  verdict: 'matches' | 'differs' | 'unconfirmed';
  foundValue: unknown;
  notes: string[];
}

export const MIN_QUOTE_CHARS = 12;
const NUMERIC_TYPES = new Set(['money', 'rate', 'int']);
const STRING_TYPES = new Set(['date', 'month_day', 'enum']);

/** Lower-case, NFKC, straight quotes / dashes, no soft hyphens, single spaces. */
export function normalizeQuoteText(s: string): string {
  return s.normalize('NFKC')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/­/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** normalizeQuoteText without any whitespace or markdown table / emphasis marks (PDF and HTML-to-text layouts break lines anywhere). */
function compact(s: string): string {
  return normalizeQuoteText(s).replace(/[\s*_|#>`]/g, '');
}

/** URL identity for "was this page retrieved": host without www., path without trailing slash, query kept, no fragment / scheme. */
export function canonicalUrl(url: string): string | null {
  const host = urlHost(url);
  if (!host) return null;
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, '') || '';
  return `${host.replace(/^www\./, '')}${path}${u.search}`;
}

/** True when `quote` occurs in `text` (normalized, then whitespace-free as a fallback). */
export function quoteAppearsIn(quote: string, text: string): boolean {
  const q = normalizeQuoteText(quote);
  if (q === '') return false;
  if (normalizeQuoteText(text).includes(q)) return true;
  const cq = compact(quote);
  return cq.length > 0 && compact(text).includes(cq);
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const tidy = (n: number) => Number(n.toPrecision(12));

function lenientNumber(raw: string, valueType: string): number | null {
  const s = raw.trim().replace(/[$,\s]/g, '').replace(/^usd/i, '');
  const pct = /^(-?\d+(?:\.\d+)?)(%|percent)$/i.exec(s);
  if (pct) return valueType === 'rate' ? tidy(Number(pct[1]) / 100) : null;
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Parse the model's foundValue (a JSON string in the stored shape; scalars leniently). undefined = unparseable. */
export function parseFoundValue(raw: unknown, valueType: string): unknown {
  if (raw === null || raw === undefined) return undefined;
  let v: unknown = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '') return undefined;
    try { v = JSON.parse(t); } catch { v = t; }
  }
  if (NUMERIC_TYPES.has(valueType) && typeof v === 'string') {
    const n = lenientNumber(v, valueType);
    return n === null ? undefined : n;
  }
  if (valueType === 'bool' && typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true' || t === 'yes') return true;
    if (t === 'false' || t === 'no') return false;
    return undefined;
  }
  if (STRING_TYPES.has(valueType) && typeof v === 'string') return v.trim();
  return v;
}

/** Deep equality; numbers equal when they differ by binary float noise only (1e-9 relative). Object key order ignored. */
export function aiValuesEqual(a: unknown, b: unknown): boolean {
  if (isNum(a) && isNum(b)) return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => aiValuesEqual(x, b[i]));
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  return ak.length === bk.length && ak.every((k) => k in bo && aiValuesEqual(ao[k], bo[k]));
}

/**
 * Q53: the part of a structured value the law states — the modelling annotations `note` and
 * `simplified` are dropped (at any depth), so an AI-found bracket table / standard deduction /
 * capital gains rule is compared on its figures only. Arrays of objects keep their order.
 */
export function aiComparableValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(aiComparableValue);
  if (v === null || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === 'note' || k === 'simplified') continue;
    out[k] = aiComparableValue(x);
  }
  return out;
}

/** The textual forms a quote may use for a scalar value (compact, lower-case). Empty = no check for this type. */
function valueForms(value: unknown, valueType: string): string[] {
  if (!isNum(value)) return [];
  if (valueType === 'money' || valueType === 'int') {
    const whole = Number.isInteger(value);
    const forms = new Set<string>([String(value)]);
    forms.add(value.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }));
    if (whole) forms.add(value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    return [...forms].map((f) => f.toLowerCase());
  }
  if (valueType === 'rate') {
    if (value === 0) return [];
    const pct = tidy(value * 100);
    const p = String(pct);
    return [`${p}%`, `${p}percent`, `${p}per cent`.replace(/\s/g, ''), String(value), String(value).replace(/^0\./, '.')];
  }
  return [];
}

function quoteStatesValue(quote: string, value: unknown, valueType: string): boolean | null {
  const forms = valueForms(value, valueType);
  if (forms.length === 0) return null;
  const q = compact(quote);
  return forms.some((f) => {
    const idx = q.indexOf(f);
    if (idx < 0) return false;
    // "6.2%" must not match inside "16.2%" / "176,1000": the neighbouring characters may not be digits.
    const before = q[idx - 1];
    const after = q[idx + f.length];
    return !(before && /[\d.]/.test(before)) && !(after && /\d/.test(after));
  });
}

export function validateAiCheck(input: AiCheckValidationInput): AiCheckValidationResult {
  const { answer } = input;
  const notes: string[] = [];
  const unconfirmed = (why: string): AiCheckValidationResult => ({ verdict: 'unconfirmed', foundValue: null, notes: [...notes, why] });

  if (answer.verdict === 'unconfirmed') return { verdict: 'unconfirmed', foundValue: null, notes };

  // 2. source URL on the trusted list and actually retrieved.
  const url = answer.sourceUrl ?? null;
  if (!url) return unconfirmed('No source URL was given.');
  const canon = canonicalUrl(url);
  if (!canon) return unconfirmed(`Source URL '${url}' is not a valid http(s) URL.`);
  if (!isUrlAllowed(url, input.allowedDomains)) return unconfirmed(`Source ${urlHost(url)} is not on the trusted-source list for this jurisdiction.`);
  const retrievedCanon = new Set(input.retrievedUrls.map(canonicalUrl).filter((c): c is string => !!c));
  if (!retrievedCanon.has(canon)) return unconfirmed('The source URL was not retrieved by web search or fetch during this check.');

  // 3. quote present in text retrieved for that URL.
  const quote = answer.quote ?? null;
  if (!quote || normalizeQuoteText(quote).length < MIN_QUOTE_CHARS) return unconfirmed('No verbatim quote of the passage was given.');
  const candidates = input.retrieved.filter((r) => r.url === null || canonicalUrl(r.url) === canon);
  if (!candidates.some((r) => quoteAppearsIn(quote, r.text))) {
    return unconfirmed(input.retrieved.some((r) => quoteAppearsIn(quote, r.text))
      ? 'Quote found in retrieved text, but not from the cited source URL.'
      : 'Quote not found in retrieved source text.');
  }

  // 4. tax year of the source.
  const statutory = !!answer.sourceKind && AI_CHECK_STATUTORY_SOURCE_KINDS.includes(answer.sourceKind);
  const srcYear = answer.sourceTaxYear ?? null;
  if (srcYear === null) {
    if (!statutory) return unconfirmed('The source does not state the tax year it applies to.');
    notes.push('Statutory source with no tax year; accepted as current law.');
  } else if (srcYear !== input.taxYear) {
    if (!(statutory && answer.inflationIndexed === false)) {
      return unconfirmed(`The source applies to tax year ${srcYear}, not ${input.taxYear}.`);
    }
    notes.push(`Source year ${srcYear} accepted: statutory text for a value that is not inflation-indexed.`);
  }

  // 5. parse the found value in the parameter's type.
  let found = parseFoundValue(answer.foundValue, input.valueType);
  if (found === undefined) return unconfirmed('The found value could not be read.');
  // A rate written as a percentage (6.2 for 0.062) is normalized when that is the only difference.
  if (input.valueType === 'rate' && isNum(found) && isNum(input.storedValue)
      && !aiValuesEqual(found, input.storedValue) && aiValuesEqual(tidy(found / 100), input.storedValue)) {
    found = tidy(found / 100);
    notes.push('Found rate was given as a percentage; normalized to a decimal fraction.');
  }
  const err = input.validateValue(found);
  if (err) return unconfirmed(`The found value is not a valid value for this parameter: ${err}.`);

  // 6. the quote must state a scalar value.
  if (quoteStatesValue(quote, found, input.valueType) === false) return unconfirmed('The quote does not state the found value.');

  // 7. the server decides matches vs differs.
  const verdict = aiValuesEqual(aiComparableValue(found), aiComparableValue(input.storedValue)) ? 'matches' : 'differs';
  if (verdict !== answer.verdict) notes.push(`Model said '${answer.verdict}'; the server comparison says '${verdict}'.`);
  return { verdict, foundValue: found, notes };
}
