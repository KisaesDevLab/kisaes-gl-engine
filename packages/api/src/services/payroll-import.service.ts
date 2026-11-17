// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

import * as crypto from 'crypto';
import * as fs from 'fs';
import path from 'path';
import { resolveInside } from '../utils/contained-path.js';
import { eq, and, ne, sql, count, desc, inArray, notInArray } from 'drizzle-orm';
import type { ColumnMapConfig, PayrollSessionFilters } from '@kis-books/shared';
import {
  PAYROLL_RELIEF_DESCRIPTION_SUGGESTIONS,
  MODE_B_DESCRIPTION_SUGGESTIONS,
  MODE_B_COLUMN_CONFIGS,
  PAYROLL_LINE_TYPE_LABELS,
  DEFAULT_ACCOUNT_SEARCH,
  PayrollLineType,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import type { DbOrTx } from '../db/index.js';
import { log } from '../utils/logger.js';
import {
  payrollImportSessions,
  payrollImportRows,
  payrollImportErrors,
  payrollImportColumnMappings,
  payrollProviderTemplates,
  payrollDescriptionAccountMap,
  payrollCheckRegisterRows,
  payrollAccountMapping,
  accounts,
  tags,
  transactions,
} from '../db/schema/index.js';
import { assertTagsInTenant } from './tags.service.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import {
  parseFile,
  detectHeaderRow,
  detectProvider,
  detectImportMode,
  storePayrollFile,
  hashBuffer,
  applyColumnMapping,
  pivotLongFormat,
} from './payroll-parse.service.js';
import { glRowAmounts } from './payroll-modeb.service.js';
import DecimalLib from 'decimal.js';
import { env } from '../config/env.js';

const UPLOAD_DIR = env.UPLOAD_DIR || '/data/uploads';
const Decimal = DecimalLib.default || DecimalLib;
type DecimalValue = InstanceType<typeof Decimal>;

/**
 * validation_status of a row that apply-mapping dropped on purpose (a skip
 * rule such as a Total row, or skip_footer_rows), U-252. Such a row is not
 * data: validation, the entry preview and posting ignore it.
 */
export const PAYROLL_ROW_SKIPPED = 'skipped';

/**
 * True when a Mode A row was dropped by the column mapping. Sessions mapped
 * before U-252 carry no marker; there a mapped session's row with no mapped
 * data is the same thing (every kept row gets mapped data).
 */
export function isSkippedPayrollRow(
  row: { validationStatus: string | null; mappedData: unknown },
  sessionMapped: boolean,
): boolean {
  return row.validationStatus === PAYROLL_ROW_SKIPPED || (sessionMapped && row.mappedData == null);
}

// ── Idempotency Key Computation ──

export function computeIdempotencyKey(
  provider: string | null,
  rows: string[][],
  headers: string[],
  checkDate?: string | null,
): string | null {
  if (!provider || !rows.length) return null;

  const headerIdx = new Map<string, number>();
  headers.forEach((h, i) => headerIdx.set(h.toLowerCase().trim(), i));

  function getCol(row: string[], colName: string): string {
    const idx = headerIdx.get(colName.toLowerCase().trim());
    return idx !== undefined ? (row[idx] || '').trim() : '';
  }

  // The key material must stay byte-identical to the float-era keys stored
  // on posted sessions (U-250): each cell is read the way parseFloat read it
  // (so "(12.30)" still counts as 0), but the sum is exact.
  function getAmount(row: string[], colName: string): DecimalValue {
    const val = getCol(row, colName);
    const f = parseFloat(val.replace(/[$,]/g, ''));
    return Number.isFinite(f) && f !== 0 ? new Decimal(String(f)) : new Decimal(0);
  }
  const sum = (vals: DecimalValue[]) => vals.reduce((s, v) => s.plus(v), new Decimal(0));

  switch (provider) {
    case 'gusto': {
      const dates = rows.map(r => getCol(r, 'Check Date')).filter(Boolean);
      const ppStart = rows.map(r => getCol(r, 'Pay Period Start')).filter(Boolean);
      const ppEnd = rows.map(r => getCol(r, 'Pay Period End')).filter(Boolean);
      const totalGross = sum(rows.map(r => getAmount(r, 'Gross Pay')));
      const material = `${dates[0] || ''}|${ppStart[0] || ''}|${ppEnd[0] || ''}|${totalGross.toFixed(2)}|${rows.length}`;
      return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
    }
    case 'adp_run_gli': {
      const dates = rows.map(r => getCol(r, 'Check Date')).filter(Boolean);
      const totalDebit = sum(rows.map(r => getAmount(r, 'Debit Amount')));
      const material = `${dates[0] || ''}|${totalDebit.toFixed(2)}`;
      return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
    }
    case 'paychex_flex_gls': {
      const dates = rows.map(r => getCol(r, 'Check Date')).filter(Boolean);
      const totalDebit = sum(rows.map(r => getAmount(r, 'Debit')));
      const totalCredit = sum(rows.map(r => getAmount(r, 'Credit')));
      const material = `${dates[0] || ''}|${totalDebit.toFixed(2)}|${totalCredit.toFixed(2)}|${rows.length}`;
      return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
    }
    case 'onpay_gl_summary': {
      const dates = rows.map(r => getCol(r, 'Pay Date')).filter(Boolean);
      const totalAmount = sum(rows.map(r => getAmount(r, 'Amount')));
      const material = `${dates[0] || ''}|${totalAmount.toFixed(2)}`;
      return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
    }
    case 'square_payroll': {
      const dates = rows.map(r => getCol(r, 'Pay Period Start')).filter(Boolean);
      const endDates = rows.map(r => getCol(r, 'Pay Period End')).filter(Boolean);
      // Period, pay date, net total and row count (U-243): an off-cycle run in
      // the same period is a different run. Square could never balance before
      // U-243, so no posted Square session carries the old period-only key.
      const netTotal = sum(rows.map(r => getAmount(r, 'Net Pay')));
      const material = `${dates[0] || ''}|${endDates[0] || ''}|${checkDate || ''}|${netTotal.toFixed(2)}|${rows.length}`;
      return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
    }
    case 'toast_je_report': {
      const dates = rows.map(r => getCol(r, 'Check Date')).filter(Boolean);
      const payGroup = rows.map(r => getCol(r, 'Pay Group')).filter(Boolean);
      const material = `${dates[0] || ''}|${payGroup[0] || ''}|${rows.length}`;
      return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
    }
    default:
      // Fall back to null — file hash will be used
      return null;
  }
}

