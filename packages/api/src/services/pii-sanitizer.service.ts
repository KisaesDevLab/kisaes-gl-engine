// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// PII sanitizer — pattern-based redaction of text before it is sent to a
// cloud AI provider. Runs entirely on the server with regex and string
// operations; no external calls, no async work.
//
// See Build Plans/AI_PII_PROTECTION_ADDENDUM.md §PII Sanitizer for the
// full pattern list and mode definitions.

export type SanitizerMode = 'strict' | 'standard' | 'minimal' | 'none';

export type PiiType =
  | 'ssn'
  | 'ein'
  | 'bank_account'
  | 'routing'
  | 'credit_card'
  | 'phone'
  | 'email'
  | 'address'
  | 'payment_app_name';

const PAYMENT_APP_KEYWORDS = ['VENMO', 'ZELLE', 'PAYPAL', 'CASHAPP', 'CASH APP'];

// Regex library. Each pattern produces a match on text that is PII of the
// matching type. Contextual patterns (account / routing) require a keyword
// in the preceding ~30 characters to avoid shredding every long digit run.
const patterns = {
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  // EIN is XX-XXXXXXX. Distinguished from a phone extension by its
  // exact 2-7 digit split.
  ein: /\b\d{2}-\d{7}\b/g,
  // Contextual bank account: the word "account" / "acct" / "a/c" within
  // the previous ~30 characters, then a run of 8–17 digits (optionally
  // with internal spaces/dashes).
  bankAccount: /\b(?:account|acct\.?|a\/c)[^\d\n]{0,30}(\d[\d\s-]{6,19}\d)\b/gi,
  // Routing numbers: 9 digits in a row, with the word "routing" / "ABA"
  // nearby. Keep separate from bank account so we don't swallow valid
  // routing numbers into the account pattern.
  routing: /\b(?:routing|rtn|aba)[^\d\n]{0,20}(\d{9})\b/gi,
  // Credit cards: 13–19 digits with optional internal spaces or dashes,
  // in groups of 4. Matches Visa, MC, Amex (15-digit), Discover shapes.
  creditCard: /\b(?:\d[ -]?){12,18}\d\b/g,
  // Phone numbers. Covers 10-digit US phone shapes; intentionally loose.
  phone: /\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  // Mailing address: street number + up to 80 chars of street name +
  // suffix. Bounded character class (`[\w\s.'-]{1,80}`) prevents
  // catastrophic backtracking on long non-address text. Optional
  // city/state/zip on the same or following line.
  address:
    /\b\d{1,6}\s+[\w\s.'-]{1,80}(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Drive|Dr\.?|Court|Ct\.?|Way|Place|Pl\.?|Highway|Hwy\.?|Parkway|Pkwy\.?|Circle|Cir\.?|Trail|Terrace|Ter\.?|Square|Sq\.?)\b(?:\s*(?:#|Apt\.?|Suite|Ste\.?|Unit)\s*[A-Za-z0-9-]{1,10})?(?:\s*[,\n]\s*[\w\s.'-]{1,50},?\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)?/g,
  // Card last-4: preserve the last 4 digits (useful for matching) but
  // collapse the "ending in" preamble to a canonical form.
  cardLast4Preamble:
    /\b(?:ending\s+in|last\s*4|ending|xxxx|x{4,})[-\s]*(\d{4})\b/gi,
};

