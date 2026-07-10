// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';

const accountTypes = [
  'asset', 'liability', 'equity',
  'revenue', 'cogs', 'expense', 'other_revenue', 'other_expense',
] as const;

export const createAccountSchema = z.object({
  accountNumber: z.string().max(20).nullish(),
  name: z.string().min(1, 'Name is required').max(255),
  accountType: z.enum(accountTypes),
  detailType: z.string().max(100).nullish(),
  description: z.string().nullish(),
  parentId: z.string().uuid().nullish(),
});

export const updateAccountSchema = z.object({
  accountNumber: z.string().max(20).nullish(),
  name: z.string().min(1).max(255).optional(),
  accountType: z.enum(accountTypes).optional(),
  detailType: z.string().max(100).nullish(),
  description: z.string().nullish(),
  parentId: z.string().uuid().nullish(),
  isActive: z.boolean().optional(),
});

export const accountFiltersSchema = z.object({
  accountType: z.enum(accountTypes).optional(),
  isActive: z.preprocess((v) => v === 'true' ? true : v === 'false' ? false : v, z.boolean().optional()),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const mergeAccountsSchema = z.object({
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
});

// Bulk inline edit from the COA "Bulk Edit" table. Each entry targets one
// account; only the editable columns are accepted (number/name/type/detail).
// Capped at 500 — matches the list endpoint's max page size, so one bulk
// save can cover everything the table can display.
export const bulkUpdateAccountsSchema = z.object({
  updates: z.array(z.object({
    id: z.string().uuid(),
    accountNumber: z.string().max(20).nullish(),
    name: z.string().min(1).max(255).optional(),
    accountType: z.enum(accountTypes).optional(),
    detailType: z.string().max(100).nullish(),
  })).min(1).max(500),
});
export type BulkUpdateAccountsInput = z.infer<typeof bulkUpdateAccountsSchema>;

// Tenant-defined custom detail types (Settings → Detail Types). `value`
// is the snake_case slug stored on accounts.detail_type; `label` is the
// display name shown in dropdowns and grouped reports.
export const createDetailTypeSchema = z.object({
  accountType: z.enum(accountTypes),
  value: z.string().regex(/^[a-z0-9_]{2,50}$/, 'Use 2-50 lowercase letters, digits, or underscores'),
  label: z.string().min(1, 'Label is required').max(100),
  // Optional explicit presentation order; omitted = end of the list
  // (NULL sorts after every explicitly ordered type).
  sortOrder: z.number().int().min(0).optional(),
});
export type CreateDetailTypeInput = z.infer<typeof createDetailTypeSchema>;

// PATCH /tenant-settings/detail-types/:id — label rename and/or
// presentation reorder. `value` is immutable (stored on accounts).
export const updateDetailTypeSchema = z.object({
  label: z.string().min(1, 'Label is required').max(100).optional(),
  sortOrder: z.number().int().min(0).nullable().optional(),
});
export type UpdateDetailTypeInput = z.infer<typeof updateDetailTypeSchema>;
