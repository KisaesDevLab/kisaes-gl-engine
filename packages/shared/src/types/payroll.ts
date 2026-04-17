// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Payroll Import types

export type PayrollImportMode = 'employee_level' | 'prebuilt_je';
export type PayrollSessionStatus = 'uploaded' | 'mapped' | 'validated' | 'posted' | 'failed' | 'cancelled';
export type PayrollCheckType = 'employee' | 'contractor' | 'tax_payment';

export type PayrollProvider =
  | 'gusto' | 'adp_run' | 'adp_run_gli'
  | 'qbo_payroll'
  | 'paychex_flex' | 'paychex_flex_gls'
  | 'square_payroll'
  | 'payroll_relief_gl' | 'payroll_relief_checks'
  | 'onpay_gl_summary' | 'onpay_listing'
  | 'toast_je_report' | 'toast_payroll_detail'
  | 'custom';

/** Mode B column configuration — describes how a provider's GL export maps to debit/credit entries */
export interface ModeBColumnConfig {
  dateColumn: string;
  descriptionColumn: string;
  amountConvention: 'separate_dr_cr' | 'signed_single' | 'category_derived';
  debitColumn?: string;          // for 'separate_dr_cr'
  creditColumn?: string;         // for 'separate_dr_cr'
  amountColumn?: string;         // for 'signed_single' or 'category_derived'
  accountCategoryColumn?: string; // for 'category_derived'
  memoColumn?: string;
  referenceColumn?: string;
  accountCodeColumn?: string;     // GL account number if present
}

/** Mode B column configs per provider */
export const MODE_B_COLUMN_CONFIGS: Record<string, ModeBColumnConfig> = {
  payroll_relief_gl: {
    dateColumn: 'Date', descriptionColumn: 'Description',
    amountConvention: 'separate_dr_cr',
    debitColumn: 'Debit', creditColumn: 'Credit',
    memoColumn: 'Memo', referenceColumn: 'Reference',
  },
  adp_run_gli: {
    dateColumn: 'Check Date', descriptionColumn: 'GL Account Description',
    amountConvention: 'separate_dr_cr', // TODO: verify with sample file — may be signed_single
    debitColumn: 'Debit Amount', creditColumn: 'Credit Amount',
    accountCodeColumn: 'GL Account Number',
  },
  paychex_flex_gls: {
    dateColumn: 'Check Date', descriptionColumn: 'Description',
    amountConvention: 'separate_dr_cr',
    debitColumn: 'Debit', creditColumn: 'Credit',
    accountCodeColumn: 'GL Account',
  },
  onpay_gl_summary: {
    dateColumn: 'Pay Date', descriptionColumn: 'Description',
    amountConvention: 'category_derived',
    amountColumn: 'Amount',
    accountCategoryColumn: 'Category', // Expense, Liability, Asset
  },
  toast_je_report: {
    dateColumn: 'Check Date', descriptionColumn: 'Account Description',
    amountConvention: 'separate_dr_cr',
    debitColumn: 'Debit', creditColumn: 'Credit',
    accountCodeColumn: 'AccountID',
  },
};

/** Display names for providers */
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  gusto: 'Gusto',
  adp_run: 'ADP Run',
  adp_run_gli: 'ADP Run',
  qbo_payroll: 'QuickBooks Online Payroll',
  paychex_flex: 'Paychex Flex',
  paychex_flex_gls: 'Paychex Flex',
  square_payroll: 'Square Payroll',
  payroll_relief_gl: 'Payroll Relief',
  payroll_relief_checks: 'Payroll Relief',
  onpay_gl_summary: 'OnPay',
  onpay_listing: 'OnPay',
  toast_je_report: 'Toast Payroll',
  toast_payroll_detail: 'Toast Payroll',
  custom: 'Custom',
};

/** Canonical payroll row — one row per employee per pay period (Mode A) */
export interface PayrollImportRow {
  // Identity
  employee_name: string;
  employee_id?: string;
  department?: string;

