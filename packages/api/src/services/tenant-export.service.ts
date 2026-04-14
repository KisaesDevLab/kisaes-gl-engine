import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { sql, eq, and, gte, lte } from 'drizzle-orm';
import { db } from '../db/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import {
  encryptWithPassphrase,
  decryptWithPassphrase,
  generateChecksum,
  detectEncryptionMethod,
} from './portable-encryption.service.js';
// Types defined locally to avoid build-order issues with shared package
interface TenantExportPreview {
  company_name: string;
  source_version: string;
  export_date: string;
  date_range?: { from: string; to: string };
  counts: {
    accounts: number;
    contacts: number;
    transactions: number;
    invoices: number;
    bills: number;
    attachments: number;
    tags: number;
    items: number;
    budgets: number;
    bank_rules: number;
  };
  file_size: number;
  validation_token: string;
}

interface ImportResult {
  company_name: string;
  tenant_id: string;
  counts: Record<string, number>;
  warnings: string[];
  duplicate_flags: number;
}

const EXPORT_DIR = process.env['BACKUP_DIR'] || '/data/backups';
const TEMP_DIR = path.join(EXPORT_DIR, '_temp');
const APP_VERSION = '0.3.0';

// Token cache for validated imports (in-memory, short-lived). Capped so an
// authenticated caller spamming /import/validate can't hold multi-GB of
// decrypted payloads in memory while the 5-minute sweep runs — each cache
// entry is potentially a full tenant export.
const VALIDATION_CACHE_MAX = 32;
const validationCache = new Map<string, { data: ExportPayload; expiresAt: number }>();

function evictOldestValidationEntry(): void {
  if (validationCache.size < VALIDATION_CACHE_MAX) return;
  const oldest = validationCache.keys().next().value;
  if (oldest !== undefined) validationCache.delete(oldest);
}

// Cleanup expired tokens every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of validationCache) {
    if (entry.expiresAt < now) validationCache.delete(token);
  }
}, 5 * 60 * 1000);

// Import progress tracking (in-memory, per-job)
const importProgress = new Map<string, {
  status: 'processing' | 'completed' | 'failed';
  step: string;
  progress: number;
  detail?: string;
  result?: ImportResult;
  error?: string;
}>();

// Cleanup old progress entries after 1 hour
setInterval(() => {
  // Progress entries don't have timestamps so we just keep the map bounded
  if (importProgress.size > 100) {
    const keys = Array.from(importProgress.keys());
    for (let i = 0; i < keys.length - 50; i++) {
      importProgress.delete(keys[i]!);
    }
  }
}, 60 * 60 * 1000);

export function getImportProgress(jobId: string) {
  return importProgress.get(jobId) || null;
}

function updateProgress(jobId: string, step: string, progress: number, detail?: string) {
  const existing = importProgress.get(jobId);
  importProgress.set(jobId, {
    status: 'processing',
    step,
    progress,
    detail,
    result: existing?.result,
  });
}

interface ExportOptions {
  dateRange?: { from: string; to: string };
  includeAttachments?: boolean;
  includeAudit?: boolean;
  includeBankRules?: boolean;
}

interface ExportPayload {
  metadata: Record<string, unknown>;
  company: Record<string, unknown>;
  accounts: Record<string, unknown>[];
  contacts: Record<string, unknown>[];
  transactions: Record<string, unknown>[];
  journal_lines: Record<string, unknown>[];
  invoices: Record<string, unknown>[];
  bills: Record<string, unknown>[];
  bill_payment_applications: Record<string, unknown>[];
  vendor_credit_applications: Record<string, unknown>[];
  tag_groups: Record<string, unknown>[];
  tags: Record<string, unknown>[];
  transaction_tags: Record<string, unknown>[];
  items: Record<string, unknown>[];
  bank_rules: Record<string, unknown>[];
  budgets: Record<string, unknown>[];
  budget_lines: Record<string, unknown>[];
  recurring_templates: Record<string, unknown>[];
  recurring_template_lines: Record<string, unknown>[];
  categorization_history: Record<string, unknown>[];
  audit_trail: Record<string, unknown>[];
  attachments_meta: Record<string, unknown>[];
  attachment_files: Array<{ id: string; data: string }>; // base64-encoded file contents
  saved_report_filters: Record<string, unknown>[];
  export_summary?: string;
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Query a tenant-scoped table. Returns rows matching tenantId.
 * Falls back gracefully if the table doesn't exist.
 */
async function queryTable(tableName: string, tenantId: string): Promise<Record<string, unknown>[]> {
  try {
    const result = await db.execute(
      sql`SELECT * FROM ${sql.identifier(tableName)} WHERE tenant_id = ${tenantId}`,
    );
    return result.rows as Record<string, unknown>[];
  } catch {
    return [];
  }
}

/**
 * Query a tenant-scoped table with an optional date range filter on a date column.
 */
async function queryTableWithDateRange(
  tableName: string,
  tenantId: string,
  dateColumn: string,
  dateRange?: { from: string; to: string },
): Promise<Record<string, unknown>[]> {
  try {
    if (dateRange) {
      const result = await db.execute(
        sql`SELECT * FROM ${sql.identifier(tableName)}
            WHERE tenant_id = ${tenantId}
              AND ${sql.identifier(dateColumn)} >= ${dateRange.from}
              AND ${sql.identifier(dateColumn)} <= ${dateRange.to}`,
      );
      return result.rows as Record<string, unknown>[];
    }
    return queryTable(tableName, tenantId);
  } catch {
    return [];
  }
}

/**
 * Export a tenant's data as an encrypted .vmx file.
 */
export async function exportTenant(
  tenantId: string,
  passphrase: string,
  options: ExportOptions = {},
  userId?: string,
): Promise<{ fileName: string; size: number; counts: Record<string, number> }> {
  // Validate tenantId format
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw AppError.badRequest('Invalid tenant id format');
  }

  const { dateRange, includeAttachments = true, includeAudit = true, includeBankRules = true } = options;

  // 1. Query company info
  const companyRows = await queryTable('companies', tenantId);
  const company = companyRows[0] || {};
  const companyName = (company['business_name'] as string) || 'Unknown Company';

  // 2. Query all data tables
  const accounts = await queryTable('accounts', tenantId);
  const contacts = await queryTable('contacts', tenantId);
  const transactions = await queryTableWithDateRange('transactions', tenantId, 'txn_date', dateRange);
  const txnIds = new Set(transactions.map((t) => t['id'] as string));

  // Journal lines: only those linked to exported transactions
  let journal_lines = await queryTable('journal_lines', tenantId);
  if (dateRange) {
    journal_lines = journal_lines.filter((jl) => txnIds.has(jl['transaction_id'] as string));
  }

  // Invoice/bill data filtered by transaction IDs when date-ranged
  const filterByTxnId = (rows: Record<string, unknown>[], idCol: string = 'id') => {
    if (!dateRange) return rows;
    return rows.filter((r) => txnIds.has(r[idCol] as string));
  };

  // Bill payment applications and vendor credit applications
  let bill_payment_applications = await queryTable('bill_payment_applications', tenantId);
  let vendor_credit_applications = await queryTable('vendor_credit_applications', tenantId);
  if (dateRange) {
    const paymentIds = new Set(transactions.filter((t) => t['txn_type'] === 'bill_payment').map((t) => t['id']));
    bill_payment_applications = bill_payment_applications.filter((r) => paymentIds.has(r['payment_id'] as string));
    vendor_credit_applications = vendor_credit_applications.filter((r) => paymentIds.has(r['payment_id'] as string));
  }

