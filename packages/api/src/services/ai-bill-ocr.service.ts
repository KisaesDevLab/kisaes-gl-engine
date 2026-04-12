import fs from 'fs';
import { eq, and, ilike } from 'drizzle-orm';
import { db } from '../db/index.js';
import { attachments, contacts, accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as aiConfigService from './ai-config.service.js';
import * as orchestrator from './ai-orchestrator.service.js';

/**
 * Bill OCR — extracts vendor invoice data from an uploaded image or PDF
 * attachment so the bill entry form can pre-fill itself.
 *
 * Mirrors ai-receipt-ocr.service.ts in shape (vision LLM call → parsed JSON
 * → contact resolution) but uses a bill-specific prompt that asks the model
 * to identify vendor name, vendor invoice number, dates, terms, and line
 * items as separate fields. The output is structured for direct use by the
 * bill form: each line item has a description and amount that can be
 * dropped into a bill expense line as-is.
 */

export interface BillOcrLineItem {
  description: string | null;
  amount: string | null;
  quantity: string | null;
}

export interface BillOcrResult {
  vendor: string | null;
  vendorInvoiceNumber: string | null;
  billDate: string | null;
  dueDate: string | null;
  paymentTerms: string | null;
  total: string | null;
  subtotal: string | null;
  tax: string | null;
  lineItems: BillOcrLineItem[];
  notes: string | null;
  confidence: number;
  // Resolved against the tenant's data
  contactId: string | null;
  defaultExpenseAccountId: string | null;
}

/**
 * Run vendor-invoice OCR against an existing attachment and return parsed
 * fields plus best-effort vendor + default-expense-account resolution.
 */
export async function extractBillFromAttachment(tenantId: string, attachmentId: string): Promise<BillOcrResult> {
  const attachment = await db.query.attachments.findFirst({
    where: and(eq(attachments.tenantId, tenantId), eq(attachments.id, attachmentId)),
  });
  if (!attachment) throw AppError.notFound('Attachment not found');

  const config = await aiConfigService.getConfig();
  if (!config.isEnabled) {
    throw AppError.badRequest(
      'AI processing is not enabled. An administrator must enable it in System Settings → AI before bill OCR can run.',
    );
  }

  // Read the file (via cache for cloud-stored attachments, falling back to
  // direct filesystem read for local storage). Mirrors what
  // ai-receipt-ocr.service.ts does so cloud-stored bills work the same way.
  let fileBuffer: Buffer;
  try {
    const { ensureLocal } = await import('./storage/cache.service.js');
    const localPath = await ensureLocal(tenantId, attachmentId);
    fileBuffer = fs.readFileSync(localPath);
  } catch {
    const filePath = attachment.filePath;
    if (!filePath || !fs.existsSync(filePath)) throw AppError.notFound('Attachment file not found');
    fileBuffer = fs.readFileSync(filePath);
  }
  const base64 = fileBuffer.toString('base64');
  const mimeType = attachment.mimeType || 'image/jpeg';

  // PDFs need a vision model that can read PDFs (Anthropic + Gemini do; OpenAI
  // requires page rasterization). For now we pass it through and rely on the
  // configured provider; if the provider can't handle PDFs the call will fail
  // with a provider-specific error and we surface that to the user.
  const isImageOrPdf = mimeType.startsWith('image/') || mimeType === 'application/pdf';
  if (!isImageOrPdf) {
    throw AppError.badRequest('Bill OCR requires an image or PDF attachment');
  }

  await db.update(attachments).set({ ocrStatus: 'processing' }).where(eq(attachments.id, attachmentId));

  // Use 'ocr_invoice' as the job type (already documented in the ai_jobs
  // schema comment alongside ocr_receipt and ocr_statement).
  const job = await orchestrator.createJob(tenantId, 'ocr_invoice', 'attachment', attachmentId);

  try {
    const rawConfig = await aiConfigService.getRawConfig();
    const ocrProvider = config.ocrProvider || config.categorizationProvider;
    if (!ocrProvider) throw new Error('No OCR provider configured');

    const { getProvider } = await import('./ai-providers/index.js');
    const provider = getProvider(ocrProvider, rawConfig, config.ocrModel || undefined);

    // Bill-specific prompt. Asks for fields that map directly to the bill
    // form: vendor, invoice #, dates, terms, line items. Explicitly tells
    // the model to use null (not empty strings) for missing fields so the
    // frontend can distinguish "not present" from "present but blank".
    const result = await provider.completeWithImage({
      systemPrompt: `You are a vendor invoice / bill OCR assistant. You will be given an image or PDF of a bill that a small business has received from a vendor. Extract the structured data and return JSON ONLY in this exact schema:
{
  "vendor": "string | null",                  // Vendor / supplier business name
  "vendor_invoice_number": "string | null",   // The vendor's invoice or reference number (their number, not ours)
  "bill_date": "YYYY-MM-DD | null",           // Invoice date / bill date
  "due_date": "YYYY-MM-DD | null",            // Payment due date if printed on the invoice
  "payment_terms": "string | null",           // e.g. "Net 30", "Due on receipt", "Net 15", or null
  "subtotal": "0.00 | null",                  // Pre-tax subtotal
  "tax": "0.00 | null",                       // Tax amount
  "total": "0.00 | null",                     // Total amount due
  "line_items": [                             // Each charged line item — preserve order
    { "description": "string", "amount": "0.00", "quantity": "1" }
  ],
  "notes": "string | null",                   // Any memo / description / PO reference
  "confidence": 0.0                           // Your overall confidence 0–1
}

Rules:
- Use null for missing fields. Do not invent data.
- Dates MUST be in ISO format YYYY-MM-DD. If only month/year is visible, use the 1st of that month.
- Amounts are decimal strings without currency symbols ("1234.56", not "$1,234.56").
- If the invoice has no clear line item breakdown, return one summary line with the total.
- payment_terms should match standard codes when possible: "due_on_receipt", "net_10", "net_15", "net_30", "net_45", "net_60", "net_90". If non-standard, return the human-readable string.
- Return JSON only — no markdown fences, no commentary.`,
      userPrompt: 'Extract all fields from this vendor invoice. Return valid JSON matching the schema exactly.',
      images: [{ base64, mimeType }],
      temperature: 0.1,
      maxTokens: 2048,
      responseFormat: 'json',
    });

    const parsed = result.parsed || {};
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;

    // Normalize the parsed payload to our return shape. The model occasionally
    // returns numeric amounts; coerce to strings so the form can render them
    // verbatim.
    const lineItems: BillOcrLineItem[] = Array.isArray(parsed.line_items)
      ? parsed.line_items.map((li: any) => ({
          description: li?.description ?? null,
          amount: li?.amount != null ? String(li.amount) : null,
          quantity: li?.quantity != null ? String(li.quantity) : null,
        }))
      : [];

    const ocrResult: Omit<BillOcrResult, 'contactId' | 'defaultExpenseAccountId'> = {
      vendor: parsed.vendor ?? null,
      vendorInvoiceNumber: parsed.vendor_invoice_number ?? null,
      billDate: parsed.bill_date ?? null,
      dueDate: parsed.due_date ?? null,
      paymentTerms: parsed.payment_terms ?? null,
      total: parsed.total != null ? String(parsed.total) : null,
      subtotal: parsed.subtotal != null ? String(parsed.subtotal) : null,
      tax: parsed.tax != null ? String(parsed.tax) : null,
      lineItems,
      notes: parsed.notes ?? null,
      confidence,
    };

    // Persist the basic OCR fields on the attachment so the existing
    // attachment library shows the extracted vendor/date/total. We reuse the
    // ocr_vendor / ocr_date / ocr_total / ocr_tax columns rather than adding
    // new ones — that's what they were designed for.
    await db.update(attachments).set({
      ocrStatus: 'complete',
      ocrVendor: ocrResult.vendor,
      ocrDate: ocrResult.billDate,
      ocrTotal: ocrResult.total,
      ocrTax: ocrResult.tax,
    }).where(eq(attachments.id, attachmentId));

    await orchestrator.completeJob(job.id, result, parsed, confidence);

    // Resolve vendor → tenant contact. Try exact match first, then case-
    // insensitive. We only consider vendors (or 'both' contacts).
    let contactId: string | null = null;
    let defaultExpenseAccountId: string | null = null;
    if (ocrResult.vendor) {
      const exact = await db.query.contacts.findFirst({
        where: and(
          eq(contacts.tenantId, tenantId),
          eq(contacts.displayName, ocrResult.vendor),
        ),
      });
      const matched = exact ?? (await db.select().from(contacts)
        .where(and(
          eq(contacts.tenantId, tenantId),
          ilike(contacts.displayName, ocrResult.vendor),
        ))
        .limit(1))[0];

      if (matched && (matched.contactType === 'vendor' || matched.contactType === 'both')) {
        contactId = matched.id;
        defaultExpenseAccountId = matched.defaultExpenseAccountId || null;
      }
    }

    // Verify the resolved expense account still exists and belongs to this
    // tenant before returning it (defensive — contact rows can outlive their
    // referenced account).
    if (defaultExpenseAccountId) {
      const acct = await db.query.accounts.findFirst({
        where: and(eq(accounts.tenantId, tenantId), eq(accounts.id, defaultExpenseAccountId)),
      });
      if (!acct) defaultExpenseAccountId = null;
    }

    return { ...ocrResult, contactId, defaultExpenseAccountId };
  } catch (err: any) {
    await db.update(attachments).set({ ocrStatus: 'failed' }).where(eq(attachments.id, attachmentId));
    await orchestrator.failJob(job.id, err.message);
    throw err;
  }
}
