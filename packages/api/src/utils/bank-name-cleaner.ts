// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Cleans raw bank transaction descriptions into readable payee names.
 * This is the last-resort fallback — runs only when bank rules, categorization
 * history, and AI all fail to produce a clean name.
 */

// Common prefixes that banks add
const STRIP_PREFIXES = [
  /^(POS|CHECKCARD|CHECK CARD|DEBIT CARD|VISA|MC|MASTERCARD)\s+/i,
  /^(POS PURCHASE|PURCHASE|POS DEBIT|DEBIT)\s+/i,
  /^(ACH DEBIT|ACH CREDIT|ACH PMT|ACH PAYMENT|ACH)\s+/i,
  /^(RECURRING PAYMENT|RECURRING|AUTO PAY|AUTOPAY|AUTOMATIC PAYMENT)\s+/i,
  /^(ONLINE PAYMENT|ONLINE PMT|BILL PAYMENT|BILL PAY|BILLPAY)\s+/i,
  /^(WIRE TRANSFER|WIRE|EFT|ELECTRONIC)\s+/i,
  /^(PREAUTHORIZED|PRE-AUTHORIZED|PRE AUTH)\s+/i,
  /^(PENDING|HOLD)\s+/i,
  /^(SQ \*|TST\*|IN \*|SP \*|GH\*|DD\*|PP\*|FS\*)\s*/i,
  /^[A-Z]{2,4}\*\s*/i,  // Generic processor prefix: BH*, SPO*, CKO*, WPY*, etc.
];

// Known merchant name mappings
const MERCHANT_MAP: Record<string, string> = {
  'amzn': 'Amazon',
  'amazon': 'Amazon',
  'amazon.com': 'Amazon',
  'amazon mktpl': 'Amazon',
  'amazon mktpl*': 'Amazon',
  'amzn mktp': 'Amazon',
  'walmart': 'Walmart',
  'wal-mart': 'Walmart',
  'target': 'Target',
  'costco': 'Costco',
  'costco whse': 'Costco',
  'netflix': 'Netflix',
  'netflix.com': 'Netflix',
  'spotify': 'Spotify',
  'hulu': 'Hulu',
  'apple.com/bill': 'Apple',
  'google': 'Google',
  'google workspace': 'Google',
  'uber': 'Uber',
  'uber eats': 'Uber Eats',
  'lyft': 'Lyft',
  'doordash': 'DoorDash',
  'grubhub': 'Grubhub',
  'starbucks': 'Starbucks',
  'mcdonalds': "McDonald's",
  'mcdonald\'s': "McDonald's",
  'venmo': 'Venmo',
  'paypal': 'PayPal',
  'zelle': 'Zelle',
  'chase': 'Chase',
  'att': 'AT&T',
  'at&t': 'AT&T',
  'verizon': 'Verizon',
  't-mobile': 'T-Mobile',
  'comcast': 'Comcast',
  'xfinity': 'Xfinity',
  'spectrum': 'Spectrum',
  'intuit': 'Intuit',
  'fubo': 'Fubo TV',
  'appsumo': 'AppSumo',
  'appsumo.com': 'AppSumo',
  'grammarly': 'Grammarly',
  'right networks': 'Right Networks',
  'accountantsworld': 'AccountantsWorld',
  'optimum': 'Optimum',
  'taxspeaker': 'TaxSpeaker',
  'elevenlabs': 'ElevenLabs',
  'elevenlabs.io': 'ElevenLabs',
  'tax1099': 'Tax1099',
  'tax1099.com': 'Tax1099',
  'betterhelp': 'BetterHelp',
  'bubble': 'Bubble',
  'scribe': 'Scribe',
};

// Banking words that alone don't name anyone (U-176): a cut that would leave
// only these ("ONLINE TRANSFER TO CARD" → "Online") is not made.
const GENERIC_WORDS = new Set([
  'ONLINE', 'MOBILE', 'INTERNET', 'WEB', 'PHONE', 'ELECTRONIC', 'CHECK', 'CHK', 'CK', 'DEPOSIT', 'ATM', 'BRANCH',
  'TELLER', 'TRANSFER', 'XFER', 'PAYMENT', 'PAYMENTREC', 'PMT', 'AUTOPAY', 'PURCHASE', 'DEBIT', 'CREDIT', 'TRANSACTION',
  'CARD', 'BANK', 'ACCOUNT', 'ACCT', 'POS', 'ACH', 'WIRE', 'EFT', 'PENDING', 'HOLD', 'RECURRING', 'TO', 'FROM', 'FOR',
  'THE', 'OF', 'ON', 'AT', 'THANK', 'YOU', 'ID', 'REF', 'CONF', 'NO', 'NUM', 'NUMBER',
]);

