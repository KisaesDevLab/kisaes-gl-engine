// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Trial Balance module schemas (docs/tb/BUILD_PLAN.md). Server routes
// validate with these; the web app shares the enums.

import { z } from 'zod';

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
  dryRun: z.coerce.boolean().optional().default(false),
});

const vendorCode = z.string().max(50).nullable().optional();

export const createFirmTaxCodeSchema = z.object({
  // Sent WITHOUT the FIRM: prefix; the server namespaces it (rule TB8).
  code: z.string().min(1).max(50).regex(/^[A-Za-z0-9_.:-]+$/, 'Code may contain letters, digits, and _ . : -'),
  description: z.string().max(500).default(''),
  returnForm: z.enum(tbReturnForms),
  activityType: z.enum(tbActivityTypes),
  sortOrder: z.coerce.number().int().min(0).max(1_000_000).optional().default(0),
  isM1Adjustment: z.coerce.boolean().optional().default(false),
  ultrataxCode: vendorCode,
  cchCode: vendorCode,
  lacerteCode: vendorCode,
  gosystemCode: vendorCode,
  genericCode: vendorCode,
});

export const updateFirmTaxCodeSchema = createFirmTaxCodeSchema.partial().extend({
  isActive: z.coerce.boolean().optional(),
});

export const upsertTaxProfileSchema = z.object({
  returnForm: z.enum(tbReturnForms),
  // NULL floats to the latest seed version for the tax year (ADR-TB-05).
  pinnedSeedVersionId: z.string().uuid().nullable().optional(),
  sCorpElectionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
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
