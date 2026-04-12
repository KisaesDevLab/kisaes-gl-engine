import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ColumnMapConfig, PayrollImportRow } from '@kis-books/shared';
import { PROVIDER_SIGNATURES, MODE_B_PROVIDERS } from '@kis-books/shared';
import { AppError } from '../utils/errors.js';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_ROW_COUNT = 10_000;

// ── CSV Parser ──

export function parseCsvText(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let current = '';
  let inQuotes = false;
  let row: string[] = [];

  // Strip BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        row.push(current.trim());
        current = '';
      } else if (ch === '\r' && next === '\n') {
        row.push(current.trim());
        if (row.some(c => c !== '')) rows.push(row);
        row = [];
        current = '';
        i++;
      } else if (ch === '\n') {
        row.push(current.trim());
        if (row.some(c => c !== '')) rows.push(row);
        row = [];
        current = '';
      } else {
        current += ch;
      }
    }
  }
  // Last field/row
  row.push(current.trim());
  if (row.some(c => c !== '')) rows.push(row);

  return rows;
}

// ── XLSX Parser ──

export async function parseXlsxBuffer(
  buffer: Buffer,
  options?: { sheetName?: string; sheetIndex?: number },
): Promise<string[][]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = options?.sheetName || wb.SheetNames[options?.sheetIndex ?? 0];
  const sheet = sheetName ? wb.Sheets[sheetName] : undefined;
  if (!sheet) throw AppError.badRequest('Excel file has no sheets');
  const data: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  return data.map(row => row.map((cell: any) => {
    if (cell instanceof Date) {
      return cell.toISOString().split('T')[0]!;
    }
    return String(cell ?? '');
  }));
}

// ── File Type Detection ──

export function detectFileType(filename: string, buffer: Buffer): 'csv' | 'tsv' | 'xlsx' | 'xls' {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') {
    // Check XLSX magic bytes (PK zip)
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) return 'xlsx';
    // Check XLS magic bytes (compound doc)
    if (buffer[0] === 0xd0 && buffer[1] === 0xcf) return 'xls';
    return ext === '.xlsx' ? 'xlsx' : 'xls';
  }
  if (ext === '.tsv') return 'tsv';
  // .txt and .csv: auto-detect delimiter from content
  const sample = buffer.slice(0, 2000).toString('utf-8');
  const tabs = (sample.match(/\t/g) || []).length;
  const commas = (sample.match(/,/g) || []).length;
  if (tabs > commas && tabs > 5) return 'tsv';
  return 'csv';
}

// ── Header Row Auto-Detection ──

export function detectHeaderRow(rows: string[][], maxScan = 10): number {
  let bestScore = -1;
  let bestRow = 0;

  for (let i = 0; i < Math.min(rows.length, maxScan); i++) {
    const row = rows[i]!;
    let score = 0;
    for (const cell of row) {
      if (!cell) continue;
      // Headers are typically text, not numbers
      if (isNaN(Number(cell.replace(/[$,]/g, ''))) && cell.length > 1 && cell.length < 60) {
        score++;
      }
      // Headers shouldn't start with $ or be dates
      if (cell.startsWith('$') || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(cell)) {
        score -= 2;
      }
    }
    // Bonus for rows with more non-empty cells
    score += row.filter(c => c !== '').length * 0.5;
    if (score > bestScore) {
      bestScore = score;
      bestRow = i;
    }
  }
  return bestRow;
}

// ── Provider Auto-Detection ──

/** Normalize a header string for resilient matching (handles Gusto column drift, etc.) */
function normalizeHeader(h: string): string {
  return h.toLowerCase().trim()
    .replace(/\s+/g, ' ')         // collapse multiple spaces
    .replace(/[()\/\\]/g, '');     // strip parens & slashes
}

export function detectProvider(headers: string[]): { provider: string; confidence: number } | null {
  const normalizedHeaders = headers.map(normalizeHeader);
  let bestProvider: string | null = null;
  let bestScore = 0;

  for (const [provider, signature] of Object.entries(PROVIDER_SIGNATURES)) {
    const matched = signature.filter(sig => {
      const normSig = normalizeHeader(sig);
      return normalizedHeaders.some(h => h === normSig || h.includes(normSig));
    });
    const score = matched.length / signature.length;
    if (score > bestScore) {
      bestScore = score;
      bestProvider = provider;
    }
  }

  if (bestProvider && bestScore >= 0.6) {
    return { provider: bestProvider, confidence: Math.round(bestScore * 100) };
  }
  return null;
}

