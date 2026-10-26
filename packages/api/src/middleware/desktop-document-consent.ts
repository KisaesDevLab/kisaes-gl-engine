// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Desktop mode only (U-92d review L2): the document AI routes that predate
// the document reading assist (`POST /bills/extract-from-attachment/:id`,
// `POST /ai/ocr/receipt`) also need the company's `document_text_cloud`
// switch when the OCR provider is a cloud one. Mounted after companyContext
// and before the attachment lookup. A no-op on the server appliance.
// See assertDesktopDocumentTextConsent in document-reading-assist.service.ts.

import type { Request, Response, NextFunction } from 'express';
import { assertDesktopDocumentTextConsent } from '../services/document-reading-assist.service.js';

export async function requireDesktopDocumentTextConsent(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    await assertDesktopDocumentTextConsent(req.tenantId, req.companyId ?? null);
    next();
  } catch (err) {
    next(err);
  }
}