// Passes Luhn (mod-10) check. Reduces false positives on arbitrary long
// digit runs (order IDs, reference numbers).
function isLikelyCreditCard(digits: string): boolean {
  const cleaned = digits.replace(/[\s-]/g, '');
  if (cleaned.length < 13 || cleaned.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    let n = parseInt(cleaned.charAt(i), 10);
    if (Number.isNaN(n)) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// Pre-compiled regex for payment-app name masking. Built once at module
// load from PAYMENT_APP_KEYWORDS to avoid regex construction per call.
const PAYMENT_NAME_RE = new RegExp(
  `\\b(${PAYMENT_APP_KEYWORDS.map((k) => k.replace(/\s+/g, '\\s+')).join('|')})\\b(?:\\s+(?:PAYMENT|TRANSFER|FROM|TO|SEND|RECEIVED))*\\s+((?:[A-Z][A-Z'.-]{1,}\\s?){1,5})`,
  'g'
);

function maskPaymentAppNames(text: string): string {
  PAYMENT_NAME_RE.lastIndex = 0;
  return text.replace(PAYMENT_NAME_RE, (_m, keyword, _rest) => `${keyword} [NAME_REDACTED]`);
}

function maskCreditCards(text: string): string {
  return text.replace(patterns.creditCard, (match) => {
    if (!isLikelyCreditCard(match)) return match;
    return '[CARD_REDACTED]';
  });
}

function maskBankAccount(text: string): string {
  return text.replace(patterns.bankAccount, (match, digits: string) => {
    const cleaned = digits.replace(/[\s-]/g, '');
    if (cleaned.length < 8 || cleaned.length > 17) return match;
    return match.replace(digits, '[ACCT_REDACTED]');
  });
}

function maskRouting(text: string): string {
  return text.replace(patterns.routing, (match, digits: string) =>
    match.replace(digits, '[ROUTING_REDACTED]')
  );
}

function preserveCardLast4(text: string): string {
  // Replace "ending in 4567" / "xxxx 4567" with a canonical
  // "[CARD_ENDING_4567]" marker so the cloud model sees a consistent
  // token for matching but no leading PII preamble.
  return text.replace(patterns.cardLast4Preamble, (_m, last4: string) => {
    return `[CARD_ENDING_${last4}]`;
  });
}

export interface SanitizeResult {
  text: string;
  detected: PiiType[];
}

/**
 * Apply PII masking to arbitrary text based on the selected mode.
 * Returns the sanitized text and a list of PII types that were detected
 * (useful for logging and for surfacing in the disclosure popover).
 */
export function sanitize(input: string | null | undefined, mode: SanitizerMode): SanitizeResult {
  if (!input) return { text: '', detected: [] };
  if (mode === 'none') return { text: input, detected: [] };

  let text = input;
  const detected = new Set<PiiType>();

  const beforeCardLast4 = text;
  text = preserveCardLast4(text);
  if (text !== beforeCardLast4) {
    // This is preservation, not redaction — don't flag it as detected.
  }

  // Minimal mode: only SSN, EIN, and payment-app name masking (used for
  // transaction descriptions on categorization).
  if (patterns.ssn.test(text)) detected.add('ssn');
  patterns.ssn.lastIndex = 0;
  text = text.replace(patterns.ssn, '[SSN_REDACTED]');

  if (patterns.ein.test(text)) detected.add('ein');
  patterns.ein.lastIndex = 0;
  text = text.replace(patterns.ein, '[EIN_REDACTED]');

  const afterPaymentNames = maskPaymentAppNames(text);
  if (afterPaymentNames !== text) detected.add('payment_app_name');
  text = afterPaymentNames;

  if (mode === 'minimal') {
    return { text, detected: [...detected] };
  }

  // Standard mode: add card numbers, phone, email, bank account, routing.
  const afterCards = maskCreditCards(text);
  if (afterCards !== text) detected.add('credit_card');
  text = afterCards;

  const afterAccount = maskBankAccount(text);
  if (afterAccount !== text) detected.add('bank_account');
  text = afterAccount;

  const afterRouting = maskRouting(text);
  if (afterRouting !== text) detected.add('routing');
  text = afterRouting;

  if (patterns.phone.test(text)) detected.add('phone');
  patterns.phone.lastIndex = 0;
  text = text.replace(patterns.phone, '[PHONE_REDACTED]');

  if (patterns.email.test(text)) detected.add('email');
  patterns.email.lastIndex = 0;
  text = text.replace(patterns.email, '[EMAIL_REDACTED]');

  if (mode === 'standard') {
    return { text, detected: [...detected] };
  }

  // Strict mode: also mask mailing addresses.
  const beforeAddress = text;
  text = text.replace(patterns.address, '[ADDRESS_REDACTED]');
  if (text !== beforeAddress) detected.add('address');

  return { text, detected: [...detected] };
}

/**
 * Inspect text for PII without modifying it. Useful for audit logging
 * when we want to record what categories were present without storing
 * the redacted text itself.
 */
export function detectPiiTypes(input: string | null | undefined): PiiType[] {
  const { detected } = sanitize(input, 'strict');
  return detected;
}

/**
 * Bank-statement header sanitizer. The header block of a statement
 * (account holder name, account number, routing number, address) is the
 * highest-risk section — always apply strict mode.
 */
export function sanitizeStatementHeader(input: string | null | undefined): SanitizeResult {
  return sanitize(input, 'strict');
}

/**
 * Single bank-feed description sanitizer. Used by the categorization
 * pipeline: strips SSN/EIN and payment-app personal names while keeping
 * merchant names, amounts, and dates intact.
 */
export function sanitizeTransactionDescription(input: string | null | undefined): SanitizeResult {
  return sanitize(input, 'minimal');
}

/**
 * Map a provider name + task type to the appropriate sanitizer mode.
 * Self-hosted providers bypass sanitization entirely because no data
 * leaves the server; cloud providers apply a mode appropriate to the
 * task's risk profile.
 *
 * For `openai_compat` the caller must decide whether it's pointing at
 * a local or cloud URL and pass `isSelfHosted` accordingly — the
 * sanitizer can't read the ai_config table itself. Default (boolean
 * omitted) is CLOUD so PII sanitization engages unless the orchestrator
 * has affirmatively verified the target is local.
 */
export function pickMode(
  providerName: string,
  task: 'categorize' | 'ocr_receipt' | 'ocr_invoice' | 'ocr_statement' | 'classify_document',
  isSelfHosted?: boolean,
): SanitizerMode {
  const alwaysLocal = providerName === 'ollama' || providerName === 'glm_ocr_local';
  const resolvedSelfHosted = alwaysLocal || isSelfHosted === true;
  if (resolvedSelfHosted) return 'none';
  switch (task) {
    case 'ocr_statement':
      return 'strict';
    case 'ocr_receipt':
    case 'ocr_invoice':
      return 'standard';
    case 'categorize':
    case 'classify_document':
      return 'minimal';
  }
}
