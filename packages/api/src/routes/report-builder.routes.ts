// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Saved report definitions (memorized reports) and their groups — U-118,
// capability report-defs-v1 (ClientLedger P28 PR-F; ADD-03 Q-310 / Q-312).
// Mounted at /api/v1/report-builder. Since report-defs-builder-v1 (U-119,
// migration 0276) a saved report's kind is 'standard' or 'builder' (Report
// Builder schema v1 from @kis-books/shared); the Report Builder (A07) adds
// its run routes here.
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
import { requirePermission, resolvePermissionsForRequest } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { idempotent } from '../middleware/idempotent.js';
import { AppError } from '../utils/errors.js';
import * as defs from '../services/report-definitions.service.js';
import { REPORT_DEFINITION_KINDS } from '../db/schema/index.js';
import {
  builderDefinitionSchema, BUILDER_STARTERS, RB_ENGINE_ERROR_CODES, RB_ERROR_CODES, RB_SOURCE_INFO, RB_UNAVAILABLE_SOURCES, RB_MEASURE_UNIT,
  RB_FILTER_VALUES, RB_DETAIL_FIELDS,
} from '@kis-books/shared';
import { runRequestSchema, detailRequestSchema } from '../services/report-builder/request.js';
import { runReport, runDetail, type Viewer as RunViewer } from '../services/report-builder/run.js';

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

const standardDefinitionDoc = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('standard'),
  reportKey: z.string().regex(defs.REPORT_KEY_RE).describe('the report, /^[a-z0-9_]{1,64}$/'),
  options: z.record(z.unknown()).describe('report options; ids only at options.filters.{accountIds,contactIds,tagIds,itemIds}, options.tagSplit.tagGroupId, options.columnTagGroupId and options.budgetId'),
}).strict().describe('kind standard: at most 64 KB as JSON (413 DEFINITION_TOO_LARGE); checked by the engine (400 DEFINITION_INVALID {details.path})');

const builderDefinitionDoc = (builderDefinitionSchema as unknown as z.ZodTypeAny).describe(
  'kind builder (report-defs-builder-v1): Report Builder schema v1, strict (unknown keys refused). At most 256 KB as JSON (413 '
  + 'DEFINITION_TOO_LARGE), 200 nodes at any depth, groups nested at most 8 deep, 500 ids or values per filter. Ids only at '
  + 'nodes.**.filters.N.ids and nodes.**.groupBy.N.tagGroupId. 400 DEFINITION_INVALID {details.path, details.code}, code one of '
  + `${[...RB_ERROR_CODES, ...RB_ENGINE_ERROR_CODES].join(', ')}. Text is stored as sent (no trimming; captions may not start or end with a space); lengths count UTF-16 units.`,
);

const definitionDoc = z.union([standardDefinitionDoc, builderDefinitionDoc]);

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

// ── Report Builder runs (U-119, report-builder-v1) ─────────────────

/** Aborts when the client goes away, so the run's query is cancelled (Q-A07l). */
function abortOnClose(req: Request, res: Response): AbortSignal {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  return ac.signal;
}

async function runViewer(req: Request): Promise<RunViewer> {
  return {
    tenantId: req.tenantId, companyId: req.companyId, permissions: await resolvePermissionsForRequest(req),
    userId: req.userId, userRole: req.userRole, isSuperAdmin: req.isSuperAdmin,
  };
}

const RUN_DOC = 'Response `{columns: [{key, caption, kind, field?, range?}], rows: [{kind, nodeId, level, path, caption, cells: (string|null)[], fields?: {txnId, txnType, lineId}, drill?, expandable, expanded, cursor?}], meta: {basis, dates, notes[], truncated, hiddenNotice, denied[]}, fingerprint, stamp}`. '
  + 'Row kinds: header, group, line (a group-by line), detail, subtotal, total, formula, text, blank, page_break, more, denied, earnings, opening. '
  + 'Column kinds: field, total, period, prior, change, pct_change, percent, bucket, and for tb_net the *_debit / *_credit pairs; kind hidden marks a compare amount that only feeds a change (its cells are null). '
  + 'Paths are ["n:<nodeId>", "<key>:<id|value|none>", …]. Amounts are exact strings (never -0); percents 1 place, null on a zero base. '
  + 'Errors: 400 DEFINITION_INVALID {path, code} (also NOT_ON_CASH, MIXED_POLARITY for an account filter), 404 (deleted saved report), 409 STALE_VERSION {current}, 422 REPORT_TOO_LARGE (more than 100,000 group-by lines), 503 REPORT_TIMEOUT (30 s). '
  + 'A section the role cannot see is one denied row, and anything built on it shows null cells.';

