import fs from 'fs';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { attachments } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as aiConfigService from './ai-config.service.js';
import * as orchestrator from './ai-orchestrator.service.js';

export type DocumentType = 'receipt' | 'invoice' | 'bank_statement' | 'tax_form' | 'other';

export async function classifyDocument(tenantId: string, attachmentId: string): Promise<{ type: DocumentType; confidence: number }> {
  const attachment = await db.query.attachments.findFirst({
    where: and(eq(attachments.tenantId, tenantId), eq(attachments.id, attachmentId)),
  });
  if (!attachment) throw AppError.notFound('Attachment not found');

  const config = await aiConfigService.getConfig();
  if (!config.isEnabled) return { type: 'other', confidence: 0 };

  let fileBuffer: Buffer;
  try {
    const { ensureLocal } = await import('./storage/cache.service.js');
    const localPath = await ensureLocal(tenantId, attachmentId);
    fileBuffer = fs.readFileSync(localPath);
  } catch {
    const filePath = attachment.filePath;
    if (!filePath || !fs.existsSync(filePath)) return { type: 'other', confidence: 0 };
    fileBuffer = fs.readFileSync(filePath);
  }
  const base64 = fileBuffer.toString('base64');
  const mimeType = attachment.mimeType || 'image/jpeg';

  const job = await orchestrator.createJob(tenantId, 'classify_document', 'attachment', attachmentId);

  try {
    const rawConfig = await aiConfigService.getRawConfig();
    const provider = config.documentClassificationProvider || config.categorizationProvider;
    if (!provider) throw new Error('No classification provider configured');

    const { getProvider: gp } = await import('./ai-providers/index.js');
    const aiProvider = gp(provider, rawConfig, config.documentClassificationModel || undefined);

    const result = await aiProvider.completeWithImage({
      systemPrompt: `You are a document classifier. Identify the type of financial document in the image. Return JSON: { "type": "receipt"|"invoice"|"bank_statement"|"tax_form"|"other", "confidence": 0.0-1.0, "reason": "..." }`,
      userPrompt: 'What type of financial document is this? Classify it.',
      images: [{ base64, mimeType }],
      temperature: 0.1,
      maxTokens: 128,
      responseFormat: 'json',
    });

    const parsed = result.parsed || {};
    const docType = (['receipt', 'invoice', 'bank_statement', 'tax_form'].includes(parsed.type) ? parsed.type : 'other') as DocumentType;
    const confidence = parsed.confidence || 0.5;

    await orchestrator.completeJob(job.id, result, parsed, confidence);
    return { type: docType, confidence };
  } catch (err: any) {
    await orchestrator.failJob(job.id, err.message);
    return { type: 'other', confidence: 0 };
  }
}

export async function classifyAndRoute(tenantId: string, attachmentId: string) {
  const { type, confidence } = await classifyDocument(tenantId, attachmentId);

  // Route to appropriate pipeline
  switch (type) {
    case 'receipt': {
      const { processReceipt } = await import('./ai-receipt-ocr.service.js');
      return { type, confidence, ocrResult: await processReceipt(tenantId, attachmentId) };
    }
    case 'bank_statement': {
      const { parseStatement } = await import('./ai-statement-parser.service.js');
      return { type, confidence, parseResult: await parseStatement(tenantId, attachmentId) };
    }
    default:
      return { type, confidence };
  }
}
