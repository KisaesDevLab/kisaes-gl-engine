import fs from 'fs';
import path from 'path';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { attachments, contacts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as aiConfigService from './ai-config.service.js';
import * as orchestrator from './ai-orchestrator.service.js';

export async function processReceipt(tenantId: string, attachmentId: string) {
  const attachment = await db.query.attachments.findFirst({
    where: and(eq(attachments.tenantId, tenantId), eq(attachments.id, attachmentId)),
  });
  if (!attachment) throw AppError.notFound('Attachment not found');

  const config = await aiConfigService.getConfig();
  if (!config.isEnabled) throw AppError.badRequest('AI processing is not enabled');

  // Read the image file (via cache for cloud-stored files)
  let imageBuffer: Buffer;
  try {
    const { ensureLocal } = await import('./storage/cache.service.js');
    const localPath = await ensureLocal(tenantId, attachmentId);
    imageBuffer = fs.readFileSync(localPath);
  } catch {
    // Fallback to direct file_path for local storage
    const filePath = attachment.filePath;
    if (!filePath || !fs.existsSync(filePath)) throw AppError.notFound('Attachment file not found');
    imageBuffer = fs.readFileSync(filePath);
  }
  const base64 = imageBuffer.toString('base64');
  const mimeType = attachment.mimeType || 'image/jpeg';

  await db.update(attachments).set({ ocrStatus: 'processing' }).where(eq(attachments.id, attachmentId));

  const job = await orchestrator.createJob(tenantId, 'ocr_receipt', 'attachment', attachmentId);

  try {
    const rawConfig = await aiConfigService.getRawConfig();
    const ocrProvider = config.ocrProvider || config.categorizationProvider;
    if (!ocrProvider) throw new Error('No OCR provider configured');

    const { getProvider } = await import('./ai-providers/index.js');
    const provider = getProvider(ocrProvider, rawConfig, config.ocrModel || undefined);

    const result = await provider.completeWithImage({
      systemPrompt: `You are a receipt OCR assistant. Extract structured data from the receipt image. Return JSON only: { "vendor": "...", "date": "YYYY-MM-DD", "total": "0.00", "tax": "0.00", "line_items": [{"description": "...", "amount": "0.00", "quantity": 1}], "payment_method": "...", "confidence": 0.0-1.0 }`,
      userPrompt: 'Extract all information from this receipt. Return valid JSON.',
      images: [{ base64, mimeType }],
      temperature: 0.1,
      maxTokens: 1024,
      responseFormat: 'json',
    });

    const parsed = result.parsed || {};
    const confidence = parsed.confidence || 0.5;

    // Update attachment with OCR results
    await db.update(attachments).set({
      ocrStatus: 'complete',
      ocrVendor: parsed.vendor || null,
      ocrDate: parsed.date || null,
      ocrTotal: parsed.total || null,
      ocrTax: parsed.tax || null,
    }).where(eq(attachments.id, attachmentId));

    await orchestrator.completeJob(job.id, result, parsed, confidence);

    // Try to match vendor to existing contact
    let contactId: string | null = null;
    if (parsed.vendor) {
      const contact = await db.query.contacts.findFirst({
        where: and(eq(contacts.tenantId, tenantId), eq(contacts.displayName, parsed.vendor)),
      });
      contactId = contact?.id || null;
    }

    return {
      vendor: parsed.vendor,
      date: parsed.date,
      total: parsed.total,
      tax: parsed.tax,
      lineItems: parsed.line_items || [],
      paymentMethod: parsed.payment_method,
      confidence,
      contactId,
    };
  } catch (err: any) {
    await db.update(attachments).set({ ocrStatus: 'failed' }).where(eq(attachments.id, attachmentId));
    await orchestrator.failJob(job.id, err.message);
    throw err;
  }
}