// ── Upload & Create Session ──

export async function uploadPayrollFile(
  tenantId: string,
  companyId: string | undefined,
  file: { buffer: Buffer; originalname: string },
  companionFile: { buffer: Buffer; originalname: string } | undefined,
  options: {
    templateId?: string;
    importMode?: string;
    payPeriodStart?: string;
    payPeriodEnd?: string;
    checkDate?: string;
  },
  userId: string,
) {
  // Store file
  const { filePath, fileHash } = await storePayrollFile(file.buffer, file.originalname, UPLOAD_DIR);

  // Check for duplicate
  const [existing] = await db.select({ id: payrollImportSessions.id })
    .from(payrollImportSessions)
    .where(and(
      eq(payrollImportSessions.tenantId, tenantId),
      eq(payrollImportSessions.fileHash, fileHash),
    ))
    .limit(1);
  const isDuplicate = !!existing;

  // Parse file
  const { rows, fileType } = await parseFile(file.buffer, file.originalname);
  const headerRowIdx = detectHeaderRow(rows);
  const headers = rows[headerRowIdx] || [];
  const detection = detectProvider(headers);
  const detectedMode = detection ? detectImportMode(detection.provider) : 'employee_level';
  const importMode = options.importMode || detectedMode;

  // Handle companion file (Mode B checks)
  let companionFilePath: string | null = null;
  let companionFilename: string | null = null;
  if (companionFile) {
    const stored = await storePayrollFile(companionFile.buffer, companionFile.originalname, UPLOAD_DIR);
    companionFilePath = stored.filePath;
    companionFilename = companionFile.originalname;
  }

  // Compute idempotency key
  const dataRows = rows.slice(headerRowIdx + 1);
  const idempotencyKey = computeIdempotencyKey(detection?.provider || null, dataRows, headers, options.checkDate);

  // Check idempotency key duplicate (in addition to file hash check)
  let isDuplicateByKey = false;
  if (idempotencyKey && detection?.provider && companyId) {
    const [existingByKey] = await db.select({ id: payrollImportSessions.id })
      .from(payrollImportSessions)
      .where(and(
        eq(payrollImportSessions.tenantId, tenantId),
        eq(payrollImportSessions.detectedProvider, detection.provider),
        eq(payrollImportSessions.idempotencyKey, idempotencyKey),
        eq(payrollImportSessions.status, 'posted'),
      ))
      .limit(1);
    isDuplicateByKey = !!existingByKey;
  }

  // Create session
  const [session] = await db.insert(payrollImportSessions).values({
    tenantId,
    companyId: companyId || null,
    importMode,
    templateId: options.templateId || null,
    originalFilename: file.originalname,
    filePath,
    fileHash,
    companionFilename,
    companionFilePath,
    payPeriodStart: options.payPeriodStart || null,
    payPeriodEnd: options.payPeriodEnd || null,
    checkDate: options.checkDate || null,
    status: 'uploaded',
    rowCount: rows.length - headerRowIdx - 1,
    errorCount: 0,
    idempotencyKey: idempotencyKey || null,
    detectedProvider: detection?.provider || null,
    createdBy: userId,
    metadata: {
      fileType,
      headerRowIndex: headerRowIdx,
      headers,
      detectedProvider: detection?.provider || null,
      detectedConfidence: detection?.confidence || 0,
      isDuplicate,
      isDuplicateByKey,
    },
  }).returning();

  if (!session) throw AppError.internal('Failed to create import session');

  // Store raw rows (dataRows already computed above for idempotency)
  if (dataRows.length > 0) {
    const rowValues = dataRows.map((row, i) => {
      const rawData: Record<string, string> = {};
      headers.forEach((h, j) => { rawData[h] = row[j] || ''; });
      return {
        sessionId: session.id,
        rowNumber: i + 1,
        rawData,
      };
    });
    // Insert in batches of 500
    for (let i = 0; i < rowValues.length; i += 500) {
      await db.insert(payrollImportRows).values(rowValues.slice(i, i + 500));
    }
  }

  await auditLog(tenantId, 'create', 'payroll_import_session', session.id, null,
    { filename: file.originalname, importMode, rowCount: session.rowCount }, userId);

  return {
    session,
    preview: {
      headers,
      sampleRows: dataRows.slice(0, 25),
      headerRowIndex: headerRowIdx,
      detectedProvider: detection?.provider || null,
      detectedConfidence: detection?.confidence || 0,
      importMode,
      isDuplicate,
      isDuplicateByKey,
      rowCount: dataRows.length,
    },
  };
}

