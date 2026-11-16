// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permission.js';
import { db } from '../db/index.js';
import { sql, type SQL } from 'drizzle-orm';
import { companyContext } from '../middleware/company.js';
import { describe } from '../middleware/describe.js';
import { AppError } from '../utils/errors.js';
import { toCsvRow } from '../services/export.service.js';
import { escapeLike } from '../utils/sql-like.js';
import { hiddenAccountIds } from '../services/visibility.js';

export const auditRouter = Router();
auditRouter.use(authenticate);
auditRouter.use(requirePermission('audit_log', 'read'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The JSON object of an audit image column (auditLog() stores JSON text; migrations wrote objects). */
const doc = (col: string) => sql.raw(`(CASE WHEN jsonb_typeof(${col}) = 'string' THEN (${col} #>> '{}')::jsonb ELSE ${col} END)`);

/**
 * Filters shared by the list and the CSV export. audit-filters-v1 adds
 * `user_id`, `entity_id` (uuids, else 400 VALIDATION_ERROR) and `company`
 * (`current` = the request's company as X-Company-Id selects it, or a
 * company id of the tenant): a row belongs to a company through its
 * company_id, its transaction, the company it is about, or the companyId of
 * its images; rows that belong to no company (users, tenant settings) are
 * kept, rows of another company are left out.
 */
async function auditFilters(req: Request): Promise<SQL> {
  const { entity_type, action, start_date, end_date, search, user_id, entity_id, company } = req.query as Record<string, string>;
  const conditions = [sql`a.tenant_id = ${req.tenantId}`];
  if (entity_type) conditions.push(sql`a.entity_type = ${entity_type}`);
  if (action) conditions.push(sql`a.action = ${action}`);
  if (start_date) conditions.push(sql`a.created_at >= ${start_date}::timestamptz`);
  if (end_date) conditions.push(sql`a.created_at <= ${end_date}::timestamptz + interval '1 day'`);
  if (search) {
    const pattern = '%' + escapeLike(String(search)) + '%';
    conditions.push(sql`(a.entity_type ILIKE ${pattern} OR CAST(a.before_data AS TEXT) ILIKE ${pattern} OR CAST(a.after_data AS TEXT) ILIKE ${pattern})`);
  }
  for (const [name, value] of [['user_id', user_id], ['entity_id', entity_id]] as const) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      throw AppError.badRequest(`${name} must be a uuid`, 'VALIDATION_ERROR', { field: name });
    }
  }
  if (user_id) conditions.push(sql`a.user_id = ${user_id}::uuid`);
  if (entity_id) conditions.push(sql`a.entity_id = ${entity_id}::uuid`);
  if (company !== undefined) {
    if (company !== 'current' && !(typeof company === 'string' && UUID_RE.test(company))) {
      throw AppError.badRequest('company must be "current" or a company id', 'VALIDATION_ERROR', { field: 'company' });
    }
    // The company rules of every company-scoped route (tenant, accountant
    // exclusions): a company id is checked as X-Company-Id would be (403).
    if (company !== 'current') req.headers['x-company-id'] = company;
    await new Promise<void>((resolve, reject) => {
      companyContext(req, {} as Response, (err?: unknown) => (err ? reject(err) : resolve())).catch(reject);
    });
    const companyId = req.companyId;
    conditions.push(sql`COALESCE(
      a.company_id::text,
      (SELECT t.company_id::text FROM transactions t WHERE t.tenant_id = a.tenant_id AND t.id = a.entity_id),
      (SELECT c.id::text FROM companies c WHERE c.tenant_id = a.tenant_id AND c.id = a.entity_id),
      ${doc('a.after_data')}->>'companyId',
      ${doc('a.before_data')}->>'companyId',
      ${companyId}::text
    ) = ${companyId}::text`);
  }
  return sql.join(conditions, sql` AND `);
}

