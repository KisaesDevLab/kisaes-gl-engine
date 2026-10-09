// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, asc, sql } from 'drizzle-orm';
import {
  BUSINESS_TEMPLATES,
  BUSINESS_TYPE_OPTIONS,
  type CoaTemplate,
  type CoaTemplateAccountInput,
  type CoaTemplateOption,
  type CoaTemplateSummary,
  type CreateCoaTemplateInput,
  type UpdateCoaTemplateInput,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { coaTemplatesTable, accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';

type DbCoaTemplate = typeof coaTemplatesTable.$inferSelect;

function rowToTemplate(row: DbCoaTemplate): CoaTemplate {
  return {
    id: row.id,
    slug: row.slug,
    label: row.label,
    accounts: (row.accounts as CoaTemplateAccountInput[]) ?? [],
    isBuiltin: row.isBuiltin,
    isHidden: row.isHidden,
    accountsCustomized: row.accountsCustomized,
    createdByUserId: row.createdByUserId ?? null,
    createdAt: (row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt as unknown as string)).toISOString(),
    updatedAt: (row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt as unknown as string)).toISOString(),
  };
}

function rowToSummary(row: DbCoaTemplate): CoaTemplateSummary {
  const acctList = (row.accounts as CoaTemplateAccountInput[]) ?? [];
  return {
    id: row.id,
    slug: row.slug,
    label: row.label,
    isBuiltin: row.isBuiltin,
    isHidden: row.isHidden,
    accountsCustomized: row.accountsCustomized,
    accountCount: acctList.length,
    updatedAt: (row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt as unknown as string)).toISOString(),
  };
}

// Built-ins seeded hidden on a fresh install. `personal_activities` is not a
// business chart of accounts; migration 0176 hides it on existing installs.
const HIDDEN_BY_DEFAULT = new Set(['personal_activities']);

/**
 * On every startup, copy the static BUSINESS_TEMPLATES into the database
 * so super admins have something to manage, and re-sync the accounts of
 * existing built-in rows so they stay in lockstep with the code constant
 * (built-in accounts are frozen against admin edits — see update()).
 * Label and is_hidden are admin-owned and never touched on conflict.
 * Idempotent and safe to call from API startup unconditionally,
 * INCLUDING under scale-out where two API containers may boot
 * simultaneously.
 *
 * Race safety: the upsert is intentionally not wrapped in any
 * application-level "am I first?" logic. `ON CONFLICT (slug) DO UPDATE`
 * with a setWhere that only fires for built-ins whose accounts differ
 * means a second container's upsert is a no-op. Without the ON CONFLICT
 * clause the second container would crash on the unique index
 * (idx_coa_templates_slug) and the API would fail to start.
 *
 * `returning()` reports only rows this caller inserted or changed;
 * `xmax = 0` distinguishes a fresh insert from an update.
 */
export async function bootstrapBuiltins(): Promise<{ inserted: number; synced: number }> {
  // Build (slug → label) map from BUSINESS_TYPE_OPTIONS so the labels match
  // what the rest of the app already shows.
  const labelBySlug = new Map<string, string>();
  for (const opt of BUSINESS_TYPE_OPTIONS) {
    labelBySlug.set(opt.value, opt.label);
  }

  const rows = Object.entries(BUSINESS_TEMPLATES).map(([slug, accountsList]) => ({
    slug,
    label: labelBySlug.get(slug) ?? slug,
    accounts: accountsList as unknown as CoaTemplateAccountInput[],
    isBuiltin: true,
    isHidden: HIDDEN_BY_DEFAULT.has(slug),
  }));

  if (rows.length === 0) {
    return { inserted: 0, synced: 0 };
  }

  const changed = await db
    .insert(coaTemplatesTable)
    .values(rows)
    .onConflictDoUpdate({
      target: coaTemplatesTable.slug,
      set: { accounts: sql`excluded.accounts`, updatedAt: new Date() },
      // A built-in a super admin edited (accounts_customized) is left alone
      // until "Reset to default" (migration 0199).
      setWhere: sql`${coaTemplatesTable.isBuiltin} = true AND ${coaTemplatesTable.accountsCustomized} = false AND ${coaTemplatesTable.accounts} IS DISTINCT FROM excluded.accounts`,
    })
    .returning({ id: coaTemplatesTable.id, inserted: sql<boolean>`(xmax = 0)` });
  const inserted = changed.filter((r) => r.inserted).length;
  return { inserted, synced: changed.length - inserted };
}

/**
 * Admin-facing list. Returns ALL templates, including hidden ones,
 * so a super admin can see and un-hide them. Each summary includes
 * `isHidden` so the UI can render a badge.
 */
export async function list(): Promise<CoaTemplateSummary[]> {
  const rows = await db.select().from(coaTemplatesTable).orderBy(asc(coaTemplatesTable.label));
  return rows.map(rowToSummary);
}

/**
 * Public-facing options list — what the registration page, the
 * first-run wizard, and the in-app setup wizard show in their
 * business-type dropdowns. Hidden templates are excluded so they
 * vanish from those dropdowns; un-hiding them brings them back
 * without any other changes.
 */