// ── Get Session ──

export async function getSession(tenantId: string, sessionId: string, executor: DbOrTx = db) {
  const [session] = await executor.select().from(payrollImportSessions)
    .where(and(
      eq(payrollImportSessions.tenantId, tenantId),
      eq(payrollImportSessions.id, sessionId),
    ))
    .limit(1);
  if (!session) throw AppError.notFound('Import session not found');
  return session;
}

// ── Get Preview (raw rows) ──

export async function getPreview(tenantId: string, sessionId: string) {
  const session = await getSession(tenantId, sessionId);
  const rows = await db.select().from(payrollImportRows)
    .where(eq(payrollImportRows.sessionId, sessionId))
    .orderBy(payrollImportRows.rowNumber)
    .limit(25);

  return {
    session,
    headers: (session.metadata as any)?.headers || [],
    rows: rows.map(r => ({ rowNumber: r.rowNumber, rawData: r.rawData, mappedData: r.mappedData })),
    // U-251: the employee rows were discarded when the import posted.
    detailDiscarded: !!session.detailDiscardedAt,
  };
}

// ── Apply Column Mapping (Mode A) ──

export async function applyMapping(tenantId: string, sessionId: string, config: ColumnMapConfig & { rowFormat?: string; pivotConfig?: any }) {
  const session = await getSession(tenantId, sessionId);
  const metadata = session.metadata as any;
  const headers: string[] = metadata?.headers || [];

  // Get all raw rows
  const rawRows = await db.select().from(payrollImportRows)
    .where(eq(payrollImportRows.sessionId, sessionId))
    .orderBy(payrollImportRows.rowNumber);

  // Handle long-format pivot (e.g. Toast custom reports) before standard mapping
  if (config.rowFormat === 'long' && config.pivotConfig) {
    const rawRecords = rawRows.map(r => r.rawData as Record<string, any>);
    const pivoted = pivotLongFormat(rawRecords, config.pivotConfig);

    // Replace raw rows in DB with pivoted rows
    if (pivoted.length > 0) {
      await db.delete(payrollImportRows).where(eq(payrollImportRows.sessionId, sessionId));
      const pivotedValues = pivoted.map((row, i) => ({
        sessionId: session.id,
        rowNumber: i + 1,
        rawData: row,
        mappedData: row, // pivoted data IS the mapped data for long-format
        validationStatus: 'pending' as const,
      }));
      for (let i = 0; i < pivotedValues.length; i += 500) {
        await db.insert(payrollImportRows).values(pivotedValues.slice(i, i + 500));
      }
    }

    await db.update(payrollImportSessions)
      .set({ status: 'mapped', rowCount: pivoted.length, updatedAt: new Date() })
      .where(eq(payrollImportSessions.id, sessionId));

    return { mappedCount: pivoted.length, skippedCount: rawRows.length - pivoted.length };
  }

  // Reconstruct row arrays from raw data
  const rowArrays = rawRows.map(r => {
    const raw = r.rawData as Record<string, string>;
    return headers.map(h => raw[h] || '');
  });

  // Apply mapping
  const allRows = [headers, ...rowArrays];
  const mappingConfig: ColumnMapConfig = {
    ...config,
    header_row: 0,
    data_start_row: 1,
  };
  const { mappedRows, skippedCount, originalIndices } = applyColumnMapping(allRows, headers, mappingConfig);

  // Rows the mapping dropped on purpose (skip rules such as a Total row,
  // skip_footer_rows) are marked 'skipped' (U-252): validation and the
  // entry ignore them. Written on every map so a re-map with new skip rules
  // clears data and status left by an earlier mapping.
  const kept = new Set(originalIndices);
  for (let i = 0; i < rawRows.length; i++) {
    if (kept.has(i)) continue;
    await db.update(payrollImportRows)
      .set({ mappedData: null, validationStatus: PAYROLL_ROW_SKIPPED, validationMessages: null })
      .where(eq(payrollImportRows.id, rawRows[i]!.id));
  }

  // Update rows with mapped data — use originalIndices to align correctly after skips
  for (let i = 0; i < mappedRows.length; i++) {
    const rawRow = rawRows[originalIndices[i]!];
    if (rawRow) {
      await db.update(payrollImportRows)
        .set({
          mappedData: mappedRows[i],
          validationStatus: 'pending',
          validationMessages: null,
        })
        .where(eq(payrollImportRows.id, rawRow.id));
    }
  }

  // Update session
  await db.update(payrollImportSessions)
    .set({
      status: 'mapped',
      columnMapSnapshot: config,
      rowCount: mappedRows.length,
      updatedAt: new Date(),
    })
    .where(eq(payrollImportSessions.id, sessionId));

  return { mappedCount: mappedRows.length, skippedCount };
}

