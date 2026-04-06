import fs from 'fs';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { attachments, bankFeedItems } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as aiConfigService from './ai-config.service.js';
import * as orchestrator from './ai-orchestrator.service.js';

export interface StatementTransaction {
  date: string;
  description: string;
  amount: string;
  type: 'debit' | 'credit';
  balance?: string;
}

export async function parseStatement(tenantId: string, attachmentId: string) {
  const attachment = await db.query.attachments.findFirst({
    where: and(eq(attachments.tenantId, tenantId), eq(attachments.id, attachmentId)),
  });
  if (!attachment) throw AppError.notFound('Attachment not found');

  const config = await aiConfigService.getConfig();
  if (!config.isEnabled) throw AppError.badRequest('AI processing is not enabled');

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

  const job = await orchestrator.createJob(tenantId, 'ocr_statement', 'attachment', attachmentId);

  try {
    const rawConfig = await aiConfigService.getRawConfig();
    const ocrProvider = config.ocrProvider || config.categorizationProvider;
    if (!ocrProvider) throw new Error('No OCR provider configured');

    const { getProvider } = await import('./ai-providers/index.js');
    const provider = getProvider(ocrProvider, rawConfig, config.ocrModel || undefined);

    const result = await provider.completeWithImage({
      systemPrompt: `You are a bank statement parser. Extract all transactions from the bank statement image/document. Return JSON: { "transactions": [{"date": "YYYY-MM-DD", "description": "...", "amount": "0.00", "type": "debit"|"credit", "balance": "0.00"}], "account_number_masked": "****1234", "statement_period": {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}, "opening_balance": "0.00", "closing_balance": "0.00", "confidence": 0.0-1.0 }`,
      userPrompt: 'Extract all transactions from this bank statement. Include date, description, amount, type (debit/credit), and running balance if visible.',
      images: [{ base64, mimeType }],
      temperature: 0.1,
      maxTokens: 4096,
      responseFormat: 'json',
    });

    const parsed = result.parsed || {};
    const transactions: StatementTransaction[] = (parsed.transactions || []).map((t: any) => ({
      date: t.date,
      description: t.description,
      amount: t.amount,
      type: t.type || 'debit',
      balance: t.balance,
    }));

    const confidence = parsed.confidence || 0.5;
    await orchestrator.completeJob(job.id, result, parsed, confidence);

    return {
      transactions,
      accountNumberMasked: parsed.account_number_masked,
      statementPeriod: parsed.statement_period,
      openingBalance: parsed.opening_balance,
      closingBalance: parsed.closing_balance,
      confidence,
    };
  } catch (err: any) {
    await orchestrator.failJob(job.id, err.message);
    throw err;
  }
}

export async function importStatementTransactions(tenantId: string, bankConnectionId: string, transactions: StatementTransaction[]) {
  const { importStatementItems } = await import('./bank-feed.service.js');
  return importStatementItems(tenantId, bankConnectionId, transactions);
}