  // Tags (always included)
  const tag_groups = await queryTable('tag_groups', tenantId);
  const tags = await queryTable('tags', tenantId);
  let transaction_tags = await queryTable('transaction_tags', tenantId);
  if (dateRange) {
    transaction_tags = transaction_tags.filter((tt) => txnIds.has(tt['transaction_id'] as string));
  }

  // Items (always included)
  const items = await queryTable('items', tenantId);

  // Bank rules and categorization history
  const bank_rules = includeBankRules ? await queryTable('bank_rules', tenantId) : [];
  const categorization_history = includeBankRules ? await queryTable('categorization_history', tenantId) : [];

  // Budgets
  const budgets = await queryTable('budgets', tenantId);
  const budget_lines = await queryTable('budget_lines', tenantId);

  // Recurring templates
  const recurring_templates = await queryTable('recurring_templates', tenantId);
  const recurring_template_lines = await queryTable('recurring_template_lines', tenantId);

  // Audit trail
  const audit_trail = includeAudit ? await queryTable('audit_log', tenantId) : [];

  // Attachments metadata and file bundling
  let attachments_meta = includeAttachments ? await queryTable('attachments', tenantId) : [];
  if (dateRange && includeAttachments) {
    // Only include attachments linked to exported transactions
    attachments_meta = attachments_meta.filter((a) =>
      a['attachable_type'] !== 'transaction' || txnIds.has(a['attachable_id'] as string));
  }

