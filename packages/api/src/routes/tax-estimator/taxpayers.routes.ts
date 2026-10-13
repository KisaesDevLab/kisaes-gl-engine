// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router, type Request } from 'express';
import {
  createTaxpayerSchema, updateTaxpayerSchema, listTaxpayersQuerySchema, taxpayerIdParamsSchema,
  personRoleParamsSchema, upsertPersonSchema, linksQuerySchema, upsertLinkSchema, linkIdParamsSchema,
  companyOptionsQuerySchema, linkContactSchema, contactIdParamsSchema, unlinkContactQuerySchema,
  replaceTaxpayerStaffSchema, can, upsertDependentSchema, dependentIdParamsSchema,
  outsideEntitiesQuerySchema, upsertOutsideEntitySchema, upsertOutsideEntityYearSchema, outsideEntityIdParamsSchema, outsideEntityYearParamsSchema,
} from '@kis-books/shared';
import { resolvePermissionsForRequest } from '../../middleware/permission.js';
import { getScope, requireTaxEstimatorWrite } from '../../middleware/tax-estimator-scope.js';
import { listPageQuerySchema, pageOf } from './paging.js';
import * as taxpayersService from '../../services/tax-estimator/taxpayers.service.js';
import * as staffService from '../../services/tax-estimator/taxpayer-staff.service.js';

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

// ── dependents (Q44) — part of the taxpayer: same visibility as persons, writes need requireTaxEstimatorWrite ──
taxpayersRouter.get('/:id/dependents', async (req, res) => {
  const { id } = taxpayerIdParamsSchema.parse(req.params);
  const list = await taxpayersService.listDependents(getScope(req), id);
  res.json({ ...list, ...pageOf(list.data, listPageQuerySchema.parse(req.query)) });
});

taxpayersRouter.post('/:id/dependents', requireTaxEstimatorWrite, async (req, res) => {
  const { id } = taxpayerIdParamsSchema.parse(req.params);
  const input = upsertDependentSchema.parse(req.body);
  res.status(201).json({ data: await taxpayersService.createDependent(getScope(req), actor(req), id, input) });
});

taxpayersRouter.put('/:id/dependents/:dependentId', requireTaxEstimatorWrite, async (req, res) => {
  const { id, dependentId } = dependentIdParamsSchema.parse(req.params);
  const input = upsertDependentSchema.parse(req.body);
  res.json({ data: await taxpayersService.updateDependent(getScope(req), actor(req), id, dependentId, input) });
});

taxpayersRouter.delete('/:id/dependents/:dependentId', requireTaxEstimatorWrite, async (req, res) => {
  const { id, dependentId } = dependentIdParamsSchema.parse(req.params);
  res.json({ data: await taxpayersService.removeDependent(getScope(req), actor(req), id, dependentId) });
});

// ── businesses outside MyBooks (Q45) — part of the taxpayer like dependents; writes need requireTaxEstimatorWrite ──
taxpayersRouter.get('/:id/outside-entities', async (req, res) => {
  const { id } = taxpayerIdParamsSchema.parse(req.params);
  const { taxYear } = outsideEntitiesQuerySchema.parse(req.query);
  const list = await taxpayersService.listOutsideEntities(getScope(req), id, taxYear);
  res.json({ ...list, ...pageOf(list.data, listPageQuerySchema.parse(req.query)) });
});

taxpayersRouter.post('/:id/outside-entities', requireTaxEstimatorWrite, async (req, res) => {
  const { id } = taxpayerIdParamsSchema.parse(req.params);
  const input = upsertOutsideEntitySchema.parse(req.body);
  res.status(201).json({ data: await taxpayersService.createOutsideEntity(getScope(req), actor(req), id, input) });
});

taxpayersRouter.put('/:id/outside-entities/:outsideEntityId', requireTaxEstimatorWrite, async (req, res) => {
  const { id, outsideEntityId } = outsideEntityIdParamsSchema.parse(req.params);
  const input = upsertOutsideEntitySchema.parse(req.body);
  res.json({ data: await taxpayersService.updateOutsideEntity(getScope(req), actor(req), id, outsideEntityId, input) });
});

taxpayersRouter.delete('/:id/outside-entities/:outsideEntityId', requireTaxEstimatorWrite, async (req, res) => {
  const { id, outsideEntityId } = outsideEntityIdParamsSchema.parse(req.params);
  res.json({ data: await taxpayersService.removeOutsideEntity(getScope(req), actor(req), id, outsideEntityId) });
});

taxpayersRouter.put('/:id/outside-entities/:outsideEntityId/years/:taxYear', requireTaxEstimatorWrite, async (req, res) => {
  const { id, outsideEntityId, taxYear } = outsideEntityYearParamsSchema.parse(req.params);
  const input = upsertOutsideEntityYearSchema.parse(req.body);
  res.json({ data: await taxpayersService.upsertOutsideEntityYear(getScope(req), actor(req), id, outsideEntityId, taxYear, input) });
});

taxpayersRouter.delete('/:id/outside-entities/:outsideEntityId/years/:taxYear', requireTaxEstimatorWrite, async (req, res) => {
  const { id, outsideEntityId, taxYear } = outsideEntityYearParamsSchema.parse(req.params);
  res.json({ data: await taxpayersService.removeOutsideEntityYear(getScope(req), actor(req), id, outsideEntityId, taxYear) });
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

// QA D11: contacts of the taxpayer's linked client companies (any tenant in scope), for the picker.
taxpayersRouter.get('/:id/contact-candidates', async (req, res) => {
  const { id } = taxpayerIdParamsSchema.parse(req.params);
  const list = await taxpayersService.listContactCandidates(getScope(req), id);
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

// ── D17: who can see this taxpayer (staff allow-list) ──
// Read: anyone who can see the taxpayer. Change / candidates: firm admins and super admins
// only (403 TE_FIRM_ADMIN_REQUIRED). A taxpayer the caller cannot see is a 404 first.
// `canEdit` mirrors GET /scope `canWrite` (a member whose active-tenant role is readonly
// gets the read-only card).
const canWrite = async (req: Request) => can(await resolvePermissionsForRequest(req), 'tax_estimator', 'update');

taxpayersRouter.get('/:id/staff', async (req, res) => {
  const { id } = taxpayerIdParamsSchema.parse(req.params);
  res.json({ data: await staffService.getTaxpayerStaff(getScope(req), id, await canWrite(req)) });
});

taxpayersRouter.get('/:id/staff-candidates', async (req, res) => {
  const { id } = taxpayerIdParamsSchema.parse(req.params);
  res.json(await staffService.getStaffCandidates(getScope(req), id, req.tenantId));
});

taxpayersRouter.put('/:id/staff', requireTaxEstimatorWrite, async (req, res) => {
  const { id } = taxpayerIdParamsSchema.parse(req.params);
  const { userIds } = replaceTaxpayerStaffSchema.parse(req.body);
  res.json({ data: await staffService.replaceTaxpayerStaff(getScope(req), actor(req), id, userIds, await canWrite(req)) });
});
