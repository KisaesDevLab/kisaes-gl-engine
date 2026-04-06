import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.js';
import * as attachmentService from '../services/attachment.service.js';
import * as ocrService from '../services/ocr.service.js';

const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff', 'image/bmp',
  'application/pdf',
  'text/csv', 'text/plain',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.ms-excel', // xls
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} is not allowed. Accepted: images, PDFs, spreadsheets, documents.`));
    }
  },
});

export const attachmentsRouter = Router();
attachmentsRouter.use(authenticate);

attachmentsRouter.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: { message: 'No file uploaded' } }); return; }

  const { attachableType, attachableId } = req.body;
  if (!attachableType || !attachableId) {
    res.status(400).json({ error: { message: 'attachableType and attachableId required' } });
    return;
  }

  const attachment = await attachmentService.upload(req.tenantId, req.file, attachableType, attachableId);

  // Auto-trigger OCR for receipt images
  if (req.file.mimetype.startsWith('image/')) {
    ocrService.processReceipt(req.tenantId, attachment!.id).catch(() => {});
  }

  res.status(201).json({ attachment });
});

attachmentsRouter.get('/', async (req, res) => {
  const result = await attachmentService.list(req.tenantId, {
    attachableType: req.query['attachable_type'] as string,
    attachableId: req.query['attachable_id'] as string,
    limit: parseInt(req.query['limit'] as string) || 50,
    offset: parseInt(req.query['offset'] as string) || 0,
  });
  res.json(result);
});

attachmentsRouter.get('/unlinked', async (req, res) => {
  const data = await attachmentService.listUnlinked(req.tenantId);
  res.json({ data });
});

attachmentsRouter.post('/:id/link', async (req, res) => {
  const { attachableType, attachableId } = req.body;
  if (!attachableType || !attachableId) {
    res.status(400).json({ error: { message: 'attachableType and attachableId required' } });
    return;
  }
  await attachmentService.linkAttachment(req.tenantId, req.params['id']!, attachableType, attachableId);
  res.json({ linked: true });
});

attachmentsRouter.get('/:id', async (req, res) => {
  const attachment = await attachmentService.getById(req.tenantId, req.params['id']!);
  res.json({ attachment });
});

attachmentsRouter.get('/:id/download', async (req, res) => {
  const { stream, attachment } = await attachmentService.download(req.tenantId, req.params['id']!);
  res.setHeader('Content-Type', attachment.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${attachment.fileName}"`);
  stream.pipe(res);
});

attachmentsRouter.delete('/:id', async (req, res) => {
  await attachmentService.remove(req.tenantId, req.params['id']!);
  res.json({ message: 'Attachment deleted' });
});

attachmentsRouter.post('/:id/ocr', async (req, res) => {
  await ocrService.processReceipt(req.tenantId, req.params['id']!);
  const attachment = await attachmentService.getById(req.tenantId, req.params['id']!);
  res.json({ attachment });
});
