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
import * as transfer from '../services/report-transfer.service.js';
import { REPORT_DEFINITION_KINDS } from '../db/schema/index.js';
import {
  builderDefinitionSchema, BUILDER_STARTERS, RB_ENGINE_ERROR_CODES, RB_ERROR_CODES, RB_SOURCE_INFO, RB_UNAVAILABLE_SOURCES, RB_MEASURE_UNIT,
  RB_FILTER_VALUES, RB_DETAIL_FIELDS, RB_PRESET_RE,
} from '@kis-books/shared';
import { runRequestSchema, detailRequestSchema } from '../services/report-builder/request.js';
import { expensiveOpLimiter } from '../middleware/expensive-op-limiter.js';
import * as reportDraft from '../services/report-builder/draft.js';
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
  origin: z.literal('import').optional().describe('report-defs-transfer-v1: import marks a report saved from a report file (audit row after.origin); not stored on the row'),
}).strict();

const updateDefinitionSchema = z.object({
  version: z.number().int().min(1),
  name: name(200).optional(),
  kind: z.enum(REPORT_DEFINITION_KINDS).optional().describe('optional; must equal the saved kind'),
  groupId: z.string().uuid().nullable().optional(),
  definition: z.unknown().optional(),
  origin: z.literal('import').optional().describe('report-defs-transfer-v1: import marks a Replace from a report file (audit row after.origin); not stored on the row'),
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

const ROW_DOC = '`{id, groupId, name, kind, definition, version, createdBy, createdByName, canEdit, updatedAt, missing}`; canEdit is true for the author, an owner or a super admin (Q-310). '
  + 'missing (report-refs-v1, Q-PRA2c): `[{path, nodeId|null, field, kind: account|contact|item|tag|tagGroup|budget, ids, reason: deleted|merged, mergedInto?: {id, label}}]`: '
  + 'reason deleted, ids no longer rows of this company (a deleted tag, tag group or budget); reason merged, a contact or tag merged into another before report-refs-v1 '
  + '(an inactive contact or deleted tag with a merge audit row), mergedInto the live row it went into (through later merges) when this company sees it. A deactivated row '
  + 'that was not merged still works. One entry per path, reason and survivor (path dotted from definition; field the builder filter field, '
  + 'groupBy.tagGroupId, or the standard option path such as filters.tagIds); [] when none. A contact or tag merge rewrites saved reports to the kept row (version + 1). '
  + 'sensitive-accounts-builder-v1 (U-33, Q-309): a report naming an account hidden from the caller has canEdit false, hiddenRefs: true and hidden: '
  + '`[{path, nodeId|null, field, kind: account, ids}]` (as missing, no reason, no name); both keys are absent otherwise. It still runs, hidden.';
const GROUP_DOC = '`{id, name, sort, version, definitionCount, updatedAt}`';

/** 404 for another company's (or a deleted) report; 403 NOT_AUTHOR unless author, owner or super admin. */
async function authorMw(req: Request, _res: Response, next: NextFunction) {
  const row = await defs.definitionForAccess(req.tenantId, req.companyId, uuidParam(req.params['id'], defs.definitionNotFound));
  // U-33 (Q-309): a report naming an account hidden from the caller can't be changed by them (checked again under the lock).
  await defs.assertNoHiddenRefs(row);
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
  description: `Body \`{version, name?, groupId?, kind?, definition?}\` (groupId null moves it to no group; the kind cannot change: kind and definition.kind must equal it). Response: the row with the next version. 403 SENSITIVE_DEFINITION (the report names an account hidden from the caller, U-33), NOT_AUTHOR (only the author, an owner or a super admin, Q-310); 409 STALE_VERSION {details.current}, NAME_TAKEN; 400 DEFINITION_INVALID {details.path}; 413 DEFINITION_TOO_LARGE.`,
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
  description: '204. 403 SENSITIVE_DEFINITION (the report names an account hidden from the caller, U-33), NOT_AUTHOR (only the author, an owner or a super admin); 409 STALE_VERSION {details.current}.',
  params: idParams, query: versionQuery,
}), authorMw, async (req, res) => {
  const { version } = versionQuery.parse(req.query);
  await defs.deleteDefinition(req.tenantId, req.companyId, viewer(req), uuidParam(req.params['id'], defs.definitionNotFound), version);
  res.status(204).end();
});