export async function listOptions(): Promise<CoaTemplateOption[]> {
  const rows = await db
    .select({ slug: coaTemplatesTable.slug, label: coaTemplatesTable.label })
    .from(coaTemplatesTable)
    .where(eq(coaTemplatesTable.isHidden, false))
    .orderBy(asc(coaTemplatesTable.label));
  return rows.map((r) => ({ value: r.slug, label: r.label }));
}

export async function getBySlug(slug: string): Promise<CoaTemplate> {
  const row = await db.query.coaTemplatesTable.findFirst({
    where: eq(coaTemplatesTable.slug, slug),
  });
  if (!row) {
    throw AppError.notFound(`COA template not found: ${slug}`);
  }
  return rowToTemplate(row);
}

/**
 * Look up a template's accounts list, or fall back to the static
 * BUSINESS_TEMPLATES constant if the slug isn't in the DB. Used by
 * accounts.service.seedFromTemplate so seeding works even before the
 * bootstrap has run, or for legacy aliases like `default`/`service`.
 */
export async function getAccountsForSeed(slug: string): Promise<CoaTemplateAccountInput[] | null> {
  const row = await db.query.coaTemplatesTable.findFirst({
    where: eq(coaTemplatesTable.slug, slug),
  });
  if (row) {
    return (row.accounts as CoaTemplateAccountInput[]) ?? [];
  }
  const fallback = (BUSINESS_TEMPLATES as Record<string, CoaTemplateAccountInput[]>)[slug];
  return fallback ?? null;
}

export async function create(
  input: CreateCoaTemplateInput,
  userId?: string,
): Promise<CoaTemplate> {
  validateAccountNumbersUnique(input.accounts);

  // Race-safe insert: rely on the unique index on `slug` rather than a
  // pre-check. Two admins clicking "Save" at the same moment with the
  // same slug would each pass a findFirst check and then one of them
  // would hit the unique constraint with a raw 500. With
  // onConflictDoNothing + empty-returning check we surface a clean
  // TEMPLATE_SLUG_EXISTS to whichever caller lost the race.
  const [row] = await db
    .insert(coaTemplatesTable)
    .values({
      slug: input.slug,
      label: input.label,
      accounts: input.accounts,
      isBuiltin: false,
      createdByUserId: userId ?? null,
    })
    .onConflictDoNothing({ target: coaTemplatesTable.slug })
    .returning();

  if (!row) {
    throw AppError.conflict(`Template slug already exists: ${input.slug}`, 'TEMPLATE_SLUG_EXISTS');
  }
  return rowToTemplate(row);
}

export async function update(
  slug: string,
  input: UpdateCoaTemplateInput,
): Promise<CoaTemplate> {
  const existing = await db.query.coaTemplatesTable.findFirst({
    where: eq(coaTemplatesTable.slug, slug),
  });
  if (!existing) {
    throw AppError.notFound(`COA template not found: ${slug}`);
  }

  if (input.accounts) {
    validateAccountNumbersUnique(input.accounts);
  }

  const updates: Partial<typeof coaTemplatesTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.label !== undefined) updates.label = input.label;
  if (input.accounts !== undefined) {
    // Built-ins are editable by super admins (migration 0199). Their system
    // accounts (A/R, A/P, Cash, Payments Clearing, …) are looked up by
    // systemTag when a tenant is seeded, so every system account of the
    // shipped default must survive the edit. An edited built-in is marked
    // customized so the startup re-sync stops overwriting it; matching the
    // default exactly clears the flag again.
    if (existing.isBuiltin) {
      assertSystemAccountsKept(slug, input.accounts);
      updates.accountsCustomized = !sameAsDefault(slug, input.accounts);
    }
    updates.accounts = input.accounts;
  }

  const [row] = await db
    .update(coaTemplatesTable)
    .set(updates)
    .where(eq(coaTemplatesTable.slug, slug))
    .returning();
  if (!row) {
    throw AppError.internal('Failed to update COA template');
  }
  return rowToTemplate(row);
}

function builtinDefault(slug: string): CoaTemplateAccountInput[] | null {
  const list = (BUSINESS_TEMPLATES as Record<string, unknown>)[slug];
  return Array.isArray(list) ? (list as CoaTemplateAccountInput[]) : null;
}

// Key-order-independent JSON (jsonb reorders object keys on storage).
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

function sameAsDefault(slug: string, accountsList: CoaTemplateAccountInput[]): boolean {
  const def = builtinDefault(slug);
  return !!def && canonical(def) === canonical(accountsList);
}

function assertSystemAccountsKept(slug: string, accountsList: CoaTemplateAccountInput[]): void {
  const def = builtinDefault(slug) ?? [];
  const kept = new Set(accountsList.filter((a) => a.isSystem && a.systemTag).map((a) => a.systemTag));
  const missing = def
    .filter((a) => a.isSystem && a.systemTag && !kept.has(a.systemTag))
    .map((a) => `${a.accountNumber ?? ''} ${a.name}`.trim());
  if (missing.length > 0) {
    throw AppError.badRequest(
      `These system accounts are required and can't be removed (you can rename or renumber them): ${missing.join(', ')}`,
      'TEMPLATE_SYSTEM_ACCOUNT_REQUIRED',
    );
  }
}