// ── List Sessions ──

// 'payPeriod' follows what the column shows: the pay period end, falling
// back to the check date for a Mode B import without a period.
function sessionOrderExpr(key: NonNullable<PayrollSessionFilters['sortBy']>) {
  switch (key) {
    case 'payPeriod': return sql`COALESCE(${payrollImportSessions.payPeriodEnd}, ${payrollImportSessions.checkDate})`;
    case 'originalFilename': return sql`LOWER(${payrollImportSessions.originalFilename})`;
    case 'importMode': return sql`${payrollImportSessions.importMode}`;
    case 'status': return sql`${payrollImportSessions.status}`;
    case 'rowCount': return sql`${payrollImportSessions.rowCount}`;
    case 'errorCount': return sql`${payrollImportSessions.errorCount}`;
    case 'jeCount': return sql`${payrollImportSessions.jeCount}`;
    case 'createdAt':
    default: return sql`${payrollImportSessions.createdAt}`;
  }
}

export async function listSessions(tenantId: string, filters: PayrollSessionFilters) {
  const { limit = 50, offset = 0 } = filters;
  const conditions = [eq(payrollImportSessions.tenantId, tenantId)];

  if (filters.companyId) conditions.push(eq(payrollImportSessions.companyId, filters.companyId));
  if (filters.status) conditions.push(eq(payrollImportSessions.status, filters.status));

  const [data, countResult] = await Promise.all([
    db.select().from(payrollImportSessions)
      .where(and(...conditions))
      .orderBy(
        sql`${sessionOrderExpr(filters.sortBy ?? 'createdAt')} ${(filters.sortDir ?? 'desc') === 'asc' ? sql`ASC` : sql`DESC`} NULLS LAST`,
        desc(payrollImportSessions.createdAt),
        desc(payrollImportSessions.id),
      )
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(payrollImportSessions)
      .where(and(...conditions)),
  ]);

  return { data, total: countResult[0]?.total ?? 0 };
}

// ── Delete Draft Session ──

/** Test seam: runs inside the delete transaction right after the session row lock. */
export const __payrollDeleteTestHooks: { afterLock?: () => Promise<void> | void } = {};

/**
 * Deletes a draft import in ONE database transaction with the session row
 * locked (SELECT … FOR UPDATE), the same lock post and reverse take
 * (payroll-import-review-v1). A delete racing a post either runs entirely
 * first (the post then finds no session: 404, nothing posted) or waits for
 * the post and is refused on the re-read status (400, the posted import and
 * its duplicate guard stay). The stored files go after the commit.
 */
export async function deleteSession(tenantId: string, sessionId: string, userId: string) {
  const session = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(payrollImportSessions)
      .where(and(eq(payrollImportSessions.tenantId, tenantId), eq(payrollImportSessions.id, sessionId)))
      .for('update').limit(1);
    if (!locked) throw AppError.notFound('Import session not found');
    if (__payrollDeleteTestHooks.afterLock) await __payrollDeleteTestHooks.afterLock();
    if (locked.status === 'posted') {
      throw AppError.badRequest('Cannot delete a posted import. Use reverse instead.');
    }

    await tx.delete(payrollImportRows).where(eq(payrollImportRows.sessionId, sessionId));
    await tx.delete(payrollImportErrors).where(eq(payrollImportErrors.sessionId, sessionId));
    await tx.delete(payrollImportColumnMappings).where(eq(payrollImportColumnMappings.sessionId, sessionId));
    await tx.delete(payrollCheckRegisterRows).where(eq(payrollCheckRegisterRows.sessionId, sessionId));
    await tx.delete(payrollImportSessions)
      .where(and(eq(payrollImportSessions.tenantId, tenantId), eq(payrollImportSessions.id, sessionId)));

    await auditLog(tenantId, 'delete', 'payroll_import_session', sessionId, { status: locked.status }, null, userId, tx);
    return locked;
  });

  // After the commit: clean up uploaded files. The stored path is data: only
  // a regular file inside UPLOAD_DIR/payroll is ever unlinked (H2).
  for (const filePath of [session.filePath, session.companionFilePath]) {
    const safe = resolveInside(path.join(UPLOAD_DIR, 'payroll'), filePath);
    if (safe) {
      try { await fs.promises.unlink(safe); } catch { /* file may already be deleted */ }
    }
  }
}

