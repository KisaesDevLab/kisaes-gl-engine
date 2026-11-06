// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Units of measure (U-161, units-of-measure-v1): unit sets with a base unit
// and related units with fixed factors. The items resource (units belong to
// items). Idempotency-Key on create, as items.

import { Router } from 'express';
import { z } from 'zod';
import { createUnitSetSchema, updateUnitSetSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { idempotent } from '../middleware/idempotent.js';
import { describe } from '../middleware/describe.js';
import { AppError } from '../utils/errors.js';
import * as units from '../services/units.service.js';

export const unitSetsRouter = Router();
unitSetsRouter.use(authenticate);
unitSetsRouter.use(companyContext);
unitSetsRouter.use(requireResource('items'));

const idParams = z.object({ id: z.string().uuid() });
const idOr404 = (id: string | undefined) => {
  if (!id || !z.string().uuid().safeParse(id).success) throw AppError.notFound('Unit set not found');
  return id;
};

const record = 'Record: {id, name, baseUnitName, baseUnitAbbreviation, isActive, units: [{id, name, abbreviation, factor (6-place string, base '
  + 'units per unit)}], inUse (an item names the set or a line names one of its units), updatedAt}.';
const rules = 'units-of-measure-v1 (Q-P24i): a set has a base unit and other units, each factor = base units per unit, a decimal string above 0 '
  + 'with at most 6 places, at most 1,000,000 (400 VALIDATION_ERROR otherwise); unit names are unique in the set, the base unit included (400 '
  + 'VALIDATION_ERROR); set names unique in the company (409 DUPLICATE_NAME). Lines in a unit store baseQuantity = round4(quantity x factor), half '
  + `away from zero. ${record}`;

unitSetsRouter.get('/', describe({
  summary: 'List unit sets',
  description: `Response {data, total}: the company's unit sets by name. ${rules}`,
}), async (req, res) => {
  res.json(await units.listUnitSets(req.tenantId, req.companyId));
});

unitSetsRouter.post('/', idempotent({
  successStatus: 201,
  replay: async (req, entity) => ({ unitSet: await units.getUnitSet(req.tenantId, entity!.id, req.companyId) }),
}), validate(createUnitSetSchema), describe({
  summary: 'Create a unit set',
  description: `Response 201 {unitSet}. Body {name, baseUnitName, baseUnitAbbreviation?, units: [{name, abbreviation?, factor}]}. ${rules}`,
  body: createUnitSetSchema,
}), async (req, res) => {
  res.status(201).json({ unitSet: await units.createUnitSet(req.tenantId, req.body, req.userId, req.companyId) });
});

unitSetsRouter.get('/:id', describe({
  summary: 'Get a unit set',
  description: `Response {unitSet}. Of another company: 404. ${rules}`,
  params: idParams,
}), async (req, res) => {
  res.json({ unitSet: await units.getUnitSet(req.tenantId, idOr404(req.params['id']), req.companyId) });
});

unitSetsRouter.put('/:id', validate(updateUnitSetSchema), describe({
  summary: 'Edit a unit set',
  description: 'Response {unitSet}. The set and its units are locked; expectedUpdatedAt (updatedAt as last read) that no longer matches is 409 '
    + 'STALE. units, when sent, is the whole list: kept units by id (an id not in the set is 400 VALIDATION_ERROR), new ones without; a unit '
    + 'left out is removed. A unit named on any transaction line keeps its factor and can not be removed, and a unit an item uses as its default '
    + 'purchase or sale unit can not be removed: 409 UNIT_IN_USE (Q-P24w; add a new unit instead). Names, abbreviations and isActive may '
    + `change. ${rules}`,
  body: updateUnitSetSchema,
  params: idParams,
}), async (req, res) => {
  res.json({ unitSet: await units.updateUnitSet(req.tenantId, idOr404(req.params['id']), req.body, req.userId, req.companyId) });
});

unitSetsRouter.delete('/:id', describe({
  summary: 'Delete a unit set',
  description: 'Response {id, deleted: true}. Only while no item names the set and no transaction line names its units; otherwise 409 '
    + 'UNIT_IN_USE (make it inactive with PUT isActive false instead). Of another company: 404.',
  params: idParams,
}), async (req, res) => {
  res.json(await units.deleteUnitSet(req.tenantId, idOr404(req.params['id']), req.userId, req.companyId));
});