auditRouter.get('/', describe({
  summary: 'List the audit trail',
  description: 'Response {data[], total}, newest first. Rows {id, tenant_id, user_id, userName (display name, else email; null for '
    + 'system rows), action, entity_type, entity_id, before_data, after_data, ip_address, user_agent, created_at}. Filters: entity_type, '
    + 'action, start_date, end_date, search, and (audit-filters-v1) user_id, entity_id and company ("current" or a company id: rows of '
    + 'that company plus rows that belong to no company). A malformed id is 400 VALIDATION_ERROR; a company the caller cannot open is 403.',
  query: z.object({
    entity_type: z.string().optional(), action: z.string().optional(), start_date: z.string().optional(), end_date: z.string().optional(),
    search: z.string().optional(), limit: z.string().optional(), offset: z.string().optional(),
    user_id: z.string().uuid().optional(), entity_id: z.string().uuid().optional(), company: z.string().optional(),
  }),
}), async (req, res) => {
  const { limit: limitStr, offset: offsetStr } = req.query as Record<string, string>;
  const limit = parseInt(limitStr || '50');
  const offset = parseInt(offsetStr || '0');

  const where = await auditFilters(req);

  const [dataResult, countResult] = await Promise.all([
    db.execute(sql`
      SELECT a.id, a.tenant_id, a.user_id,
             (SELECT COALESCE(NULLIF(u.display_name, ''), u.email) FROM users u WHERE u.id = a.user_id) AS "userName",
             a.action, a.entity_type, a.entity_id, a.before_data, a.after_data, a.ip_address, a.user_agent, a.created_at
      FROM audit_log a
      WHERE ${where}
      ORDER BY a.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `),
    db.execute(sql`SELECT COUNT(*) as total FROM audit_log a WHERE ${where}`),
  ]);

  res.json({
    data: await redactHiddenRows(req.tenantId, dataResult.rows as Array<Record<string, unknown>>),
    total: parseInt((countResult.rows as any[])[0]?.total || '0'),
  });
});

/**
 * Sensitive accounts (U-33, Q-P29f): for a viewer with hidden accounts, a row
 * about a hidden account, about a transaction with a line on one, or whose
 * before/after names a hidden account id stays listed with before_data and
 * after_data null and `redacted: true`. Other rows are unchanged (no
 * `redacted` key). Nothing happens when no account is hidden.
 */
async function redactHiddenRows(tenantId: string, rows: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  const hidden = await hiddenAccountIds();
  if (hidden.length === 0 || rows.length === 0) return rows;
  const hiddenSet = new Set(hidden);
  const entityIds = [...new Set(rows.map((r) => r['entity_id']).filter((v): v is string => typeof v === 'string'))];
  const hiddenTxns = new Set<string>();
  if (entityIds.length > 0) {
    const res = await db.execute<{ id: string }>(sql`
      SELECT DISTINCT transaction_id::text AS id FROM journal_lines
      WHERE tenant_id = ${tenantId}
        AND transaction_id IN (${sql.join(entityIds.map((id) => sql`${id}::uuid`), sql`, `)})
        AND account_id IN (${sql.join(hidden.map((id) => sql`${id}::uuid`), sql`, `)})`);
    for (const r of res.rows) hiddenTxns.add(r.id);
  }
  return rows.map((r) => {
    const id = typeof r['entity_id'] === 'string' ? r['entity_id'] : null;
    const text = `${JSON.stringify(r['before_data'] ?? null)} ${JSON.stringify(r['after_data'] ?? null)}`;
    const touches = (id !== null && (hiddenSet.has(id) || hiddenTxns.has(id))) || hidden.some((h) => text.includes(h));
    return touches ? { ...r, before_data: null, after_data: null, redacted: true } : r;
  });
}

// Export audit log as CSV
auditRouter.get('/export', async (req, res) => {
  const where = await auditFilters(req);

  const result = await db.execute(sql`
    SELECT a.id, a.action, a.entity_type, a.entity_id, a.created_at
    FROM audit_log a
    WHERE ${where}
    ORDER BY a.created_at DESC
  `);

  // Use the shared toCsvRow helper so this export gets the same
  // formula-injection neutralization (`=HYPERLINK(...)`) and quote
  // escaping as the rest of the CSV exports. Building the row by
  // hand previously left audit_log fields like entity_id wide open
  // — a synthetic entity_id starting with `=` would inject a
  // HYPERLINK formula when an accountant opened the export in Excel.
  let csv = 'Timestamp,Action,Entity Type,Entity ID\n';
  for (const row of result.rows as Array<{
    created_at: string | Date;
    action: string;
    entity_type: string;
    entity_id: string | null;
  }>) {
    csv += toCsvRow([row.created_at, row.action, row.entity_type, row.entity_id]) + '\n';
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
  res.send(csv);
});
