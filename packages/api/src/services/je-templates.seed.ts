// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Default journal-entry templates seeded for every tenant. Currently one:
// "Monthly Payroll", the standard payroll accrual/expense split.
//
// Account references are by NAME, not number — account numbers vary from
// one client's chart to the next, so the seed resolves each line's account
// by (case-insensitive) name against the tenant's own chart at seed time
// (the je_template_lines schema stores a resolved account_id, and nothing
// re-resolves it at use time). A line whose account name isn't found is
// left UNMAPPED (account_id = null); staff pick the account in the builder
// before the template can post. Nothing is auto-created in the chart.
//
// Seeding is idempotent per tenant, keyed on the template name — a tenant
// that already has a "Monthly Payroll" template (in any state) is skipped,
// so this never clobbers an operator's edits or runs twice. It is invoked
// from tenant provisioning (new tenants) and from a boot-time sweep over
// existing tenants (see index.ts), so both paths converge on the same row.

import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import { jeTemplates, jeTemplateLines, accounts, tenants } from '../db/schema/index.js';

const TEMPLATE_NAME = 'Monthly Payroll';
const TEMPLATE_MEMO = 'To record monthly payroll';

interface SeedLine {
  label: string;
  /** Account name to resolve per tenant (case-insensitive). */
  account: string;
  side: 'debit' | 'credit';
  required?: boolean;
}

// Mirrors the standard Monthly Payroll template: gross wages + employer
// taxes on the debit side, withholdings / net pay / payables cleared
// through Payroll Clearing on the credit side.
const MONTHLY_PAYROLL_LINES: SeedLine[] = [
  { label: 'Wages and Salary', account: 'Salaries Expense', side: 'debit', required: true },
  { label: 'Federal Withholding', account: 'Payroll Clearing', side: 'credit' },
  { label: 'Social Security Withholding', account: 'Payroll Clearing', side: 'credit' },
  { label: 'Medicare Withholding', account: 'Payroll Clearing', side: 'credit' },
  { label: 'State Withholding', account: 'Payroll Clearing', side: 'credit' },
  { label: 'Net Payroll', account: 'Payroll Clearing', side: 'credit' },
  { label: 'Social Security Expense', account: 'Payroll Taxes', side: 'debit' },
  { label: 'Medicare Expense', account: 'Payroll Taxes', side: 'debit' },
  { label: 'Social Security Payable', account: 'Payroll Clearing', side: 'credit' },
  { label: 'Medicare Payable', account: 'Payroll Clearing', side: 'credit' },
  { label: 'FUTA Expense', account: 'Payroll Taxes', side: 'debit' },
  { label: 'FUTA Payable', account: 'Payroll Clearing', side: 'credit' },
  { label: 'SUTA Expense', account: 'Payroll Taxes', side: 'debit' },
  { label: 'SUTA Payable', account: 'Payroll Clearing', side: 'credit' },
];

/**
 * Build a case-insensitive account-name → id map for a tenant. Active
 * accounts win over inactive ones sharing a name (and null-is_active rows
 * are treated as active — the column defaults true but is nullable).
 */
async function accountNameMap(tenantId: string, companyId?: string): Promise<Map<string, string>> {
  const conds = [eq(accounts.tenantId, tenantId)];
  if (companyId) conds.push(or(eq(accounts.companyId, companyId), isNull(accounts.companyId))!);
  const rows = await db
    .select({ id: accounts.id, name: accounts.name, isActive: accounts.isActive })
    .from(accounts)
    .where(and(...conds));
  const byName = new Map<string, string>();
  for (const a of rows) {
    const key = a.name.trim().toLowerCase();
    if (!byName.has(key) || a.isActive !== false) byName.set(key, a.id);
  }
  return byName;
}

/**
 * Seed the default JE template(s) for a single tenant. Idempotent — a
 * no-op if the tenant already has a template with the same name.
 */
export async function seedDefaultJeTemplatesForTenant(
  tenantId: string,
  companyId?: string,
): Promise<{ created: boolean; templateId: string; unmappedLines: number }> {
  const existing = await db
    .select({ id: jeTemplates.id })
    .from(jeTemplates)
    .where(and(eq(jeTemplates.tenantId, tenantId), eq(jeTemplates.name, TEMPLATE_NAME)));
  if (existing[0]) return { created: false, templateId: existing[0].id, unmappedLines: 0 };

  const byName = await accountNameMap(tenantId, companyId);

  const [tpl] = await db
    .insert(jeTemplates)
    .values({ tenantId, companyId: companyId ?? null, name: TEMPLATE_NAME, memo: TEMPLATE_MEMO })
    .returning();
  if (!tpl) throw new Error('Failed to insert Monthly Payroll template');

  let unmappedLines = 0;
  const lineValues = MONTHLY_PAYROLL_LINES.map((l, i) => {
    const accountId = byName.get(l.account.trim().toLowerCase()) ?? null;
    if (!accountId) unmappedLines += 1;
    return {
      tenantId,
      templateId: tpl.id,
      label: l.label,
      accountId,
      normalSide: l.side,
      sortOrder: i,
      isRequired: !!l.required,
    };
  });
  await db.insert(jeTemplateLines).values(lineValues);

  return { created: true, templateId: tpl.id, unmappedLines };
}

/**
 * Boot-time sweep: ensure every existing tenant has the default template.
 * Per-tenant failures are logged and skipped so one bad tenant never
 * aborts the sweep (or server startup).
 */
export async function seedDefaultJeTemplatesAllTenants(): Promise<{ seeded: number; total: number }> {
  const all = await db.select({ id: tenants.id }).from(tenants);
  let seeded = 0;
  for (const t of all) {
    try {
      const r = await seedDefaultJeTemplatesForTenant(t.id);
      if (r.created) seeded += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Failed to seed default JE template for tenant ${t.id}:`, err);
    }
  }
  return { seeded, total: all.length };
}
