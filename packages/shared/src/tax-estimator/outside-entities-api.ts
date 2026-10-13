// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator: businesses OUTSIDE MyBooks (OPEN-QUESTIONS Q45, Kurt 2026-10-13: "Also need the
// ability to enter income/loss for entities not within the MyBooks system"). Part of the
// taxpayer (same firm + D17 / D18 visibility as persons and dependents). The DEFINITION is
// persistent (name, type, owner, %, activity, QBI / SSTB, state sourcing); the AMOUNTS are
// entered per tax year, each year with its own entry mode, amount basis and through month.
// The bridge (engine/bridge.ts engineEntityFromOutside) turns one definition + one year into
// an EngineEntity, so every engine step (QBI, SE, §469, §461(l), NIIT, states) treats it
// exactly like a linked business. MONEY: decimal strings, profit-positive (a loss is negative).

import type { CharacterAmounts } from './entities-api.js';
import type { ActivityType, EntityTaxType } from './types.js';
import type { PartnerSeStatus, PersonRole } from './taxpayers-api.js';

/**
 * `full_year` = the amounts ARE the full-year figures (used as entered, no projection);
 * `ytd` = year-to-date amounts through `throughMonth`, projected like a linked business
 * (YTD + YTD ÷ months elapsed × months remaining; every amount is treated as recurring).
 */
export const OUTSIDE_ENTRY_MODES = ['full_year', 'ytd'] as const;
export type OutsideEntryMode = typeof OUTSIDE_ENTRY_MODES[number];

/**
 * `entity_total` = 100% of the entity, allocated by the owner's profit % / loss %;
 * `owner_share` = already the taxpayer's share (e.g. a K-1): the engine allocates 100% of it and
 * the stated % is informational (shown, never used to multiply).
 */
export const OUTSIDE_AMOUNT_BASES = ['entity_total', 'owner_share'] as const;
export type OutsideAmountBasis = typeof OUTSIDE_AMOUNT_BASES[number];

/** Where an estimate entity's figures came from (EntityResult / EstimateEntityDTO; absent = books). */
export type EntitySource = 'books' | 'outside';

/** Sentinel `tenantId` of an outside business in engine entities and estimate DTOs (never a tenant uuid). */
export const OUTSIDE_TENANT_ID = 'outside';
/** Engine link id of an outside business's single owner link: `outside:<outsideEntityId>`. */
export const outsideLinkId = (outsideEntityId: string): string => `${OUTSIDE_TENANT_ID}:${outsideEntityId}`;

/** At most this many outside businesses per taxpayer. */
export const MAX_OUTSIDE_ENTITIES = 25;

/** One tax year's amounts of an outside business. */
export interface OutsideEntityYearDTO {
  outsideEntityId: string;
  taxYear: number;
  entryMode: OutsideEntryMode;
  amountBasis: OutsideAmountBasis;
  /** 1–12, required for `ytd` (amounts are Jan 1 → end of that month); null for `full_year`. */
  throughMonth: number | null;
  /** Income / loss by character (profit-positive) on the chosen basis. */
  amounts: CharacterAmounts;
  /** Partnership: guaranteed payments to this owner (always the owner's own; never allocated by %). */
  guaranteedPayments: string;
  /** S corp: the owner's officer W-2 wages (box 1; always the owner's own). */
  officerWages: string;
  /** Owner health insurance (SEHI pool; S corp: the >2% shareholder's premiums). */
  ownerSehi: string;
  /** Owner retirement contributions (Sch C / Sch F / partnership). */
  ownerRetirement: string;
  /** S corp: >2% shareholder health added to the officer's W-2 box 1. */
  sehiAsW2Wages: string;
  /** §199A W-2 wages of the business on the chosen basis, full year (null = unknown). */
  w2Wages: string | null;
  /** §199A UBIA of qualified property on the chosen basis (null = not entered). */
  ubia: string | null;
  /** Q41 switch: count the >2% shareholder health add-on as §199A W-2 wages. */
  includeSehiInW2Wages: boolean;
  /** Basis / at-risk allowed-loss override (positive magnitude; null = none). */
  allowedLossOverride: string | null;
  updatedAt: string;
}

/** A business outside MyBooks (persistent definition) with its amounts for the requested year. */
export interface OutsideEntityDTO {
  id: string;
  taxpayerId: string;
  name: string;
  entityType: EntityTaxType;
  /** The owner (taxpayer or spouse). */
  personId: string;
  personRole: PersonRole;
  /** 0–100; null = 100 (single owner). On `owner_share` it is informational only. */
  profitPct: number | null;
  /** 0–100; null = profitPct. */
  lossPct: number | null;
  /** Partnerships only. */
  partnerSeStatus: PartnerSeStatus | null;
  /** S corps only. */
  isOfficer: boolean;
  activityType: ActivityType;
  activeParticipation: boolean;
  /** null = the default for the activity (rental follows rentalQbiTradeOrBusiness). */
  qbiEligible: boolean | null;
  isSstb: boolean;
  rentalQbiTradeOrBusiness: boolean;
  /** Two-letter state the business income is sourced to (nonresident state rows); null = none. */
  stateSourcing: string | null;
  createdAt: string;
  updatedAt: string;
  /** Tax years that have amounts entered (ascending). */
  years: number[];
  /** The requested year's amounts (list `?taxYear=`); null = none entered for that year. */
  year: OutsideEntityYearDTO | null;
}

export interface OutsideEntityListDTO {
  data: OutsideEntityDTO[];
  total: number;
}
