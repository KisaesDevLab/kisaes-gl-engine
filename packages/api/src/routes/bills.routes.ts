import { Router } from 'express';
import { createBillSchema, billFiltersSchema, payableBillsQuerySchema, voidTransactionSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import * as billService from '../services/bill.service.js';
import * as billOcrService from '../services/ai-bill-ocr.service.js';
import * as attachmentService from '../services/attachment.service.js';

export const billsRouter = Router();
billsRouter.use(authenticate);
billsRouter.use(companyContext);

billsRouter.get('/', async (req, res) => {
  const filters = billFiltersSchema.parse(req.query);
  const result = await billService.listBills(req.tenantId, filters, req.companyId);
  res.json(result);
});

billsRouter.get('/payable', async (req, res) => {
  const query = payableBillsQuerySchema.parse(req.query);
  const result = await billService.getPayableBills(req.tenantId, query);
  res.json(result);
});

billsRouter.post('/', validate(createBillSchema), async (req, res) => {
  const bill = await billService.createBill(req.tenantId, req.body, req.userId, req.companyId);
  res.status(201).json({ bill });
});

billsRouter.get('/:id', async (req, res) => {
  const bill = await billService.getBill(req.tenantId, req.params['id']!);
  res.json({ bill });
});

billsRouter.put('/:id', validate(createBillSchema), async (req, res) => {
  const bill = await billService.updateBill(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId);
  res.json({ bill });
});

billsRouter.post('/:id/void', validate(voidTransactionSchema), async (req, res) => {
  await billService.voidBill(req.tenantId, req.params['id']!, req.body.reason, req.userId);
  const bill = await billService.getBill(req.tenantId, req.params['id']!);
  res.json({ bill });
});

// ─── AI: extract bill fields from an attachment ─────────────────
//
// Flow used by EnterBillPage:
//   1. Form uploads the file via POST /attachments with attachableType='draft'
//      and a client-generated draft id, getting back an attachment id.
//   2. Form calls POST /bills/extract-from-attachment/:attachmentId — this
//      runs the bill-specific OCR pipeline and returns parsed fields plus
//      best-effort vendor + default-expense-account resolution.
//   3. User reviews / edits the pre-filled form and saves the bill.
//   4. Form calls POST /bills/:id/attach-draft to relink the draft
//      attachment(s) to the newly created bill.
billsRouter.post('/extract-from-attachment/:attachmentId', async (req, res) => {
  const result = await billOcrService.extractBillFromAttachment(req.tenantId, req.params['attachmentId']!);
  res.json({ extraction: result });
});

billsRouter.post('/:id/attach-draft', async (req, res) => {
  const { draftId } = req.body as { draftId?: string };
  if (!draftId) {
    res.status(400).json({ error: { message: 'draftId is required' } });
    return;
  }
  // Re-link as 'bill' so the BillDetailPage's <AttachmentPanel
  // attachableType="bill" /> picks them up. Other transaction types
  // (expense, deposit, etc.) follow the same convention of using
  // their `txnType` as the attachable type — see
  // transactions.routes.ts and TransactionDetail.tsx.
  const reassigned = await attachmentService.reassignDraftAttachments(
    req.tenantId,
    draftId,
    'bill',
    req.params['id']!,
  );
  res.json({ reassigned });
});
