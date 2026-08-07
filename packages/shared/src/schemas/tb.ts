// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Trial Balance module schemas (docs/tb/BUILD_PLAN.md). Server routes
// validate with these; the web app shares the enums.

import { z } from 'zod';
import { createJournalEntrySchema } from './transactions.js';

// An AJE is shaped exactly like a manual JE (multi-line, per-line tags,
// basis) — the difference is txn_type, numbering, and the firm-only
// route that accepts it (rule TB3). draftAttachmentId must live IN the
// schema: validate() replaces req.body with the stripped parse.
export const createAjeSchema = createJournalEntrySchema.extend({
  draftAttachmentId: z.string().uuid().optional(),
});

export const tbReturnForms = ['1040', '1065', '1120', '1120S'] as const;
export type TbReturnForm = typeof tbReturnForms[number];

// Seed files additionally carry return_form='common' utility rows.
export const tbSeedReturnForms = [...tbReturnForms, 'common'] as const;

export const tbActivityTypes = ['common', 'business', 'rental', 'farm', 'farm_rental'] as const;
export type TbActivityType = typeof tbActivityTypes[number];

// Activity units are real activities — 'common' is a seed-row scope, not
// a unit type (ADR-TB-02).
export const tbActivityUnitTypes = ['business', 'rental', 'farm', 'farm_rental'] as const;
export type TbActivityUnitType = typeof tbActivityUnitTypes[number];

export const tbWorkpaperColumns = ['unadjusted', 'aje', 'adjusted', 'tax_rje', 'tax'] as const;
export type TbWorkpaperColumn = typeof tbWorkpaperColumns[number];

export const tbWorkflowStates = ['open', 'in_review', 'complete'] as const;
export type TbWorkflowState = typeof tbWorkflowStates[number];

export const seedImportSchema = z.object({
  taxYear: z.coerce.number().int().min(2000).max(2100),
  label: z.string().max(200).optional(),
  // Multipart fields arrive as STRINGS and z.coerce.boolean() is
  // Boolean(input) — Boolean('false') === true. Parse explicitly.
  dryRun: z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
    .optional().default(false),
});

const vendorCode = z.string().max(50).nullable().optional();

// Super-admin direct CRUD on seed-library rows. Identity fields
// (returnForm/activityType/code) are the stable key assignments point
// at, so the service refuses identity changes while any assignment
// references the row.
export const adminTaxCodeCreateSchema = z.object({
  versionId: z.string().uuid(),
  returnForm: z.enum(tbSeedReturnForms),
  activityType: z.enum(tbActivityTypes),
  code: z.string().min(1).max(50).regex(/^[A-Za-z0-9_.:-]+$/, 'Code may contain letters, digits, and _ . : -'),
  description: z.string().max(1000).default(''),
  sortOrder: z.coerce.number().int().min(0).max(1_000_000).optional().default(0),
  isM1Adjustment: z.boolean().optional().default(false),
  notes: z.string().max(2000).nullable().optional(),
  ultrataxCode: vendorCode,
  cchCode: vendorCode,
  lacerteCode: vendorCode,
  gosystemCode: vendorCode,
  genericCode: vendorCode,
});

export const adminTaxCodeUpdateSchema = adminTaxCodeCreateSchema.omit({ versionId: true }).partial();

export const createFirmTaxCodeSchema = z.object({
  // Sent WITHOUT the FIRM: prefix; the server namespaces it (rule TB8).
  code: z.string().min(1).max(50).regex(/^[A-Za-z0-9_.:-]+$/, 'Code may contain letters, digits, and _ . : -'),
  description: z.string().max(500).default(''),
  returnForm: z.enum(tbReturnForms),
  activityType: z.enum(tbActivityTypes),
  sortOrder: z.coerce.number().int().min(0).max(1_000_000).optional().default(0),
  isM1Adjustment: z.boolean().optional().default(false),
  ultrataxCode: vendorCode,
  cchCode: vendorCode,
  lacerteCode: vendorCode,
  gosystemCode: vendorCode,
  genericCode: vendorCode,
});

export const updateFirmTaxCodeSchema = createFirmTaxCodeSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const upsertTaxProfileSchema = z.object({
  returnForm: z.enum(tbReturnForms),
  // NULL floats to the latest seed version for the tax year (ADR-TB-05).
  pinnedSeedVersionId: z.string().uuid().nullable().optional(),
  sCorpElectionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  // Entity activity — scopes assignable codes (with live unit types).
  defaultActivityType: z.enum(tbActivityUnitTypes).optional(),
});

export const createActivityUnitSchema = z.object({
  activityType: z.enum(tbActivityUnitTypes),
  displayName: z.string().min(1).max(200),
  // Omitted = next free instance number for the activity type.
  instanceNumber: z.coerce.number().int().min(1).max(999).optional(),
});

export const updateActivityUnitSchema = z.object({
  displayName: z.string().min(1).max(200),
});

export const mapTagSchema = z.object({
  activityUnitId: z.string().uuid(),
});

// Tax RJEs (ADR-TB-03): tax-basis-only, must net to zero (service-
// enforced with Decimal — the schema just shapes the wire format).
export const createTaxEntrySchema = z.object({
  taxYear: z.coerce.number().int().min(2000).max(2100),
  memo: z.string().max(2000).optional(),
  lines: z.array(z.object({
    accountId: z.string().uuid(),
    activityUnitId: z.string().uuid().nullable().optional(),
    debit: z.string().regex(/^\d+(\.\d{1,4})?$/).default('0'),
    credit: z.string().regex(/^\d+(\.\d{1,4})?$/).default('0'),
    description: z.string().max(500).optional(),
  })).min(2).max(100),
  draftAttachmentId: z.string().uuid().optional(),
});
