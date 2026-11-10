// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Saved report definitions (memorized reports) and their groups — U-118,
// capability report-defs-v1 (ClientLedger P28 PR-F; ADD-03 Q-310 / Q-312).
// Mounted at /api/v1/report-builder; the Report Builder (A07) adds its run
// routes here and widens `kind` to 'builder'.
//
// Permissions (Q-310): every route needs report access ('reports' read,
// like the report packs); saved reports are visible to everyone with it.
// Changing or deleting a saved report needs its author, an owner or a super
// admin, else 403 NOT_AUTHOR; that check (and the 404 for another
// company's row) runs as middleware ahead of idempotent(), so a replay
// still needs it. Groups: anyone with report access.
//
// POST and PUT take Idempotency-Key (idempotency-v1). PUT carries the
// `version` it read in the body, DELETE as ?version=; a mismatch is 409
// STALE_VERSION {details.current}.

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { idempotent } from '../middleware/idempotent.js';
import { AppError } from '../utils/errors.js';
import * as defs from '../services/report-definitions.service.js';
import { REPORT_DEFINITION_KINDS } from '../db/schema/index.js';

export const reportBuilderRouter = Router();
reportBuilderRouter.use(authenticate);
reportBuilderRouter.use(companyContext);
reportBuilderRouter.use(requirePermission('reports', 'read'));

const idParams = z.object({ id: z.string().uuid() });

function uuidParam(value: string | undefined, notFound: () => AppError): string {
  if (!value || !z.string().uuid().safeParse(value).success) throw notFound();
  return value;
}

const viewer = (req: Request): defs.Viewer => ({ userId: req.userId, userRole: req.userRole, isSuperAdmin: req.isSuperAdmin });

const name = (max: number) => z.string().trim().min(1).max(max);

const definitionDoc = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(REPORT_DEFINITION_KINDS),
  reportKey: z.string().regex(defs.REPORT_KEY_RE).describe('the report, /^[a-z0-9_]{1,64}$/'),
  options: z.record(z.unknown()).describe('report options; ids only at options.filters.{accountIds,contactIds,tagIds,itemIds}, options.tagSplit.tagGroupId and options.budgetId'),
}).strict().describe('at most 64 KB as JSON (413 DEFINITION_TOO_LARGE); checked by the engine (400 DEFINITION_INVALID {details.path})');

const createDefinitionSchema = z.object({
  name: name(200),
  groupId: z.string().uuid().nullable().optional(),
  kind: z.enum(REPORT_DEFINITION_KINDS).optional().describe('optional; must equal definition.kind'),
  // Checked by the service so its errors carry DEFINITION_INVALID / DEFINITION_TOO_LARGE.
  definition: z.unknown(),
}).strict();

const updateDefinitionSchema = z.object({
  version: z.number().int().min(1),
  name: name(200).optional(),
  kind: z.enum(REPORT_DEFINITION_KINDS).optional().describe('optional; must equal the saved kind'),
  groupId: z.string().uuid().nullable().optional(),
  definition: z.unknown().optional(),
}).strict();

const groupCreateSchema = z.object({ name: name(100), sort: z.number().int().min(0).max(100_000).optional() }).strict();
const groupUpdateSchema = z.object({
  version: z.number().int().min(1), name: name(100).optional(), sort: z.number().int().min(0).max(100_000).optional(),
}).strict();
const versionQuery = z.object({ version: z.coerce.number().int().min(1) });

const listQuery = z.object({
  groupId: z.union([z.string().uuid(), z.literal('none')]).optional().describe('a group id, or none for reports in no group'),
  kind: z.enum(REPORT_DEFINITION_KINDS).optional(),
});

/**
 * The documented body: `definition` is checked by the service (so its errors
 * are DEFINITION_INVALID / DEFINITION_TOO_LARGE), but documented in full.
 * Placed after validate(): the OpenAPI export takes the last body in the chain.
 */
const bodyDoc = (schema: z.ZodTypeAny) => describe({ body: schema });

const ROW_DOC = '`{id, groupId, name, kind, definition, version, createdBy, createdByName, canEdit, updatedAt}`; canEdit is true for the author, an owner or a super admin (Q-310).';
const GROUP_DOC = '`{id, name, sort, version, definitionCount, updatedAt}`';

/** 404 for another company's (or a deleted) report; 403 NOT_AUTHOR unless author, owner or super admin. */
async function authorMw(req: Request, _res: Response, next: NextFunction) {
  const row = await defs.definitionForAccess(req.tenantId, req.companyId, uuidParam(req.params['id'], defs.definitionNotFound));
  if (!defs.canEdit(row, viewer(req))) throw defs.notAuthor();
  next();
}

async function groupInCompanyMw(req: Request, _res: Response, next: NextFunction) {
  await defs.getGroup(req.tenantId, req.companyId, uuidParam(req.params['id'], defs.groupNotFound));
  next();
}

// ── Definitions ────────────────────────────────────────────────────

reportBuilderRouter.get('/definitions', describe({
  summary: 'List saved reports (report-defs-v1)',
  description: `Every saved report of the company, by name. Response \`{definitions: [row]}\`, row ${ROW_DOC}`,
  query: listQuery,
}), async (req, res) => {
  const q = listQuery.parse(req.query);
  res.json({ definitions: await defs.listDefinitions(req.tenantId, req.companyId, viewer(req), q) });
});