/**
 * Deletes a stored payroll upload after its session discarded it (U-251).
 * Only a regular file inside UPLOAD_DIR/payroll is unlinked; a failure is
 * logged, never thrown (the database no longer points at it).
 */
export async function discardStoredUpload(filePath: string | null): Promise<void> {
  const safe = resolveInside(path.join(UPLOAD_DIR, 'payroll'), filePath);
  if (!safe) return;
  try {
    await fs.promises.unlink(safe);
  } catch (err) {
    log.warn({ component: 'payroll_import', event: 'upload_discard_failed', code: (err as NodeJS.ErrnoException)?.code ?? 'unknown' });
  }
}

// ── Template CRUD ──

export async function listTemplates(tenantId: string) {
  const templates = await db.select().from(payrollProviderTemplates)
    .where(
      sql`${payrollProviderTemplates.isSystem} = true OR ${payrollProviderTemplates.tenantId} = ${tenantId}`
    )
    .orderBy(payrollProviderTemplates.name);
  return templates;
}

export async function getTemplate(tenantId: string, templateId: string) {
  const [template] = await db.select().from(payrollProviderTemplates)
    .where(and(
      eq(payrollProviderTemplates.id, templateId),
      sql`${payrollProviderTemplates.isSystem} = true OR ${payrollProviderTemplates.tenantId} = ${tenantId}`
    ))
    .limit(1);
  if (!template) throw AppError.notFound('Template not found');
  return template;
}

export async function createTemplate(
  tenantId: string,
  input: { name: string; providerKey: string; description?: string; columnMap: any; fileFormatHints?: any },
) {
  const [template] = await db.insert(payrollProviderTemplates).values({
    name: input.name,
    providerKey: input.providerKey,
    description: input.description || null,
    columnMap: input.columnMap,
    fileFormatHints: input.fileFormatHints || null,
    isSystem: false,
    tenantId,
  }).returning();
  if (template) {
    await auditLog(tenantId, 'create', 'payroll_provider_template', template.id, null, { name: input.name });
  }
  return template;
}

export async function updateTemplate(tenantId: string, templateId: string, input: Partial<{
  name: string; providerKey: string; description: string; columnMap: any; fileFormatHints: any;
}>) {
  const template = await getTemplate(tenantId, templateId);
  if (template.isSystem) throw AppError.badRequest('Cannot modify system templates');
  if (template.tenantId !== tenantId) throw AppError.forbidden('Cannot modify another tenant\'s template');

  const [updated] = await db.update(payrollProviderTemplates)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(payrollProviderTemplates.id, templateId))
    .returning();
  await auditLog(tenantId, 'update', 'payroll_provider_template', templateId, { name: template.name }, input);
  return updated;
}

export async function deleteTemplate(tenantId: string, templateId: string) {
  const template = await getTemplate(tenantId, templateId);
  if (template.isSystem) throw AppError.badRequest('Cannot delete system templates');
  if (template.tenantId !== tenantId) throw AppError.forbidden('Cannot delete another tenant\'s template');

  await db.delete(payrollProviderTemplates).where(eq(payrollProviderTemplates.id, templateId));
  await auditLog(tenantId, 'delete', 'payroll_provider_template', templateId, { name: template.name }, null);
}

// ── Description Map (Mode B) ──