/** True when `s` has a word with a letter that isn't a generic banking word. */
function hasMeaningfulWord(s: string): boolean {
  return s.split(/\s+/).some((w) => {
    const letters = w.replace(/[^\p{L}]/gu, '').toUpperCase();
    return letters.length > 0 && !GENERIC_WORDS.has(letters);
  });
}

/** A word cut is made only when something meaningful is left (U-176). */
function cutWords(s: string, pattern: RegExp): string {
  const next = s.replace(pattern, '');
  return next !== s && !hasMeaningfulWord(next) ? s : next;
}

/** A trailing-number cut is made unless it leaves a bare check word: "CHECK 1005" keeps its number (U-176). */
function cutNumber(s: string, pattern: RegExp): string {
  const next = s.replace(pattern, '');
  return next !== s && /^(CHECK|CHK|CK)\s*(NO\.?|#)?$/i.test(next.trim()) ? s : next;
}

// Transaction words that end a descriptor: everything from the first of
// them with a meaningful name before it is dropped ("COMCAST PAYMENT
// 123456" → "COMCAST"); a cut that would leave only banking words is not
// made ("ONLINE TRANSFER TO CARD" stays whole).
const SUFFIX_WORD = /\s+(PAYMENTREC|PAYMENT|PMT|AUTOPAY|PURCHASE|DEBIT|CREDIT|TRANSACTION|TRANSFER)/gi;

function cutTransactionSuffix(s: string): string {
  for (const m of s.matchAll(SUFFIX_WORD)) {
    const head = s.slice(0, m.index);
    if (hasMeaningfulWord(head)) return head;
  }
  return s;
}

/** Unicode title case: "CAFÉ LUMIÈRE" → "Café Lumière", "JOE'S" → "Joe's", "O'REILLY" → "O'Reilly". */
function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_m, before: string, ch: string) => before + ch.toUpperCase())
    .replace(/(^|[^\p{L}\p{N}])(\p{L})(['’])(\p{L}{2,})/gu,
      (_m, before: string, a: string, q: string, rest: string) => before + a + q + rest.charAt(0).toUpperCase() + rest.slice(1));
}

export function cleanBankDescription(raw: string): string {
  if (!raw) return raw;

  let cleaned = raw.trim();

  // ── Phase 1: Decode & normalize characters ──
  // HTML entities: &amp; → &, etc.
  cleaned = cleaned.replace(/&amp;/gi, '&');
  cleaned = cleaned.replace(/&lt;/gi, '<');
  cleaned = cleaned.replace(/&gt;/gi, '>');
  cleaned = cleaned.replace(/&#?\w+;/gi, '');

  // Strip date prefix patterns like "0403 " (MMDD)
  cleaned = cleaned.replace(/^\d{4}\s+/, '');

  // ── Phase 2: Strip bank-added prefixes ──
  for (const pattern of STRIP_PREFIXES) {
    cleaned = cutWords(cleaned, pattern);
  }

  // Clean up asterisks used as separators: "FUBO*TV" → "FUBO TV"
  cleaned = cleaned.replace(/\*/g, ' ');

  // ── Phase 3: Strip trailing noise ──

  // Phone numbers (full and partial/truncated): 800-123-4567, 877-33239, 603-324-0, 866-665-278
  // A check keeps its number; a word cut never leaves only banking words (U-176).
  cleaned = cutNumber(cleaned, /\s+\d{3}[-.]?\d{3,}[-.]?\d*$/i);
  // Toll-free and common prefixes that might remain after other stripping
  cleaned = cutNumber(cleaned, /\s+\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{1,4}$/i);

  // Trailing numeric-heavy codes: 7704, 180-09680, etc.
  cleaned = cutNumber(cleaned, /\s+\d{3,}[-]\d+$/i);

  // Trailing reference/order codes — only if they contain digits (pure-alpha words are likely real names)
  cleaned = cutNumber(cleaned, /\s+(?=[A-Z0-9]*\d)[A-Z0-9]{5,}$/i);
  cleaned = cutNumber(cleaned, /\s+#?[A-Z]*\d{4,}[A-Z0-9]*$/i);

  // Dates: 04/03, 01-05
  cleaned = cutNumber(cleaned, /\s+\d{2}[/\-]\d{2}$/i);
  cleaned = cutNumber(cleaned, /\s+\d{4}$/i);

  // Country/state codes at end
  cleaned = cutWords(cleaned, /\s+(US|CA|GB|AU|NZ|IN|XX)\s*$/i);
  cleaned = cutWords(cleaned, /\s+[A-Z]{2}\s*$/i);

  // Zip codes
  cleaned = cutNumber(cleaned, /\s+\d{5}(-\d{4})?\s*$/i);

  // Common transaction suffixes
  cleaned = cutTransactionSuffix(cleaned);

  // Masked card/ref numbers
  cleaned = cutWords(cleaned, /\s+\*+\d+.*$/i);

  // ── Phase 4: Strip truncated/duplicate URLs and names ──

  // URLs and partial URLs: "Amzn.com/", "WWW.ACCOU", "CL.INTUIT", "ZENWORK.C"
  cleaned = cutWords(cleaned, /\s+(https?:\/\/)?[\w.-]+\.(com|org|net|io|co)\S*$/i);
  cleaned = cutWords(cleaned, /\s+WWW\.\S*$/i);
  cleaned = cutWords(cleaned, /\s+[A-Z]{2,}\.[A-Z]+$/i);  // "CL.INTUIT", "ZENWORK.C"

  // ── Phase 5: Strip business entity and noise suffixes ──
  cleaned = cutWords(cleaned, /\s*,?\s*\b(Inc\.?|LLC\.?|Corp\.?|Ltd\.?|L\.?L\.?C\.?|Incorporated|Corporation|Limited)\s*$/i);

  // Strip "Bill Pay" suffix (common for utility payments, keep the vendor name)
  cleaned = cutWords(cleaned, /\s+Bill\s+Pay\s*$/i);

  // ── Phase 6: Clean up random auth/reference codes ──
  // Only strip trailing words that have no vowels (likely random codes like TYWPYJ, BXKRM)
  // or are a single consonant-heavy token that doesn't look like English
  cleaned = cutWords(cleaned, /\s+[^aeiouàáâãäåæèéêëìíîïòóôõöøœùúûüAEIOU\s]{5,}$/i);

  // ── Phase 7: Remove duplicate/truncated repetitions ──
  // "APPSUMO.COM APPSUMO.C" → "APPSUMO.COM", "TAXSPEAKER TAXSPEAKE" → "TAXSPEAKER"
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  const words = cleaned.split(' ');
  if (words.length >= 2) {
    const deduped: string[] = [words[0]!];
    for (let i = 1; i < words.length; i++) {
      const prev = deduped[deduped.length - 1]!.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      const curr = words[i]!.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      // Skip if current word is a prefix/truncation of prev or vice versa (3+ char overlap)
      if (curr.length >= 3 && prev.length >= 3 && (prev.startsWith(curr) || curr.startsWith(prev))) {
        // Keep the longer one
        if (curr.length > prev.length) deduped[deduped.length - 1] = words[i]!;
        continue;
      }
      deduped.push(words[i]!);
    }
    cleaned = deduped.join(' ');
  }

  // ── Phase 8: Final cleanup ──
  cleaned = cleaned.replace(/[.,;:\-/]+$/, '');  // trailing punctuation
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // ── Phase 9: Merchant map lookup ──
  const lc = cleaned.toLowerCase();
  for (const [key, name] of Object.entries(MERCHANT_MAP)) {
    if (lc === key || lc.startsWith(key + ' ') || lc.startsWith(key + '.')) {
      return name;
    }
  }

  // ── Phase 10: Title case ──
  cleaned = titleCase(cleaned)
    .replace(/\bLlc\b/g, 'LLC')
    .replace(/\bInc\b/g, 'Inc.')
    .replace(/\bCo\b/g, 'Co.')
    .replace(/\bIrs\b/g, 'IRS')
    .replace(/\bCsi\b/g, 'CSI')
    .replace(/\bSvp\b/g, 'SVP')
    .replace(/\b(Atm|Pos|Usa|Llc)\b/g, (m) => m.toUpperCase());

  return cleaned || raw.trim();
}