// ── Determine import mode from provider detection ──

export function detectImportMode(provider: string | null): 'employee_level' | 'prebuilt_je' {
  if (provider && MODE_B_PROVIDERS.has(provider)) return 'prebuilt_je';
  return 'employee_level';
}

// ── File Hashing ──

export function hashBuffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ── File Storage ──

const ALLOWED_EXTENSIONS = ['.csv', '.tsv', '.xlsx', '.xls', '.txt'];

export async function storePayrollFile(
  buffer: Buffer,
  originalFilename: string,
  uploadDir: string,
): Promise<{ filePath: string; fileHash: string }> {
  const fileHash = hashBuffer(buffer);
  const rawExt = path.extname(originalFilename).toLowerCase();
  const ext = ALLOWED_EXTENSIONS.includes(rawExt) ? rawExt : '.csv';
  const storedName = `${crypto.randomUUID()}${ext}`;
  const dir = path.join(uploadDir, 'payroll');
  await fs.promises.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, storedName);
  await fs.promises.writeFile(filePath, buffer);
  return { filePath, fileHash };
}

// ── Parse File to Rows ──

/** Decode a buffer to text, falling back to Windows-1252 if UTF-8 produces replacement characters */
function decodeBuffer(buffer: Buffer): string {
  const utf8 = buffer.toString('utf-8');
  // If UTF-8 decoding produced replacement characters, try Windows-1252 (common for ADP/Paychex)
  if (utf8.includes('\ufffd')) {
    try {
      const decoder = new TextDecoder('windows-1252');
      return decoder.decode(buffer);
    } catch {
      // TextDecoder may not support windows-1252 in all runtimes; fall back to UTF-8
    }
  }
  return utf8;
}

export async function parseFile(
  buffer: Buffer,
  filename: string,
  options?: { sheetName?: string; sheetIndex?: number },
): Promise<{
  rows: string[][];
  fileType: 'csv' | 'tsv' | 'xlsx' | 'xls';
}> {
  if (buffer.length > MAX_FILE_SIZE) {
    throw AppError.badRequest(`File exceeds maximum size of ${MAX_FILE_SIZE / (1024 * 1024)} MB`);
  }

  const fileType = detectFileType(filename, buffer);
  let rows: string[][];

  if (fileType === 'xlsx' || fileType === 'xls') {
    rows = await parseXlsxBuffer(buffer, options);
  } else {
    const delimiter = fileType === 'tsv' ? '\t' : ',';
    const text = decodeBuffer(buffer);
    rows = parseCsvText(text, delimiter);
  }

  if (rows.length > MAX_ROW_COUNT + 20) {
    throw AppError.badRequest(`File has too many rows (${rows.length}). Maximum is ${MAX_ROW_COUNT}`);
  }

  return { rows, fileType };
}

// ── Currency Parsing ──

export function parseCurrency(value: string | number | null | undefined): number {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') return value;
  let str = String(value).trim();
  // Handle parenthetical negatives: (1,234.56) → -1234.56
  const isNeg = str.startsWith('(') && str.endsWith(')');
  if (isNeg) str = str.slice(1, -1);
  // Handle trailing minus: 500.00- → -500.00
  const trailingNeg = !isNeg && str.endsWith('-');
  if (trailingNeg) str = str.slice(0, -1);
  // Strip $, commas, spaces
  str = str.replace(/[$,\s]/g, '');
  const num = parseFloat(str);
  if (isNaN(num)) return 0;
  return (isNeg || trailingNeg) ? -num : num;
}

// ── Date Parsing ──

