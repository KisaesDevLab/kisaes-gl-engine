// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { z } from 'zod';
import { ACCESS_LEVELS } from '../types/permissions.js';
import { RESOURCE_KEYS } from '../constants/permissions.js';

// A permission map validates its keys against the resource catalog and
// its values against the level ladder. Unknown keys are rejected so a
// typo can't silently create a dead entry that never enforces.
export const accessLevelSchema = z.enum(ACCESS_LEVELS);

export const permissionMapSchema = z
  .record(
    z.enum(RESOURCE_KEYS as [string, ...string[]]),
    accessLevelSchema,
  )
  .default({});
export type PermissionMapInput = z.infer<typeof permissionMapSchema>;

export const createPermissionTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  permissions: permissionMapSchema,
});
export type CreatePermissionTemplateInput = z.infer<typeof createPermissionTemplateSchema>;

export const updatePermissionTemplateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  permissions: permissionMapSchema.optional(),
});
export type UpdatePermissionTemplateInput = z.infer<typeof updatePermissionTemplateSchema>;

// Assign a template (or clear it with null) and set per-user overrides.
export const setUserPermissionsSchema = z.object({
  templateId: z.string().uuid().nullable().optional(),
  overrides: permissionMapSchema.optional(),
});
export type SetUserPermissionsInput = z.infer<typeof setUserPermissionsSchema>;
