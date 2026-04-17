// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { createPaymentIntentSchema } from '@kis-books/shared';
import * as publicInvoiceService from '../services/public-invoice.service.js';
import * as stripeService from '../services/stripe.service.js';
import * as pdfService from '../services/pdf.service.js';

export const publicInvoiceRouter = Router();

// Tight rate limit — these endpoints are unauthenticated bearer-token
// surfaces, so we want to keep distributed brute-force against the 160-bit
// invoice token well below the already-infeasible threshold.
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many requests. Please try again later.' } },
});
publicInvoiceRouter.use(publicLimiter);

// GET /api/v1/public/invoices/:token — View invoice (no auth required)
publicInvoiceRouter.get('/:token', async (req, res) => {
  const token = req.params['token'] || '';
  const invoiceData = await publicInvoiceService.getInvoiceByToken(token);

  // Optional: serve PDF if requested
  if (req.query['format'] === 'pdf') {
    const pdfBuffer = await pdfService.generateInvoicePdf(
      (invoiceData as any)._tenantId,
      invoiceData.invoiceId,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${invoiceData.txnNumber || 'download'}.pdf"`);
    res.send(pdfBuffer);
    return;
  }

  // Strip internal fields before sending to client
  const { _tenantId, ...invoice } = invoiceData as any;
  res.json({ invoice });
});

// POST /api/v1/public/invoices/:token/pay — Create Stripe PaymentIntent
publicInvoiceRouter.post('/:token/pay', async (req, res) => {
  const token = req.params['token'] || '';
  const parsed = createPaymentIntentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0]?.message || 'Invalid input' } });
    return;
  }

  const result = await stripeService.createPaymentIntent(token, parsed.data.amount);
  res.json(result);
});

// POST /api/v1/public/invoices/:token/viewed — Mark invoice as viewed (fire-and-forget)
publicInvoiceRouter.post('/:token/viewed', async (req, res) => {
  const token = req.params['token'] || '';
  await publicInvoiceService.markViewed(token);
  res.json({ ok: true });
});
