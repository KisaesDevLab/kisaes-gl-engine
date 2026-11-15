// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Numbers in a Report Builder draft (U-120; ClientLedger Q-A10l, Q-315):
 * the AI never sees, states or computes a number.
 *
 * In: every number in the owner's description is masked before the prompt,
 * in any form: a digit run of any script (NFKC, so fullwidth and other
 * decimal digits fold to ASCII; `\p{N}`), with separators, decimals, an
 * exponent (5e3), a suffix (1.5k, 2 million, 20%), currency symbols or codes
 * on either side ($500, 500€, USD 500), ranges (100-500), split by invisible
 * characters (5<ZWSP>00: format characters are removed first), and English
 * number words used as quantities ("five hundred", "a thousand", "two dozen",
 * "half a million", "fifty bucks", "a grand"). A number that reads as an amount or a
 * limit (a currency, an amount unit, a comparison word before it, "or more"
 * after it, or the far end of such a range) becomes `[AMOUNT]`; any other
 * number becomes `[NUMBER]`. As a last guard every numeric character left is
 * masked too.
 *
 * Out: text the draft keeps (title, captions, total captions, text rows) and
 * a name that did not resolve may hold no digit, no mask marker and no
 * number word (NUMBER_WORDS). "one" counts (over-refusal is the safe side:
 * "One-time customers" is refused). Roman numerals are allowed: they are
 * letters (XII), and the compatibility forms (Ⅻ) fold to letters under
 * NFKC. Ordinals (first, second) and "quarter" are period words and allowed;
 * "grand" is a number only as "a grand" / "half a grand" or after a number
 * ("Grand total" is allowed). English only.
 */

/** English number words used as quantities; refused in kept model text and masked in the description. */
export const NUMBER_WORDS: readonly string[] = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
  'twenty', 'thirty', 'forty', 'fourty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
  'hundred', 'hundreds', 'thousand', 'thousands', 'million', 'millions', 'billion', 'billions', 'trillion', 'trillions',
  'dozen', 'dozens',
];
const WORD_SET = new Set(NUMBER_WORDS);

/** Units that make a number an amount; masked with it ("five grand", "50 bucks"). Not refused alone ("Grand total"). */
const AMOUNT_UNITS = ['dollars', 'dollar', 'bucks', 'buck', 'grand', 'cents', 'cent', 'usd', 'eur', 'euros', 'euro', 'gbp',
  'pounds', 'cad', 'aud', 'nzd', 'chf', 'jpy', 'yen', 'mxn', 'pesos', 'inr', 'k', 'mm', 'm', 'bn', 'b'];
const CURRENCY_CODES = ['usd', 'us\\$', 'eur', 'gbp', 'cad', 'aud', 'nzd', 'chf', 'jpy', 'mxn', 'inr', 'cny'];
const OTHER_UNITS = ['%', 'percent', 'pct', 'per cent'];

/** The marker words the prompt uses; refused in kept model text. */
export const MASK_AMOUNT = '[AMOUNT]';
export const MASK_NUMBER = '[NUMBER]';
const MASK_TOKEN_RE = /\[\s*(?:amount|number)\s*\]/i;

/** Letter-or-digit boundaries (JS \b is ASCII-only). */
const B0 = String.raw`(?<![\p{L}\p{N}])`;
const B1 = String.raw`(?![\p{L}\p{N}])`;
const alt = (l: readonly string[]) => l.join('|');

const WORD = `(?:${alt(NUMBER_WORDS)})${B1}`;
const JOIN = String.raw`(?:\s*-\s*|\s+and\s+|\s+a\s+|\s+)`;
/** A run of number words: "five hundred", "twenty-five", "a thousand", "half a million", "one hundred and fifty". */
const WORD_RUN = String.raw`${B0}(?:half\s+(?:a\s+)?|a\s+)?${WORD}(?:${JOIN}${WORD})*`;
/** A digit run in any format: 1,250.75 · 1 000 · 5e3 · .5 · 1'000. */
const DIGIT_RUN = String.raw`(?:\p{N}|[.,](?=\p{N}))(?:\p{N}|[.,'’_](?=\p{N})|\s(?=\p{N}{3}(?!\p{N}))|e[+-]?(?=\p{N}))*`;
const PREFIX = String.raw`(?:\p{Sc}\s*|${B0}(?:${alt(CURRENCY_CODES)})\s*)?`;
const SUFFIX = String.raw`(?:\s*(?:${alt([...AMOUNT_UNITS, ...OTHER_UNITS.slice(1)])})${B1}|\s*%|\s*\p{Sc})?`;
/** "a grand", "half a grand": slang for a thousand dollars ("grand" alone is not a number: "Grand total"). */
const A_GRAND = String.raw`${B0}(?:half\s+)?a\s+grand${B1}(?!\s+total)`;
const TOKEN_RE = new RegExp(`${PREFIX}(?:${DIGIT_RUN}|${A_GRAND}|${WORD_RUN})${SUFFIX}`, 'giu');
const A_GRAND_RE = new RegExp(A_GRAND, 'iu');