reportBuilderRouter.post('/definitions', describe({
  summary: 'Save a report (report-defs-v1)',
  description: `Body \`{name, groupId?, kind?, definition: {schemaVersion: 1, kind: 'standard', reportKey, options}}\`. Response 201: the row, ${ROW_DOC} The caller is the author. 400 DEFINITION_INVALID {details.path} (shape, a uuid outside the id paths, or an id not in this company), VALIDATION_ERROR {details.field: groupId}; 409 NAME_TAKEN (names are unique per company, case-insensitive, among saved reports not deleted); 413 DEFINITION_TOO_LARGE {details.limit}.`,
}), validate(createDefinitionSchema), bodyDoc(createDefinitionSchema.extend({ definition: definitionDoc })), idempotent({
  successStatus: 201,
  replay: async (req, entity) => defs.getDefinition(req.tenantId, req.companyId, entity!.id, viewer(req)),
}), async (req, res) => {
  res.status(201).json(await defs.createDefinition(req.tenantId, req.companyId, viewer(req), req.body));
});

reportBuilderRouter.get('/definitions/:id', describe({
  summary: 'Get a saved report (report-defs-v1)',
  description: `Response: the row, ${ROW_DOC} Another company's or a deleted report: 404.`,
  params: idParams,
}), async (req, res) => {
  const id = uuidParam(req.params['id'], defs.definitionNotFound);
  res.json(await defs.getDefinition(req.tenantId, req.companyId, id, viewer(req)));
});

reportBuilderRouter.put('/definitions/:id', describe({
  summary: 'Change a saved report (report-defs-v1)',
  description: `Body \`{version, name?, groupId?, kind?, definition?}\` (groupId null moves it to no group; the kind cannot change: kind and definition.kind must equal it). Response: the row with the next version. 403 NOT_AUTHOR (only the author, an owner or a super admin, Q-310); 409 STALE_VERSION {details.current}, NAME_TAKEN; 400 DEFINITION_INVALID {details.path}; 413 DEFINITION_TOO_LARGE.`,
  params: idParams,
}), authorMw, idempotent({
  successStatus: 200,
  replay: async (req) => defs.getDefinition(req.tenantId, req.companyId, req.params['id']!, viewer(req)),
}), validate(updateDefinitionSchema), bodyDoc(updateDefinitionSchema.extend({ definition: definitionDoc.optional() })), async (req, res) => {
  const id = uuidParam(req.params['id'], defs.definitionNotFound);
  res.json(await defs.updateDefinition(req.tenantId, req.companyId, viewer(req), id, req.body));
});

reportBuilderRouter.delete('/definitions/:id', describe({
  summary: 'Delete a saved report (soft) (report-defs-v1)',
  description: '204. 403 NOT_AUTHOR (only the author, an owner or a super admin); 409 STALE_VERSION {details.current}.',
  params: idParams, query: versionQuery,
}), authorMw, async (req, res) => {
  const { version } = versionQuery.parse(req.query);
  await defs.deleteDefinition(req.tenantId, req.companyId, viewer(req), uuidParam(req.params['id'], defs.definitionNotFound), version);
  res.status(204).end();
});

// ── Groups ─────────────────────────────────────────────────────────

reportBuilderRouter.get('/definition-groups', describe({
  summary: 'List saved-report groups (report-defs-v1)',
  description: `Response \`{groups: [group]}\` by sort then name, group ${GROUP_DOC}.`,
}), async (req, res) => {
  res.json({ groups: await defs.listGroups(req.tenantId, req.companyId) });
});

reportBuilderRouter.post('/definition-groups', describe({
  summary: 'Create a saved-report group (report-defs-v1)',
  description: `Response 201: the group, ${GROUP_DOC}. 409 NAME_TAKEN (unique per company, case-insensitive, among groups not deleted).`,
}), validate(groupCreateSchema), idempotent({
  successStatus: 201,
  replay: async (req, entity) => defs.getGroup(req.tenantId, req.companyId, entity!.id),
}), async (req, res) => {
  res.status(201).json(await defs.createGroup(req.tenantId, req.companyId, req.userId, req.body));
});

reportBuilderRouter.put('/definition-groups/:id', describe({
  summary: 'Rename or reorder a saved-report group (report-defs-v1)',
  description: 'Body `{version, name?, sort?}`. Response: the group. 409 STALE_VERSION {details.current}, NAME_TAKEN.',
  params: idParams,
}), groupInCompanyMw, idempotent({
  successStatus: 200,
  replay: async (req) => defs.getGroup(req.tenantId, req.companyId, req.params['id']!),
}), validate(groupUpdateSchema), async (req, res) => {
  const id = uuidParam(req.params['id'], defs.groupNotFound);
  res.json(await defs.updateGroup(req.tenantId, req.companyId, req.userId, id, req.body));
});

reportBuilderRouter.delete('/definition-groups/:id', describe({
  summary: 'Delete a saved-report group (soft); its reports move to no group (report-defs-v1)',
  description: '204. Each moved report gets a new version (audited). 409 STALE_VERSION {details.current}.',
  params: idParams, query: versionQuery,
}), async (req, res) => {
  const { version } = versionQuery.parse(req.query);
  await defs.deleteGroup(req.tenantId, req.companyId, req.userId, uuidParam(req.params['id'], defs.groupNotFound), version);
  res.status(204).end();
});
