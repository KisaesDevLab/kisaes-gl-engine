// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import * as crypto from 'crypto';
import * as fs from 'fs';
import { eq, and, ne, sql, count, desc, inArray } from 'drizzle-orm';
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
} from '../db/schema/index.js';
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
  parseCurrency,
  pivotLongFormat,
} from './payroll-parse.service.js';
import { env } from '../config/env.js';

const UPLOAD_DIR = env.UPLOAD_DIR || '/data/uploads';

// ── Idempotency Key Computation ──

function computeIdempotencyKey(
  provider: string | null,
  rows: string[][],
  headers: string[],
): string | null {
  if (!provider || !rows.length) return null;

  const headerIdx = new Map<string, number>();
  headers.forEach((h, i) => headerIdx.set(h.toLowerCase().trim(), i));

  function getCol(row: string[], colName: string): string {
    const idx = headerIdx.get(colName.toLowerCase().trim());
    return idx !== undefined ? (row[idx] || '').trim() : '';
  }

  function getAmount(row: string[], colName: string): number {
    const val = getCol(row, colName);
    return parseFloat(val.replace(/[$,]/g, '')) || 0;
  }

  switch (provider) {
    case 'gusto': {
      const dates = rows.map(r => getCol(r, 'Check Date')).filter(Boolean);
      const ppStart = rows.map(r => getCol(r, 'Pay Period Start')).filter(Boolean);
      const ppEnd = rows.map(r => getCol(r, 'Pay Period End')).filter(Boolean);
      const totalGross = rows.reduce((sum, r) => sum + getAmount(r, 'Gross Pay'), 0);
      const material = `${dates[0] || ''}|${ppStart[0] || ''}|${ppEnd[0] || ''}|${totalGross.toFixed(2)}|${rows.length}`;
      return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
    }
    case 'adp_run_gli': {
      const dates = rows.map(r => getCol(r, 'Check Date')).filter(Boolean);
      const totalDebit = rows.reduce((sum, r) => sum + getAmount(r, 'Debit Amount'), 0);
      const material = `${dates[0] || ''}|${totalDebit.toFixed(2)}`;
      return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
    }
    case 'paychex_flex_gls': {
      const dates = rows.map(r => getCol(r, 'Check Date')).filter(Boolean);
      const totalDebit = rows.reduce((sum, r) => sum + getAmount(r, 'Debit'), 0);
      const totalCredit = rows.reduce((sum, r) => sum + getAmount(r, 'Credit'), 0);
      const material = `${dates[0] || ''}|${totalDebit.toFixed(2)}|${totalCredit.toFixed(2)}|${rows.length}`;
      return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
    }
    case 'onpay_gl_summary': {
      const dates = rows.map(r => getCol(r, 'Pay Date')).filter(Boolean);
      const totalAmount = rows.reduce((sum, r) => sum + getAmount(r, 'Amount'), 0);
      const material = `${dates[0] || ''}|${totalAmount.toFixed(2)}`;
      return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
    }
    case 'square_payroll': {
      const dates = rows.map(r => getCol(r, 'Pay Period Start')).filter(Boolean);
      const endDates = rows.map(r => getCol(r, 'Pay Period End')).filter(Boolean);
      const material = `${dates[0] || ''}|${endDates[0] || ''}`;
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
  const idempotencyKey = computeIdempotencyKey(detection?.provider || null, dataRows, headers);

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

export async function getSession(tenantId: string, sessionId: string) {
  const [session] = await db.select().from(payrollImportSessions)
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

export async function listSessions(tenantId: string, filters: PayrollSessionFilters) {
  const { limit = 50, offset = 0 } = filters;
  const conditions = [eq(payrollImportSessions.tenantId, tenantId)];

  if (filters.companyId) conditions.push(eq(payrollImportSessions.companyId, filters.companyId));
  if (filters.status) conditions.push(eq(payrollImportSessions.status, filters.status));

  const [data, countResult] = await Promise.all([
    db.select().from(payrollImportSessions)
      .where(and(...conditions))
      .orderBy(desc(payrollImportSessions.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(payrollImportSessions)
      .where(and(...conditions)),
  ]);

  return { data, total: countResult[0]?.total ?? 0 };
}

// ── Delete Draft Session ──

export async function deleteSession(tenantId: string, sessionId: string, userId: string) {
  const session = await getSession(tenantId, sessionId);
  if (session.status === 'posted') {
    throw AppError.badRequest('Cannot delete a posted import. Use reverse instead.');
  }

  await db.delete(payrollImportRows).where(eq(payrollImportRows.sessionId, sessionId));
  await db.delete(payrollImportErrors).where(eq(payrollImportErrors.sessionId, sessionId));
  await db.delete(payrollImportColumnMappings).where(eq(payrollImportColumnMappings.sessionId, sessionId));
  await db.delete(payrollCheckRegisterRows).where(eq(payrollCheckRegisterRows.sessionId, sessionId));
  await db.delete(payrollImportSessions).where(eq(payrollImportSessions.id, sessionId));

  // Clean up uploaded files
  for (const filePath of [session.filePath, session.companionFilePath]) {
    if (filePath) {
      try { await fs.promises.unlink(filePath); } catch { /* file may already be deleted */ }
    }
  }

  await auditLog(tenantId, 'delete', 'payroll_import_session', sessionId, { status: session.status }, null, userId);
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

  const descriptionEntries = new Map<string, { debit: number; credit: number; sampleAmount: string }>();

  for (const row of rows) {
    const raw = row.rawData as Record<string, string>;
    // Use provider-specific column names
    const descCol = columnConfig.descriptionColumn;
    const desc = raw[descCol] || raw[descCol.toLowerCase()] || raw['Description'] || raw['description'] || '';
    if (!desc) continue;

    let debit = 0;
    let credit = 0;

    if (columnConfig.amountConvention === 'separate_dr_cr') {
      const drCol = columnConfig.debitColumn || 'Debit';
      const crCol = columnConfig.creditColumn || 'Credit';
      debit = parseCurrency(raw[drCol] || raw[drCol.toLowerCase()]);
      credit = parseCurrency(raw[crCol] || raw[crCol.toLowerCase()]);
    } else if (columnConfig.amountConvention === 'signed_single') {
      const amtCol = columnConfig.amountColumn || 'Amount';
      const val = parseCurrency(raw[amtCol] || raw[amtCol.toLowerCase()]);
      if (val >= 0) debit = val;
      else credit = Math.abs(val);
    } else if (columnConfig.amountConvention === 'category_derived') {
      const amtCol = columnConfig.amountColumn || 'Amount';
      const catCol = columnConfig.accountCategoryColumn || 'Category';
      const amount = Math.abs(parseCurrency(raw[amtCol] || raw[amtCol.toLowerCase()]));
      const category = (raw[catCol] || raw[catCol.toLowerCase()] || '').toLowerCase().trim();
      if (category.startsWith('expense') || category.startsWith('cost')) debit = amount;
      else credit = amount;
    }

    if (!descriptionEntries.has(desc)) {
      descriptionEntries.set(desc, {
        debit: debit > 0 ? debit : 0,
        credit: credit > 0 ? credit : 0,
        sampleAmount: debit > 0 ? debit.toFixed(2) : credit.toFixed(2),
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

  // Build result
  const result = Array.from(descriptionEntries.entries()).map(([description, info]) => {
    const existing = existingMap.get(description);
    const acct = existing ? accts.find(a => a.id === existing.accountId) : null;
    const debitOrCredit = info.debit > 0 ? 'debit' : 'credit';

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
    };
  });

  return result;
}

export async function saveDescriptionMap(
  tenantId: string,
  sessionId: string,
  providerKey: string,
  mappings: Array<{ sourceDescription: string; accountId: string; lineCategory?: string }>,
) {
  const session = await getSession(tenantId, sessionId);
  const companyId = session.companyId;
  if (!companyId) throw AppError.badRequest('Session must have a company to save description mappings');

  // Batch upsert using ON CONFLICT
  for (const mapping of mappings) {
    await db.insert(payrollDescriptionAccountMap).values({
      tenantId,
      companyId,
      providerKey,
      sourceDescription: mapping.sourceDescription,
      accountId: mapping.accountId,
      lineCategory: mapping.lineCategory || null,
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

export async function checkDuplicateFileHash(tenantId: string, session: typeof payrollImportSessions.$inferSelect) {
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
    const [priorByKey] = await db.select({
      id: payrollImportSessions.id,
      createdAt: payrollImportSessions.createdAt,
      originalFilename: payrollImportSessions.originalFilename,
    })
      .from(payrollImportSessions)
      .where(and(...conditions))
      .limit(1);

    if (priorByKey) {
      const date = priorByKey.createdAt ? new Date(priorByKey.createdAt).toLocaleDateString() : 'unknown date';
      throw AppError.badRequest(
        `A payroll import with matching data was already posted on ${date} (file "${priorByKey.originalFilename}"). ` +
        `Reverse that import first if you need to re-post.`
      );
    }
  }

  // Fall back to file hash check (backward compat for Payroll Relief and unknown providers)
  const [priorPosted] = await db.select({
    id: payrollImportSessions.id,
    createdAt: payrollImportSessions.createdAt,
    originalFilename: payrollImportSessions.originalFilename,
  })
    .from(payrollImportSessions)
    .where(and(
      eq(payrollImportSessions.tenantId, tenantId),
      eq(payrollImportSessions.fileHash, session.fileHash),
      eq(payrollImportSessions.status, 'posted'),
      ne(payrollImportSessions.id, session.id),
    ))
    .limit(1);

  if (priorPosted) {
    const date = priorPosted.createdAt ? new Date(priorPosted.createdAt).toLocaleDateString() : 'unknown date';
    throw AppError.badRequest(
      `This payroll file was already posted on ${date} (file "${priorPosted.originalFilename}"). ` +
      `Reverse that import first if you need to re-post.`
    );
  }
}
