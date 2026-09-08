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

// How tax codes resolve per activity unit (migration 0170). 'account':
// a unit slice falls back to the account-level code. 'unit': strict —
// the account-level row is the default unit's code and every other unit
// with a balance needs its own row (Tax Mapping shows a sub-row per unit).
export const tbTaxCodeMappingModes = ['account', 'unit'] as const;
export type TbTaxCodeMappingMode = typeof tbTaxCodeMappingModes[number];

export const upsertTaxProfileSchema = z.object({
  returnForm: z.enum(tbReturnForms),
  taxCodeMappingMode: z.enum(tbTaxCodeMappingModes).optional(),
  // NULL floats to the latest seed version for the tax year (ADR-TB-05).
  pinnedSeedVersionId: z.string().uuid().nullable().optional(),
  sCorpElectionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  // Entity activity — scopes assignable codes (with live unit types).
  defaultActivityType: z.enum(tbActivityUnitTypes).optional(),
  // Where vendor exports attach the unit number on unit-split account
  // rows: append (1000-2) or prepend (2-1000) to the account number.
  unitNumberPlacement: z.enum(['suffix', 'prefix']).optional(),
});

export const createActivityUnitSchema = z.object({
  activityType: z.enum(tbActivityUnitTypes),
  displayName: z.string().min(1).max(200),
  // Omitted = next free instance number for the activity type.
  instanceNumber: z.coerce.number().int().min(1).max(999).optional(),
});

export const updateActivityUnitSchema = z.object({
  displayName: z.string().min(1).max(200),
  // Vendor exports print the unit number and suffix account numbers
  // with it — firms align it with the return's unit numbering.
  instanceNumber: z.coerce.number().int().min(1).max(999).optional(),
});

export const mapTagSchema = z.object({
  activityUnitId: z.string().uuid(),
});

// Making a unit the default in 'unit' mapping mode re-targets every
// account-level code; the server returns an impact preview unless
// `confirm` is set. `convertOldDefault` copies the account-level codes
// onto the previous default unit as unit rows so nothing loses coverage.
export const setDefaultUnitSchema = z.object({
  confirm: z.boolean().optional().default(false),
  convertOldDefault: z.boolean().optional().default(false),
});

// Account → tax code assignment write (PUT /tb/assignments). The unit's
// activity type is derived server-side from activityUnitId; the legacy
// `activityUnitType` field is accepted for compatibility and ignored.
export const setAssignmentSchema = z.object({
  accountId: z.string().uuid(),
  activityUnitId: z.string().uuid().nullable().optional(),
  seedCode: z.string().max(50).nullable().optional(),
  seedActivityType: z.string().max(20).nullable().optional(),
  firmCodeId: z.string().uuid().nullable().optional(),
  activityUnitType: z.string().max(20).optional(),
  effectiveTaxYear: z.coerce.number().int().optional(),
  // 'ai' when the user ACCEPTS an AI suggestion (6C.4) — acceptance is
  // always an explicit user act; the server never auto-commits.
  source: z.enum(['manual', 'ai']).optional().default('manual'),
  aiConfidence: z.coerce.number().int().min(0).max(100).nullable().optional(),
});
export type TbSetAssignmentInput = z.infer<typeof setAssignmentSchema>;

// Copy tax-code mappings from one activity unit (or the account-level
// codes, sourceUnitId = null) onto other live units. Codes that are not
// assignable to a target's activity type are skipped and reported.
export const tbCopyAssignmentModes = ['skip_existing', 'overwrite'] as const;
export const copyAssignmentsSchema = z.object({
  sourceUnitId: z.string().uuid().nullable(),
  targetUnitIds: z.array(z.string().uuid()).min(1).max(100),
  mode: z.enum(tbCopyAssignmentModes),
  // Restrict to these accounts (the per-row "apply to all <type> units").
  accountIds: z.array(z.string().uuid()).max(5000).optional(),
  // Report what would happen without writing (dialog preview).
  dryRun: z.boolean().optional(),
});
export type TbCopyAssignmentsInput = z.infer<typeof copyAssignmentsSchema>;

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