/** The token itself says amount: a currency sign or code, or an amount unit. */
const AMOUNT_IN_TOKEN = new RegExp(String.raw`\p{Sc}|(?<!\p{L})(?:${alt([...CURRENCY_CODES, ...AMOUNT_UNITS])})(?!\p{L})`, 'iu');
const COMPARISON = [
  'over', 'under', 'above', 'below', 'more than', 'less than', 'fewer than', 'at least', 'at most', 'greater than', 'exceeding',
  'exceeds', 'exceed', 'bigger than', 'larger than', 'smaller than', 'higher than', 'lower than', 'minimum of', 'minimum',
  'maximum of', 'maximum', 'min', 'max', 'up to', 'between', 'of', 'totalling', 'totaling', 'totals', 'total', 'total of',
  'worth', 'costing', 'cost', 'costs', 'equal to', 'equals', 'equal', 'amount', 'amounts', 'amounting to', 'limit', 'limit of',
  'threshold', 'threshold of', 'value', 'value of', 'balance', 'balance of', 'price', 'price of', 'sum', 'sum of',
];
/** A comparison word or sign right before the number: an amount limit. */
const AMOUNT_BEFORE = new RegExp(String.raw`(?:${B0}(?:${alt(COMPARISON)})|[<>=≥≤])\s*$`, 'iu');
/** "500 or more", "500 and up", "500+", "500 plus". */
const AMOUNT_AFTER = new RegExp(
  String.raw`^\s*(?:\+|plus${B1}|or (?:more|less|above|below|over|under|higher|lower|greater|fewer)${B1}|and (?:up|above|over|under|below|higher|lower)${B1})`,
  'iu',
);
/** Between two numbers of a range: "100 to 500", "100-500", "100 and 500". */
const RANGE_GAP = /^\s*(?:and|to|or|through|thru|-|–|—)\s*$/iu;

/** NFKC, then without format characters (zero-width spaces, joiners, bidi marks): what every check reads. */
export function prepare(s: string): string {
  return s.normalize('NFKC').replace(/\p{Cf}/gu, '');
}

export interface MaskedNumbers {
  /** The text with every number replaced by [AMOUNT] or [NUMBER]. */
  text: string;
  /** Something was masked. */
  masked: boolean;
  /** Something masked reads as an amount or a limit. */
  amountLike: boolean;
}

/** Masks every number in `text` (prepared first). See the file comment. */
export function maskNumbers(text: string): MaskedNumbers {
  const s = prepare(text);
  let out = '';
  let last = 0;
  let prevAmountEnd = -1;
  let masked = false;
  let amountLike = false;
  for (const m of s.matchAll(TOKEN_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    const before = s.slice(Math.max(0, start - 40), start);
    const amount = AMOUNT_IN_TOKEN.test(m[0]) || AMOUNT_BEFORE.test(before) || AMOUNT_AFTER.test(s.slice(end, end + 40))
      || (prevAmountEnd >= 0 && RANGE_GAP.test(s.slice(prevAmountEnd, start)));
    out += s.slice(last, start) + (amount ? MASK_AMOUNT : MASK_NUMBER);
    last = end;
    masked = true;
    if (amount) { amountLike = true; prevAmountEnd = end; }
  }
  out += s.slice(last);
  // The last guard: no numeric character survives, whatever the patterns above missed.
  if (/\p{N}/u.test(out)) { out = out.replace(/\p{N}+/gu, MASK_NUMBER); masked = true; }
  return { text: out, masked, amountLike };
}

/** The words of `s` (prepared, lowercased, split on anything not a letter). */
const wordsOf = (s: string) => prepare(s).toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);

/** `s` holds an English number word (NUMBER_WORDS), hyphenated or not. */
export function hasNumberWord(s: string): boolean {
  return wordsOf(s).some((w) => WORD_SET.has(w)) || A_GRAND_RE.test(prepare(s));
}

/** `s` holds a mask marker ([AMOUNT], [NUMBER]) the model copied from the prompt. */
export function hasMaskToken(s: string): boolean {
  return MASK_TOKEN_RE.test(prepare(s));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `phrase` is a whole word or phrase of `text` (both compared normalized), never a part of a word. */
export function containsPhrase(text: string, phrase: string): boolean {
  if (!phrase) return false;
  return new RegExp(`${B0}${escapeRe(phrase)}${B1}`, 'u').test(text);
}
