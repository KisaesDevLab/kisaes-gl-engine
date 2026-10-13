// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import {
  putAccountTreatmentsSchema, putTransactionFlagsSchema, taxEstEntityParamsSchema, taxEstEntityYearParamsSchema,
  taxEstEntityYearQuerySchema, taxEstListQuerySchema, taxEstReadinessQuerySchema, taxEstTaxBasisPlQuerySchema, upsertEntitySettingsSchema,
  upsertEntityYearInputsSchema,
} from '@kis-books/shared';
import { getScope, requireTaxEstimatorWrite } from '../../middleware/tax-estimator-scope.js';
import { listPageQuerySchema, pageOf } from './paging.js';
import * as entitySettingsService from '../../services/tax-estimator/entity-settings.service.js';
import * as treatmentsService from '../../services/tax-estimator/treatments.service.js';
import * as plProviderService from '../../services/tax-estimator/pl-provider.service.js';
import * as readinessService from '../../services/tax-estimator/readiness.service.js';

// entities router — mounted by tax-estimator.routes.ts AFTER its guard chain
// (session auth, client 404, flag, resource, firm scope).
//
// :tenantId/:companyId are PATH parameters naming the books being read. They
// are never authority: every service call re-checks the tenant against the
// server-resolved FirmScope (404 TE_TENANT_NOT_MANAGED) before any query, and
// loads the company strictly by (tenant_id, id). Reads are open to every firm
// member; mutations need firm_admin / firm_staff (requireTaxEstimatorWrite).
export const entitiesRouter = Router();

const BASE = '/:tenantId/:companyId';

entitiesRouter.get(`${BASE}/settings`, async (req, res) => {
  const { tenantId, companyId } = taxEstEntityParamsSchema.parse(req.params);
  // Q49: ?taxYear= resolves the entity type for that year (its per-year override applies).
  const { taxYear } = taxEstEntityYearQuerySchema.parse(req.query);
  res.json({ data: await entitySettingsService.getEntitySettings(getScope(req), tenantId, companyId, taxYear) });
});

entitiesRouter.put(`${BASE}/settings`, requireTaxEstimatorWrite, async (req, res) => {
  const { tenantId, companyId } = taxEstEntityParamsSchema.parse(req.params);
  const input = upsertEntitySettingsSchema.parse(req.body);
  const { taxYear } = taxEstEntityYearQuerySchema.parse(req.query);
  res.json({ data: await entitySettingsService.upsertEntitySettings(getScope(req), tenantId, companyId, input, req.userId, taxYear) });
});

entitiesRouter.get(`${BASE}/year-inputs/:taxYear`, async (req, res) => {
  const { tenantId, companyId, taxYear } = taxEstEntityYearParamsSchema.parse(req.params);
  res.json({ data: await entitySettingsService.getYearInputs(getScope(req), tenantId, companyId, taxYear) });
});

entitiesRouter.put(`${BASE}/year-inputs/:taxYear`, requireTaxEstimatorWrite, async (req, res) => {
  const { tenantId, companyId, taxYear } = taxEstEntityYearParamsSchema.parse(req.params);
  const input = upsertEntityYearInputsSchema.parse(req.body);
  res.json({ data: await entitySettingsService.upsertYearInputs(getScope(req), tenantId, companyId, taxYear, input, req.userId) });
});

entitiesRouter.get(`${BASE}/treatments`, async (req, res) => {
  const { tenantId, companyId } = taxEstEntityParamsSchema.parse(req.params);
  const page = taxEstListQuerySchema.parse(req.query);
  res.json({ data: await treatmentsService.listTreatments(getScope(req), tenantId, companyId, page) });
});

entitiesRouter.put(`${BASE}/treatments`, requireTaxEstimatorWrite, async (req, res) => {
  const { tenantId, companyId } = taxEstEntityParamsSchema.parse(req.params);
  const { treatments } = putAccountTreatmentsSchema.parse(req.body);
  res.json({ data: await treatmentsService.putTreatments(getScope(req), tenantId, companyId, treatments, req.userId) });
});

// Suggestions only — the client confirms each one through PUT /treatments.
entitiesRouter.get(`${BASE}/treatment-suggestions`, async (req, res) => {
  const { tenantId, companyId } = taxEstEntityParamsSchema.parse(req.params);
  const { taxYear } = taxEstEntityYearQuerySchema.parse({ taxYear: req.query['taxYear'] });
  res.json(pageOf(await treatmentsService.suggestTreatments(getScope(req), tenantId, companyId, taxYear), listPageQuerySchema.parse(req.query)));
});

entitiesRouter.get(`${BASE}/transaction-flags`, async (req, res) => {
  const { tenantId, companyId } = taxEstEntityParamsSchema.parse(req.params);
  const page = taxEstListQuerySchema.parse(req.query);
  res.json({ data: await treatmentsService.listTransactionFlags(getScope(req), tenantId, companyId, page) });
});

entitiesRouter.put(`${BASE}/transaction-flags`, requireTaxEstimatorWrite, async (req, res) => {
  const { tenantId, companyId } = taxEstEntityParamsSchema.parse(req.params);
  const input = putTransactionFlagsSchema.parse(req.body);
  res.json({ data: await treatmentsService.putTransactionFlags(getScope(req), tenantId, companyId, input, req.userId) });
});

entitiesRouter.get(`${BASE}/readiness`, async (req, res) => {
  const { tenantId, companyId } = taxEstEntityParamsSchema.parse(req.params);
  const { through, taxYear } = taxEstReadinessQuerySchema.parse(req.query);
  res.json({ data: await readinessService.getReadiness(getScope(req), { tenantId, companyId, taxYear, throughMonth: through }) });
});

entitiesRouter.get(`${BASE}/tax-basis-pl`, async (req, res) => {
  const { tenantId, companyId } = taxEstEntityParamsSchema.parse(req.params);
  const { taxYear, through } = taxEstTaxBasisPlQuerySchema.parse(req.query);
  res.json({ data: await plProviderService.getTaxBasisPl(getScope(req), { tenantId, companyId, taxYear, throughMonth: through }) });
});