  // Bundle attachment binary files as base64
  const attachment_files: Array<{ id: string; data: string }> = [];
  if (includeAttachments) {
    const UPLOAD_DIR = process.env['UPLOAD_DIR'] || '/data/uploads';
    for (const att of attachments_meta) {
      const filePath = att['file_path'] as string;
      if (!filePath) continue;
      // Try both absolute path and relative-to-upload-dir
      const candidates = [filePath, path.join(UPLOAD_DIR, filePath)];
      for (const candidate of candidates) {
        try {
          if (fs.existsSync(candidate)) {
            const data = fs.readFileSync(candidate);
            attachment_files.push({ id: att['id'] as string, data: data.toString('base64') });
            break;
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  // Saved report filters
  const saved_report_filters = await queryTable('saved_report_filters', tenantId);

  const payload: ExportPayload = {
    metadata: {}, // filled below
    company,
    accounts,
    contacts,
    transactions,
    journal_lines,
    invoices: filterByTxnId(transactions.filter((t) =>
      ['invoice', 'credit_note'].includes(t['txn_type'] as string))),
    bills: filterByTxnId(transactions.filter((t) =>
      ['bill', 'vendor_credit'].includes(t['txn_type'] as string))),
    bill_payment_applications,
    vendor_credit_applications,
    tag_groups,
    tags,
    transaction_tags,
    items,
    bank_rules,
    budgets,
    budget_lines,
    recurring_templates,
    recurring_template_lines,
    categorization_history,
    audit_trail,
    attachments_meta,
    attachment_files,
    saved_report_filters,
  };

  const counts: Record<string, number> = {
    accounts: accounts.length,
    contacts: contacts.length,
    transactions: transactions.length,
    journal_lines: journal_lines.length,
    invoices: payload.invoices.length,
    bills: payload.bills.length,
    tags: tags.length,
    items: items.length,
    bank_rules: bank_rules.length,
    budgets: budgets.length,
    attachments: attachments_meta.length,
    audit_entries: audit_trail.length,
  };

  // Build metadata
  payload.metadata = {
    export_type: 'tenant',
    version: '1.0.0',
    source_version: APP_VERSION,
    created_at: new Date().toISOString(),
    created_by: userId || 'unknown',
    encryption_method: 'passphrase_pbkdf2_aes256gcm',
    company_name: companyName,
    fiscal_year_start: company['fiscal_year_start_month'] || 1,
    transaction_count: transactions.length,
    date_range: dateRange || undefined,
    counts,
    checksum: '',
  };

  // Generate human-readable export summary
  payload.export_summary = generateExportSummary(companyName, counts, dateRange);

  const contentBuffer = Buffer.from(JSON.stringify(payload));
  payload.metadata['checksum'] = generateChecksum(contentBuffer);
  const finalContent = Buffer.from(JSON.stringify(payload));

  // Encrypt
  const encrypted = encryptWithPassphrase(finalContent, passphrase);

  // Write file
  const safeName = companyName.replace(/[^a-zA-Z0-9-_]/g, '-').substring(0, 50).toLowerCase();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const fileName = `${safeName}-export-${timestamp}.vmx`;
  const exportDir = path.join(EXPORT_DIR, tenantId, 'exports');
  ensureDir(exportDir);
  const filePath = path.join(exportDir, fileName);
  fs.writeFileSync(filePath, encrypted);

  await auditLog(
    tenantId,
    'create',
    'tenant_export',
    fileName,
    null,
    { fileName, size: encrypted.length, counts, dateRange },
    userId,
  );

  return { fileName, size: encrypted.length, counts };
}

/**
 * Download an export file.
 */
export async function downloadExport(
  tenantId: string,
  fileName: string,
  userId?: string,
): Promise<Buffer> {
  // Validate fileName
  if (!/^[a-z0-9_-]+-export-[0-9T-]+\.vmx$/i.test(fileName)) {
    throw AppError.badRequest('Invalid export file name');
  }
  if (fileName !== path.basename(fileName)) {
    throw AppError.badRequest('Invalid export file name');
  }

  const exportDir = path.join(EXPORT_DIR, tenantId, 'exports');
  const filePath = path.resolve(path.join(exportDir, fileName));
  if (!filePath.startsWith(path.resolve(exportDir))) {
    throw AppError.badRequest('Invalid export file path');
  }
  if (!fs.existsSync(filePath)) {
    throw AppError.notFound('Export file not found');
  }

  await auditLog(tenantId, 'update', 'tenant_export_downloaded', fileName, null, { fileName }, userId);
  return fs.readFileSync(filePath);
}

/**
 * Preview/validate an import file without actually importing.
 * Returns metadata + counts and a short-lived validation token.
 */
export async function previewImport(
  fileBuffer: Buffer,
  passphrase: string,
): Promise<TenantExportPreview> {
  // Detect encryption method
  const method = detectEncryptionMethod(fileBuffer);
  if (method !== 'passphrase') {
    throw AppError.badRequest('This file does not appear to be a Vibe MyBooks tenant export (.vmx)');
  }

  let decrypted: Buffer;
  try {
    decrypted = decryptWithPassphrase(fileBuffer, passphrase);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Decryption failed';
    if (msg.includes('Incorrect passphrase')) {
      throw AppError.badRequest('Incorrect passphrase');
    }
    throw AppError.badRequest(msg);
  }

  // Cap the decrypted payload before JSON.parse allocates its own copy.
  // AES-GCM doesn't expand input, so this only triggers if the upstream
  // encrypted file is unreasonably large.
  if (decrypted.length > 500 * 1024 * 1024) {
    throw AppError.badRequest('Export payload exceeds size limit');
  }

  let payload: ExportPayload;
  try {
    payload = JSON.parse(decrypted.toString());
  } catch {
    throw AppError.badRequest('Invalid export file: could not parse contents');
  }

  const meta = payload.metadata;
  if (!meta || meta['export_type'] !== 'tenant') {
    throw AppError.badRequest('This file is not a tenant export. Use the system restore for .vmb files.');
  }

  // Version compatibility check
  const sourceVersion = (meta['source_version'] as string) || '0.0.0';
  if (compareVersions(sourceVersion, APP_VERSION) > 0) {
    throw AppError.badRequest(
      `This export was created by a newer version of Vibe MyBooks (${sourceVersion}). ` +
      `Please upgrade to at least version ${sourceVersion} before importing.`,
    );
  }

  // Generate a short-lived validation token
  const validationToken = crypto.randomUUID();
  evictOldestValidationEntry();
  validationCache.set(validationToken, {
    data: payload,
    expiresAt: Date.now() + 30 * 60 * 1000, // 30 minutes
  });

  const counts = (meta['counts'] as Record<string, number>) || {};

  return {
    company_name: (meta['company_name'] as string) || 'Unknown',
    source_version: sourceVersion,
    export_date: (meta['created_at'] as string) || '',
    date_range: meta['date_range'] as { from: string; to: string } | undefined,
    counts: {
      accounts: counts['accounts'] || payload.accounts?.length || 0,
      contacts: counts['contacts'] || payload.contacts?.length || 0,
      transactions: counts['transactions'] || payload.transactions?.length || 0,
      invoices: counts['invoices'] || 0,
      bills: counts['bills'] || 0,
      attachments: counts['attachments'] || 0,
      tags: counts['tags'] || 0,
      items: counts['items'] || 0,
      budgets: counts['budgets'] || 0,
      bank_rules: counts['bank_rules'] || 0,
    },
    file_size: fileBuffer.length,
    validation_token: validationToken,
  };
}

/**
 * Import a validated export as a new tenant.
 */
export async function importAsNewTenant(
  validationToken: string,
  companyName: string,
  assignUserIds: string[],
  userId?: string,
  jobId?: string,
): Promise<ImportResult> {
  const cached = validationCache.get(validationToken);
  if (!cached || cached.expiresAt < Date.now()) {
    validationCache.delete(validationToken);
    throw AppError.badRequest('Validation token expired. Please re-upload and validate the file.');
  }

  const payload = cached.data;
  validationCache.delete(validationToken); // single use

  // ID remapping table
  const idMap = new Map<string, string>();
  function remap(oldId: string | null | undefined): string | null {
    if (!oldId) return null;
    if (!idMap.has(oldId)) {
      idMap.set(oldId, crypto.randomUUID());
    }
    return idMap.get(oldId)!;
  }

  // Progress tracking
  const jid = jobId || crypto.randomUUID();
  if (jobId) updateProgress(jid, 'Creating company', 0);

  // 1. Create new tenant
  const tenantId = crypto.randomUUID();
  const slug = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 90) + '-' + tenantId.substring(0, 8);

  await db.execute(sql`
    INSERT INTO tenants (id, name, slug) VALUES (${tenantId}, ${companyName}, ${slug})
  `);

  // 2. Create company record
  const sourceCompany = payload.company;
  const companyId = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO companies (
      id, tenant_id, business_name, legal_name, ein,
      address_line1, address_line2, city, state, zip, country,
      phone, email, website, industry, entity_type,
      fiscal_year_start_month, accounting_method, default_payment_terms,
      invoice_prefix, invoice_next_number, default_sales_tax_rate,
      currency, date_format, category_filter_mode, setup_complete
    ) VALUES (
      ${companyId}, ${tenantId},
      ${companyName},
      ${(sourceCompany['legal_name'] as string) || null},
      ${(sourceCompany['ein'] as string) || null},
      ${(sourceCompany['address_line1'] as string) || null},
      ${(sourceCompany['address_line2'] as string) || null},
      ${(sourceCompany['city'] as string) || null},
      ${(sourceCompany['state'] as string) || null},
      ${(sourceCompany['zip'] as string) || null},
      ${(sourceCompany['country'] as string) || 'US'},
      ${(sourceCompany['phone'] as string) || null},
      ${(sourceCompany['email'] as string) || null},
      ${(sourceCompany['website'] as string) || null},
      ${(sourceCompany['industry'] as string) || null},
      ${(sourceCompany['entity_type'] as string) || 'sole_prop'},
      ${(sourceCompany['fiscal_year_start_month'] as number) || 1},
      ${(sourceCompany['accounting_method'] as string) || 'accrual'},
      ${(sourceCompany['default_payment_terms'] as string) || 'net_30'},
      ${(sourceCompany['invoice_prefix'] as string) || 'INV-'},
      ${(sourceCompany['invoice_next_number'] as number) || 1001},
      ${(sourceCompany['default_sales_tax_rate'] as string) || '0'},
      ${(sourceCompany['currency'] as string) || 'USD'},
      ${(sourceCompany['date_format'] as string) || 'MM/DD/YYYY'},
      ${(sourceCompany['category_filter_mode'] as string) || 'by_type'},
      ${true}
    )
  `);

  const warnings: string[] = [];
  const counts = {
    accounts: 0,
    contacts: 0,
    transactions: 0,
    journal_lines: 0,
    invoices: 0,
    bills: 0,
    attachments: 0,
    tags: 0,
    items: 0,
    budgets: 0,
    bank_rules: 0,
    audit_entries: 0,
  };

  if (jobId) updateProgress(jid, 'Importing accounts', 10, `${(payload.accounts || []).length} accounts`);

  // 3. Import accounts (COA) — preserving hierarchy
  for (const acc of payload.accounts || []) {
    const oldId = acc['id'] as string;
    const newId = remap(oldId)!;
    const parentId = remap(acc['parent_id'] as string | null);

    await db.execute(sql`
      INSERT INTO accounts (
        id, tenant_id, company_id, account_number, name, account_type,
        detail_type, description, is_active, is_system, system_tag,
        parent_id, balance
      ) VALUES (
        ${newId}, ${tenantId}, ${companyId},
        ${(acc['account_number'] as string) || null},
        ${acc['name'] as string},
        ${acc['account_type'] as string},
        ${(acc['detail_type'] as string) || null},
        ${(acc['description'] as string) || null},
        ${acc['is_active'] !== false},
        ${acc['is_system'] === true},
        ${(acc['system_tag'] as string) || null},
        ${parentId},
        ${(acc['balance'] as string) || '0'}
      )
    `);
    counts.accounts++;
  }

  if (jobId) updateProgress(jid, 'Importing contacts', 20, `${(payload.contacts || []).length} contacts`);

  // 4. Import contacts
  for (const c of payload.contacts || []) {
    const oldId = c['id'] as string;
    const newId = remap(oldId)!;
    const defaultExpenseAccountId = remap(c['default_expense_account_id'] as string | null);

    await db.execute(sql`
      INSERT INTO contacts (
        id, tenant_id, company_id, contact_type, display_name, company_name,
        first_name, last_name, email, phone,
        billing_line1, billing_line2, billing_city, billing_state, billing_zip, billing_country,
        shipping_line1, shipping_line2, shipping_city, shipping_state, shipping_zip, shipping_country,
        default_payment_terms, default_terms_days, opening_balance, opening_balance_date,
        default_expense_account_id, tax_id, is_1099_eligible, notes, is_active
      ) VALUES (
        ${newId}, ${tenantId}, ${companyId},
        ${c['contact_type'] as string},
        ${c['display_name'] as string},
        ${(c['company_name'] as string) || null},
        ${(c['first_name'] as string) || null},
        ${(c['last_name'] as string) || null},
        ${(c['email'] as string) || null},
        ${(c['phone'] as string) || null},
        ${(c['billing_line1'] as string) || null},
        ${(c['billing_line2'] as string) || null},
        ${(c['billing_city'] as string) || null},
        ${(c['billing_state'] as string) || null},
        ${(c['billing_zip'] as string) || null},
        ${(c['billing_country'] as string) || 'US'},
        ${(c['shipping_line1'] as string) || null},
        ${(c['shipping_line2'] as string) || null},
        ${(c['shipping_city'] as string) || null},
        ${(c['shipping_state'] as string) || null},
        ${(c['shipping_zip'] as string) || null},
        ${(c['shipping_country'] as string) || 'US'},
        ${(c['default_payment_terms'] as string) || null},
        ${(c['default_terms_days'] as number) || null},
        ${(c['opening_balance'] as string) || '0'},
        ${(c['opening_balance_date'] as string) || null},
        ${defaultExpenseAccountId},
        ${(c['tax_id'] as string) || null},
        ${c['is_1099_eligible'] === true},
        ${(c['notes'] as string) || null},
        ${c['is_active'] !== false}
      )
    `);
    counts.contacts++;
  }

  // 5. Import items
  for (const item of payload.items || []) {
    const newId = remap(item['id'] as string)!;
    const incomeAccountId = remap(item['income_account_id'] as string | null);
    const expenseAccountId = remap(item['expense_account_id'] as string | null);

    await db.execute(sql`
      INSERT INTO items (
        id, tenant_id, company_id, name, description, item_type,
        rate, income_account_id, expense_account_id, is_active
      ) VALUES (
        ${newId}, ${tenantId}, ${companyId},
        ${item['name'] as string},
        ${(item['description'] as string) || null},
        ${(item['item_type'] as string) || 'service'},
        ${(item['rate'] as string) || '0'},
        ${incomeAccountId},
        ${expenseAccountId},
        ${item['is_active'] !== false}
      )
    `);
    counts.items++;
  }

  // 6. Import tag groups and tags
  for (const tg of payload.tag_groups || []) {
    const newId = remap(tg['id'] as string)!;
    await db.execute(sql`
      INSERT INTO tag_groups (
        id, tenant_id, company_id, name, description, is_single_select, sort_order
      ) VALUES (
        ${newId}, ${tenantId}, ${companyId},
        ${tg['name'] as string},
        ${(tg['description'] as string) || null},
        ${tg['is_single_select'] === true},
        ${(tg['sort_order'] as number) || 0}
      )
    `);
  }

  for (const tag of payload.tags || []) {
    const newId = remap(tag['id'] as string)!;
    const groupId = remap(tag['group_id'] as string | null);
    await db.execute(sql`
      INSERT INTO tags (
        id, tenant_id, company_id, group_id, name, color, description,
        is_active, usage_count, sort_order
      ) VALUES (
        ${newId}, ${tenantId}, ${companyId},
        ${groupId},
        ${tag['name'] as string},
        ${(tag['color'] as string) || null},
        ${(tag['description'] as string) || null},
        ${tag['is_active'] !== false},
        ${(tag['usage_count'] as number) || 0},
        ${(tag['sort_order'] as number) || 0}
      )
    `);
    counts.tags++;
  }

  if (jobId) updateProgress(jid, 'Importing transactions', 40, `${(payload.transactions || []).length} transactions`);

  // 7. Import transactions
  for (const txn of payload.transactions || []) {
    const newId = remap(txn['id'] as string)!;
    const contactId = remap(txn['contact_id'] as string | null);
    const recurringScheduleId = remap(txn['recurring_schedule_id'] as string | null);
    const sourceEstimateId = remap(txn['source_estimate_id'] as string | null);
    const appliedToInvoiceId = remap(txn['applied_to_invoice_id'] as string | null);

    await db.execute(sql`
      INSERT INTO transactions (
        id, tenant_id, company_id, txn_type, txn_number, txn_date, due_date,
        status, contact_id, memo, internal_notes, payment_terms,
        subtotal, tax_amount, total, amount_paid, balance_due,
        invoice_status, bill_status, terms_days, credits_applied,
        vendor_invoice_number, sent_at, viewed_at, paid_at,
        is_recurring, recurring_schedule_id, source_estimate_id,
        applied_to_invoice_id, void_reason, voided_at,
        check_number, print_status, payee_name_on_check, payee_address,
        printed_memo, printed_at
      ) VALUES (
        ${newId}, ${tenantId}, ${companyId},
        ${txn['txn_type'] as string},
        ${(txn['txn_number'] as string) || null},
        ${txn['txn_date'] as string},
        ${(txn['due_date'] as string) || null},
        ${(txn['status'] as string) || 'posted'},
        ${contactId},
        ${(txn['memo'] as string) || null},
        ${(txn['internal_notes'] as string) || null},
        ${(txn['payment_terms'] as string) || null},
        ${(txn['subtotal'] as string) || null},
        ${(txn['tax_amount'] as string) || '0'},
        ${(txn['total'] as string) || null},
        ${(txn['amount_paid'] as string) || '0'},
        ${(txn['balance_due'] as string) || null},
        ${(txn['invoice_status'] as string) || null},
        ${(txn['bill_status'] as string) || null},
        ${(txn['terms_days'] as number) || null},
        ${(txn['credits_applied'] as string) || '0'},
        ${(txn['vendor_invoice_number'] as string) || null},
        ${(txn['sent_at'] as string) || null},
        ${(txn['viewed_at'] as string) || null},
        ${(txn['paid_at'] as string) || null},
        ${txn['is_recurring'] === true},
        ${recurringScheduleId},
        ${sourceEstimateId},
        ${appliedToInvoiceId},
        ${(txn['void_reason'] as string) || null},
        ${(txn['voided_at'] as string) || null},
        ${(txn['check_number'] as number) || null},
        ${(txn['print_status'] as string) || null},
        ${(txn['payee_name_on_check'] as string) || null},
        ${(txn['payee_address'] as string) || null},
        ${(txn['printed_memo'] as string) || null},
        ${(txn['printed_at'] as string) || null}
      )
    `);
    counts.transactions++;
  }

  if (jobId) updateProgress(jid, 'Importing journal lines', 60, `${(payload.journal_lines || []).length} lines`);

  // 8. Import journal lines
  for (const jl of payload.journal_lines || []) {
    const newId = remap(jl['id'] as string)!;
    const transactionId = remap(jl['transaction_id'] as string | null);
    const accountId = remap(jl['account_id'] as string | null);
    const itemId = remap(jl['item_id'] as string | null);

    await db.execute(sql`
      INSERT INTO journal_lines (
        id, tenant_id, company_id, transaction_id, account_id,
        debit, credit, description, item_id, quantity, unit_price,
        is_taxable, tax_rate, tax_amount, line_order
      ) VALUES (
        ${newId}, ${tenantId}, ${companyId},
        ${transactionId},
        ${accountId},
        ${(jl['debit'] as string) || '0'},
        ${(jl['credit'] as string) || '0'},
        ${(jl['description'] as string) || null},
        ${itemId},
        ${(jl['quantity'] as string) || null},
        ${(jl['unit_price'] as string) || null},
        ${jl['is_taxable'] === true},
        ${(jl['tax_rate'] as string) || '0'},
        ${(jl['tax_amount'] as string) || '0'},
        ${(jl['line_order'] as number) || 0}
      )
    `);
    counts.journal_lines++;
  }

  // 9. Import bill payment applications
  for (const bpa of payload.bill_payment_applications || []) {
    const newId = remap(bpa['id'] as string)!;
    const paymentId = remap(bpa['payment_id'] as string | null);
    const billId = remap(bpa['bill_id'] as string | null);

    await db.execute(sql`
      INSERT INTO bill_payment_applications (
        id, tenant_id, company_id, payment_id, bill_id, amount
      ) VALUES (
        ${newId}, ${tenantId}, ${companyId},
        ${paymentId}, ${billId},
        ${bpa['amount'] as string}
      )
    `);
  }

  // 10. Import vendor credit applications
  for (const vca of payload.vendor_credit_applications || []) {
    const newId = remap(vca['id'] as string)!;
    const paymentId = remap(vca['payment_id'] as string | null);
    const creditId = remap(vca['credit_id'] as string | null);
    const billId = remap(vca['bill_id'] as string | null);

    await db.execute(sql`
      INSERT INTO vendor_credit_applications (
        id, tenant_id, company_id, payment_id, credit_id, bill_id, amount
      ) VALUES (
        ${newId}, ${tenantId}, ${companyId},
        ${paymentId}, ${creditId}, ${billId},
        ${vca['amount'] as string}
      )
    `);
  }

  // 11. Import transaction tags
  for (const tt of payload.transaction_tags || []) {
    const transactionId = remap(tt['transaction_id'] as string | null);
    const tagId = remap(tt['tag_id'] as string | null);
    if (transactionId && tagId) {
      await db.execute(sql`
        INSERT INTO transaction_tags (transaction_id, tag_id, tenant_id, company_id)
        VALUES (${transactionId}, ${tagId}, ${tenantId}, ${companyId})
      `);
    }
  }

  // 12. Import bank rules (remap account references by name)
  for (const rule of payload.bank_rules || []) {
    const newId = remap(rule['id'] as string)!;
    const categoryAccountId = remap(rule['category_account_id'] as string | null);

    await db.execute(sql`
      INSERT INTO bank_rules (
        id, tenant_id, company_id, name, priority,
        match_field, match_type, match_value,
        category_account_id, contact_id, memo_template,
        is_active, auto_categorize
      ) VALUES (
        ${newId}, ${tenantId}, ${companyId},
        ${(rule['name'] as string) || 'Imported Rule'},
        ${(rule['priority'] as number) || 0},
        ${(rule['match_field'] as string) || 'description'},
        ${(rule['match_type'] as string) || 'contains'},
        ${(rule['match_value'] as string) || ''},
        ${categoryAccountId},
        ${remap(rule['contact_id'] as string | null)},
        ${(rule['memo_template'] as string) || null},
        ${rule['is_active'] !== false},
        ${rule['auto_categorize'] === true}
      )
    `);
    counts.bank_rules++;
  }

  // 13. Import budgets
  for (const budget of payload.budgets || []) {
    const newId = remap(budget['id'] as string)!;
    await db.execute(sql`
      INSERT INTO budgets (
        id, tenant_id, company_id, name, fiscal_year, status
      ) VALUES (
        ${newId}, ${tenantId}, ${companyId},
        ${budget['name'] as string},
        ${(budget['fiscal_year'] as number) || new Date().getFullYear()},
        ${(budget['status'] as string) || 'active'}
      )
    `);
    counts.budgets++;
  }

  for (const bl of payload.budget_lines || []) {
    const newId = remap(bl['id'] as string)!;
    const budgetId = remap(bl['budget_id'] as string | null);
    const accountId = remap(bl['account_id'] as string | null);
    await db.execute(sql`
      INSERT INTO budget_lines (
        id, tenant_id, company_id, budget_id, account_id,
        month_1, month_2, month_3, month_4, month_5, month_6,
        month_7, month_8, month_9, month_10, month_11, month_12
      ) VALUES (
        ${newId}, ${tenantId}, ${companyId},
        ${budgetId}, ${accountId},
        ${(bl['month_1'] as string) || '0'},
        ${(bl['month_2'] as string) || '0'},
        ${(bl['month_3'] as string) || '0'},
        ${(bl['month_4'] as string) || '0'},
        ${(bl['month_5'] as string) || '0'},
        ${(bl['month_6'] as string) || '0'},
        ${(bl['month_7'] as string) || '0'},
        ${(bl['month_8'] as string) || '0'},
        ${(bl['month_9'] as string) || '0'},
        ${(bl['month_10'] as string) || '0'},
        ${(bl['month_11'] as string) || '0'},
        ${(bl['month_12'] as string) || '0'}
      )
    `);
  }

  // 14. Import recurring templates
  for (const rt of payload.recurring_templates || []) {
    const newId = remap(rt['id'] as string)!;
    const contactId = remap(rt['contact_id'] as string | null);
    await db.execute(sql`
      INSERT INTO recurring_templates (
        id, tenant_id, company_id, name, txn_type, frequency,
        interval_count, start_date, end_date, next_date,
        contact_id, memo, is_active, total, status
      ) VALUES (
        ${newId}, ${tenantId}, ${companyId},
        ${(rt['name'] as string) || 'Imported Template'},
        ${rt['txn_type'] as string},
        ${(rt['frequency'] as string) || 'monthly'},
        ${(rt['interval_count'] as number) || 1},
        ${(rt['start_date'] as string) || null},
        ${(rt['end_date'] as string) || null},
        ${(rt['next_date'] as string) || null},
        ${contactId},
        ${(rt['memo'] as string) || null},
        ${rt['is_active'] !== false},
        ${(rt['total'] as string) || '0'},
        ${(rt['status'] as string) || 'active'}
      )
    `);
  }

  for (const rtl of payload.recurring_template_lines || []) {
    const newId = remap(rtl['id'] as string)!;
    const templateId = remap(rtl['template_id'] as string | null);
    const accountId = remap(rtl['account_id'] as string | null);
    const itemId = remap(rtl['item_id'] as string | null);
    await db.execute(sql`
      INSERT INTO recurring_template_lines (
        id, tenant_id, company_id, template_id, account_id,
        debit, credit, description, item_id, quantity, unit_price, line_order
      ) VALUES (
        ${newId}, ${tenantId}, ${companyId},
        ${templateId}, ${accountId},
        ${(rtl['debit'] as string) || '0'},
        ${(rtl['credit'] as string) || '0'},
        ${(rtl['description'] as string) || null},
        ${itemId},
        ${(rtl['quantity'] as string) || null},
        ${(rtl['unit_price'] as string) || null},
        ${(rtl['line_order'] as number) || 0}
      )
    `);
  }

  // 15. Import audit trail (as historical snapshots)
  for (const entry of payload.audit_trail || []) {
    await db.execute(sql`
      INSERT INTO audit_log (
        id, tenant_id, action, entity_type, entity_id,
        before_data, after_data, user_id, created_at
      ) VALUES (
        ${crypto.randomUUID()}, ${tenantId},
        ${(entry['action'] as string) || 'imported'},
        ${(entry['entity_type'] as string) || 'unknown'},
        ${(entry['entity_id'] as string) || 'unknown'},
        ${(entry['before_data'] as string) || null},
        ${(entry['after_data'] as string) || null},
        ${null},
        ${(entry['created_at'] as string) || new Date().toISOString()}
      )
    `);
    counts.audit_entries++;
  }

  // 16. Import saved report filters
  for (const srf of payload.saved_report_filters || []) {
    const newId = remap(srf['id'] as string)!;
    await db.execute(sql`
      INSERT INTO saved_report_filters (
        id, tenant_id, company_id, name, report_type, filters, is_default
      ) VALUES (
        ${newId}, ${tenantId}, ${companyId},
        ${srf['name'] as string},
        ${srf['report_type'] as string},
        ${srf['filters'] as string},
        ${srf['is_default'] === true}
      )
    `);
  }

  if (jobId) updateProgress(jid, 'Importing attachments', 85, `${(payload.attachment_files || []).length} files`);

  // 16b. Import attachment files (write to disk)
  const UPLOAD_DIR = process.env['UPLOAD_DIR'] || '/data/uploads';
  const tenantUploadDir = path.join(UPLOAD_DIR, tenantId);
  if ((payload.attachment_files || []).length > 0) {
    ensureDir(tenantUploadDir);
  }
  for (const af of payload.attachment_files || []) {
    try {
      const oldId = af['id'] as string;
      const newId = remap(oldId);
      if (!newId) continue;

      // Find the matching metadata
      const meta = (payload.attachments_meta || []).find((m) => m['id'] === oldId);
      if (!meta) continue;

      const originalName = (meta['file_name'] as string) || 'attachment';
      const ext = path.extname(originalName);
      const destFileName = `${newId}${ext}`;
      const destPath = path.join(tenantUploadDir, destFileName);

      fs.writeFileSync(destPath, Buffer.from(af['data'] as string, 'base64'));

      // Insert attachment record
      await db.execute(sql`
        INSERT INTO attachments (
          id, tenant_id, company_id, file_name, file_path, file_size, mime_type,
          attachable_type, attachable_id, storage_provider
        ) VALUES (
          ${newId}, ${tenantId}, ${companyId},
          ${originalName},
          ${destPath},
          ${(meta['file_size'] as number) || 0},
          ${(meta['mime_type'] as string) || 'application/octet-stream'},
          ${(meta['attachable_type'] as string) || 'transaction'},
          ${remap(meta['attachable_id'] as string | null) || newId},
          ${'local'}
        )
      `);
      counts.attachments++;
    } catch {
      // Skip individual file failures
    }
  }

  // 17. Assign specified users to the new tenant
  for (const uid of assignUserIds) {
    await db.execute(sql`
      INSERT INTO user_tenant_access (id, user_id, tenant_id, role, is_active)
      VALUES (${crypto.randomUUID()}, ${uid}, ${tenantId}, 'admin', ${true})
      ON CONFLICT DO NOTHING
    `);
  }

  // 18. Record import in audit log
  await auditLog(
    tenantId,
    'create',
    'tenant_import',
    tenantId,
    null,
    { companyName, counts, source: payload.metadata },
    userId,
  );

  warnings.push('Plaid connections not included — connect the client\'s bank if needed');
  warnings.push('No users imported — assign your team members to this company');

  const result: ImportResult = {
    company_name: companyName,
    tenant_id: tenantId,
    counts,
    warnings,
    duplicate_flags: 0,
  };

  if (jobId) {
    importProgress.set(jid, {
      status: 'completed',
      step: 'Done',
      progress: 100,
      result,
    });
  }

  return result;
}

/**
 * Import and merge into an existing tenant.
 */
export async function importMergeIntoTenant(
  validationToken: string,
  targetTenantId: string,
  userId?: string,
): Promise<ImportResult> {
  const cached = validationCache.get(validationToken);
  if (!cached || cached.expiresAt < Date.now()) {
    validationCache.delete(validationToken);
    throw AppError.badRequest('Validation token expired. Please re-upload and validate the file.');
  }

  const payload = cached.data;
  validationCache.delete(validationToken);

  // Validate target tenant exists
  const tenantResult = await db.execute(
    sql`SELECT id, name FROM tenants WHERE id = ${targetTenantId}`,
  );
  if (!tenantResult.rows.length) {
    throw AppError.notFound('Target tenant not found');
  }

  // Get the target company
  const companyResult = await db.execute(
    sql`SELECT id, business_name FROM companies WHERE tenant_id = ${targetTenantId} LIMIT 1`,
  );
  if (!companyResult.rows.length) {
    throw AppError.notFound('No company found for the target tenant');
  }
  const targetCompany = companyResult.rows[0] as { id: string; business_name: string };
  const companyId = targetCompany.id;

  const idMap = new Map<string, string>();
  function remap(oldId: string | null | undefined): string | null {
    if (!oldId) return null;
    if (!idMap.has(oldId)) {
      idMap.set(oldId, crypto.randomUUID());
    }
    return idMap.get(oldId)!;
  }

  const warnings: string[] = [];
  let duplicateFlags = 0;
  const counts = {
    accounts: 0, contacts: 0, transactions: 0, journal_lines: 0,
    invoices: 0, bills: 0, attachments: 0, tags: 0, items: 0,
    budgets: 0, bank_rules: 0, audit_entries: 0,
  };

  // 1. Match/create accounts by number or name
  const existingAccounts = await db.execute(
    sql`SELECT id, account_number, name FROM accounts WHERE tenant_id = ${targetTenantId}`,
  );
  const accountsByNumber = new Map<string, string>();
  const accountsByName = new Map<string, string>();
  for (const acc of existingAccounts.rows as { id: string; account_number: string | null; name: string }[]) {
    if (acc.account_number) accountsByNumber.set(acc.account_number, acc.id);
    accountsByName.set(acc.name.toLowerCase(), acc.id);
  }

  for (const acc of payload.accounts || []) {
    const oldId = acc['id'] as string;
    const accNumber = acc['account_number'] as string | null;
    const accName = acc['name'] as string;

    // Try to match by number first, then by name
    const matchedId = (accNumber && accountsByNumber.get(accNumber))
      || accountsByName.get(accName.toLowerCase());

    if (matchedId) {
      idMap.set(oldId, matchedId); // map to existing account
    } else {
      // Create new account
      const newId = remap(oldId)!;
      const parentId = remap(acc['parent_id'] as string | null);
      await db.execute(sql`
        INSERT INTO accounts (
          id, tenant_id, company_id, account_number, name, account_type,
          detail_type, description, is_active, is_system, system_tag,
          parent_id, balance
        ) VALUES (
          ${newId}, ${targetTenantId}, ${companyId},
          ${accNumber},
          ${accName},
          ${acc['account_type'] as string},
          ${(acc['detail_type'] as string) || null},
          ${(acc['description'] as string) || null},
          ${acc['is_active'] !== false},
          ${false},
          ${null},
          ${parentId},
          ${(acc['balance'] as string) || '0'}
        )
      `);
      counts.accounts++;
      warnings.push(`Account "${accName}" created (not in current COA)`);
    }
  }

  // 2. Match/create contacts by name + email
  const existingContacts = await db.execute(
    sql`SELECT id, display_name, email FROM contacts WHERE tenant_id = ${targetTenantId}`,
  );
  const contactsByNameEmail = new Map<string, string>();
  for (const c of existingContacts.rows as { id: string; display_name: string; email: string | null }[]) {
    const key = `${c.display_name.toLowerCase()}|${(c.email || '').toLowerCase()}`;
    contactsByNameEmail.set(key, c.id);
  }

  for (const c of payload.contacts || []) {
    const oldId = c['id'] as string;
    const name = (c['display_name'] as string) || '';
    const email = (c['email'] as string) || '';
    const key = `${name.toLowerCase()}|${email.toLowerCase()}`;

    const matchedId = contactsByNameEmail.get(key);
    if (matchedId) {
      idMap.set(oldId, matchedId);
    } else {
      const newId = remap(oldId)!;
      const defaultExpenseAccountId = remap(c['default_expense_account_id'] as string | null);
      await db.execute(sql`
        INSERT INTO contacts (
          id, tenant_id, company_id, contact_type, display_name, company_name,
          first_name, last_name, email, phone,
          billing_line1, billing_line2, billing_city, billing_state, billing_zip, billing_country,
          default_payment_terms, default_expense_account_id, tax_id, is_1099_eligible, notes, is_active
        ) VALUES (
          ${newId}, ${targetTenantId}, ${companyId},
          ${c['contact_type'] as string},
          ${name},
          ${(c['company_name'] as string) || null},
          ${(c['first_name'] as string) || null},
          ${(c['last_name'] as string) || null},
          ${email || null},
          ${(c['phone'] as string) || null},
          ${(c['billing_line1'] as string) || null},
          ${(c['billing_line2'] as string) || null},
          ${(c['billing_city'] as string) || null},
          ${(c['billing_state'] as string) || null},
          ${(c['billing_zip'] as string) || null},
          ${(c['billing_country'] as string) || 'US'},
          ${(c['default_payment_terms'] as string) || null},
          ${defaultExpenseAccountId},
          ${(c['tax_id'] as string) || null},
          ${c['is_1099_eligible'] === true},
          ${(c['notes'] as string) || null},
          ${c['is_active'] !== false}
        )
      `);
      counts.contacts++;
    }
  }

  // 3. Import items (merge by name)
  const existingItems = await db.execute(
    sql`SELECT id, name FROM items WHERE tenant_id = ${targetTenantId}`,
  );
  const itemsByName = new Map<string, string>();
  for (const item of existingItems.rows as { id: string; name: string }[]) {
    itemsByName.set(item.name.toLowerCase(), item.id);
  }

  for (const item of payload.items || []) {
    const oldId = item['id'] as string;
    const name = item['name'] as string;
    const matchedId = itemsByName.get(name.toLowerCase());
    if (matchedId) {
      idMap.set(oldId, matchedId);
    } else {
      const newId = remap(oldId)!;
      await db.execute(sql`
        INSERT INTO items (id, tenant_id, company_id, name, description, item_type, rate, is_active)
        VALUES (${newId}, ${targetTenantId}, ${companyId},
          ${name}, ${(item['description'] as string) || null},
          ${(item['item_type'] as string) || 'service'},
          ${(item['rate'] as string) || '0'}, ${item['is_active'] !== false})
      `);
      counts.items++;
    }
  }

  // 4. Import tags (merge by name)
  const existingTags = await db.execute(
    sql`SELECT id, name FROM tags WHERE tenant_id = ${targetTenantId}`,
  );
  const tagsByName = new Map<string, string>();
  for (const tag of existingTags.rows as { id: string; name: string }[]) {
    tagsByName.set(tag.name.toLowerCase(), tag.id);
  }

  for (const tg of payload.tag_groups || []) {
    remap(tg['id'] as string); // Ensure mapping exists
  }

  for (const tag of payload.tags || []) {
    const oldId = tag['id'] as string;
    const name = tag['name'] as string;
    const matchedId = tagsByName.get(name.toLowerCase());
    if (matchedId) {
      idMap.set(oldId, matchedId);
    } else {
      const newId = remap(oldId)!;
      await db.execute(sql`
        INSERT INTO tags (id, tenant_id, company_id, name, color, is_active)
        VALUES (${newId}, ${targetTenantId}, ${companyId},
          ${name}, ${(tag['color'] as string) || null}, ${true})
      `);
      counts.tags++;
    }
  }

  // 5. Import transactions with duplicate detection
  // Load existing transactions for duplicate checking
  const existingTxns = await db.execute(
    sql`SELECT id, txn_date, total, contact_id FROM transactions WHERE tenant_id = ${targetTenantId}`,
  );
  const existingTxnSet = new Set(
    (existingTxns.rows as { txn_date: string; total: string; contact_id: string }[])
      .map((t) => `${t.txn_date}|${t.total}|${t.contact_id}`),
  );

  for (const txn of payload.transactions || []) {
    const newId = remap(txn['id'] as string)!;
    const contactId = remap(txn['contact_id'] as string | null);

    // Check for potential duplicate
    const txnKey = `${txn['txn_date']}|${txn['total']}|${contactId}`;
    if (existingTxnSet.has(txnKey)) {
      duplicateFlags++;
    }

    await db.execute(sql`
      INSERT INTO transactions (
        id, tenant_id, company_id, txn_type, txn_number, txn_date, due_date,
        status, contact_id, memo, payment_terms,
        subtotal, tax_amount, total, amount_paid, balance_due,
        invoice_status, bill_status, terms_days, credits_applied,
        vendor_invoice_number
      ) VALUES (
        ${newId}, ${targetTenantId}, ${companyId},
        ${txn['txn_type'] as string},
        ${(txn['txn_number'] as string) || null},
        ${txn['txn_date'] as string},
        ${(txn['due_date'] as string) || null},
        ${(txn['status'] as string) || 'posted'},
        ${contactId},
        ${(txn['memo'] as string) || null},
        ${(txn['payment_terms'] as string) || null},
        ${(txn['subtotal'] as string) || null},
        ${(txn['tax_amount'] as string) || '0'},
        ${(txn['total'] as string) || null},
        ${(txn['amount_paid'] as string) || '0'},
        ${(txn['balance_due'] as string) || null},
        ${(txn['invoice_status'] as string) || null},
        ${(txn['bill_status'] as string) || null},
        ${(txn['terms_days'] as number) || null},
        ${(txn['credits_applied'] as string) || '0'},
        ${(txn['vendor_invoice_number'] as string) || null}
      )
    `);
    counts.transactions++;
  }

  // 6. Import journal lines
  for (const jl of payload.journal_lines || []) {
    const newId = remap(jl['id'] as string)!;
    const transactionId = remap(jl['transaction_id'] as string | null);
    const accountId = remap(jl['account_id'] as string | null);
    const itemId = remap(jl['item_id'] as string | null);

    await db.execute(sql`
      INSERT INTO journal_lines (
        id, tenant_id, company_id, transaction_id, account_id,
        debit, credit, description, item_id, quantity, unit_price, line_order
      ) VALUES (
        ${newId}, ${targetTenantId}, ${companyId},
        ${transactionId}, ${accountId},
        ${(jl['debit'] as string) || '0'},
        ${(jl['credit'] as string) || '0'},
        ${(jl['description'] as string) || null},
        ${itemId},
        ${(jl['quantity'] as string) || null},
        ${(jl['unit_price'] as string) || null},
        ${(jl['line_order'] as number) || 0}
      )
    `);
    counts.journal_lines++;
  }

  // 7. Import transaction tags
  for (const tt of payload.transaction_tags || []) {
    const transactionId = remap(tt['transaction_id'] as string | null);
    const tagId = remap(tt['tag_id'] as string | null);
    if (transactionId && tagId) {
      await db.execute(sql`
        INSERT INTO transaction_tags (transaction_id, tag_id, tenant_id, company_id)
        VALUES (${transactionId}, ${tagId}, ${targetTenantId}, ${companyId})
        ON CONFLICT DO NOTHING
      `);
    }
  }

  // 8. Import bank rules
  for (const rule of payload.bank_rules || []) {
    const newId = remap(rule['id'] as string)!;
    const categoryAccountId = remap(rule['category_account_id'] as string | null);
    await db.execute(sql`
      INSERT INTO bank_rules (
        id, tenant_id, company_id, name, priority,
        match_field, match_type, match_value,
        category_account_id, is_active
      ) VALUES (
        ${newId}, ${targetTenantId}, ${companyId},
        ${(rule['name'] as string) || 'Imported Rule'},
        ${(rule['priority'] as number) || 0},
        ${(rule['match_field'] as string) || 'description'},
        ${(rule['match_type'] as string) || 'contains'},
        ${(rule['match_value'] as string) || ''},
        ${categoryAccountId},
        ${rule['is_active'] !== false}
      )
    `);
    counts.bank_rules++;
  }

  if (duplicateFlags > 0) {
    warnings.push(`${duplicateFlags} potential duplicate transactions flagged — review in Duplicate Review`);
  }
  warnings.push('Plaid connections not included — connect the client\'s bank if needed');

  await auditLog(
    targetTenantId,
    'create',
    'tenant_import_merge',
    targetTenantId,
    null,
    { counts, duplicateFlags, source: payload.metadata },
    userId,
  );

  return {
    company_name: targetCompany.business_name,
    tenant_id: targetTenantId,
    counts,
    warnings,
    duplicate_flags: duplicateFlags,
  };
}

/**
 * Get merge preview before committing.
 */
export async function getMergePreview(
  validationToken: string,
  targetTenantId: string,
): Promise<{
  contacts: { merge: number; create: number };
  accounts: { match: number; create: number };
  transactions: { import: number; potentialDuplicates: number };
}> {
  const cached = validationCache.get(validationToken);
  if (!cached || cached.expiresAt < Date.now()) {
    throw AppError.badRequest('Validation token expired');
  }

  const payload = cached.data;

  // Check account matches
  const existingAccounts = await db.execute(
    sql`SELECT account_number, name FROM accounts WHERE tenant_id = ${targetTenantId}`,
  );
  const accNumbers = new Set((existingAccounts.rows as { account_number: string }[]).map((a) => a.account_number).filter(Boolean));
  const accNames = new Set((existingAccounts.rows as { name: string }[]).map((a) => a.name.toLowerCase()));

  let accountMatch = 0;
  let accountCreate = 0;
  for (const acc of payload.accounts || []) {
    const num = acc['account_number'] as string;
    const name = (acc['name'] as string || '').toLowerCase();
    if ((num && accNumbers.has(num)) || accNames.has(name)) {
      accountMatch++;
    } else {
      accountCreate++;
    }
  }

  // Check contact matches
  const existingContacts = await db.execute(
    sql`SELECT display_name, email FROM contacts WHERE tenant_id = ${targetTenantId}`,
  );
  const contactKeys = new Set(
    (existingContacts.rows as { display_name: string; email: string | null }[])
      .map((c) => `${c.display_name.toLowerCase()}|${(c.email || '').toLowerCase()}`),
  );

  let contactMerge = 0;
  let contactCreate = 0;
  for (const c of payload.contacts || []) {
    const key = `${((c['display_name'] as string) || '').toLowerCase()}|${((c['email'] as string) || '').toLowerCase()}`;
    if (contactKeys.has(key)) {
      contactMerge++;
    } else {
      contactCreate++;
    }
  }

  // Check potential duplicate transactions
  const existingTxns = await db.execute(
    sql`SELECT txn_date, total FROM transactions WHERE tenant_id = ${targetTenantId}`,
  );
  const txnKeys = new Set(
    (existingTxns.rows as { txn_date: string; total: string }[])
      .map((t) => `${t.txn_date}|${t.total}`),
  );

  let potentialDuplicates = 0;
  for (const txn of payload.transactions || []) {
    const key = `${txn['txn_date']}|${txn['total']}`;
    if (txnKeys.has(key)) potentialDuplicates++;
  }

  return {
    contacts: { merge: contactMerge, create: contactCreate },
    accounts: { match: accountMatch, create: accountCreate },
    transactions: {
      import: (payload.transactions || []).length,
      potentialDuplicates,
    },
  };
}

/**
 * Generate a human-readable export summary markdown document.
 */
function generateExportSummary(
  companyName: string,
  counts: Record<string, number>,
  dateRange?: { from: string; to: string },
): string {
  const now = new Date().toISOString();
  const lines = [
    `# Export Summary — ${companyName}`,
    '',
    `**Exported:** ${now}`,
    `**Source Version:** ${APP_VERSION}`,
    dateRange ? `**Date Range:** ${dateRange.from} to ${dateRange.to}` : '**Date Range:** All data',
    '',
    '## Record Counts',
    '',
    `| Data Type | Count |`,
    `|-----------|-------|`,
  ];

  for (const [key, value] of Object.entries(counts)) {
    if (value > 0) {
      const label = key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
      lines.push(`| ${label} | ${value.toLocaleString()} |`);
    }
  }

  lines.push('');
  lines.push('## What\'s Included');
  lines.push('');
  lines.push('- Chart of accounts with balances');
  lines.push('- All contacts (customers and vendors)');
  lines.push('- All transactions with journal lines');
  lines.push('- Invoice and bill details with payment applications');
  lines.push('- Tags and tag assignments');
  lines.push('- Products/services list');
  lines.push('- Bank categorization rules');
  lines.push('- Budget data');
  lines.push('- Recurring transaction templates');
  if ((counts['attachments'] || 0) > 0) {
    lines.push(`- ${counts['attachments']} attachment files`);
  }
  if ((counts['audit_entries'] || 0) > 0) {
    lines.push('- Complete audit trail');
  }
  lines.push('');
  lines.push('## What\'s NOT Included');
  lines.push('');
  lines.push('- User accounts (the receiving server has its own users)');
  lines.push('- Plaid/bank connections (must be re-established)');
  lines.push('- API keys and server-specific configuration');
  lines.push('- AI processing data');
  lines.push('');
  lines.push('## How to Import');
  lines.push('');
  lines.push('1. Log into the target Vibe MyBooks installation');
  lines.push('2. Go to Settings → Import Client Data');
  lines.push('3. Upload this .vmx file');
  lines.push('4. Enter the passphrase used to create this export');
  lines.push('5. Review the preview and choose "Import as new company" or "Merge"');
  lines.push('');

  return lines.join('\n');
}

/**
 * Simple semver comparison. Returns -1, 0, or 1.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}