reportBuilderRouter.post('/run', describe({
  summary: 'Run a Report Builder report (report-builder-v1)',
  description: 'Runs a builder definition (inline, or saved: definitionId + version) for the dates, one snapshot, 30 s. '
    + 'Display rules: summary returns every group level and no detail; expandable returns level-1 lines and, under expanded paths, deeper lines and detail; detail returns everything. '
    + 'A path is expanded when listed in open (≤ 1,000), or under a defaultExpanded section unless listed in collapsed (≤ 1,000), or with expandAll. '
    + 'Detail rows count toward 5,000 per run (100,000 with purpose export); a cut path ends in a more row whose cursor pages /run/detail. '
    + 'fingerprint hashes every parameter except open, collapsed, expandAll and purpose; stamp is the ledger stamp read in the run snapshot. ' + RUN_DOC,
  body: runRequestSchema,
}), validate(runRequestSchema), async (req, res) => {
  const body = runRequestSchema.parse(req.body);
  res.json(await runReport(await runViewer(req), body, abortOnClose(req, res)));
});

reportBuilderRouter.post('/run/detail', describe({
  summary: 'Page the detail rows of one Report Builder row (report-builder-v1)',
  description: 'The same definition, dates and ranges as the run, the nodeId and path of the row (innermost grouping, or the section without group-bys), range? (a period column), cursor? (from a more row or a previous page), fingerprint and stamp of the run. '
    + 'Response `{rows (≤ 500, kind detail; a range balance starts with an opening row), cursor: string|null, subtotal: cells}`; subtotal is the own cells of the row, for an equality check. '
    + '409 RUN_CHANGED {reason: params} when the fingerprint differs, {reason: books} when the ledger stamp moved; 403 PERMISSION_DENIED for a denied section; 400 CURSOR_INVALID.',
  body: detailRequestSchema,
}), validate(detailRequestSchema), async (req, res) => {
  const body = detailRequestSchema.parse(req.body);
  res.json(await runDetail(await runViewer(req), body, abortOnClose(req, res)));
});

reportBuilderRouter.get('/fields', describe({
  summary: 'Report Builder field catalogue (report-builder-v1)',
  description: 'Response `{sources: {<source>: {key, caption, lines, sign, openItems, measures, accrualOnly, filters, groupBy, detailFields, rights, tiesTo}}, unavailable: [{key, reason}], measureUnits, filterValues, detailFields}` (packages/shared/src/report-builder/fields.ts).',
}), (_req, res) => {
  res.json({ sources: RB_SOURCE_INFO, unavailable: RB_UNAVAILABLE_SOURCES, measureUnits: RB_MEASURE_UNIT, filterValues: RB_FILTER_VALUES, detailFields: RB_DETAIL_FIELDS });
});

reportBuilderRouter.get('/starters', describe({
  summary: 'Report Builder starters (report-builder-starters-v1)',
  description: 'Response `{starters: [{key, title, tiesTo, definition}]}`: builder definitions (schema v1) that reproduce standard reports; '
    + 'tiesTo is the standard report route (/reports/<tiesTo>) a starter ties to, to the cent, when run with the same dates, ranges, fiscal year starts, basis and adjusting '
    + '(packages/shared/src/report-builder/starters.ts; the same definitions as fixtures/starters/*.json).',
}), (_req, res) => {
  res.json({ starters: BUILDER_STARTERS });
});