  // Pay Period
  pay_period_start?: string;
  pay_period_end?: string;
  check_date: string;

  // Gross Pay Components
  gross_pay: number;
  regular_pay?: number;
  overtime_pay?: number;
  bonus_pay?: number;
  commission_pay?: number;
  other_pay?: number;

  // Employee Withholdings
  federal_income_tax?: number;
  state_income_tax?: number;
  local_income_tax?: number;
  social_security_ee?: number;
  medicare_ee?: number;
  other_ee_tax?: number;

  // Employee Deductions
  health_insurance_ee?: number;
  dental_vision_ee?: number;
  retirement_401k_ee?: number;
  roth_401k_ee?: number;
  hsa_ee?: number;
  other_deduction_ee?: number;
  other_deduction_ee_label?: string;

  // Net Pay
  net_pay: number;

  // Employer Taxes
  social_security_er?: number;
  medicare_er?: number;
  futa_er?: number;
  suta_er?: number;
  other_er_tax?: number;

  // Employer-Paid Benefits
  health_insurance_er?: number;
  retirement_401k_er?: number;
  other_benefit_er?: number;

  // Reimbursements (non-taxable, separate from gross wages)
  reimbursement_ee?: number;

  // Contractor
  is_contractor?: boolean;
  contractor_pay?: number;

  // Memo
  memo?: string;
}

/** All standard payroll fields with display labels */
export const PAYROLL_STANDARD_FIELDS: Record<string, { label: string; category: string; required?: boolean }> = {
  employee_name: { label: 'Employee Name', category: 'identity', required: true },
  employee_id: { label: 'Employee ID', category: 'identity' },
  department: { label: 'Department', category: 'identity' },
  pay_period_start: { label: 'Pay Period Start', category: 'pay_period' },
  pay_period_end: { label: 'Pay Period End', category: 'pay_period' },
  check_date: { label: 'Check Date', category: 'pay_period', required: true },
  gross_pay: { label: 'Gross Pay', category: 'gross', required: true },
  regular_pay: { label: 'Regular Pay', category: 'gross' },
  overtime_pay: { label: 'Overtime Pay', category: 'gross' },
  bonus_pay: { label: 'Bonus Pay', category: 'gross' },
  commission_pay: { label: 'Commission Pay', category: 'gross' },
  other_pay: { label: 'Other Pay', category: 'gross' },
  federal_income_tax: { label: 'Federal Income Tax', category: 'ee_tax' },
  state_income_tax: { label: 'State Income Tax', category: 'ee_tax' },
  local_income_tax: { label: 'Local Income Tax', category: 'ee_tax' },
  social_security_ee: { label: 'Social Security (Employee)', category: 'ee_tax' },
  medicare_ee: { label: 'Medicare (Employee)', category: 'ee_tax' },
  other_ee_tax: { label: 'Other Employee Tax', category: 'ee_tax' },
  health_insurance_ee: { label: 'Health Insurance (Employee)', category: 'ee_deduction' },
  dental_vision_ee: { label: 'Dental/Vision (Employee)', category: 'ee_deduction' },
  retirement_401k_ee: { label: '401(k) (Employee)', category: 'ee_deduction' },
  roth_401k_ee: { label: 'Roth 401(k) (Employee)', category: 'ee_deduction' },
  hsa_ee: { label: 'HSA (Employee)', category: 'ee_deduction' },
  other_deduction_ee: { label: 'Other Deduction (Employee)', category: 'ee_deduction' },
  other_deduction_ee_label: { label: 'Other Deduction Label', category: 'ee_deduction' },
  net_pay: { label: 'Net Pay', category: 'net', required: true },
  social_security_er: { label: 'Social Security (Employer)', category: 'er_tax' },
  medicare_er: { label: 'Medicare (Employer)', category: 'er_tax' },
  futa_er: { label: 'FUTA (Employer)', category: 'er_tax' },
  suta_er: { label: 'SUTA (Employer)', category: 'er_tax' },
  other_er_tax: { label: 'Other Employer Tax', category: 'er_tax' },
  health_insurance_er: { label: 'Health Insurance (Employer)', category: 'er_benefit' },
  retirement_401k_er: { label: '401(k) Match (Employer)', category: 'er_benefit' },
  other_benefit_er: { label: 'Other Benefit (Employer)', category: 'er_benefit' },
  reimbursement_ee: { label: 'Reimbursement (Employee)', category: 'ee_deduction' },
  is_contractor: { label: 'Is Contractor (1099)', category: 'contractor' },
  contractor_pay: { label: 'Contractor Pay', category: 'contractor' },
  memo: { label: 'Memo', category: 'other' },
};

