import { Router } from 'express';
import { createBillSchema, billFiltersSchema, payableBillsQuerySchema, voidTransactionSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as billService from '../services/bill.service.js';

export const billsRouter = Router();
billsRouter.use(authenticate);

billsRouter.get('/', async (req, res) => {
  const filters = billFiltersSchema.parse(req.query);
  const result = await billService.listBills(req.tenantId, filters);
  res.json(result);
});

billsRouter.get('/payable', async (req, res) => {
  const query = payableBillsQuerySchema.parse(req.query);
  const result = await billService.getPayableBills(req.tenantId, query);
  res.json(result);
});

billsRouter.post('/', validate(createBillSchema), async (req, res) => {
  const bill = await billService.createBill(req.tenantId, req.body, req.userId);
  res.status(201).json({ bill });
});

billsRouter.get('/:id', async (req, res) => {
  const bill = await billService.getBill(req.tenantId, req.params['id']!);
  res.json({ bill });
});

billsRouter.put('/:id', validate(createBillSchema), async (req, res) => {
  const bill = await billService.updateBill(req.tenantId, req.params['id']!, req.body, req.userId);
  res.json({ bill });
});

billsRouter.post('/:id/void', validate(voidTransactionSchema), async (req, res) => {
  await billService.voidBill(req.tenantId, req.params['id']!, req.body.reason, req.userId);
  const bill = await billService.getBill(req.tenantId, req.params['id']!);
  res.json({ bill });
});
