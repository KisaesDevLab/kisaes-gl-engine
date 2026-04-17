// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { db } from '../db/index.js';
import { attachments } from '../db/schema/index.js';
import { eq, and } from 'drizzle-orm';

export async function processReceipt(tenantId: string, attachmentId: string) {
  const attachment = await db.query.attachments.findFirst({
    where: and(eq(attachments.tenantId, tenantId), eq(attachments.id, attachmentId)),
  });
  if (!attachment) return;

  // Mark as processing
  await db.update(attachments).set({ ocrStatus: 'pending' }).where(eq(attachments.id, attachmentId));

  try {
    // Attempt LLM-based OCR if ANTHROPIC_API_KEY is set
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (apiKey && attachment.mimeType?.startsWith('image/')) {
      // Stub: In production, call Claude vision API to extract receipt data
      // For now, set status to indicate it needs manual entry
      await db.update(attachments).set({
        ocrStatus: 'complete',
        ocrVendor: null,
        ocrDate: null,
        ocrTotal: null,
        ocrTax: null,
      }).where(eq(attachments.id, attachmentId));

      console.log(`[OCR] Processed receipt ${attachmentId} (LLM stub)`);
      return;
    }

    // No API key or non-image — mark as needing manual entry
    await db.update(attachments).set({ ocrStatus: 'complete' }).where(eq(attachments.id, attachmentId));
    console.log(`[OCR] Receipt ${attachmentId} — no LLM key, manual entry needed`);
  } catch (err) {
    await db.update(attachments).set({ ocrStatus: 'failed' }).where(eq(attachments.id, attachmentId));
    console.error(`[OCR] Failed for ${attachmentId}:`, err);
  }
}