/** JE line types for payroll account mapping */
export enum PayrollLineType {
  GROSS_WAGES_EXPENSE = 'gross_wages_expense',
  OFFICER_WAGES_EXPENSE = 'officer_wages_expense',
  EMPLOYER_TAX_EXPENSE = 'employer_tax_expense',
  EMPLOYER_BENEFITS_EXPENSE = 'employer_benefits_expense',
  FIT_PAYABLE = 'fit_payable',
  SIT_PAYABLE = 'sit_payable',
  LOCAL_TAX_PAYABLE = 'local_tax_payable',
  SS_PAYABLE = 'ss_payable',
  MEDICARE_PAYABLE = 'medicare_payable',
  FUTA_PAYABLE = 'futa_payable',
  SUTA_PAYABLE = 'suta_payable',
  HEALTH_INS_PAYABLE = 'health_ins_payable',
  RETIREMENT_PAYABLE = 'retirement_payable',
  OTHER_DEDUCTION_PAYABLE = 'other_deduction_payable',
  PAYROLL_CLEARING = 'payroll_clearing',
  REIMBURSEMENT_EXPENSE = 'reimbursement_expense',
  CONTRACTOR_EXPENSE = 'contractor_expense',
  CONTRACTOR_PAYABLE = 'contractor_payable',
}

/** Labels for each payroll line type */
export const PAYROLL_LINE_TYPE_LABELS: Record<PayrollLineType, string> = {
  [PayrollLineType.GROSS_WAGES_EXPENSE]: 'Gross Wages Expense',
  [PayrollLineType.OFFICER_WAGES_EXPENSE]: 'Officer Wages Expense',
  [PayrollLineType.EMPLOYER_TAX_EXPENSE]: 'Employer Payroll Tax Expense',
  [PayrollLineType.EMPLOYER_BENEFITS_EXPENSE]: 'Employer Benefits Expense',
  [PayrollLineType.FIT_PAYABLE]: 'Federal Income Tax Payable',
  [PayrollLineType.SIT_PAYABLE]: 'State Income Tax Payable',
  [PayrollLineType.LOCAL_TAX_PAYABLE]: 'Local Tax Payable',
  [PayrollLineType.SS_PAYABLE]: 'Social Security Payable',
  [PayrollLineType.MEDICARE_PAYABLE]: 'Medicare Payable',
  [PayrollLineType.FUTA_PAYABLE]: 'FUTA Payable',
  [PayrollLineType.SUTA_PAYABLE]: 'SUTA Payable',
  [PayrollLineType.HEALTH_INS_PAYABLE]: 'Health Insurance Payable',
  [PayrollLineType.RETIREMENT_PAYABLE]: 'Retirement (401k) Payable',
  [PayrollLineType.OTHER_DEDUCTION_PAYABLE]: 'Other Deductions Payable',
  [PayrollLineType.PAYROLL_CLEARING]: 'Payroll Clearing / Cash',
  [PayrollLineType.REIMBURSEMENT_EXPENSE]: 'Employee Reimbursements',
  [PayrollLineType.CONTRACTOR_EXPENSE]: 'Contractor Expense',
  [PayrollLineType.CONTRACTOR_PAYABLE]: 'Contractor Payable / Cash',
};

