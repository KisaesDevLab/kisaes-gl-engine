// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Prompt templates per docType. Each `schemaInstruction` tells the local
// vision model the EXACT JSON shape to return and the extraction rules. The
// shape mirrors the per-docType Zod schema in @kis-books/shared so the
// model's output validates cleanly.
//
// HARD RULES baked into every prompt:
//   - Return ONLY a JSON object — no prose, no markdown fences.
//   - Use null for any field you cannot read; never guess.
//   - Mask SSNs/TINs to the last 4 digits.
//   - The exact instruction string is persisted on extraction_pages.prompt
//     for audit, so changing a template is traceable per-page.

import type { DocType } from '@kis-books/shared';

export const EXTRACTION_SYSTEM_PROMPT =
  'You are a precise financial-document data extractor. Return ONLY valid JSON ' +
  'matching the requested schema. No commentary, no markdown, no code fences. ' +
  'Use null for any field you cannot read; never guess or fabricate a value. ' +
  'Mask any Social Security Number or Taxpayer Identification Number to its ' +
  'last four digits (e.g. "***-**-6789").';

const BANK_STATEMENT = `Extract every transaction from this bank statement page.
Return ONLY a JSON object of this exact shape:

{
  "page_confidence": <0.0-1.0, your confidence the page was legible>,
  "opening_balance": <number or null>,
  "closing_balance": <number or null>,
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "description": "<raw merchant/description text>",
      "amount": <number, positive>,
      "type": "debit" | "credit",
      "balance": <number or null>,
      "confidence": <0.0-1.0>
    }
  ]
}

Rules:
- Use null for any field you cannot read; never guess.
- amount is always positive; direction is in "type".
- opening_balance / closing_balance: the statement's beginning and ending
  balance from the header/summary, ONLY on the page where each is printed;
  use null on pages where it is not shown. Do NOT include them as transactions.
- Do not include headers, summaries, opening/closing balances, or totals as transactions.
- If the page is not a bank statement, return {"page_confidence": 0, "transactions": []}.`;

const INVOICE = `Extract the invoice on this page.
Return ONLY a JSON object of this exact shape:

{
  "page_confidence": <0.0-1.0>,
  "vendor": "<seller/biller name or null>",
  "invoice_no": "<invoice number or null>",
  "date": "YYYY-MM-DD or null",
  "due_date": "YYYY-MM-DD or null",
  "line_items": [
    { "description": "<text or null>", "quantity": <number or null>, "amount": <number or null> }
  ],
  "subtotal": <number or null>,
  "tax": <number or null>,
  "total": <number or null>,
  "confidence": <0.0-1.0>
}

Rules:
- Use null for any field you cannot read; never guess.
- Amounts are plain numbers (no currency symbols or thousands separators).
- line_items amounts are the extended (line total) amount.
- If the page is not an invoice, return {"page_confidence": 0, ...nulls/empty}.`;

const RECEIPT = `Extract the receipt on this page.
Return ONLY a JSON object of this exact shape:

{
  "page_confidence": <0.0-1.0>,
  "merchant": "<merchant name or null>",
  "date": "YYYY-MM-DD or null",
  "total": <number or null>,
  "tax": <number or null>,
  "category_hint": "<short spend category guess or null>",
  "confidence": <0.0-1.0>
}

Rules:
- Use null for any field you cannot read; never guess.
- total is the final amount paid.
- If the page is not a receipt, return {"page_confidence": 0, ...nulls}.`;

const W2 = `Extract this W-2 wage and tax statement page.
Return ONLY a JSON object of this exact shape:

{
  "page_confidence": <0.0-1.0>,
  "employer": "<employer name or null>",
  "employee_tin_masked": "<SSN masked to last 4, e.g. ***-**-6789, or null>",
  "tax_year": <year number or null>,
  "boxes": { "1": <number or null>, "2": <number or null>, "3": <number or null>, "...": <number> },
  "confidence": <0.0-1.0>
}

Rules:
- Use null for any field you cannot read; never guess.
- MASK the SSN to its last four digits; never return the full number.
- "boxes" maps the W-2 box number (as a string key) to its amount.
- If the page is not a W-2, return {"page_confidence": 0, "boxes": {}}.`;

const FORM_1099 = `Extract this 1099 information return page.
Return ONLY a JSON object of this exact shape:

{
  "page_confidence": <0.0-1.0>,
  "form_variant": "<NEC | MISC | INT | DIV | ... or null>",
  "payer": "<payer name or null>",
  "recipient_tin_masked": "<TIN masked to last 4, e.g. **-***6789, or null>",
  "tax_year": <year number or null>,
  "boxes": { "1": <number or null>, "2": <number or null>, "...": <number> },
  "confidence": <0.0-1.0>
}

Rules:
- Use null for any field you cannot read; never guess.
- MASK the recipient TIN/SSN to its last four digits; never return the full number.
- "boxes" maps the 1099 box number (as a string key) to its amount.
- If the page is not a 1099, return {"page_confidence": 0, "boxes": {}}.`;

const GENERIC = `Extract the key information from this document page.
Return ONLY a JSON object of this exact shape:

{
  "page_confidence": <0.0-1.0>,
  "raw_text": "<the full readable text of the page, or null>",
  "key_values": [ { "key": "<label>", "value": "<value or null>" } ]
}

Rules:
- Use null for any value you cannot read; never guess.
- key_values captures the salient labelled fields you can identify.
- Mask any SSN/TIN to its last four digits.`;

const TEMPLATES: Record<DocType, string> = {
  bank_statement: BANK_STATEMENT,
  invoice: INVOICE,
  receipt: RECEIPT,
  w2: W2,
  '1099': FORM_1099,
  generic: GENERIC,
};

/** The exact schemaInstruction (user prompt) sent to the model for a docType. */
export function buildSchemaInstruction(docType: DocType): string {
  return TEMPLATES[docType];
}