export async function getDescriptionMap(tenantId: string, sessionId: string) {
  const session = await getSession(tenantId, sessionId);
  const companyId = session.companyId;
  const metadata = session.metadata as any;
  const providerKey = metadata?.detectedProvider || 'payroll_relief_gl';
  const columnConfig = MODE_B_COLUMN_CONFIGS[providerKey] || MODE_B_COLUMN_CONFIGS['payroll_relief_gl']!;

  // Get all raw rows to extract unique descriptions
  const rows = await db.select().from(payrollImportRows)
    .where(eq(payrollImportRows.sessionId, sessionId))
    .orderBy(payrollImportRows.rowNumber);

  const descriptionEntries = new Map<string, { debit: boolean; credit: boolean; sampleAmount: string }>();

  for (const row of rows) {
    const raw = row.rawData as Record<string, string>;
    // Use provider-specific column names
    const descCol = columnConfig.descriptionColumn;
    // Trim to match parseGLEntries (payroll-modeb.service), which trims the
    // description before looking it up in the saved map. Without this, a
    // source value with surrounding whitespace would save under a padded key
    // and fail the "unmapped descriptions" check at posting time.
    const desc = (raw[descCol] || raw[descCol.toLowerCase()] || raw['Description'] || raw['description'] || '').trim();
    if (!desc) continue;

    // Exact amounts (U-250); a bad cell shows as 0.00 here and is refused
    // by validation and generate-je.
    const { debit, credit } = glRowAmounts(raw, columnConfig);

    if (!descriptionEntries.has(desc)) {
      descriptionEntries.set(desc, {
        debit: debit.gt(0),
        credit: credit.gt(0),
        sampleAmount: debit.gt(0) ? debit.toFixed(2) : credit.toFixed(2),
      });
    }
  }

  // Get existing mappings for this company
  const existingMappings = companyId ? await db.select()
    .from(payrollDescriptionAccountMap)
    .where(and(
      eq(payrollDescriptionAccountMap.tenantId, tenantId),
      eq(payrollDescriptionAccountMap.companyId, companyId),
    )) : [];

  const existingMap = new Map(existingMappings.map(m => [m.sourceDescription, m]));

  // Get accounts for name resolution
  const accts = await db.select({
    id: accounts.id,
    name: accounts.name,
    accountNumber: accounts.accountNumber,
    accountType: accounts.accountType,
  }).from(accounts)
    .where(and(
      eq(accounts.tenantId, tenantId),
      eq(accounts.isActive, true),
    ));

  // Use provider-specific suggestion map
  const suggestions = MODE_B_DESCRIPTION_SUGGESTIONS[providerKey] || PAYROLL_RELIEF_DESCRIPTION_SUGGESTIONS;

  // Tag suggestion: Payroll Relief suffixes location-specific lines with
  // " - <Location>" ("Wages and Salary - Bentonville"); when an active tag
  // has that name, suggest it for descriptions with no saved mapping.
  const activeTags = await db.select({ id: tags.id, name: tags.name }).from(tags)
    .where(and(eq(tags.tenantId, tenantId), eq(tags.isActive, true)));
  const tagByName = new Map(activeTags.map(t => [t.name.trim().toLowerCase(), t.id]));
  const suggestTag = (description: string): string | null => {
    const idx = description.lastIndexOf(' - ');
    if (idx < 0) return null;
    return tagByName.get(description.slice(idx + 3).trim().toLowerCase()) ?? null;
  };

  // Build result
  const result = Array.from(descriptionEntries.entries()).map(([description, info]) => {
    const existing = existingMap.get(description);
    const acct = existing ? accts.find(a => a.id === existing.accountId) : null;
    const debitOrCredit = info.debit ? 'debit' : 'credit';

    // Try auto-suggestion
    let suggestedAccountId: string | null = null;
    let suggestedAccountName: string | null = null;
    let suggestedAccountNumber: string | null = null;
    let status: 'mapped' | 'suggested' | 'unmapped' = 'unmapped';

    if (existing) {
      status = 'mapped';
    } else {
      const suggestion = suggestions[description];
      if (suggestion) {
        const matchedAccount = accts.find(a =>
          suggestion.search_terms.some((term: string) =>
            a.accountNumber === term ||
            a.name.toLowerCase().includes(term.toLowerCase())
          )
        );
        if (matchedAccount) {
          suggestedAccountId = matchedAccount.id;
          suggestedAccountName = matchedAccount.name;
          suggestedAccountNumber = matchedAccount.accountNumber;
          status = 'suggested';
        }
      }
    }

    return {
      sourceDescription: description,
      debitOrCredit,
      sampleAmount: info.sampleAmount,
      accountId: existing ? existing.accountId : suggestedAccountId,
      accountName: acct ? acct.name : suggestedAccountName,
      accountNumber: acct ? acct.accountNumber : suggestedAccountNumber,
      status,
      lineCategory: existing?.lineCategory || null,
      tagId: existing ? existing.tagId ?? null : suggestTag(description),
      tagSuggested: !existing && suggestTag(description) !== null,
    };
  });

  return result;
}

