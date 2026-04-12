import { db } from '../db/index.js';
import { payrollProviderTemplates } from '../db/schema/index.js';
import { eq, and } from 'drizzle-orm';

const SYSTEM_TEMPLATES = [
  {
    name: 'Gusto — Payroll Journal',
    providerKey: 'gusto',
    description: 'Gusto Payroll Journal export. Export path: Gusto → Reports → Payroll Journal → Export CSV. Contains one row per employee per pay period with detailed tax breakdowns.',
    columnMap: {
      header_row: 0,
      data_start_row: 1,
      skip_footer_rows: 0,
      date_format: 'YYYY-MM-DD',
      mappings: {
        employee_name: { source: 'Employee Name' },
        check_date: { source: 'Check Date', format: 'YYYY-MM-DD' },
        gross_pay: { source: 'Gross Pay' },
        regular_pay: { source: 'Regular Pay' },
        overtime_pay: { source: 'Overtime Pay' },
        bonus_pay: { source: 'Bonus' },
        federal_income_tax: { source: 'Federal Income Tax' },
        state_income_tax: { source: 'State Income Tax' },
        social_security_ee: { source: 'Social Security (Employee)' },
        medicare_ee: { source: 'Medicare (Employee)' },
        health_insurance_ee: { source: 'Health Insurance' },
        retirement_401k_ee: { source: '401(k)' },
        reimbursement_ee: { source: 'Reimbursements' },
        net_pay: { source: 'Net Pay' },
        social_security_er: { source: 'Social Security (Employer)' },
        medicare_er: { source: 'Medicare (Employer)' },
        futa_er: { source: 'FUTA' },
        suta_er: { source: 'SUTA' },
      },
      skip_rules: [
        { type: 'blank_field', field: 'employee_name' },
        { type: 'value_match', field: 'employee_name', values: ['Total', 'Grand Total', 'Totals'] },
      ],
      defaults: { is_contractor: false },
    },
    fileFormatHints: { delimiter: ',', encoding: 'utf-8' },
  },
  {
    name: 'ADP Run — Payroll Detail',
    providerKey: 'adp_run',
    description: 'ADP Run Payroll Detail Report export. Export path: ADP Run → Reports → Payroll Detail → Export to Excel. Note: ADP often includes company header rows — set header row to 4-6.',
    columnMap: {
      header_row: 4,
      data_start_row: 5,
      skip_footer_rows: 2,
      date_format: 'MM/DD/YYYY',
      mappings: {
        employee_id: { source: 'File #' },
        employee_name: { source: 'Employee Name' },
        check_date: { source: 'Check Date', format: 'MM/DD/YYYY' },
        regular_pay: { source: 'Reg Earnings' },
        overtime_pay: { source: 'OT Earnings' },
        gross_pay: { source: 'Gross' },
        federal_income_tax: { source: 'FIT' },
        state_income_tax: { source: 'SIT' },
        social_security_ee: { source: 'FICA/EE' },
        medicare_ee: { source: 'MEDI/EE' },
        net_pay: { source: 'Net Pay' },
        social_security_er: { source: 'FICA/ER' },
        medicare_er: { source: 'MEDI/ER' },
        futa_er: { source: 'FUTA' },
        suta_er: { source: 'SUTA' },
      },
      skip_rules: [
        { type: 'blank_field', field: 'employee_name' },
        { type: 'value_match', field: 'employee_name', values: ['Total', 'Grand Total', 'Totals', 'Company Total'] },
      ],
      defaults: { is_contractor: false },
    },
    fileFormatHints: { delimiter: ',', encoding: 'utf-8', headerRowVariable: true },
  },
  {
    name: 'QuickBooks Online Payroll — Summary',
    providerKey: 'qbo_payroll',
    description: 'QuickBooks Online Payroll Summary export. Export path: QBO → Reports → Payroll Summary → Export to Excel. QBO prepends report metadata rows — adjust header row as needed.',
    columnMap: {
      header_row: 3,
      data_start_row: 4,
      skip_footer_rows: 1,
      date_format: 'MM/DD/YYYY',
      mappings: {
        employee_name: { source: 'Employee' },
        check_date: { source: 'Pay Period' },
        gross_pay: { source: 'Gross Pay' },
        federal_income_tax: { source: 'Federal Taxes' },
        state_income_tax: { source: 'State Taxes' },
        net_pay: { source: 'Net Pay' },
      },
      skip_rules: [
        { type: 'blank_field', field: 'employee_name' },
        { type: 'value_match', field: 'employee_name', values: ['Total', 'Totals'] },
      ],
      defaults: { is_contractor: false },
    },
    fileFormatHints: { delimiter: ',', encoding: 'utf-8', headerRowVariable: true },
  },
  {
    name: 'Paychex Flex — Payroll Register',
    providerKey: 'paychex_flex',
    description: 'Paychex Flex Payroll Register export. Export path: Paychex Flex → Reports → Payroll Register → Download CSV. Clean format, closest to the standard schema.',
    columnMap: {
      header_row: 0,
      data_start_row: 1,
      skip_footer_rows: 0,
      date_format: 'MM/DD/YYYY',
      mappings: {
        employee_name: { source: 'EE Name' },
        check_date: { source: 'Check Date', format: 'MM/DD/YYYY' },
        gross_pay: { source: 'Gross' },
        federal_income_tax: { source: 'Fed W/H' },
        state_income_tax: { source: 'State W/H' },
        social_security_ee: { source: 'OASDI/EE' },
        medicare_ee: { source: 'MED/EE' },
        net_pay: { source: 'Net' },
        social_security_er: { source: 'OASDI/ER' },
        medicare_er: { source: 'MED/ER' },
        futa_er: { source: 'FUTA' },
        suta_er: { source: 'SUTA' },
      },
      skip_rules: [
        { type: 'blank_field', field: 'employee_name' },
        { type: 'value_match', field: 'employee_name', values: ['Total', 'Grand Total'] },
      ],
      defaults: { is_contractor: false },
    },
    fileFormatHints: { delimiter: ',', encoding: 'utf-8' },
  },
  {
    name: 'Square Payroll',
    providerKey: 'square_payroll',
    description: 'Square Payroll export. Export path: Square Dashboard → Payroll → Tax Forms & Reports → Payroll Export. Square aggregates taxes into totals without granular breakdown.',
    columnMap: {
      header_row: 0,
      data_start_row: 1,
      skip_footer_rows: 0,
      date_format: 'YYYY-MM-DD',
      mappings: {
        employee_name: { source: 'Name' },
        pay_period_start: { source: 'Pay Period Start' },
        pay_period_end: { source: 'Pay Period End' },
        gross_pay: { source: 'Gross Pay' },
        other_ee_tax: { source: 'Total Employee Taxes' },
        social_security_er: { source: 'Employer Social Security' },
        medicare_er: { source: 'Employer Medicare' },
        futa_er: { source: 'FUTA' },
        suta_er: { source: 'SUTA' },
        // Note: 'Total Employer Taxes' is NOT mapped to avoid double-counting with granular columns above.
        // If the granular columns are absent, the user should remap other_er_tax manually via Column Mapper.
        other_deduction_ee: { source: 'Total Deductions' },
        net_pay: { source: 'Net Pay' },
      },
      skip_rules: [
        { type: 'blank_field', field: 'employee_name' },
      ],
      defaults: { is_contractor: false },
    },
    fileFormatHints: { delimiter: ',', encoding: 'utf-8' },
  },
  {
    name: 'Payroll Relief — GL Entries',
    providerKey: 'payroll_relief_gl',
    description: 'AccountantsWorld Payroll Relief GL Journal export. Export path: Payroll Relief → Reports → GL Entries → Export to CSV. Optionally also export Checks report for disbursement detail. This is a Mode B (pre-built JE) import — the file contains balanced debit/credit journal entries grouped by pay date.',
    columnMap: {
      date: { source: 'Date', format: 'MM/DD/YYYY' },
      description: { source: 'Description' },
      debit: { source: 'Debit' },
      credit: { source: 'Credit' },
      memo: { source: 'Memo' },
      reference: { source: 'Reference' },
    },
    fileFormatHints: {
      header_row: 0,
      currency_format: '$#,##0.00',
      memo_period_regex: 'Period: (\\d{2}/\\d{2}/\\d{4}) to (\\d{2}/\\d{2}/\\d{4})',
      contractor_prefix: '1099',
      trailing_comma: true,
    },
  },
  // ── New Mode B templates ──
  {
    name: 'ADP Run — GL Interface Export (Recommended)',
    providerKey: 'adp_run_gli',
    description: 'ADP Run GL Interface "Other" format export. Export path: ADP Run → General Ledger → GL Interface → Other. This is a Mode B (pre-built JE) import with balanced debit/credit entries. Note: You must configure your Chart of Accounts in ADP before using this export. The header row may vary — the system will attempt auto-detection.',
    columnMap: {
      date: { source: 'Check Date', format: 'MM/DD/YYYY' },
      description: { source: 'GL Account Description' },
      debit: { source: 'Debit Amount' },
      credit: { source: 'Credit Amount' },
      accountCode: { source: 'GL Account Number' },
    },
    fileFormatHints: { header_row: 5, encoding: 'utf-8' }, // TODO: verify with sample file
  },
  {
    name: 'Paychex Flex — GLS Export (Recommended)',
    providerKey: 'paychex_flex_gls',
    description: 'Paychex Flex General Ledger Summary (GLS) export. Export path: Paychex Flex → Reporting → General Ledger Summary → Export. This is a Mode B (pre-built JE) import. Note: GLS must be activated by your Paychex representative. The file may be tab-delimited or comma-delimited, and may use Windows-1252 encoding.',
    columnMap: {
      date: { source: 'Check Date', format: 'MM/DD/YYYY' },
      description: { source: 'Description' },
      debit: { source: 'Debit' },
      credit: { source: 'Credit' },
      accountCode: { source: 'GL Account' },
    },
    fileFormatHints: { delimiter: 'auto', encoding: 'auto' },
  },
  {
    name: 'OnPay — GL Summary (Recommended)',
    providerKey: 'onpay_gl_summary',
    description: 'OnPay GL Summary export. Export path: OnPay → Reports → GL Summary → Download XLSX. This is a Mode B (pre-built JE) import. Amounts are all positive; the system determines debit/credit based on the Category column (Expense = debit, Liability/Asset = credit).',
    columnMap: {
      date: { source: 'Pay Date' },
      description: { source: 'Description' },
      amount: { source: 'Amount' },
      category: { source: 'Category' },
    },
    fileFormatHints: { file_type: 'xlsx' },
  },
  {
    name: 'OnPay — Payroll Listing',
    providerKey: 'onpay_listing',
    description: 'OnPay Payroll Listing export. Export path: OnPay → Reports → Payroll Listing → Download CSV. Contains one row per employee per pay period. Note: OnPay allows users to customize which columns appear — you may need to adjust the column mapping.',
    columnMap: {
      header_row: 0,
      data_start_row: 1,
      skip_footer_rows: 0,
      date_format: 'YYYY-MM-DD',
      mappings: {
        employee_name: { source: 'Employee Name' },
        check_date: { source: 'Check Date' },
        gross_pay: { source: 'Gross Wages' },
        federal_income_tax: { source: 'Federal Tax' },
        state_income_tax: { source: 'State Tax' },
        social_security_ee: { source: 'FICA Employee' },
        medicare_ee: { source: 'Medicare Employee' },
        net_pay: { source: 'Net Pay' },
        social_security_er: { source: 'FICA Employer' },
        medicare_er: { source: 'Medicare Employer' },
        futa_er: { source: 'FUTA' },
        suta_er: { source: 'SUTA' },
      },
      skip_rules: [
        { type: 'blank_field', field: 'employee_name' },
        { type: 'value_match', field: 'employee_name', values: ['Total', 'Grand Total'] },
      ],
      defaults: { is_contractor: false },
    },
    fileFormatHints: { delimiter: ',', encoding: 'utf-8' },
  },
  {
    name: 'Toast Payroll — Journal Entry Report (Recommended)',
    providerKey: 'toast_je_report',
    description: 'Toast Payroll Journal Entry Report export. This is a Mode B (pre-built JE) import. Requires Toast Payroll Pro tier. Contact Toast support to configure the AccountID column in the export. Includes restaurant-specific items like Tips Owed and Gratuity Owed.',
    columnMap: {
      date: { source: 'Check Date' },
      description: { source: 'Account Description' },
      debit: { source: 'Debit' },
      credit: { source: 'Credit' },
      accountCode: { source: 'AccountID' },
    },
    fileFormatHints: { notes: 'Requires Toast Payroll Pro. Contact Toast support to configure AccountID column.' },
  },
  {
    name: 'Toast Payroll — Custom Reports',
    providerKey: 'toast_payroll_detail',
    description: 'Toast Payroll Custom Reports export. Available on all Toast Payroll tiers. Uses a long-format layout where each row has an Earning Name/Amount or Tax Name/Amount pair. The system will pivot this into standard wide format during import.',
    columnMap: {
      header_row: 0,
      data_start_row: 1,
      skip_footer_rows: 0,
      date_format: 'MM/DD/YYYY',
      rowFormat: 'long',
      pivotConfig: {
        employeeField: 'Employee Name',
        nameField: 'Earning Name',
        amountField: 'Earning Amount',
        dateField: 'Check Date',
      },
      mappings: {
        employee_name: { source: 'Employee Name' },
        check_date: { source: 'Check Date' },
      },
      skip_rules: [
        { type: 'blank_field', field: 'employee_name' },
      ],
      defaults: { is_contractor: false },
    },
    fileFormatHints: { delimiter: ',', encoding: 'utf-8', longFormat: true },
  },
  // ── Generic ──
  {
    name: 'Generic / Manual Mapping',
    providerKey: 'custom',
    description: 'Start with a blank mapping and manually assign each column. Use this when your payroll export doesn\'t match any of the pre-built provider templates.',
    columnMap: {
      header_row: 0,
      data_start_row: 1,
      mappings: {},
      skip_rules: [{ type: 'blank_field', field: 'employee_name' }],
    },
    fileFormatHints: {},
  },
];

export async function seedPayrollTemplates() {
  for (const tpl of SYSTEM_TEMPLATES) {
    const [existing] = await db.select({ id: payrollProviderTemplates.id })
      .from(payrollProviderTemplates)
      .where(and(
        eq(payrollProviderTemplates.providerKey, tpl.providerKey),
        eq(payrollProviderTemplates.isSystem, true),
      ))
      .limit(1);

    if (!existing) {
      await db.insert(payrollProviderTemplates).values({
        name: tpl.name,
        providerKey: tpl.providerKey,
        description: tpl.description,
        columnMap: tpl.columnMap,
        fileFormatHints: tpl.fileFormatHints,
        isSystem: true,
        tenantId: null,
      });
    }
  }
}