// ── Transfer (report files) ────────────────────────────────────────

const transferReference = z.object({
  kind: z.enum(['account', 'contact', 'item', 'tag', 'tagGroup', 'budget']),
  name: z.string().max(255).optional(),
  number: z.string().max(20).optional(),
  accountType: z.string().max(40).optional(),
  contactType: z.enum(['customer', 'vendor', 'both']).optional(),
  tagGroupName: z.string().max(100).nullable().optional(),
  fiscalYear: z.number().int().min(1900).max(9999).optional(),
  missing: z.literal(true).optional(),
}).strict();

const exportSchema = z.union([
  z.object({ ids: z.array(z.string().uuid()).min(1).max(transfer.MAX_TRANSFER_REPORTS) }).strict(),
  z.object({ groupId: z.string().uuid() }).strict(),
]);

const previewSchema = z.object({
  reports: z.array(z.object({
    name: name(200),
    groupName: z.string().trim().min(1).max(100).nullable().optional(),
    kind: z.enum(REPORT_DEFINITION_KINDS),
    // Checked by the service (newer schema, tokens) and, once resolved, as a save checks it.
    definition: z.unknown(),
    references: z.array(transferReference).max(5000),
  }).strict()).min(1).max(transfer.MAX_TRANSFER_REPORTS),
  choices: z.record(z.string().regex(/^\d{1,3}:\$ref:\d{1,6}$/), z.string().uuid().nullable()).optional()
    .describe('"<report index>:$ref:N" -> an id of this company (of the reference\'s kind), or null to leave it out'),
}).strict();

const REF_DOC = 'reference `{kind: account|contact|item|tag|tagGroup|budget, name?, number?, accountType?, contactType?: customer|vendor|both, tagGroupName?, fiscalYear?, missing?: true}`';

reportBuilderRouter.post('/definitions/export', describe({
  summary: 'Export saved reports as an id-free report file (report-defs-transfer-v1)',
  description: 'Body `{ids: uuid[1..200]}` or `{groupId}` (every report of the group, by name; more than 200 is 400 VALIDATION_ERROR). '
    + 'Response `{reports: [{name, groupName|null, kind, definition, references}]}` in the order asked: each id at an id path of the definition is replaced by the token "$ref:N" '
    + `(one per distinct id per report), references[N] a ${REF_DOC}; an id that is no longer a row of this company, or an account hidden from the caller (U-33), is {kind, missing: true}. `
    + 'The response holds no ids, no author and no figures. One audit row per report: action download, entity report_definition, after {kind, reportKey, format: clreport}. '
    + 'A report or group not in this company: 404. Reports read access.',
  body: exportSchema,
}), validate(exportSchema), async (req, res) => {
  res.json(await transfer.exportDefinitions(req.tenantId, req.companyId, req.userId, req.body));
});

