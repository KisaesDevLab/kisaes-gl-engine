import { z } from 'zod';

export const createTagSchema = z.object({
  name: z.string().min(1, 'Tag name is required').max(100),
  color: z.string().max(7).nullish(),
  groupId: z.string().uuid().nullish(),
  description: z.string().nullish(),
});

export const updateTagSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  color: z.string().max(7).nullish(),
  groupId: z.string().uuid().nullish(),
  description: z.string().nullish(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const mergeTagsSchema = z.object({
  sourceTagId: z.string().uuid(),
  targetTagId: z.string().uuid(),
});

export const createTagGroupSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().nullish(),
  isSingleSelect: z.boolean().default(false),
});

export const updateTagGroupSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().nullish(),
  isSingleSelect: z.boolean().optional(),
});

export const transactionTagsSchema = z.object({
  tagIds: z.array(z.string().uuid()),
});

export const bulkTagSchema = z.object({
  transactionIds: z.array(z.string().uuid()),
  tagIds: z.array(z.string().uuid()),
});

export const tagFilterSchema = z.object({
  tagIds: z.string().optional().transform((v) => v ? v.split(',') : undefined),
  tagMode: z.enum(['any', 'all']).default('any'),
  excludeTagIds: z.string().optional().transform((v) => v ? v.split(',') : undefined),
  untaggedOnly: z.preprocess((v) => v === 'true', z.boolean().default(false)),
});

export const createSavedFilterSchema = z.object({
  name: z.string().min(1).max(255),
  reportType: z.string().min(1).max(100),
  filters: z.record(z.unknown()),
  isDefault: z.boolean().default(false),
});

export const updateSavedFilterSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  filters: z.record(z.unknown()).optional(),
  isDefault: z.boolean().optional(),
});
