import { Router } from 'express';
import { createVendorCreditSchema, voidTransactionSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import * as vendorCreditService from '../services/vendor-credit.service.js';

export const vendorCreditsRouter = Router();
vendorCreditsRouter.use(authenticate);
vendorCreditsRouter.use(companyContext);

vendorCreditsRouter.get('/', async (req, res) => {
  const result = await vendorCreditService.listVendorCredits(req.tenantId, {
    contactId: req.query['contactId'] as string | undefined,
    startDate: req.query['startDate'] as string | undefined,
    endDate: req.query['endDate'] as string | undefined,
    search: req.query['search'] as string | undefined,
    limit: req.query['limit'] ? Number(req.query['limit']) : undefined,
    offset: req.query['offset'] ? Number(req.query['offset']) : undefined,
  }, req.companyId);
  res.json(result);
});

vendorCreditsRouter.get('/available/:vendorId', async (req, res) => {
  const credits = await vendorCreditService.getAvailableCredits(req.tenantId, req.params['vendorId']!);
  res.json({ credits });
});

vendorCreditsRouter.post('/', validate(createVendorCreditSchema), async (req, res) => {
  const credit = await vendorCreditService.createVendorCredit(req.tenantId, req.body, req.userId, req.companyId);
  res.status(201).json({ credit });
});

vendorCreditsRouter.get('/:id', async (req, res) => {
  const credit = await vendorCreditService.getVendorCredit(req.tenantId, req.params['id']!);
  res.json({ credit });
});

vendorCreditsRouter.post('/:id/void', validate(voidTransactionSchema), async (req, res) => {
  await vendorCreditService.voidVendorCredit(req.tenantId, req.params['id']!, req.body.reason, req.userId);
  const credit = await vendorCreditService.getVendorCredit(req.tenantId, req.params['id']!);
  res.json({ credit });
});