export async function saveDescriptionMap(
  tenantId: string,
  sessionId: string,
  providerKey: string,
  mappings: Array<{ sourceDescription: string; accountId: string; lineCategory?: string; tagId?: string | null }>,
) {
  const session = await getSession(tenantId, sessionId);
  const companyId = session.companyId;
  if (!companyId) throw AppError.badRequest('Session must have a company to save description mappings');
  await assertTagsInTenant(tenantId, mappings.flatMap(m => (m.tagId ? [m.tagId] : [])));

  // Batch upsert using ON CONFLICT
  for (const mapping of mappings) {
    await db.insert(payrollDescriptionAccountMap).values({
      tenantId,
      companyId,
      providerKey,
      sourceDescription: mapping.sourceDescription,
      accountId: mapping.accountId,
      lineCategory: mapping.lineCategory || null,
      tagId: mapping.tagId ?? null,
    }).onConflictDoUpdate({
      target: [
        payrollDescriptionAccountMap.tenantId,
        payrollDescriptionAccountMap.companyId,
        payrollDescriptionAccountMap.providerKey,
        payrollDescriptionAccountMap.sourceDescription,
      ],
      set: {
        accountId: sql`excluded.account_id`,
        lineCategory: sql`excluded.line_category`,
        tagId: sql`excluded.tag_id`,
        updatedAt: new Date(),
      },
    });
  }

  // Update session status
  await db.update(payrollImportSessions)
    .set({ status: 'mapped', updatedAt: new Date() })
    .where(eq(payrollImportSessions.id, sessionId));

  await auditLog(tenantId, 'update', 'payroll_description_map', sessionId, null,
    { providerKey, count: mappings.length });
}

// ── Account Mapping (JE line type → COA account) ──

export async function getAccountMappings(tenantId: string, companyId: string) {
  const mappings = await db.select().from(payrollAccountMapping)
    .where(and(
      eq(payrollAccountMapping.tenantId, tenantId),
      eq(payrollAccountMapping.companyId, companyId),
    ));

  // Resolve account names
  const accountIds = mappings.map(m => m.accountId).filter(Boolean);
  const accts = accountIds.length > 0
    ? await db.select({ id: accounts.id, name: accounts.name, accountNumber: accounts.accountNumber })
        .from(accounts)
        .where(inArray(accounts.id, accountIds))
    : [];

  const acctMap = new Map(accts.map(a => [a.id, a]));

  return mappings.map(m => {
    const acct = acctMap.get(m.accountId);
    return {
      lineType: m.lineType,
      lineTypeLabel: (PAYROLL_LINE_TYPE_LABELS as any)[m.lineType] || m.lineType,
      accountId: m.accountId,
      accountName: acct?.name || null,
      accountNumber: acct?.accountNumber || null,
    };
  });
}

export async function saveAccountMappings(
  tenantId: string,
  companyId: string,
  mappings: Record<string, string>,
) {
  for (const [lineType, accountId] of Object.entries(mappings)) {
    await db.insert(payrollAccountMapping).values({
      tenantId,
      companyId,
      lineType,
      accountId,
    }).onConflictDoUpdate({
      target: [
        payrollAccountMapping.tenantId,
        payrollAccountMapping.companyId,
        payrollAccountMapping.lineType,
      ],
      set: {
        accountId: sql`excluded.account_id`,
        updatedAt: new Date(),
      },
    });
  }

  await auditLog(tenantId, 'update', 'payroll_account_mapping', companyId, null,
    { count: Object.keys(mappings).length });
}

export async function autoMapAccounts(tenantId: string, companyId: string) {
  const accts = await db.select({
    id: accounts.id,
    name: accounts.name,
    accountNumber: accounts.accountNumber,
    accountType: accounts.accountType,
  }).from(accounts)
    .where(and(
      eq(accounts.tenantId, tenantId),
      eq(accounts.isActive, true),
    ));

  const suggestions: Record<string, string> = {};

  for (const [lineType, searchTerms] of Object.entries(DEFAULT_ACCOUNT_SEARCH)) {
    const matched = accts.find(a =>
      searchTerms.some(term =>
        a.accountNumber === term ||
        a.name.toLowerCase().includes(term.toLowerCase())
      )
    );
    if (matched) {
      suggestions[lineType] = matched.id;
    }
  }

  return suggestions;
}

// ── Duplicate File Guard (shared by Mode A + Mode B posting) ──

/** Every ledger transaction a posted import created (JEs + check rows). */
export async function sessionTransactionIds(sessionId: string, session: Pick<typeof payrollImportSessions.$inferSelect, 'journalEntryId' | 'journalEntryIds'>, executor: DbOrTx = db): Promise<string[]> {
  const ids = new Set<string>();
  if (session.journalEntryId) ids.add(session.journalEntryId);
  if (Array.isArray(session.journalEntryIds)) for (const id of session.journalEntryIds as string[]) ids.add(id);
  const rows = await executor.select({ transactionId: payrollCheckRegisterRows.transactionId })
    .from(payrollCheckRegisterRows)
    .where(and(eq(payrollCheckRegisterRows.sessionId, sessionId), eq(payrollCheckRegisterRows.posted, true)));
  for (const r of rows) if (r.transactionId) ids.add(r.transactionId);
  return [...ids];
}

