import { eq, asc } from 'drizzle-orm';
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

type DbCoaTemplate = typeof coaTemplatesTable.$inferSelect;

function rowToTemplate(row: DbCoaTemplate): CoaTemplate {
  return {
    id: row.id,
    slug: row.slug,
    label: row.label,
    accounts: (row.accounts as CoaTemplateAccountInput[]) ?? [],
    isBuiltin: row.isBuiltin,
    isHidden: row.isHidden,
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
    accountCount: acctList.length,
    updatedAt: (row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt as unknown as string)).toISOString(),
  };
}

/**
 * On first startup, copy the static BUSINESS_TEMPLATES into the database
 * so super admins have something to manage. Idempotent and safe to call
 * from API startup unconditionally, INCLUDING under scale-out where two
 * API containers may boot simultaneously.
 *
 * Race safety: the emptiness check + INSERT is intentionally not wrapped
 * in any application-level "am I first?" logic. Instead the INSERT uses
 * `ON CONFLICT (slug) DO NOTHING` so a second container whose INSERT
 * arrives after the first simply no-ops its own rows and returns.
 * Without this, the second container would crash on the unique index
 * (idx_coa_templates_slug) and the API would fail to start.
 *
 * `returning()` tells us how many rows this particular caller actually
 * inserted — zero for the loser of the race, full count for the winner.
 */
export async function bootstrapBuiltins(): Promise<{ inserted: number }> {
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
  }));

  if (rows.length === 0) {
    return { inserted: 0 };
  }

  const inserted = await db
    .insert(coaTemplatesTable)
    .values(rows)
    .onConflictDoNothing({ target: coaTemplatesTable.slug })
    .returning({ id: coaTemplatesTable.id });
  return { inserted: inserted.length };
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

  // Built-in templates are frozen: their accounts are referenced
  // by system-account lookups (e.g., systemTag = 'accounts_payable')
  // and must stay in lockstep with the static BUSINESS_TEMPLATES
  // constant. We still allow relabeling the display label so an
  // admin can re-brand the dropdown entry, but block account
  // mutations outright — editing the accounts list on a built-in
  // silently diverges the DB from the code constant and causes
  // hard-to-debug seeding failures.
  if (existing.isBuiltin && input.accounts !== undefined) {
    throw AppError.badRequest(
      'Cannot modify accounts on a built-in template. Hide it and create a custom copy instead.',
      'TEMPLATE_BUILTIN_LOCKED',
    );
  }

  if (input.accounts) {
    validateAccountNumbersUnique(input.accounts);
  }

  const updates: Partial<typeof coaTemplatesTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.label !== undefined) updates.label = input.label;
  if (input.accounts !== undefined) updates.accounts = input.accounts;

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

export async function remove(slug: string): Promise<void> {
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
