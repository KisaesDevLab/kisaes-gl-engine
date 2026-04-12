import { z } from 'zod';

const accountTypes = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;

/**
 * One row of a chart-of-accounts template — matches CoaTemplateAccount in
 * coa-templates.ts. Kept here in Zod form so the API can validate inbound
 * payloads from the admin UI and the import endpoint.
 */
export const coaTemplateAccountSchema = z.object({
  accountNumber: z.string().min(1).max(20),
  name: z.string().min(1).max(255),
  accountType: z.enum(accountTypes),
  detailType: z.string().min(1).max(100),
  isSystem: z.boolean(),
  systemTag: z.string().max(50).nullable(),
});

export type CoaTemplateAccountInput = z.infer<typeof coaTemplateAccountSchema>;

const slugSchema = z
  .string()
  .min(2)
  .max(100)
  .regex(/^[a-z0-9_]+$/, 'Slug must be lowercase letters, digits, and underscores only');

export const createCoaTemplateSchema = z.object({
  slug: slugSchema,
  label: z.string().min(1).max(255),
  accounts: z.array(coaTemplateAccountSchema).min(1, 'Template must contain at least one account'),
});

export type CreateCoaTemplateInput = z.infer<typeof createCoaTemplateSchema>;

export const updateCoaTemplateSchema = z.object({
  label: z.string().min(1).max(255).optional(),
  accounts: z.array(coaTemplateAccountSchema).min(1).optional(),
});

export type UpdateCoaTemplateInput = z.infer<typeof updateCoaTemplateSchema>;

/**
 * Import payload — same shape as create, but the route accepts a JSON
 * blob (e.g. pasted into a textarea or read from an uploaded file).
 */
export const importCoaTemplateSchema = createCoaTemplateSchema;

export const cloneCoaTemplateFromTenantSchema = z.object({
  tenantId: z.string().uuid(),
  slug: slugSchema,
  label: z.string().min(1).max(255),
});

export type CloneCoaTemplateFromTenantInput = z.infer<typeof cloneCoaTemplateFromTenantSchema>;

export interface CoaTemplate {
  id: string;
  slug: string;
  label: string;
  accounts: CoaTemplateAccountInput[];
  isBuiltin: boolean;
  /** Hidden templates are excluded from the public business-type dropdowns. */
  isHidden: boolean;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CoaTemplateSummary {
  id: string;
  slug: string;
  label: string;
  isBuiltin: boolean;
  isHidden: boolean;
  accountCount: number;
  updatedAt: string;
}

export interface CoaTemplateOption {
  value: string;
  label: string;
}
