// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router, type Request } from 'express';
import {
  createTaxpayerSchema, updateTaxpayerSchema, listTaxpayersQuerySchema, taxpayerIdParamsSchema,
  personRoleParamsSchema, upsertPersonSchema, linksQuerySchema, upsertLinkSchema, linkIdParamsSchema,
  companyOptionsQuerySchema, linkContactSchema, contactIdParamsSchema, unlinkContactQuerySchema,
} from '@kis-books/shared';
import { getScope, requireTaxEstimatorWrite } from '../../middleware/tax-estimator-scope.js';
import { listPageQuerySchema, pageOf } from './paging.js';
import * as taxpayersService from '../../services/tax-estimator/taxpayers.service.js';

// taxpayers router — mounted by tax-estimator.routes.ts AFTER its guard chain
// (session auth, client 404, flag, resource, firm scope). The firm and the
// allowed-tenant set come ONLY from req.taxEstimatorScope; nothing about the
// firm, role or tenant list is read from the request. Reads are open to every
// firm member; mutations need firm_admin / firm_staff (requireTaxEstimatorWrite).
export const taxpayersRouter = Router();

const actor = (req: Request): taxpayersService.Actor => ({ tenantId: req.tenantId, userId: req.userId });

// GET /company-options?q= — registered before /:id so "company-options" is never read as an id.
taxpayersRouter.get('/company-options', async (req, res) => {
  const query = companyOptionsQuerySchema.parse(req.query);
  res.json(await taxpayersService.listCompanyOptions(getScope(req), query));
});

taxpayersRouter.get('/', async (req, res) => {
  const query = listTaxpayersQuerySchema.parse(req.query);
  res.json(await taxpayersService.listTaxpayers(getScope(req), query));
});

taxpayersRouter.post('/', requireTaxEstimatorWrite, async (req, res) => {
  const input = createTaxpayerSchema.parse(req.body);
  res.status(201).json({ data: await taxpayersService.createTaxpayer(getScope(req), actor(req), input) });
});

taxpayersRouter.get('/:id', async (req, res) => {
  const { id } = taxpayerIdParamsSchema.parse(req.params);
  res.json({ data: await taxpayersService.getTaxpayer(getScope(req), id) });
});

taxpayersRouter.patch('/:id', requireTaxEstimatorWrite, async (req, res) => {
  const { id } = taxpayerIdParamsSchema.parse(req.params);
  const input = updateTaxpayerSchema.parse(req.body);
  res.json({ data: await taxpayersService.updateTaxpayer(getScope(req), actor(req), id, input) });
});

taxpayersRouter.delete('/:id', requireTaxEstimatorWrite, async (req, res) => {
  const { id } = taxpayerIdParamsSchema.parse(req.params);
  res.json({ data: await taxpayersService.archiveTaxpayer(getScope(req), actor(req), id) });
});

// ── persons ──
taxpayersRouter.put('/:id/persons/:role', requireTaxEstimatorWrite, async (req, res) => {
  const { id, role } = personRoleParamsSchema.parse(req.params);
  const input = upsertPersonSchema.parse(req.body);
  res.json({ data: await taxpayersService.upsertPerson(getScope(req), actor(req), id, role, input) });
});

taxpayersRouter.delete('/:id/persons/:role', requireTaxEstimatorWrite, async (req, res) => {
  const { id, role } = personRoleParamsSchema.parse(req.params);
  res.json({ data: await taxpayersService.removePerson(getScope(req), actor(req), id, role) });
});

// ── links ──
taxpayersRouter.get('/:id/links', async (req, res) => {
  const { id } = taxpayerIdParamsSchema.parse(req.params);
  const { taxYear } = linksQuerySchema.parse(req.query);
  const list = await taxpayersService.listLinks(getScope(req), id, taxYear);
  res.json({ ...list, ...pageOf(list.data, listPageQuerySchema.parse(req.query)) });
});

taxpayersRouter.put('/:id/links', requireTaxEstimatorWrite, async (req, res) => {
  const { id } = taxpayerIdParamsSchema.parse(req.params);
  const input = upsertLinkSchema.parse(req.body);
  res.json({ data: await taxpayersService.upsertLink(getScope(req), actor(req), id, input) });
});

taxpayersRouter.delete('/:id/links/:linkId', requireTaxEstimatorWrite, async (req, res) => {
  const { id, linkId } = linkIdParamsSchema.parse(req.params);
  await taxpayersService.removeLink(getScope(req), actor(req), id, linkId);
  res.status(204).end();
});

// ── portal contacts ──
taxpayersRouter.get('/:id/contacts', async (req, res) => {
  const { id } = taxpayerIdParamsSchema.parse(req.params);
  const list = await taxpayersService.listContacts(getScope(req), id);
  res.json({ ...list, ...pageOf(list.data, listPageQuerySchema.parse(req.query)) });
});

taxpayersRouter.post('/:id/contacts', requireTaxEstimatorWrite, async (req, res) => {
  const { id } = taxpayerIdParamsSchema.parse(req.params);
  const input = linkContactSchema.parse(req.body);
  res.status(201).json({ data: await taxpayersService.linkContact(getScope(req), actor(req), id, input) });
});

taxpayersRouter.delete('/:id/contacts/:contactId', requireTaxEstimatorWrite, async (req, res) => {
  const { id, contactId } = contactIdParamsSchema.parse(req.params);
  const { revokeAccess } = unlinkContactQuerySchema.parse(req.query);
  res.json({ data: await taxpayersService.unlinkContact(getScope(req), actor(req), id, contactId, revokeAccess) });
});