export function parseDate(value: string, _format?: string): string | null {
  if (!value || !value.trim()) return null;
  const str = value.trim();

  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  // Try MM/DD/YYYY (most common US format)
  const usMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const [, m, d, y] = usMatch;
    return `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
  }

  // Try MM-DD-YYYY
  const dashMatch = str.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dashMatch) {
    const [, m, d, y] = dashMatch;
    return `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
  }

  // Try YYYY/MM/DD
  const isoSlash = str.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (isoSlash) {
    const [, y, m, d] = isoSlash;
    return `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
  }

  return null;
}

// ── Apply Column Mapping ──

export function applyColumnMapping(
  rows: string[][],
  headers: string[],
  config: ColumnMapConfig,
): { mappedRows: Record<string, any>[]; skippedCount: number; originalIndices: number[] } {
  const mappedRows: Record<string, any>[] = [];
  const originalIndices: number[] = [];
  let skippedCount = 0;

  const headerIndex = new Map<string, number>();
  headers.forEach((h, i) => headerIndex.set(h, i));

  const dataRows = rows.slice(config.data_start_row);
  const endIndex = config.skip_footer_rows
    ? dataRows.length - config.skip_footer_rows
    : dataRows.length;

  for (let i = 0; i < endIndex; i++) {
    const row = dataRows[i]!;
    const mapped: Record<string, any> = {};

    // Apply mappings
    for (const [field, mapping] of Object.entries(config.mappings)) {
      const colIdx = headerIndex.get(mapping.source);
      if (colIdx !== undefined && colIdx < row.length) {
        mapped[field] = row[colIdx];
      }
    }

    // Apply defaults
    if (config.defaults) {
      for (const [field, value] of Object.entries(config.defaults)) {
        if (mapped[field] === undefined || mapped[field] === '') {
          mapped[field] = value;
        }
      }
    }

    // Apply skip rules
    let skip = false;
    if (config.skip_rules) {
      for (const rule of config.skip_rules) {
        const val = mapped[rule.field];
        if (rule.type === 'blank_field' && (!val || String(val).trim() === '')) {
          skip = true;
          break;
        }
        if (rule.type === 'value_match' && rule.values) {
          const strVal = String(val ?? '').trim().toLowerCase();
          if (rule.values.some(v => v.toLowerCase() === strVal)) {
            skip = true;
            break;
          }
        }
      }
    }

    if (skip) {
      skippedCount++;
      continue;
    }

    // Normalize date fields
    for (const dateField of ['check_date', 'pay_period_start', 'pay_period_end']) {
      if (mapped[dateField]) {
        const parsed = parseDate(String(mapped[dateField]), config.date_format);
        if (parsed) mapped[dateField] = parsed;
      }
    }

    // Normalize currency fields
    const currencyFields = [
      'gross_pay', 'regular_pay', 'overtime_pay', 'bonus_pay', 'commission_pay', 'other_pay',
      'federal_income_tax', 'state_income_tax', 'local_income_tax',
      'social_security_ee', 'medicare_ee', 'other_ee_tax',
      'health_insurance_ee', 'dental_vision_ee', 'retirement_401k_ee', 'roth_401k_ee',
      'hsa_ee', 'other_deduction_ee',
      'net_pay',
      'social_security_er', 'medicare_er', 'futa_er', 'suta_er', 'other_er_tax',
      'health_insurance_er', 'retirement_401k_er', 'other_benefit_er',
      'reimbursement_ee',
      'contractor_pay',
    ];
    for (const field of currencyFields) {
      if (mapped[field] !== undefined) {
        mapped[field] = parseCurrency(mapped[field]);
      }
    }

    // Boolean fields
    if (mapped['is_contractor'] !== undefined) {
      const v = String(mapped['is_contractor']).toLowerCase();
      mapped['is_contractor'] = v === 'true' || v === 'yes' || v === '1';
    }

    mappedRows.push(mapped);
    originalIndices.push(i);
  }

  return { mappedRows, skippedCount, originalIndices };
}

// ── Row to PayrollImportRow conversion (best-effort) ──

export function toPayrollImportRow(mapped: Record<string, any>): PayrollImportRow {
  const m = mapped as any;
  return {
    employee_name: String(m.employee_name ?? ''),
    employee_id: m.employee_id ? String(m.employee_id) : undefined,
    department: m.department ? String(m.department) : undefined,
    pay_period_start: m.pay_period_start || undefined,
    pay_period_end: m.pay_period_end || undefined,
    check_date: String(m.check_date ?? ''),
    gross_pay: Number(m.gross_pay ?? 0),
    regular_pay: m.regular_pay != null ? Number(m.regular_pay) : undefined,
    overtime_pay: m.overtime_pay != null ? Number(m.overtime_pay) : undefined,
    bonus_pay: m.bonus_pay != null ? Number(m.bonus_pay) : undefined,
    commission_pay: m.commission_pay != null ? Number(m.commission_pay) : undefined,
    other_pay: m.other_pay != null ? Number(m.other_pay) : undefined,
    federal_income_tax: m.federal_income_tax != null ? Number(m.federal_income_tax) : undefined,
    state_income_tax: m.state_income_tax != null ? Number(m.state_income_tax) : undefined,
    local_income_tax: m.local_income_tax != null ? Number(m.local_income_tax) : undefined,
    social_security_ee: m.social_security_ee != null ? Number(m.social_security_ee) : undefined,
    medicare_ee: m.medicare_ee != null ? Number(m.medicare_ee) : undefined,
    other_ee_tax: m.other_ee_tax != null ? Number(m.other_ee_tax) : undefined,
    health_insurance_ee: m.health_insurance_ee != null ? Number(m.health_insurance_ee) : undefined,
    dental_vision_ee: m.dental_vision_ee != null ? Number(m.dental_vision_ee) : undefined,
    retirement_401k_ee: m.retirement_401k_ee != null ? Number(m.retirement_401k_ee) : undefined,
    roth_401k_ee: m.roth_401k_ee != null ? Number(m.roth_401k_ee) : undefined,
    hsa_ee: m.hsa_ee != null ? Number(m.hsa_ee) : undefined,
    other_deduction_ee: m.other_deduction_ee != null ? Number(m.other_deduction_ee) : undefined,
    other_deduction_ee_label: m.other_deduction_ee_label || undefined,
    net_pay: Number(m.net_pay ?? 0),
    social_security_er: m.social_security_er != null ? Number(m.social_security_er) : undefined,
    medicare_er: m.medicare_er != null ? Number(m.medicare_er) : undefined,
    futa_er: m.futa_er != null ? Number(m.futa_er) : undefined,
    suta_er: m.suta_er != null ? Number(m.suta_er) : undefined,
    other_er_tax: m.other_er_tax != null ? Number(m.other_er_tax) : undefined,
    health_insurance_er: m.health_insurance_er != null ? Number(m.health_insurance_er) : undefined,
    retirement_401k_er: m.retirement_401k_er != null ? Number(m.retirement_401k_er) : undefined,
    other_benefit_er: m.other_benefit_er != null ? Number(m.other_benefit_er) : undefined,
    reimbursement_ee: m.reimbursement_ee != null ? Number(m.reimbursement_ee) : undefined,
    is_contractor: m.is_contractor || false,
    contractor_pay: m.contractor_pay != null ? Number(m.contractor_pay) : undefined,
    memo: m.memo || undefined,
  };
}

// ── Pivot Long-Format Rows (Toast custom reports) ──
// Toast uses rows like: Employee Name, Earning Name, Earning Amount (one row per earning/tax line)
// This pivots them into the standard wide format (one row per employee)

export function pivotLongFormat(
  rows: Record<string, any>[],
  config: { employeeField: string; nameField: string; amountField: string; dateField: string },
): Record<string, any>[] {
  const { employeeField, nameField, amountField, dateField } = config;
  const grouped = new Map<string, Record<string, any>>();

  for (const row of rows) {
    const empKey = String(row[employeeField] || '').trim();
    if (!empKey) continue;

    const dateVal = row[dateField] || '';
    const key = `${empKey}|${dateVal}`;

    if (!grouped.has(key)) {
      grouped.set(key, { employee_name: empKey, check_date: dateVal });
    }

    const entry = grouped.get(key)!;
    const name = String(row[nameField] || '').trim().toLowerCase().replace(/\s+/g, '_');
    const amount = row[amountField];

    if (name && amount !== undefined) {
      entry[name] = (entry[name] || 0) + (typeof amount === 'number' ? amount : parseFloat(String(amount).replace(/[$,]/g, '')) || 0);
    }
  }

  return Array.from(grouped.values());
}