/** Restore a built-in template's accounts to the version shipped in code. */
export async function resetBuiltin(slug: string): Promise<CoaTemplate> {
  const existing = await db.query.coaTemplatesTable.findFirst({ where: eq(coaTemplatesTable.slug, slug) });
  if (!existing) throw AppError.notFound(`COA template not found: ${slug}`);
  const def = builtinDefault(slug);
  if (!existing.isBuiltin || !def) throw AppError.badRequest('Only built-in templates can be reset to default.');
  const [row] = await db.update(coaTemplatesTable)
    .set({ accounts: def, accountsCustomized: false, updatedAt: new Date() })
    .where(eq(coaTemplatesTable.slug, slug))
    .returning();
  if (!row) throw AppError.internal('Failed to reset COA template');
  return rowToTemplate(row);
}

/**
 * Toggle a template's hidden flag. Works for both built-in and
 * custom templates — hiding is the safe alternative to deleting a
 * built-in (which is blocked because it would lose data).
 *
 * Hidden templates are excluded from `listOptions()` so they vanish
 * from registration / setup business-type dropdowns. They remain
 * visible to super admins via `list()` so they can be un-hidden.
 *
 * Existing tenants that were registered against this template are
 * unaffected — their accounts table was already seeded; hiding only
 * controls what new registrations can pick.
 */
export async function setHidden(slug: string, hidden: boolean): Promise<CoaTemplate> {
  const [row] = await db
    .update(coaTemplatesTable)
    .set({ isHidden: hidden, updatedAt: new Date() })
    .where(eq(coaTemplatesTable.slug, slug))
    .returning();
  if (!row) {
    throw AppError.notFound(`COA template not found: ${slug}`);
  }
  return rowToTemplate(row);
}

export async function remove(slug: string, actingTenantId?: string, actingUserId?: string): Promise<void> {
  const existing = await db.query.coaTemplatesTable.findFirst({
    where: eq(coaTemplatesTable.slug, slug),
  });
  if (!existing) {
    throw AppError.notFound(`COA template not found: ${slug}`);
  }
  if (existing.isBuiltin) {
    throw AppError.badRequest('Built-in templates cannot be deleted', 'TEMPLATE_BUILTIN');
  }
  await db.delete(coaTemplatesTable).where(eq(coaTemplatesTable.slug, slug));

  // COA templates are system-level (not tenant-scoped). The audit_log
  // table requires a tenantId, so we log against the super-admin's home
  // tenant — captures "this super-admin in this firm deleted this
  // system template". Better than no audit at all; a proper system-wide
  // audit log is a future refactor.
  if (actingTenantId) {
    await auditLog(actingTenantId, 'delete', 'coa_template', existing.id, existing, null, actingUserId);
  } else {
    // eslint-disable-next-line no-console
    console.warn(`[coa-templates] removed template ${slug} (id=${existing.id}) without acting-tenant context — audit log skipped.`);
  }
}

/**
 * Build a new template from a tenant's existing accounts table. Useful
 * when a CPA configures a tenant's COA by hand and wants to make it
 * available to future tenants.
 */
export async function cloneFromTenant(
  tenantId: string,
  slug: string,
  label: string,
  userId?: string,
): Promise<CoaTemplate> {
  // Slug uniqueness is enforced at the DB level and re-checked inside
  // `create()` via onConflictDoNothing; we don't need a pre-check here.

  const tenantAccounts = await db
    .select()
    .from(accounts)
    .where(eq(accounts.tenantId, tenantId))
    .orderBy(asc(accounts.accountNumber));

  if (tenantAccounts.length === 0) {
    throw AppError.badRequest(`Tenant ${tenantId} has no accounts to clone`, 'TENANT_HAS_NO_ACCOUNTS');
  }

  const cloned: CoaTemplateAccountInput[] = tenantAccounts
    .filter((a) => a.isActive !== false && !!a.accountNumber)
    .map((a) => ({
      accountNumber: a.accountNumber!,
      name: a.name,
      accountType: a.accountType as CoaTemplateAccountInput['accountType'],
      detailType: a.detailType ?? 'other_expense',
      isSystem: a.isSystem ?? false,
      systemTag: a.systemTag ?? null,
    }));

  if (cloned.length === 0) {
    throw AppError.badRequest('Tenant has no active accounts with account numbers', 'TENANT_HAS_NO_NUMBERED_ACCOUNTS');
  }

  return create({ slug, label, accounts: cloned }, userId);
}

function validateAccountNumbersUnique(list: CoaTemplateAccountInput[]): void {
  const seen = new Set<string>();
  for (const a of list) {
    if (seen.has(a.accountNumber)) {
      throw AppError.badRequest(
        `Duplicate account number in template: ${a.accountNumber}`,
        'TEMPLATE_DUPLICATE_NUMBER',
      );
    }
    seen.add(a.accountNumber);
  }
}