/**
 * A "posted" import whose transactions are all gone (removed by the admin
 * date-range delete / a tenant purge) or voided no longer has anything in
 * the books. Such a record must not block re-posting the same file: release
 * it (status cancelled, check rows unposted, audited) and report that it was
 * stale. Returns true when the prior import still has live transactions.
 */
async function priorImportStillLive(tenantId: string, priorId: string, executor: DbOrTx = db): Promise<boolean> {
  const prior = await executor.query.payrollImportSessions.findFirst({
    where: and(eq(payrollImportSessions.tenantId, tenantId), eq(payrollImportSessions.id, priorId)),
  });
  if (!prior) return false;
  const ids = await sessionTransactionIds(prior.id, prior, executor);
  if (ids.length > 0) {
    const [live] = await executor.select({ n: count() }).from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), inArray(transactions.id, ids), notInArray(transactions.status, ['void', 'deleted'])));
    if ((live?.n ?? 0) > 0) return true;
  }
  await executor.update(payrollCheckRegisterRows)
    .set({ posted: false, transactionId: null })
    .where(eq(payrollCheckRegisterRows.sessionId, prior.id));
  await executor.update(payrollImportSessions)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(payrollImportSessions.id, prior.id), eq(payrollImportSessions.status, 'posted')));
  await auditLog(tenantId, 'update', 'payroll_import_reverse', prior.id, { status: 'posted' }, {
    status: 'cancelled',
    reason: 'Its transactions were already removed from the books; released so the file can be posted again',
    missingTransactions: ids.length,
  }, undefined, executor);
  return false;
}

/**
 * Refuses a second post of the same payroll (U-244): the same provider run
 * (409 PAYROLL_DUPLICATE_RUN) or the same file (409 PAYROLL_DUPLICATE_FILE),
 * details {priorSessionId, postedAt}. Scoped to the session's company when it
 * has one. Runs on the posting transaction after the session row lock.
 */
export async function checkDuplicateFileHash(tenantId: string, session: typeof payrollImportSessions.$inferSelect, executor: DbOrTx = db) {
  // Check idempotency key first (provider-specific composite key)
  if (session.idempotencyKey && session.detectedProvider) {
    const conditions = [
      eq(payrollImportSessions.tenantId, tenantId),
      eq(payrollImportSessions.detectedProvider, session.detectedProvider),
      eq(payrollImportSessions.idempotencyKey, session.idempotencyKey),
      eq(payrollImportSessions.status, 'posted'),
      ne(payrollImportSessions.id, session.id),
    ];
    // Scope to same company if session has a companyId (matches the unique index)
    if (session.companyId) {
      conditions.push(eq(payrollImportSessions.companyId, session.companyId));
    }
    const [priorByKey] = await executor.select({
      id: payrollImportSessions.id,
      createdAt: payrollImportSessions.createdAt,
      originalFilename: payrollImportSessions.originalFilename,
    })
      .from(payrollImportSessions)
      .where(and(...conditions))
      .limit(1);

    if (priorByKey && await priorImportStillLive(tenantId, priorByKey.id, executor)) {
      const date = priorByKey.createdAt ? new Date(priorByKey.createdAt).toLocaleDateString() : 'unknown date';
      throw AppError.conflict(
        `A payroll import with matching data was already posted on ${date} (file "${priorByKey.originalFilename}"). ` +
        `Reverse that import first if you need to re-post.`,
        'PAYROLL_DUPLICATE_RUN',
        { priorSessionId: priorByKey.id, postedAt: priorByKey.createdAt ? new Date(priorByKey.createdAt).toISOString() : null },
      );
    }
  }

  // Fall back to file hash check (backward compat for Payroll Relief and unknown providers)
  const hashConditions = [
    eq(payrollImportSessions.tenantId, tenantId),
    eq(payrollImportSessions.fileHash, session.fileHash),
    eq(payrollImportSessions.status, 'posted'),
    ne(payrollImportSessions.id, session.id),
  ];
  if (session.companyId) hashConditions.push(eq(payrollImportSessions.companyId, session.companyId));
  const [priorPosted] = await executor.select({
    id: payrollImportSessions.id,
    createdAt: payrollImportSessions.createdAt,
    originalFilename: payrollImportSessions.originalFilename,
  })
    .from(payrollImportSessions)
    .where(and(...hashConditions))
    .limit(1);

  if (priorPosted && await priorImportStillLive(tenantId, priorPosted.id, executor)) {
    const date = priorPosted.createdAt ? new Date(priorPosted.createdAt).toLocaleDateString() : 'unknown date';
    throw AppError.conflict(
      `This payroll file was already posted on ${date} (file "${priorPosted.originalFilename}"). ` +
      `Reverse that import first if you need to re-post.`,
      'PAYROLL_DUPLICATE_FILE',
      { priorSessionId: priorPosted.id, postedAt: priorPosted.createdAt ? new Date(priorPosted.createdAt).toISOString() : null },
    );
  }
}
