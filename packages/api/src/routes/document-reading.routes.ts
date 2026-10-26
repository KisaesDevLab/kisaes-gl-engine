// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Document reading assist (U-92d, document-assist-v1). Company-scoped like
// the document drafts routes: the request's company's AI switches decide.
// Needs full access to any of bills, checks or transactions (what a reading
// can become), as changing a draft does.
// See services/document-reading-assist.service.ts and docs/DESKTOP.md
// "Document reading assist".

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import {
  documentAssistRequestSchema, DOCUMENT_ASSIST_MAX_IMAGES, DOCUMENT_ASSIST_MAX_IMAGE_BYTES, DOCUMENT_ASSIST_MAX_TEXT_CHARS,
} from '@kis-books/shared';
import { getRateLimitStore } from '../utils/rate-limit-store.js';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { requireAnyDocumentResource } from '../middleware/document-draft-permission.js';
import * as assistService from '../services/document-reading-assist.service.js';

export const documentReadingRouter = Router();
documentReadingRouter.use(authenticate);
documentReadingRouter.use(companyContext);
documentReadingRouter.use(requireAnyDocumentResource('update'));

// Each call may reach a paid provider: the per-user limit of the AI
// processing routes (ai.routes.ts).
const assistLimiter = rateLimit({
  store: getRateLimitStore('ai:documentAssist'),
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).userId || req.ip || 'anonymous',
  message: { error: { message: 'Too many AI requests, please slow down', code: 'AI_RATE_LIMIT' } },
});

const money = z.string().nullable().describe('decimal string as read, e.g. "1234.56"; null when not read. Never computed.');
const confidence = z.enum(['high', 'medium', 'low']);
const assistResponse = z.object({
  suggestion: z.object({
    jobId: z.string(),
    reader: z.enum(['self_hosted', 'cloud']),
    usedImages: z.boolean(),
    vendor: z.string().nullable(),
    vendorAddress: z.object({
      line1: z.string().nullable(), line2: z.string().nullable(), city: z.string().nullable(),
      state: z.string().nullable(), zip: z.string().nullable(),
    }).nullable(),
    vendorInvoiceNumber: z.string().nullable(),
    billDate: z.string().nullable().describe('YYYY-MM-DD, or null when not a real date'),
    dueDate: z.string().nullable(),
    paymentTerms: z.string().nullable(),
    total: money,
    subtotal: money,
    tax: money,
    lineItems: z.array(z.object({
      description: z.string().nullable(),
      amount: money,
      quantity: z.string().nullable(),
      unitPrice: money,
      confidence: confidence.describe('low when the amount did not read'),
    })),
    notes: z.string().nullable(),
    confidence: z.number().describe('document-level 0–1 score from the model'),
    fieldConfidence: z.object({
      vendor: confidence, billDate: confidence, dueDate: confidence,
      vendorInvoiceNumber: confidence, total: confidence, subtotal: confidence,
      tax: confidence, paymentTerms: confidence,
    }).describe('bill-ocr-v2 thresholds: high ≥ 0.85, medium ≥ 0.6, else low; an empty field is low'),
    qualityWarnings: z.array(z.string()),
  }),
});

documentReadingRouter.post('/assist', assistLimiter, validate(documentAssistRequestSchema), describe({
  summary: 'Suggest a document\'s fields with the company\'s AI provider (suggestions only)',
  description: 'Response 200 `{suggestion}`: the bill-ocr-v2 reading of the text (and page images) the client sends. Nothing is stored ' +
    'or posted and no file is parsed; every amount is what the model read, as a decimal string, or null, and must be checked by the client. ' +
    'No vendor match (the client matches). ' +
    `Limits: text ≤ ${DOCUMENT_ASSIST_MAX_TEXT_CHARS} characters (400 TEXT_TOO_LONG), ≤ ${DOCUMENT_ASSIST_MAX_IMAGES} PNG page images ` +
    `(400 TOO_MANY_IMAGES, IMAGE_NOT_PNG) of ≤ ${DOCUMENT_ASSIST_MAX_IMAGE_BYTES} bytes together (400 IMAGES_TOO_LARGE); empty text and ` +
    'no images 400 NOTHING_TO_READ. AI off 400 ai_disabled; OCR function off or no provider 400 ai_function_disabled. ' +
    'Cloud provider: the company\'s document_text_cloud switch, and document_images_cloud as well when images are sent, else 403 ' +
    'CONSENT_REQUIRED (details.task; receipt_ocr does not count); images also need the system cloud-vision gate (403 CLOUD_VISION_DISABLED). ' +
    'A self-hosted provider (Ollama) needs neither switch and never falls back to a cloud one. Reply not JSON 400 ai_parse_failed; ' +
    'provider error or timeout 400 ai_ocr_failed; offline 503 OFFLINE_UNAVAILABLE (desktop). ' +
    'Needs full access to any of bills, checks or transactions. 60 calls a minute per user (429 AI_RATE_LIMIT). document-assist-v1.',
  body: documentAssistRequestSchema,
  response: assistResponse,
}), async (req, res) => {
  const suggestion = await assistService.assist(req.tenantId, req.companyId, req.body);
  res.json({ suggestion });
});