reportBuilderRouter.post('/definitions/import/preview', describe({
  summary: 'Match a report file to this company (report-defs-transfer-v1)',
  description: 'Body `{reports: [{name, groupName?, kind, definition, references}] (1..200), choices?}` (the export shape). Writes nothing. '
    + 'Matches references in this company (shared rows or this company\'s, inactive included; never an account hidden from the caller, U-33, which is also refused as a choice like an unknown row): account by number when given and only when that account\'s name also matches, case and spacing aside '
    + '(report-refs-v1, Q-PRA2d; a number whose account has another name, or no account, is unresolved: candidates the account with that number, then the accounts of that name), else by name; contact by name and type '
    + '(customer: customer|both, vendor: vendor|both), item by name, tag by name and group name, tag group by name, budget by name and fiscal year; names case-insensitive, trimmed. '
    + 'Response `{reports: [{name, kind, ready, definition, unresolved: [{ref, reference, candidates: [{id, label}] (≤20)}], dropped: [{ref, effect}], groupId|null, '
    + 'nameTaken: {id, version, kind, canEdit}|null, problem?: {path, code}}]}`: definition has the matched and chosen ids in place (tokens left for unresolved references); '
    + 'ready when every reference is resolved or left out and the result passes the save check (else problem {path, code}). '
    + 'Leaving out (choice null), effect: removed_from_list (an id leaves its list; a standard list may end empty), filter_removed (a builder filter whose list empties), '
    + 'group_by_removed (a builder group-by on the tag group), tag_split_removed (standard tagSplit becomes null), columns_total (standard columnTagGroupId removed, columns total); '
    + 'a budget cannot be left out (stays unresolved). groupId: this company\'s group of that name. '
    + 'Errors: 400 DEFINITION_INVALID {path: reports.N.definition…, code: SCHEMA_NEWER} for a newer schemaVersion, {path} for an id path not holding a "$ref:N" token; '
    + '400 VALIDATION_ERROR {field: choices} for a choice of a reference not in the file or a row not in this company.',
  body: previewSchema,
}), validate(previewSchema), async (req, res) => {
  res.json(await transfer.previewImport(req.tenantId, req.companyId, viewer(req), req.body));
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
  + 'The multi-period Total (report-builder-ties-v1) adds flows only: a range report whose sections are all balances (balance, tb_net, open items) has no Total column; in a mixed report a balance\'s Total cell is its last period\'s value. '
  + 'Trial Balance (tb_net) debit / credit are decided per account, as the standard Trial Balance: an account\'s side is its whole net for the section\'s scope (dates, basis, filters; zero or more is debit), and every line, group subtotal and the section Total show their facts in their accounts\' columns, whatever is expanded, so the Total = the standard Trial Balance for every group-by. '
  + 'A slice of an account (account then tag or contact) shows its part in the account\'s column, negative there when it goes against the account\'s side (never positive in the other column); slices sum to their account. '
  + 'Paths are ["n:<nodeId>", "<key>:<id|value|none>", …]. Amounts are exact strings (never -0); percents 1 place, null on a zero base. '
  + 'Errors: 400 DEFINITION_INVALID {path, code} (also NOT_ON_CASH, MIXED_POLARITY for an account filter; NOT_IN_COMPANY for an inline id not of this company; when the cause is a missing record, deleted or merged away, details add missing as on GET), 404 (deleted saved report), 409 STALE_VERSION {current}, '
  + '422 REPORT_REFERENCE_MISSING {path, nodeId, field, kind, ids, reason, mergedInto?, missing: [{path, nodeId, field, kind, ids, reason, mergedInto?}]} (report-refs-v1: a saved report, definitionId, naming a record that no longer exists in this company; as GET missing), '
  + '422 REPORT_TOO_LARGE (more than 100,000 group-by lines), 503 REPORT_TIMEOUT (30 s). '
  + 'Drills: line and total rows {type: detail, nodeId, path} (page /run/detail), detail rows {type: transaction, txnId, txnType}, earnings rows {type: profit_loss, from, to, tagIds?} (tagIds: a tag-filtered section; the lines carry one of them) or null in Trial Balance tag mode; detail rows of open items carry the path of their line. '
  + 'Aging columns age as of the report date: periodRanges (other than one range ending on it) and compareRanges are 400 INVALID_PARAM. '
  + 'A section the role cannot see is one denied row, and anything built on it shows null cells. '
  + 'Sensitive accounts (sensitive-accounts-builder-v1, U-33): lines of accounts hidden from the caller are left out of every row, total, formula, '
  + 'earnings and opening row (a total over all accounts then shows the hidden net as a gap); meta.hiddenNotice is true when the caller has hidden '
  + 'accounts, else null; a drill path keyed on a hidden account is 404; a hidden id in an inline definition is 400 DEFINITION_INVALID NOT_IN_COMPANY.';

reportBuilderRouter.post('/run', describe({
  summary: 'Run a Report Builder report (report-builder-v1)',
  description: 'Runs a builder definition (inline, or saved: definitionId + version) for the dates, one snapshot, 30 s. '
    + 'Display rules: summary returns every group level and no detail; expandable returns level-1 lines and, under expanded paths, deeper lines and detail; detail returns everything. '
    + 'A path is expanded when listed in open (≤ 1,000), or under a defaultExpanded section unless listed in collapsed (≤ 1,000), or with expandAll. '
    + 'Detail rows count toward 5,000 per run (100,000 with purpose export); a cut path ends in a more row whose cursor pages /run/detail. '
    + 'purpose preview (report-builder-preview-v1): at most 50 detail rows per line, after a running-balance line\'s opening row (same query and order as a screen run, so the rows up to the cut are identical); '
    + 'a longer line ends in a more row with its cursor; meta.truncated is true and meta.preview = {detailRowsPerLine: 50}. '
    + 'Signs (report-builder-formula-sign-v1): a section\'s polarity signs only its own rows\' cells and a group\'s shown subtotal; formulas and percentOf node bases use each section\'s normal sign (as if its polarity were natural), so a polarity never changes a formula row. '
    + 'fingerprint hashes every parameter except open, collapsed, expandAll and purpose; stamp is the ledger stamp read in the run snapshot. ' + RUN_DOC,
  body: runRequestSchema,
}), validate(runRequestSchema), async (req, res) => {
  const body = runRequestSchema.parse(req.body);
  res.json(await runReport(await runViewer(req), body, abortOnClose(req, res)));
});

reportBuilderRouter.post('/run/detail', describe({
  summary: 'Page the detail rows of one Report Builder row (report-builder-v1, report-builder-drill-v1)',
  description: 'The same definition, dates and ranges as the run, the nodeId and path of the row, range? (one column), cursor? (from a more row or a previous page), fingerprint and stamp of the run. '
    + 'The path is any drill path of the run (report-builder-drill-v1): a group-by line at any level (all lines under it), a section ["n:<id>"] (its Total: every line of the section plus, for an earnings section, the earnings lines; a Trial Balance adds only the prior years\' income lines, as its earnings row), or an earnings row ["n:<id>", "earnings:prior" | "earnings:current"] (income-statement lines, credit - debit; debit - credit for a tb or debit section). In Trial Balance tag mode the section and earnings paths are 400 INVALID_PARAM. '
    + 'range is the range of one column as the run gave it ({from: null, to} for an as-of column): rows and subtotal hold that column only (its other value columns are null); a range of no column, or a range on aging columns, is 400 INVALID_PARAM. '
    + 'Response `{rows (≤ 500, kind detail; a range balance starts with an opening row), cursor: string|null, subtotal: cells}`; subtotal is the own cells of the row, for an equality check (percent cells are null). A running balance is filled only on an innermost line. '
    + 'report-builder-ties-v1: a balance (balance, tb_net) in a range report starts, on the first page, with an opening row (kind opening, caption "Balance before <first date>") whose amount cells hold each selected column\'s balance before the drill\'s first date (tb_net: on the debit or credit side; the Total cell: the last column\'s), so opening + rows = the row\'s cells; a flow with a running balance keeps its "Opening balance" row with only the running-balance cell. '
    + 'The subtotal fills only the columns the rows fill: without range, compare columns and their changes are null; an open-item drill reads, and fills, the last selected column. With range, a flow\'s multi-period Total cell holds that column\'s share (the rows\' sum), not the run\'s Total. '
    + 'A tb_net row\'s subtotal debit / credit are the row\'s own cells (each account\'s side decided on the whole section, as the run); its detail rows keep each line on its own side, so the rows\' debit - credit = the row\'s debit - credit. '
    + '409 RUN_CHANGED {reason: params} when the fingerprint differs, {reason: books} when the ledger stamp moved; 403 PERMISSION_DENIED for a denied section; 400 CURSOR_INVALID.',
  body: detailRequestSchema,
}), validate(detailRequestSchema), async (req, res) => {
  const body = detailRequestSchema.parse(req.body);
  res.json(await runDetail(await runViewer(req), body, abortOnClose(req, res)));
});

// ── AI draft (U-120, report-builder-ai-v1) ─────────────────────────

export const draftRequestSchema = z.object({
  description: z.string().trim().min(1).max(reportDraft.DRAFT_LIMITS.descriptionChars)
    .describe('the report in plain words, ≤ 1,000 characters'),
  datePresets: z.array(z.string().regex(RB_PRESET_RE)).max(reportDraft.DRAFT_LIMITS.presets).default([])
    .describe('the client\'s date preset keys (/^[a-z0-9_]{1,40}$/, as dates.preset); the draft\'s dates.preset is one of them or left out'),
}).strict();

const DRAFT_DOC = '`{definition, savable, unresolved: [{ref: "$ref:N", kind: account | contact | item | tag | tagGroup, name: string | null, '
  + 'reason: not_found | ambiguous, sites: [{nodeId, path}], candidates: [{id, label}] (≤ 20)}], notes: [{code: pick_unresolved | amount_filter_left_out | '
  + 'preset_left_out | numbers_not_used, message, nodeId?}], reader: self_hosted | cloud, provider, model}`';

reportBuilderRouter.post('/draft', expensiveOpLimiter, describe({
  summary: 'Draft a Report Builder definition with AI (report-builder-ai-v1)',
  description: 'The company\'s AI provider (the chat function, Ollama included) drafts a builder definition (sections, sources, filters, group-bys, '
    + 'columns) from a plain-language description, for the owner to review. Nothing is saved. The model sees the description (PII-redacted), the '
    + 'field catalogue, the sent date presets and names from the books (active accounts, items and tags, tag groups, contacts the description '
    + `names; never an account hidden from the caller, U-33, which is also never resolved or kept); never an amount. Response ${DRAFT_DOC}. The definition is Report Builder schema v1 with engine-made node ids; names are resolved `
    + 'to ids by the engine (the model never gives an id). An unresolved name (none or several matches) leaves the token "$ref:N" at each of its '
    + 'id paths (sites[].path): the token is not an id, so a save or run refuses the definition (400 DEFINITION_INVALID) until the client puts '
    + 'an id there (a candidate, or any row the owner picks) or removes it (an emptied filter, or the tag group-by, must then be removed). savable is '
    + 'true when unresolved is empty: the definition then passes the save check as is. name is null when the model named something that is not '
    + 'in the books and the owner did not type it. One-shot: the body takes a description only, never a definition to redraft. '
    + 'There is no amount filter: an amount condition (in the description, or an amount filter or amount-like key the model gives) is left out '
    + 'and noted as amount_filter_left_out (nodeId when the row is known); the amount itself never reaches the definition or the response. '
    + 'Every number in the description, in any form (digits of any script and format, currencies, ranges, number words such as "five hundred"), '
    + 'is masked before the prompt ([AMOUNT] when it reads as an amount or a limit, else [NUMBER]) and noted: amount_filter_left_out, else '
    + 'numbers_not_used. No digit from the model is kept except the aging bucket keys and exact books names: a title, caption, text row or '
    + 'not-found name with a mask marker is refused (422 number), and so is one with a digit or a number word unless the whole text equals '
    + '(case and spacing aside) the name of an account, contact, item, tag or tag group of this company, found by lookup (the name only, not '
    + 'an account\'s "number name" form; "401(k) Match" is kept, "401(k) Match over 500" is refused). '
    + 'One audit row for every send (whenever the request may have left for a provider): create report_builder_draft (entity the ai_jobs id), '
    + 'after {companyId, provider, model, reader, outcome: drafted, nodes, unresolved, sentTo}, {…, outcome: refused, reason, sentTo} (the 422 reason code) or '
    + '{…, outcome: failed, reason: provider_error | offline} (the call erred or timed out after it was sent; provider the last one tried, model '
    + 'null when its default was used, reader cloud if any provider tried is not local). report-refs-v1 (Q-PRA2e): sentTo [{provider, model, reader, outcome}] lists every provider '
    + 'the names were sent to (the one that answered has the row\'s outcome, the others failed), and on every outcome provider/model are the answering (or last) one and reader '
    + '(audit row and response) is cloud if any provider sent to is not local. Contacts sent are chosen from the description with every number masked. If the engine cannot tell whether bytes left, an '
    + 'attempted send counts as sent. None for 400, 403, a 503 decided before the call (no_provider, function_disabled) or a call no provider '
    + 'took (no credentials, every try refused before connecting); never the description, prompt, reply or definition. '
    + 'Errors: 400 VALIDATION_ERROR (empty or > 1,000 character description, an unknown key); 403 AI_CONSENT_REQUIRED {reason, task: report_summary} '
    + '(AI off, the company not opted in, a stale disclosure, or the report_summary task off; no provider call); 422 DRAFT_UNMAPPED {field, reason} '
    + '(reason no_report, not_json, shape, number, amount_filter (an amount-like key outside a row or filter), id, unknown, missing, duplicate, too_deep, too_many_names, or a shared validator '
    + 'code at a definition path such as MIXED_POLARITY or FORMULA_FORWARD_REF); 503 AI_UNAVAILABLE {provider, reason: no_provider | '
    + 'function_disabled | offline | provider_error}. Reports read access. Not keyed: it changes nothing.',
  body: draftRequestSchema,
}), validate(draftRequestSchema), async (req, res) => {
  const body = draftRequestSchema.parse(req.body);
  res.json(await reportDraft.draft(req.tenantId, req.companyId, body, req.userId));
});

reportBuilderRouter.get('/fields', describe({
  summary: 'Report Builder field catalogue (report-builder-v1)',
  description: 'Response `{sources: {<source>: {key, caption, lines, sign, openItems, measures, accrualOnly, filters, groupBy, detailFields, rights, tiesTo}}, unavailable: [{key, reason}], measureUnits, filterValues, detailFields}` (packages/shared/src/report-builder/fields.ts).',
}), (_req, res) => {
  res.json({ sources: RB_SOURCE_INFO, unavailable: RB_UNAVAILABLE_SOURCES, measureUnits: RB_MEASURE_UNIT, filterValues: RB_FILTER_VALUES, detailFields: RB_DETAIL_FIELDS });
});

reportBuilderRouter.get('/starters', describe({
  summary: 'Report Builder starters (report-builder-starters-v1, v2)',
  description: 'Response `{starters: [{key, title, tiesTo, definition}]}`: builder definitions (schema v1) that reproduce standard reports; '
    + 'tiesTo is the standard report route (/reports/<tiesTo>) a starter ties to, to the cent, when run with the same dates, ranges, fiscal year starts, basis and adjusting '
    + '(packages/shared/src/report-builder/starters.ts; the same definitions as fixtures/starters/*.json). '
    + 'report-builder-starters-v2: every starter has detail fields; Transaction Detail by Account is one natural-sign section per account type; '
    + 'Open Invoices and Unpaid Bills list invoices and bills only.',
}), (_req, res) => {
  res.json({ starters: BUILDER_STARTERS });
});
