// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { z } from 'zod';
import { FIRM_ROLES } from '../types/firms.js';

// 3-tier rules plan, Phase 1 — firms foundation zod schemas.
// Reuses the legacy slug rule (lowercase letters/digits/hyphens
// only) the rest of the codebase enforces for tenant slugs.

const slugSchema = z
  .string()
  .min(2)
  .max(100)
  .regex(/^[a-z0-9](-?[a-z0-9])*$/, 'Slug must be lowercase alphanumeric with single hyphens');

export const createFirmSchema = z.object({
  name: z.string().min(1).max(255),
  slug: slugSchema,
  superAdminManaged: z.boolean().optional(),
});
export type CreateFirmInput = z.infer<typeof createFirmSchema>;

export const updateFirmSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  slug: slugSchema.optional(),
  isActive: z.boolean().optional(),
  superAdminManaged: z.boolean().optional(),
});
export type UpdateFirmInput = z.infer<typeof updateFirmSchema>;

export const firmRoleSchema = z.enum(FIRM_ROLES);

export const inviteFirmUserSchema = z.object({
  // Either userId (existing user) OR email (will look up). One of
  // them is required; the route handler resolves email→userId.
  userId: z.string().uuid().optional(),
  email: z.string().email().optional(),
  firmRole: firmRoleSchema.default('firm_staff'),
}).refine((v) => v.userId !== undefined || v.email !== undefined, {
  message: 'Either userId or email is required',
});
export type InviteFirmUserInput = z.infer<typeof inviteFirmUserSchema>;

export const updateFirmUserSchema = z.object({
  firmRole: firmRoleSchema.optional(),
  isActive: z.boolean().optional(),
});
export type UpdateFirmUserInput = z.infer<typeof updateFirmUserSchema>;

export const assignTenantToFirmSchema = z.object({
  tenantId: z.string().uuid(),
  // When true and another firm currently has this tenant
  // assigned, soft-detach the prior assignment.
  force: z.boolean().optional().default(false),
});
export type AssignTenantToFirmInput = z.infer<typeof assignTenantToFirmSchema>;