/** Default account search terms for auto-mapping */
export const DEFAULT_ACCOUNT_SEARCH: Record<string, string[]> = {
  [PayrollLineType.GROSS_WAGES_EXPENSE]: ['6000', '6010', 'Wages', 'Salaries', 'Payroll Expense'],
  [PayrollLineType.OFFICER_WAGES_EXPENSE]: ['6001', 'Officer', 'Wages'],
  [PayrollLineType.EMPLOYER_TAX_EXPENSE]: ['6200', '6210', 'Payroll Tax', 'Employer Tax'],
  [PayrollLineType.EMPLOYER_BENEFITS_EXPENSE]: ['6250', 'Employee Benefits', 'Benefits Expense'],
  [PayrollLineType.FIT_PAYABLE]: ['2100', '2110', 'Federal Tax Payable', 'FIT Payable'],
  [PayrollLineType.SIT_PAYABLE]: ['2120', '2130', 'State Tax Payable', 'SIT Payable'],
  [PayrollLineType.LOCAL_TAX_PAYABLE]: ['2140', 'Local Tax Payable'],
  [PayrollLineType.SS_PAYABLE]: ['2150', 'Social Security Payable', 'FICA Payable'],
  [PayrollLineType.MEDICARE_PAYABLE]: ['2160', 'Medicare Payable'],
  [PayrollLineType.FUTA_PAYABLE]: ['2170', 'FUTA Payable', 'Federal Unemployment'],
  [PayrollLineType.SUTA_PAYABLE]: ['2180', 'SUTA Payable', 'State Unemployment'],
  [PayrollLineType.HEALTH_INS_PAYABLE]: ['2190', 'Health Insurance Payable'],
  [PayrollLineType.RETIREMENT_PAYABLE]: ['2200', '401k Payable', 'Retirement Payable'],
  [PayrollLineType.OTHER_DEDUCTION_PAYABLE]: ['2210', 'Other Payroll Payable', 'Other Deductions'],
  [PayrollLineType.PAYROLL_CLEARING]: ['1000', '1010', 'Checking', 'Payroll Clearing', 'Cash'],
  [PayrollLineType.REIMBURSEMENT_EXPENSE]: ['6400', 'Reimbursement', 'Employee Reimbursement'],
  [PayrollLineType.CONTRACTOR_EXPENSE]: ['6300', 'Contract Labor', 'Subcontractor'],
  [PayrollLineType.CONTRACTOR_PAYABLE]: ['2000', 'Accounts Payable', 'Cash'],
};

