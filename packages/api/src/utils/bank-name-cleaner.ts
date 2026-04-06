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
  'quickbooks': 'QuickBooks',
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
    cleaned = cleaned.replace(pattern, '');
  }

  // Clean up asterisks used as separators: "FUBO*TV" → "FUBO TV"
  cleaned = cleaned.replace(/\*/g, ' ');

  // ── Phase 3: Strip trailing noise ──

  // Phone numbers (full and partial/truncated): 800-123-4567, 877-33239, 603-324-0, 866-665-278
  cleaned = cleaned.replace(/\s+\d{3}[-.]?\d{3,}[-.]?\d*$/i, '');
  // Toll-free and common prefixes that might remain after other stripping
  cleaned = cleaned.replace(/\s+\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{1,4}$/i, '');

  // Trailing numeric-heavy codes: 7704, 180-09680, etc.
  cleaned = cleaned.replace(/\s+\d{3,}[-]\d+$/i, '');

  // Trailing reference/order codes — only if they contain digits (pure-alpha words are likely real names)
  cleaned = cleaned.replace(/\s+(?=[A-Z0-9]*\d)[A-Z0-9]{5,}$/i, '');
  cleaned = cleaned.replace(/\s+#?[A-Z]*\d{4,}[A-Z0-9]*$/i, '');

  // Dates: 04/03, 01-05
  cleaned = cleaned.replace(/\s+\d{2}[/\-]\d{2}$/i, '');
  cleaned = cleaned.replace(/\s+\d{4}$/i, '');

  // Country/state codes at end
  cleaned = cleaned.replace(/\s+(US|CA|GB|AU|NZ|IN|XX)\s*$/i, '');
  cleaned = cleaned.replace(/\s+[A-Z]{2}\s*$/i, '');

  // Zip codes
  cleaned = cleaned.replace(/\s+\d{5}(-\d{4})?\s*$/i, '');

  // Common transaction suffixes
  cleaned = cleaned.replace(/\s+(PAYMENTREC|PAYMENT|PMT|AUTOPAY|PURCHASE|DEBIT|CREDIT|TRANSACTION|TRANSFER).*$/i, '');

  // Masked card/ref numbers
  cleaned = cleaned.replace(/\s+\*+\d+.*$/i, '');

  // ── Phase 4: Strip truncated/duplicate URLs and names ──

  // URLs and partial URLs: "Amzn.com/", "WWW.ACCOU", "CL.INTUIT", "ZENWORK.C"
  cleaned = cleaned.replace(/\s+(https?:\/\/)?[\w.-]+\.(com|org|net|io|co)\S*$/i, '');
  cleaned = cleaned.replace(/\s+WWW\.\S*$/i, '');
  cleaned = cleaned.replace(/\s+[A-Z]{2,}\.[A-Z]+$/i, '');  // "CL.INTUIT", "ZENWORK.C"

  // ── Phase 5: Strip business entity and noise suffixes ──
  cleaned = cleaned.replace(/\s*,?\s*\b(Inc\.?|LLC\.?|Corp\.?|Ltd\.?|L\.?L\.?C\.?|Incorporated|Corporation|Limited)\s*$/i, '');

  // Strip "Bill Pay" suffix (common for utility payments, keep the vendor name)
  cleaned = cleaned.replace(/\s+Bill\s+Pay\s*$/i, '');

  // ── Phase 6: Clean up random auth/reference codes ──
  // Only strip trailing words that have no vowels (likely random codes like TYWPYJ, BXKRM)
  // or are a single consonant-heavy token that doesn't look like English
  cleaned = cleaned.replace(/\s+[^aeiouAEIOU\s]{5,}$/i, '');

  // ── Phase 7: Remove duplicate/truncated repetitions ──
  // "APPSUMO.COM APPSUMO.C" → "APPSUMO.COM", "TAXSPEAKER TAXSPEAKE" → "TAXSPEAKER"
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  const words = cleaned.split(' ');
  if (words.length >= 2) {
    const deduped: string[] = [words[0]!];
    for (let i = 1; i < words.length; i++) {
      const prev = deduped[deduped.length - 1]!.toLowerCase().replace(/[^a-z0-9]/g, '');
      const curr = words[i]!.toLowerCase().replace(/[^a-z0-9]/g, '');
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
  cleaned = cleaned
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bLlc\b/g, 'LLC')
    .replace(/\bInc\b/g, 'Inc.')
    .replace(/\bCo\b/g, 'Co.')
    .replace(/\bIrs\b/g, 'IRS')
    .replace(/\bCsi\b/g, 'CSI')
    .replace(/\bSvp\b/g, 'SVP')
    .replace(/\b(Atm|Pos|Usa|Llc)\b/g, (m) => m.toUpperCase());

  return cleaned || raw.trim();
}