/** Mode B: Payroll Relief description auto-suggestion map */
export const PAYROLL_RELIEF_DESCRIPTION_SUGGESTIONS: Record<string, {
  search_terms: string[];
  expected_normal_balance: 'debit' | 'credit';
  category: 'expense' | 'liability' | 'asset';
}> = {
  'Wages and Salary': { search_terms: ['6000', 'Wages', 'Salaries', 'Payroll Expense'], expected_normal_balance: 'debit', category: 'expense' },
  'Paycheck Tips': { search_terms: ['6005', 'Tips Expense', 'Tip Wages'], expected_normal_balance: 'debit', category: 'expense' },
  'Social Security Expense': { search_terms: ['6200', 'Payroll Tax', 'SS Expense', 'FICA Expense'], expected_normal_balance: 'debit', category: 'expense' },
  'Medicare Expense': { search_terms: ['6200', 'Payroll Tax', 'Medicare Expense'], expected_normal_balance: 'debit', category: 'expense' },
  'FUTA Expense': { search_terms: ['6210', 'FUTA', 'Federal Unemployment'], expected_normal_balance: 'debit', category: 'expense' },
  'SUTA Expense': { search_terms: ['6220', 'SUTA', 'State Unemployment'], expected_normal_balance: 'debit', category: 'expense' },
  'Disability Expense Employer': { search_terms: ['6230', 'Disability', 'Workers Comp'], expected_normal_balance: 'debit', category: 'expense' },
  '1099 Wages and Salary': { search_terms: ['6300', 'Contract Labor', 'Subcontractor', '1099'], expected_normal_balance: 'debit', category: 'expense' },
  'Social Security Withholding': { search_terms: ['2100', 'SS Payable', 'FICA Payable', 'Social Security'], expected_normal_balance: 'credit', category: 'liability' },
  'Medicare Withholding': { search_terms: ['2110', 'Medicare Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'Federal Withholding': { search_terms: ['2120', 'FIT Payable', 'Federal Tax Payable', 'Federal Income Tax'], expected_normal_balance: 'credit', category: 'liability' },
  'State Withholding': { search_terms: ['2130', 'SIT Payable', 'State Tax Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'Local Withholding': { search_terms: ['2140', 'Local Tax Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'Disability Withholding': { search_terms: ['2150', 'Disability Payable', 'SDI Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'Unemployment Withholding': { search_terms: ['2155', 'SUI Payable', 'Unemployment Payable'], expected_normal_balance: 'credit', category: 'liability' },
  '401(k) (D)': { search_terms: ['2160', '401k Payable', 'Retirement Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'Net Payroll': { search_terms: ['1000', '1010', 'Checking', 'Payroll Clearing', 'Cash'], expected_normal_balance: 'credit', category: 'asset' },
  'Social Security Payable': { search_terms: ['2100', 'SS Payable', 'FICA Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'Medicare Payable': { search_terms: ['2110', 'Medicare Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'FUTA Taxes Payable': { search_terms: ['2170', 'FUTA Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'SUTA Taxes Payable': { search_terms: ['2180', 'SUTA Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'Other Taxes Payable': { search_terms: ['2190', 'Other Tax Payable'], expected_normal_balance: 'credit', category: 'liability' },
  '1099 Federal Withholding': { search_terms: ['2120', 'FIT Payable', 'Federal Tax Payable'], expected_normal_balance: 'credit', category: 'liability' },
  '1099 Net Payroll': { search_terms: ['1000', 'Checking', 'Cash', 'Payroll Clearing'], expected_normal_balance: 'credit', category: 'asset' },
};

type DescSuggestionMap = Record<string, { search_terms: string[]; expected_normal_balance: 'debit' | 'credit'; category: 'expense' | 'liability' | 'asset' }>;

/** ADP Run GL Interface description suggestions */
export const ADP_GLI_DESCRIPTION_SUGGESTIONS: DescSuggestionMap = {
  'Payroll - Salaries & Wages': { search_terms: ['6000', 'Wages', 'Salaries', 'Payroll Expense'], expected_normal_balance: 'debit', category: 'expense' },
  'Payroll - Officer Compensation': { search_terms: ['6001', 'Officer', 'Compensation'], expected_normal_balance: 'debit', category: 'expense' },
  'ER Social Security': { search_terms: ['6200', 'Payroll Tax', 'SS Expense', 'FICA Expense'], expected_normal_balance: 'debit', category: 'expense' },
  'ER Medicare': { search_terms: ['6200', 'Payroll Tax', 'Medicare Expense'], expected_normal_balance: 'debit', category: 'expense' },
  'FUTA': { search_terms: ['6210', 'FUTA', 'Federal Unemployment'], expected_normal_balance: 'debit', category: 'expense' },
  'SUTA': { search_terms: ['6220', 'SUTA', 'State Unemployment'], expected_normal_balance: 'debit', category: 'expense' },
  'Federal Withholding': { search_terms: ['2120', 'FIT Payable', 'Federal Tax Payable', 'Federal Income Tax'], expected_normal_balance: 'credit', category: 'liability' },
  'State Withholding': { search_terms: ['2130', 'SIT Payable', 'State Tax Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'Social Security Withholding': { search_terms: ['2100', 'SS Payable', 'FICA Payable', 'Social Security'], expected_normal_balance: 'credit', category: 'liability' },
  'Medicare Withholding': { search_terms: ['2110', 'Medicare Payable'], expected_normal_balance: 'credit', category: 'liability' },
  '401(k) Deduction': { search_terms: ['2160', '401k Payable', 'Retirement Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'Health Insurance Deduction': { search_terms: ['2190', 'Health Insurance Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'Net Pay': { search_terms: ['1000', '1010', 'Checking', 'Payroll Clearing', 'Cash'], expected_normal_balance: 'credit', category: 'asset' },
  'Direct Deposit': { search_terms: ['1000', '1010', 'Checking', 'Cash'], expected_normal_balance: 'credit', category: 'asset' },
};

/** Paychex Flex GLS description suggestions */
export const PAYCHEX_GLS_DESCRIPTION_SUGGESTIONS: DescSuggestionMap = {
  'Gross Wages': { search_terms: ['6000', 'Wages', 'Salaries', 'Payroll Expense'], expected_normal_balance: 'debit', category: 'expense' },
  'OASDI/ER': { search_terms: ['6200', 'Payroll Tax', 'SS Expense', 'FICA Expense'], expected_normal_balance: 'debit', category: 'expense' },
  'MED/ER': { search_terms: ['6200', 'Payroll Tax', 'Medicare Expense'], expected_normal_balance: 'debit', category: 'expense' },
  'FUTA': { search_terms: ['6210', 'FUTA', 'Federal Unemployment'], expected_normal_balance: 'debit', category: 'expense' },
  'SUTA': { search_terms: ['6220', 'SUTA', 'State Unemployment'], expected_normal_balance: 'debit', category: 'expense' },
  'Fed W/H': { search_terms: ['2120', 'FIT Payable', 'Federal Tax Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'State W/H': { search_terms: ['2130', 'SIT Payable', 'State Tax Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'OASDI/EE': { search_terms: ['2100', 'SS Payable', 'FICA Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'MED/EE': { search_terms: ['2110', 'Medicare Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'Net Check': { search_terms: ['1000', '1010', 'Checking', 'Payroll Clearing', 'Cash'], expected_normal_balance: 'credit', category: 'asset' },
};

/** OnPay GL Summary description suggestions */
export const ONPAY_GL_DESCRIPTION_SUGGESTIONS: DescSuggestionMap = {
  'Wages Expense': { search_terms: ['6000', 'Wages', 'Salaries', 'Payroll Expense'], expected_normal_balance: 'debit', category: 'expense' },
  'FICA - Employer': { search_terms: ['6200', 'Payroll Tax', 'FICA Expense'], expected_normal_balance: 'debit', category: 'expense' },
  'FUTA Expense': { search_terms: ['6210', 'FUTA', 'Federal Unemployment'], expected_normal_balance: 'debit', category: 'expense' },
  'SUTA Expense': { search_terms: ['6220', 'SUTA', 'State Unemployment'], expected_normal_balance: 'debit', category: 'expense' },
  'Federal Income Tax W/H': { search_terms: ['2120', 'FIT Payable', 'Federal Tax Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'State Income Tax W/H': { search_terms: ['2130', 'SIT Payable', 'State Tax Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'FICA - Employee': { search_terms: ['2100', 'SS Payable', 'FICA Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'Medicare - Employee': { search_terms: ['2110', 'Medicare Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'Net Payroll': { search_terms: ['1000', '1010', 'Checking', 'Payroll Clearing', 'Cash'], expected_normal_balance: 'credit', category: 'asset' },
  'Tax Sweep': { search_terms: ['1000', 'Checking', 'Cash', 'Tax Deposit'], expected_normal_balance: 'credit', category: 'asset' },
};

/** Toast JE Report description suggestions (includes restaurant-specific items) */
export const TOAST_JE_DESCRIPTION_SUGGESTIONS: DescSuggestionMap = {
  'Regular Wages': { search_terms: ['6000', 'Wages', 'Salaries', 'Payroll Expense'], expected_normal_balance: 'debit', category: 'expense' },
  'Salary': { search_terms: ['6000', 'Wages', 'Salaries'], expected_normal_balance: 'debit', category: 'expense' },
  'Employer FICA': { search_terms: ['6200', 'Payroll Tax', 'FICA Expense'], expected_normal_balance: 'debit', category: 'expense' },
  'FUTA': { search_terms: ['6210', 'FUTA', 'Federal Unemployment'], expected_normal_balance: 'debit', category: 'expense' },
  'SUTA': { search_terms: ['6220', 'SUTA', 'State Unemployment'], expected_normal_balance: 'debit', category: 'expense' },
  'Paycheck Tips': { search_terms: ['6005', 'Tips Expense', 'Tip Wages'], expected_normal_balance: 'debit', category: 'expense' },
  'Tips Owed': { search_terms: ['2300', 'Tips Payable', 'Gratuity Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'Gratuity Owed': { search_terms: ['2310', 'Gratuity Payable', 'Tips Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'Federal Tax': { search_terms: ['2120', 'FIT Payable', 'Federal Tax Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'State Tax': { search_terms: ['2130', 'SIT Payable', 'State Tax Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'Employee FICA': { search_terms: ['2100', 'SS Payable', 'FICA Payable'], expected_normal_balance: 'credit', category: 'liability' },
  'Net Pay': { search_terms: ['1000', '1010', 'Checking', 'Payroll Clearing', 'Cash'], expected_normal_balance: 'credit', category: 'asset' },
  'Toast Service Fee': { search_terms: ['6500', 'Service Fee', 'Processing Fee', 'SaaS Fee'], expected_normal_balance: 'debit', category: 'expense' },
};

/** All Mode B description suggestion maps, keyed by provider */
export const MODE_B_DESCRIPTION_SUGGESTIONS: Record<string, DescSuggestionMap> = {
  payroll_relief_gl: PAYROLL_RELIEF_DESCRIPTION_SUGGESTIONS,
  adp_run_gli: ADP_GLI_DESCRIPTION_SUGGESTIONS,
  paychex_flex_gls: PAYCHEX_GLS_DESCRIPTION_SUGGESTIONS,
  onpay_gl_summary: ONPAY_GL_DESCRIPTION_SUGGESTIONS,
  toast_je_report: TOAST_JE_DESCRIPTION_SUGGESTIONS,
};

/** Provider signatures for auto-detection */
export const PROVIDER_SIGNATURES: Record<string, string[]> = {
  // Mode A (employee-level)
  gusto: ['Employee Name', 'Check Date', 'Gross Pay', 'Net Pay', 'Federal Income Tax', 'Social Security (Employee)'],
  adp_run: ['File #', 'Employee Name', 'Check Date', 'Earnings', 'Taxes', 'Net Pay', 'Deductions'],
  qbo_payroll: ['Employee', 'Pay Period', 'Total Hours', 'Gross Pay', 'Federal Taxes', 'State Taxes', 'Net Pay'],
  paychex_flex: ['EE Name', 'Check Date', 'Gross', 'Fed W/H', 'State W/H', 'OASDI/EE', 'MED/EE', 'Net'],
  square_payroll: ['Name', 'Pay Period Start', 'Pay Period End', 'Net Pay', 'Total Employer Taxes', 'Total Employee Taxes'],
  onpay_listing: ['Employee Name', 'Check Date', 'Gross Wages', 'Net Pay', 'Federal Tax', 'State Tax', 'FICA Employee'],
  toast_payroll_detail: ['Employee Name', 'Check Date', 'Earning Name', 'Earning Amount', 'Tax Name', 'Tax Amount'],
  // Mode B (GL-mapped)
  payroll_relief_gl: ['Date', 'Reference', 'Account', 'Description', 'Debit', 'Credit', 'Memo'],
  payroll_relief_checks: ['Check Number', 'Date', 'Payee Name', 'Cash Account', 'Account', 'Amount', 'Memo'],
  adp_run_gli: ['Company Code', 'Check Date', 'GL Account Number', 'GL Account Description', 'Debit Amount', 'Credit Amount'],
  paychex_flex_gls: ['Check Date', 'GL Account', 'Description', 'Debit', 'Credit'],
  onpay_gl_summary: ['Pay Date', 'Description', 'Category', 'Amount'],
  toast_je_report: ['AccountID', 'Account Description', 'Debit', 'Credit', 'Check Date', 'Pay Group'],
};

/** Set of Mode B provider keys for import mode detection */
export const MODE_B_PROVIDERS = new Set([
  'payroll_relief_gl',
  'adp_run_gli',
  'paychex_flex_gls',
  'onpay_gl_summary',
  'toast_je_report',
]);

/** Tax agency patterns for check classification */
export const TAX_AGENCY_PATTERNS = [
  /federal\s+(check\s+)?payment/i,
  /^irs$/i,
  /^us\s+treasury/i,
  /state\s+of\s+\w+/i,
  /\w+\s+income\s+tax/i,
  /\w+\s+department\s+of\s+(revenue|taxation)/i,
];

// ── API response/input types ──

export interface PayrollImportSession {
  id: string;
  tenantId: string;
  companyId: string | null;
  importMode: PayrollImportMode;
  templateId: string | null;
  originalFilename: string;
  filePath: string;
  fileHash: string;
  companionFilename: string | null;
  companionFilePath: string | null;
  payPeriodStart: string | null;
  payPeriodEnd: string | null;
  checkDate: string | null;
  status: PayrollSessionStatus;
  rowCount: number;
  errorCount: number;
  jeCount: number;
  journalEntryId: string | null;
  journalEntryIds: string[] | null;
  columnMapSnapshot: any;
  metadata: any;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PayrollProviderTemplate {
  id: string;
  name: string;
  providerKey: string;
  description: string | null;
  columnMap: any;
  fileFormatHints: any;
  isSystem: boolean;
  tenantId: string | null;
}

export interface PayrollDescriptionMapping {
  sourceDescription: string;
  debitOrCredit: 'debit' | 'credit';
  sampleAmount: string;
  accountId: string | null;
  accountName: string | null;
  accountNumber: string | null;
  status: 'mapped' | 'suggested' | 'unmapped';
  lineCategory: string | null;
}

export interface PayrollCheckRow {
  id: string;
  rowNumber: number;
  checkNumber: string | null;
  checkDate: string;
  payeeName: string;
  amount: string;
  memo: string | null;
  checkType: PayrollCheckType | null;
  posted: boolean;
  transactionId: string | null;
}

export interface PayrollValidationMessage {
  field: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface PayrollValidationSummary {
  totalRows: number;
  validRows: number;
  warningRows: number;
  errorRows: number;
  messages: PayrollValidationMessage[];
}

export interface PayrollJEPreviewLine {
  lineType: string;
  description: string;
  accountId: string | null;
  accountName: string | null;
  accountNumber: string | null;
  debit: string;
  credit: string;
}

export interface PayrollJEPreview {
  date: string;
  memo: string;
  lines: PayrollJEPreviewLine[];
  totalDebits: string;
  totalCredits: string;
  isBalanced: boolean;
}

export interface PayrollAccountMappingEntry {
  lineType: string;
  lineTypeLabel: string;
  accountId: string | null;
  accountName: string | null;
  accountNumber: string | null;
}

export interface ColumnMapConfig {
  header_row: number;
  data_start_row: number;
  skip_footer_rows?: number;
  date_format?: string;
  mappings: Record<string, { source: string; format?: string }>;
  skip_rules?: Array<{
    type: 'blank_field' | 'value_match';
    field: string;
    values?: string[];
  }>;
  defaults?: Record<string, any>;
}

export interface PayrollSessionFilters {
  companyId?: string;
  status?: PayrollSessionStatus;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}
